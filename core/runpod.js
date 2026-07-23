/**
 * runpod.js — RunPod 파드 반자동 켜기/끄기 (과금 절감)
 *
 *  목적: 만들기(큐/단건) 시작 시 파드가 꺼져 있으면 자동으로 켜고(ComfyUI 뜰 때까지 대기),
 *        작업이 끝나면 자동으로 끈다. 수동 켜기/끄기/상태도 제공.
 *
 *  - autoManage=false(기본)면 아무것도 안 함 → 기존 동작 무영향(안전).
 *  - podId 는 활성 ComfyUI 서버 주소(https://<podId>-8188.proxy.runpod.net)에서 자동 추출.
 *  - API 키는 secret-store 'runpod' 에 저장(평문 config 에 안 남김). RunPod → Settings → API Keys 에서 발급.
 *
 *  ⚠ RunPod GraphQL 스키마는 실제 키로 1회 검증 필요(응답을 로그로 남김). 응답이 다르면 쿼리만 보정.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_PATH = path.join(os.homedir(), '.priming-maker', 'runpod-config.json');
const DEFAULTS = {
  autoManage: false,     // true 여야 자동 켜기/끄기 동작(기본 OFF = 무영향)
  podId: '',             // 빈값이면 활성 ComfyUI 주소에서 자동 추출
  gpuCount: 1,
  readyTimeoutSec: 360,  // 켠 뒤 ComfyUI 기동 대기 상한(콜드스타트 모델 로딩 포함)
  stopOnAbort: true,     // 중단 시에도 파드를 끌지(과금 절감). false 면 중단 땐 켜둠
};

function loadConfig() {
  try { if (fs.existsSync(CFG_PATH)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }; } catch {}
  return { ...DEFAULTS };
}
function saveConfig(patch) {
  try {
    fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
    const next = { ...loadConfig(), ...(patch || {}) };
    fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch { return loadConfig(); }
}
function getKey() {
  try { return (require('../tts/secret-store').get('runpod') || {}).key || ''; } catch { return ''; }
}
function setKey(key) {
  try { require('../tts/secret-store').set('runpod', { key: String(key || '').trim() }); return true; } catch { return false; }
}

// proxy URL 에서 podId 추출: https://<podId>-8188.proxy.runpod.net → <podId>
function extractPodId(url) {
  const m = String(url || '').match(/https?:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i);
  return m ? m[1] : '';
}
function isRunpodUrl(url) { return /\.proxy\.runpod\.net/i.test(String(url || '')); }

async function _gql(query) {
  const key = getKey();
  if (!key) throw new Error('RunPod API 키 없음 (⚡ RunPod 설정에서 키 입력)');
  const r = await fetch('https://api.runpod.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`RunPod API ${r.status}: ${t.slice(0, 200)}`);
  if (j && j.errors) throw new Error('RunPod API: ' + JSON.stringify(j.errors).slice(0, 200));
  return j && j.data;
}

// desiredStatus: RUNNING | EXITED | ...
async function podStatus(podId) {
  const d = await _gql(`query { pod(input:{podId:"${podId}"}) { id desiredStatus } }`);
  return (d && d.pod && d.pod.desiredStatus) || 'UNKNOWN';
}
async function podStart(podId, gpuCount = 1) {
  const d = await _gql(`mutation { podResume(input:{podId:"${podId}", gpuCount:${gpuCount}}) { id desiredStatus } }`);
  return (d && d.podResume && d.podResume.desiredStatus) || 'UNKNOWN';
}
async function podStop(podId) {
  const d = await _gql(`mutation { podStop(input:{podId:"${podId}"}) { id desiredStatus } }`);
  return (d && d.podStop && d.podStop.desiredStatus) || 'UNKNOWN';
}

// baseUrl(ComfyUI) 이 200 응답할 때까지 대기 — 파드 부팅 + ComfyUI 자동기동 + 모델 로딩 포함.
async function waitComfyReady(baseUrl, timeoutSec, logger) {
  const log = logger || (() => {});
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/';
  const deadline = Date.now() + (timeoutSec || 360) * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { method: 'GET' }); if (r && (r.ok || r.status === 200)) return true; } catch {}
    n++;
    if (n % 3 === 0) log('[RunPod] ComfyUI 기동 대기…');
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

// 이미 ComfyUI 가 응답하면 true (파드가 이미 켜져 있음)
async function comfyAlive(baseUrl) {
  try { const r = await fetch(String(baseUrl || '').replace(/\/+$/, '') + '/', { method: 'GET' }); return !!(r && (r.ok || r.status === 200)); } catch { return false; }
}

module.exports = {
  loadConfig, saveConfig, getKey, setKey,
  extractPodId, isRunpodUrl,
  podStatus, podStart, podStop, waitComfyReady, comfyAlive,
  CFG_PATH, DEFAULTS,
};
