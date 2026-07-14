'use strict';
/**
 * core/comfy-video.js — ComfyUI(HTTP API) 이미지→비디오(i2v). Wan 2.2 5B / LTX 등 워크플로.
 *
 * 흐름: /upload/image 로 그룹 이미지 업로드 → 워크플로 LoadImage.image = 업로드명
 *   (LoadImage 노드가 없으면 하나를 자동 주입해 i2v latent 노드의 start_image 에 연결)
 *   → 프롬프트/길이(length)/해상도/seed 주입 → /prompt 큐 → 폴링 → 비디오(mp4) 다운로드.
 * 로컬(127.0.0.1:8188): /prompt·/history·/view.  클라우드(cloud.comfy.org): /api 접두 + X-API-Key +
 *   extra_data.api_key_comfy_org, 폴링 /api/job/{id}/status → /api/jobs/{id}. (comfy-image.js 와 동일 패턴)
 * 워크플로는 ComfyUI 에서 "저장(API 포맷)" 한 JSON. (구 comfy-engine.js 의 검증된 i2v 로직을 이식)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
function ffmpegPath() { try { return require('./media-utils').getFfmpegPath(); } catch {} try { return require('ffmpeg-static'); } catch { return ''; } }

const CFG_PATH = path.join(os.homedir(), '.priming-maker', 'comfy-video-config.json');
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  cloud: false,
  apiKey: '',
  workflowPath: '',        // 현재 활성 i2v 워크플로 "저장(API 포맷)" JSON 경로
  workflows: [],           // 저장된 워크플로 목록 [{name, path}] — 드롭다운 전환(Wan/LTX 등)
  promptNodeId: '',        // 빈값=Positive CLIPTextEncode 자동탐지
  imageNodeId: '',         // 빈값=LoadImage 자동탐지(없으면 자동 주입)
  fps: 24,                 // 초→프레임 변환용(워크플로 CreateVideo fps 와 맞추기)
  videoMaxSec: 8,          // i2v 최대 길이(초) — 클라우드 GPU 시간/비용 상한. 0=제한없음(TTS 길이 그대로)
  sendDims: true,          // 비율에 맞춰 해상도 주입
  timeoutSec: 600,
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

class ComfyVideo {
  constructor(cfg = {}, logger = () => {}) {
    this.cloud = !!cfg.cloud;
    this.apiKey = cfg.apiKey || '';
    let base = (cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    if (this.cloud && /127\.0\.0\.1|localhost/.test(base)) base = 'https://cloud.comfy.org';
    this.baseUrl = base;
    this.workflowPath = cfg.workflowPath || '';
    this.promptNodeId = cfg.promptNodeId || '';
    this.imageNodeId = cfg.imageNodeId || '';
    this.fps = Number(cfg.fps) > 0 ? Number(cfg.fps) : 24;
    this.videoMaxSec = Number(cfg.videoMaxSec) >= 0 ? Number(cfg.videoMaxSec) : 8;
    this.sendDims = cfg.sendDims !== false;
    this.timeoutSec = Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 600;
    this.clientId = 'priming_' + Math.random().toString(36).slice(2, 10);
    this.log = logger;
  }
  _url(p) { return this.baseUrl + (this.cloud ? '/api' : '') + p; }
  _headers(extra = {}) { const h = { ...extra }; if (this.cloud && this.apiKey) h['X-API-Key'] = this.apiKey; return h; }
  async health() {
    if (this.cloud) { if (!this.apiKey) { this.log('[ComfyVid] ⚠ 클라우드 모드인데 API 키가 비었습니다.'); return false; } return true; }
    try { const r = await fetch(this._url('/system_stats'), { method: 'GET' }); return r.ok; } catch { return false; }
  }
  async _uploadImage(imagePath) {
    const data = fs.readFileSync(imagePath);
    const fd = new FormData();
    fd.append('image', new Blob([data]), path.basename(imagePath));
    fd.append('type', 'input');
    fd.append('overwrite', 'true');
    const r = await fetch(this._url('/upload/image'), { method: 'POST', headers: this._headers(), body: fd });
    if (!r.ok) throw new Error(`이미지 업로드 실패 (${r.status})`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }
  _scanVideo(outputs) {
    outputs = outputs || {};
    const match = (x) => x && (/\.(mp4|webm|mov|mkv)$/i.test(x.filename || '') || /video|mp4|webm/i.test(x.format || ''));
    for (const nodeId of Object.keys(outputs)) {
      const o = outputs[nodeId] || {};
      for (const key of Object.keys(o)) { const arr = o[key]; if (Array.isArray(arr)) { const m = arr.find(match); if (m) return m; } }
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
  _videoDims(aspect) {
    if (aspect === '16:9') return { w: 1280, h: 704 };
    if (aspect === '1:1') return { w: 960, h: 960 };
    return { w: 704, h: 1280 }; // 9:16
  }
  _snap4(frames) { return Math.max(5, 4 * Math.round((frames - 1) / 4) + 1); } // Wan length = 4n+1
  _buildGraph(uploadName, prompt, aspect, durSec) {
    if (!this.workflowPath || !fs.existsSync(this.workflowPath)) throw new Error('워크플로(API 포맷 JSON)가 지정되지 않았습니다 — ⚙ ComfyUI 비디오에서 지정하세요.');
    let wf = JSON.parse(fs.readFileSync(this.workflowPath, 'utf8'));
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') throw new Error('UI 포맷 워크플로입니다. ComfyUI 에서 "저장(API 포맷)"으로 저장하세요.');
    const graph = JSON.parse(JSON.stringify(wf));
    const ids = Object.keys(graph);
    // ── 이미지 주입 (LoadImage) ──
    if (this.imageNodeId && graph[this.imageNodeId]) {
      graph[this.imageNodeId].inputs = graph[this.imageNodeId].inputs || {}; graph[this.imageNodeId].inputs.image = uploadName;
    } else {
      const imgIds = ids.filter((id) => graph[id].class_type === 'LoadImage');
      if (imgIds.length) { for (const id of imgIds) graph[id].inputs.image = uploadName; }
      else {
        // LoadImage 가 없으면 자동 주입 → i2v latent 노드(start_image)에 연결.
        const i2vId = ids.find((id) => /ImageToVideo|I2V|ImageToVideoLatent/i.test(graph[id].class_type || ''));
        if (!i2vId) throw new Error('LoadImage 도 i2v 노드도 못 찾음 — 워크플로에 "Load Image → start_image" 연결 후 API 포맷으로 다시 저장하세요.');
        const newId = String(Math.max(0, ...ids.map(Number).filter((n) => !isNaN(n))) + 1);
        graph[newId] = { inputs: { image: uploadName, upload: 'image' }, class_type: 'LoadImage', _meta: { title: 'LoadImage(auto)' } };
        graph[i2vId].inputs = graph[i2vId].inputs || {}; graph[i2vId].inputs.start_image = [newId, 0];
        this.log('[ComfyVid] LoadImage 노드 자동 주입 → ' + (graph[i2vId].class_type) + '.start_image');
      }
    }
    // ── 프롬프트 주입 (Positive CLIPTextEncode, Negative 회피) ──
    if (prompt) {
      const inject = (n) => { if (!n || !n.inputs) return false; for (const k of ['text', 'prompt', 'positive', 'positive_prompt']) { if (k in n.inputs && typeof n.inputs[k] !== 'object') { n.inputs[k] = String(prompt); return true; } } return false; };
      if (this.promptNodeId && graph[this.promptNodeId]) inject(graph[this.promptNodeId]);
      else {
        const clipIds = ids.filter((id) => graph[id].class_type === 'CLIPTextEncode' && 'text' in (graph[id].inputs || {}));
        const titleOf = (id) => ((graph[id]._meta && graph[id]._meta.title) || '').toLowerCase();
        const isNeg = (id) => /negative|부정/.test(titleOf(id));
        const isPos = (id) => /positive|긍정/.test(titleOf(id));
        const pId = clipIds.find(isPos) || clipIds.filter((id) => !isNeg(id))[0] || clipIds[0];
        if (pId) inject(graph[pId]);
      }
    }
    // ── seed 랜덤(0~2^31-1) ──
    for (const id of ids) {
      const inp = graph[id].inputs || {}; const rnd = Math.floor(Math.random() * 2147483647);
      if (typeof inp.seed === 'number') inp.seed = rnd;
      if (typeof inp.noise_seed === 'number') inp.noise_seed = rnd;
    }
    // ── 해상도(비율) ──
    if (this.sendDims && aspect) {
      const d = this._videoDims(aspect);
      for (const id of ids) { const inp = graph[id].inputs || {}; if (typeof inp.width === 'number' && typeof inp.height === 'number') { inp.width = d.w; inp.height = d.h; break; } }
    }
    // ── 길이(초→프레임 length) ──
    if (durSec) {
      let sec = Math.max(1, Math.ceil(Number(durSec) || 0));
      if (this.videoMaxSec > 0) sec = Math.min(this.videoMaxSec, sec);
      const frames = this._snap4(Math.round(sec * this.fps));
      for (const id of ids) { const inp = graph[id].inputs || {}; if (typeof inp.length === 'number') { inp.length = frames; break; } if (typeof inp.num_frames === 'number') { inp.num_frames = frames; break; } }
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
      await new Promise((res) => setTimeout(res, 2500));
      let st;
      try {
        const r = await fetch(this._url(`/job/${promptId}/status`), { headers: this._headers() });
        if (r.status === 401 || r.status === 403) throw new Error('API 키 인증 실패 (401/403)');
        if (!r.ok) continue; st = await r.json();
      } catch (e) { if (/인증/.test(e.message)) throw e; continue; }
      const status = (st && (st.status || st.state) || '').toLowerCase();
      if (status === 'failed' || status === 'cancelled' || status === 'error') { const d = (st && st.error_message) ? String(st.error_message) : JSON.stringify(st); throw new Error(`클라우드 작업 ${status}: ${d.slice(0, 1000)}`); }
      if (status === 'completed' || status === 'success') {
        const r2 = await fetch(this._url(`/jobs/${promptId}`), { headers: this._headers() });
        if (!r2.ok) throw new Error(`작업 상세 조회 실패 (${r2.status})`);
        const vid = this._scanVideo(this._extractOutputs(await r2.json()));
        if (vid) return vid;
        throw new Error('출력에서 비디오를 찾지 못했습니다 — SaveVideo/VHS_VideoCombine 출력을 확인하세요.');
      }
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초)`);
  }
  async _waitLocal(promptId, abortSignal) {
    const deadline = Date.now() + this.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this._url('/interrupt'), { method: 'POST', headers: this._headers() }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1500));
      let hist;
      try { const r = await fetch(this._url(`/history/${promptId}`)); if (!r.ok) continue; hist = await r.json(); } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 실행 오류 (history status=error)');
      const outputs = entry.outputs || {};
      const vid = this._scanVideo(outputs);
      if (vid) return vid;
      if (Object.keys(outputs).length) throw new Error('출력에 비디오가 없습니다 — SaveVideo 노드를 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초)`);
  }
  async _download(vid, outputPath) {
    const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' });
    const r = await fetch(this._url('/view') + '?' + q.toString(), { headers: this._headers() });
    if (!r.ok) throw new Error(`/view 다운로드 실패 (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (/\.mp4$/i.test(vid.filename)) { fs.writeFileSync(outputPath, buf); return outputPath; }
    // webm/mov → mp4 재인코딩
    const tmp = outputPath.replace(/\.mp4$/i, '') + (path.extname(vid.filename) || '.webm');
    fs.writeFileSync(tmp, buf);
    const ff = ffmpegPath();
    if (ff && fs.existsSync(ff)) {
      const rr = spawnSync(ff, ['-y', '-i', tmp, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath], { stdio: 'ignore' });
      try { fs.unlinkSync(tmp); } catch {}
      if (rr.status === 0 && fs.existsSync(outputPath)) return outputPath;
      throw new Error('ffmpeg mp4 변환 실패');
    }
    return tmp;
  }
  // 이미지 → 비디오 1개. { success, videoPath } | { success:false, error }
  async imageToVideo({ imagePath, prompt, aspect, durationSec, outputPath, abortSignal }) {
    try {
      if (!(await this.health())) return { success: false, error: `ComfyUI 연결 실패 (${this.baseUrl})${this.cloud ? ' — API 키/구독 확인' : ''}` };
      const uploadName = await this._uploadImage(imagePath);
      const graph = this._buildGraph(uploadName, prompt, aspect, durationSec);
      const promptId = await this._queue(graph);
      const vid = this.cloud ? await this._waitCloud(promptId, abortSignal) : await this._waitLocal(promptId, abortSignal);
      const out = await this._download(vid, outputPath);
      return { success: true, videoPath: out };
    } catch (e) { return { success: false, error: e.message }; }
  }
}

module.exports = { ComfyVideo, loadConfig, saveConfig, CFG_PATH, DEFAULTS };
