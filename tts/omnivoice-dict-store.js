/**
 * OmniVoice 전역 발음 사전 CRUD
 * 위치: ~/.flow-app/omnivoice-dict.json  (로컬 캐시)
 * 서버: GET/PUT http://<omnivoice-server>:9881/dict  (LAN 공유)
 * 형식: [{source, pron, enabled}]
 *
 * 동작:
 *   loadAll()  — 로컬 캐시 즉시 반환 (sync)
 *   saveAll()  — 로컬 캐시 저장 + 온라인이면 백그라운드 PUT
 *   refresh()  — 서버에서 GET → 로컬 갱신 (async, 모달 open 시 await)
 *   isOnline() — 마지막 refresh 결과 (초기값 false)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STORE_DIR  = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'omnivoice-dict.json');

let _online         = false;
let _inflightRefresh = null;

// ── 서버 URL 결정 ──────────────────────────────────────────────
function _getBaseUrl() {
  try {
    const { getProvider } = require('./tts-config');
    return (getProvider('omnivoice').baseUrl || '').replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

// secret-store 의 omnivoice.apiKey 가 있으면 X-API-Key 헤더 반환
function _authHeaders() {
  try {
    const SecretStore = require('./secret-store');
    const s = SecretStore.get('omnivoice');
    if (s && s.apiKey) return { 'X-API-Key': s.apiKey };
  } catch {}
  return {};
}

// ── 로컬 캐시 ──────────────────────────────────────────────────
function loadAll() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('[omnivoice-dict-store] 로드 실패:', e.message);
  }
  return [];
}

function _writeLocal(entries) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (e) {
    console.error('[omnivoice-dict-store] 로컬 저장 실패:', e.message);
  }
}

// ── 원격 동기화 ────────────────────────────────────────────────

/**
 * 서버에서 사전을 가져와 로컬 캐시를 갱신한다.
 * @returns {Promise<{ok:boolean, source:'remote'|'local-fallback', version?:string}>}
 */
async function refresh() {
  // 인플라이트 중복 방지
  if (_inflightRefresh) return _inflightRefresh;
  _inflightRefresh = _doRefresh().finally(() => { _inflightRefresh = null; });
  return _inflightRefresh;
}

async function _doRefresh() {
  const baseUrl = _getBaseUrl();
  if (!baseUrl) {
    _online = false;
    return { ok: false, source: 'local-fallback' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/dict`, { signal: controller.signal, headers: { ..._authHeaders() } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    // 🛡 파괴적 동기화 방지 — 서버가 빈 사전을 반환했는데 로컬에 항목이 있으면,
    //   (백엔드 재시작·FLOW_DICT_PATH 미설정·일시 초기화 등으로 빈 응답이 온 것일 가능성 큼)
    //   로컬을 덮어쓰지 말고 보존 + 로컬을 서버로 되올려 복구(self-heal). → 등록분 영구 소실 방지.
    if (entries.length === 0) {
      const local = loadAll();
      if (local.length > 0) {
        console.warn('[omnivoice-dict-store] 서버 사전이 비어있음 — 로컬 보존 + 서버로 복구(self-heal):', local.length, '건');
        saveAll(local);   // 로컬 → 서버 PUT (다른 사용자도 다시 받을 수 있게)
        _online = true;
        return { ok: true, source: 'local-heal' };
      }
    }
    _writeLocal(entries);
    _online = true;
    return { ok: true, source: 'remote', version: data.version };
  } catch (e) {
    _online = false;
    console.warn('[omnivoice-dict-store] refresh 실패 (로컬 폴백):', e.message);
    return { ok: false, source: 'local-fallback' };
  }
}

/** 마지막 refresh 기준 온라인 상태 */
function isOnline() {
  return _online;
}

// ── CRUD ───────────────────────────────────────────────────────

function saveAll(entries) {
  _writeLocal(entries);
  // 온라인이면 백그라운드 PUT — 실패는 로그만
  const baseUrl = _getBaseUrl();
  if (baseUrl) {
    fetch(`${baseUrl}/dict`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ entries }),
    }).then(res => {
      if (!res.ok) console.warn('[omnivoice-dict-store] 원격 PUT 실패:', res.status);
      else _online = true;
    }).catch(e => {
      console.warn('[omnivoice-dict-store] 원격 PUT 오류:', e.message);
      _online = false;
    });
  }
  return true;
}

function add(entry) {
  const all = loadAll();
  const normalized = { source: entry.source || '', pron: entry.pron || '', enabled: entry.enabled !== false };
  all.push(normalized);
  saveAll(all);
  return normalized;
}

function update(idx, patch) {
  const all = loadAll();
  if (idx < 0 || idx >= all.length) return null;
  all[idx] = { ...all[idx], ...patch };
  saveAll(all);
  return all[idx];
}

function remove(idx) {
  const all = loadAll();
  if (idx < 0 || idx >= all.length) return false;
  all.splice(idx, 1);
  saveAll(all);
  return true;
}

module.exports = { loadAll, saveAll, add, update, remove, refresh, isOnline, STORE_PATH };
