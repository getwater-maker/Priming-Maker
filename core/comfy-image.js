'use strict';
/**
 * core/comfy-image.js — ComfyUI(HTTP API)로 텍스트→이미지 1장. z-image 등 워크플로 사용.
 *
 * 브라우저 없이 REST API 만 사용 → 로컬(127.0.0.1:8188)이든 comfy.org 클라우드든 설정만 바꾸면 동작.
 *   로컬:    baseUrl=http://127.0.0.1:8188, 키 없음. /prompt·/history·/view.
 *   클라우드: cloud=true → baseUrl=https://cloud.comfy.org, 경로에 /api 접두 + X-API-Key 헤더,
 *            폴링 /api/job/{id}/status → /api/jobs/{id}. (Standard+ 구독 필요)
 *
 * 워크플로는 ComfyUI 에서 "저장(API 포맷)" 한 JSON 을 workflowPath 로 지정.
 *   앱이 그 그래프에 프롬프트(첫 CLIPTextEncode.text 또는 promptNodeId)·해상도(latent width/height)·seed 를 주입.
 * (proven 코드 — 구 comfy-engine.js 의 이미지 경로를 이식·집중화)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_PATH = path.join(os.homedir(), '.priming-maker', 'comfy-image-config.json');
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  cloud: false,
  apiKey: '',
  workflowPath: '',        // 현재 활성 워크플로 "저장(API 포맷)" JSON 경로 (필수)
  workflows: [],           // 저장된 워크플로 목록 [{name, path}] — 드롭다운으로 전환(z-image/Krea2 등)
  promptNodeId: '',        // 빈값=CLIPTextEncode(계열) 또는 text 입력 노드 자동탐지
  widthNodeId: '',         // 빈값=width·height 가진 latent 노드 자동탐지
  heightNodeId: '',
  sendDims: true,          // 프로젝트 비율에 맞춰 해상도 주입(끄면 워크플로 기본 해상도 사용)
  timeoutSec: 300,
  servers: [],             // 저장된 서버 프로필 [{name, baseUrl, cloud, apiKey}] — 드롭다운으로 전환(comfy.org/RunPod 등)
  activeServer: '',        // 현재 선택된 서버 프로필 이름(표시용)
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

class ComfyImage {
  constructor(cfg = {}, logger = () => {}) {
    this.cloud = !!cfg.cloud;
    this.apiKey = cfg.apiKey || '';
    let base = String(cfg.baseUrl || 'http://127.0.0.1:8188').trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base;   // 스킴 없이 입력해도 동작
    base = base.replace(/(:\d+)(?::\d+)+$/, '$1');                      // "host:8188:8188" 같은 포트 중복 오타 보정
    // 클라우드 체크 시엔 주소칸(로컬/LAN IP 등)과 무관하게 항상 comfy.org 로. (LAN IP+클라우드 혼합 오설정 방지)
    if (this.cloud && !/cloud\.comfy\.org/i.test(base)) base = 'https://cloud.comfy.org';
    this.baseUrl = base;
    this.workflowPath = cfg.workflowPath || '';
    this.promptNodeId = cfg.promptNodeId || '';
    this.widthNodeId = cfg.widthNodeId || '';
    this.heightNodeId = cfg.heightNodeId || '';
    this.sendDims = cfg.sendDims !== false;
    this.timeoutSec = Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 300;
    this.clientId = 'priming_' + Math.random().toString(36).slice(2, 10);
    this.log = logger;
  }
  _url(p) { return this.baseUrl + (this.cloud ? '/api' : '') + p; }
  _headers(extra = {}) { const h = { ...extra }; if (this.cloud && this.apiKey) h['X-API-Key'] = this.apiKey; return h; }
  async health() {
    if (this.cloud) { if (!this.apiKey) { this.log('[Comfy] ⚠ 클라우드 모드인데 API 키가 비었습니다.'); return false; } return true; }
    try { const r = await fetch(this._url('/system_stats'), { method: 'GET' }); return r.ok; } catch { return false; }
  }
  // 로컬 ComfyUI 상주 모델 언로드 + VRAM 해제(12GB OOM 방지 — 예: 비디오 Wan→이미지 전환). 클라우드는 불필요.
  async freeMemory() {
    if (this.cloud) return;
    try { await fetch(this._url('/free'), { method: 'POST', headers: this._headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ unload_models: true, free_memory: true }) }); } catch {}
  }
  _scanImage(outputs) {
    outputs = outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const o = outputs[nodeId] || {};
      for (const key of Object.keys(o)) {
        const arr = o[key];
        if (Array.isArray(arr)) { const m = arr.find((x) => x && /\.(png|jpe?g|webp)$/i.test(x.filename || '')); if (m) return m; }
      }
    }
    return null;
  }
  _extractOutputs(j) {
    if (!j || typeof j !== 'object') return {};
    if (j.outputs) return j.outputs;
    if (j.job && j.job.outputs) return j.job.outputs;
    if (j.result && j.result.outputs) return j.result.outputs;
    for (const k of Object.keys(j)) { if (j[k] && j[k].outputs) return j[k].outputs; }
    return j;
  }
  _dims(aspect) {
    if (aspect === '16:9') return { w: 1344, h: 768 };
    if (aspect === '1:1') return { w: 1024, h: 1024 };
    return { w: 768, h: 1344 }; // 9:16
  }
  _buildWorkflow(positive, aspect) {
    let wf = JSON.parse(fs.readFileSync(this.workflowPath, 'utf8'));
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') throw new Error('UI 포맷 워크플로입니다. ComfyUI 에서 "저장(API 포맷)"으로 저장하세요.');
    const graph = JSON.parse(JSON.stringify(wf));
    if (positive) {
      // CLIPTextEncode 계열(FLUX/Krea 포함) 우선 → 없으면 text 문자열 입력 가진 첫 노드(범용 폴백)
      const pId = this.promptNodeId
        || Object.keys(graph).find((id) => /CLIPTextEncode/i.test(graph[id].class_type || '') && 'text' in (graph[id].inputs || {}))
        || Object.keys(graph).find((id) => typeof (graph[id].inputs || {}).text === 'string');
      if (pId && graph[pId] && graph[pId].inputs) graph[pId].inputs.text = String(positive);
    }
    if (this.sendDims) {
      const dim = this._dims(aspect);
      const setNum = (id, keys, val) => { const inp = id && graph[id] && graph[id].inputs; if (!inp) return false; for (const k of keys) { if (k in inp) { inp[k] = val; return true; } } return false; };
      let wSet = setNum(this.widthNodeId, ['value', 'width'], dim.w);
      let hSet = setNum(this.heightNodeId, ['value', 'height'], dim.h);
      if (!wSet || !hSet) {
        for (const id of Object.keys(graph)) {
          const inp = graph[id].inputs || {};
          if (('width' in inp) && ('height' in inp)) { if (!wSet) inp.width = dim.w; if (!hSet) inp.height = dim.h; wSet = hSet = true; break; }
        }
      }
    }
    for (const id of Object.keys(graph)) {
      const inp = graph[id].inputs || {};
      const rnd = Math.floor(Math.random() * 1e15);
      if (typeof inp.seed === 'number') inp.seed = rnd;
      if (typeof inp.noise_seed === 'number') inp.noise_seed = rnd;
    }
    return graph;
  }
  async _queue(graph) {
    const payload = { prompt: graph, client_id: this.clientId };
    if (this.cloud && this.apiKey) payload.extra_data = { api_key_comfy_org: this.apiKey };
    const r = await fetch(this._url('/prompt'), { method: 'POST', headers: this._headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
    if (r.status === 401 || r.status === 403) throw new Error('API 키 인증 실패 (401/403) — 키를 확인하세요.');
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`/prompt 큐 실패 (${r.status}): ${t.slice(0, 300)}`); }
    const j = await r.json();
    if (j.node_errors && Object.keys(j.node_errors).length) throw new Error('워크플로 노드 오류: ' + JSON.stringify(j.node_errors).slice(0, 300));
    return j.prompt_id;
  }
  async _waitCloud(promptId, abortSignal) {
    const deadline = Date.now() + this.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) throw new Error('중단됨');
      await new Promise((res) => setTimeout(res, 2000));
      let st;
      try {
        const r = await fetch(this._url(`/job/${promptId}/status`), { headers: this._headers() });
        if (r.status === 401 || r.status === 403) throw new Error('API 키 인증 실패 (401/403)');
        if (!r.ok) continue; st = await r.json();
      } catch (e) { if (/인증/.test(e.message)) throw e; continue; }
      const status = (st && (st.status || st.state) || '').toLowerCase();
      if (status === 'failed' || status === 'cancelled' || status === 'error') { const d = (st && st.error_message) ? String(st.error_message) : JSON.stringify(st); throw new Error(`클라우드 작업 ${status}: ${d.slice(0, 800)}`); }
      if (status === 'completed' || status === 'success') {
        const r2 = await fetch(this._url(`/jobs/${promptId}`), { headers: this._headers() });
        if (!r2.ok) throw new Error(`작업 상세 조회 실패 (${r2.status})`);
        const j = await r2.json();
        const img = this._scanImage(this._extractOutputs(j));
        if (img) return img;
        throw new Error('출력에서 이미지를 찾지 못했습니다: ' + JSON.stringify(j).slice(0, 300));
      }
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초)`);
  }
  async _waitLocal(promptId, abortSignal) {
    const deadline = Date.now() + this.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this._url('/interrupt'), { method: 'POST', headers: this._headers() }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1000));
      let hist;
      try { const r = await fetch(this._url(`/history/${promptId}`)); if (!r.ok) continue; hist = await r.json(); } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 실행 오류');
      const outputs = entry.outputs || {};
      const img = this._scanImage(outputs);
      if (img) return img;
      if (Object.keys(outputs).length) throw new Error('출력에 이미지가 없습니다 — SaveImage 노드를 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초)`);
  }
  async _download(img, outputPath) {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    const r = await fetch(this._url('/view') + '?' + q.toString(), { headers: this._headers() });
    if (!r.ok) throw new Error(`/view 다운로드 실패 (${r.status})`);
    const ext = (/\.(jpe?g)$/i.test(img.filename) ? 'jpg' : /\.webp$/i.test(img.filename) ? 'webp' : 'png');
    const out = outputPath.replace(/\.(png|jpe?g|webp)$/i, '') + '.' + ext;
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    return out;
  }
  // 텍스트 → 이미지 1장. { success:true, imagePath } | { success:false, error }
  async textToImage({ prompt, aspect, outputPath, abortSignal }) {
    try {
      if (!this.workflowPath || !fs.existsSync(this.workflowPath)) return { success: false, error: '워크플로(API 포맷 JSON)가 지정되지 않았습니다 — ⚙ ComfyUI 에서 지정하세요.' };
      if (!(await this.health())) return { success: false, error: `ComfyUI 연결 실패 (${this.baseUrl})${this.cloud ? ' — API 키/구독 확인' : ''}` };
      const graph = this._buildWorkflow(prompt, aspect);
      const promptId = await this._queue(graph);
      const img = this.cloud ? await this._waitCloud(promptId, abortSignal) : await this._waitLocal(promptId, abortSignal);
      const out = await this._download(img, outputPath);
      return { success: true, imagePath: out };
    } catch (e) { return { success: false, error: e.message }; }
  }
}

module.exports = { ComfyImage, loadConfig, saveConfig, CFG_PATH, DEFAULTS };
