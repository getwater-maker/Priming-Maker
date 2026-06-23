'use strict';

/**
 * comfy-engine.js — ComfyUI(HTTP API)로 이미지→비디오(i2v). LTX-Video 등 워크플로 사용.
 *
 * 브라우저 자동화 없이 ComfyUI REST API 만 사용 → 로컬 PC(127.0.0.1:8188)든 RunPod든
 * baseUrl 만 바꾸면 동일 동작.
 *
 * 흐름:
 *   1. /upload/image  로 그룹 이미지를 ComfyUI input 으로 업로드 → 파일명 획득
 *   2. 사용자가 저장한 워크플로(API 포맷 JSON)를 로드 → LoadImage 노드.image = 업로드 파일명,
 *      프롬프트 노드.text = 영상 프롬프트, (있으면) 샘플러 seed 랜덤화
 *   3. POST /prompt 로 큐 등록 → prompt_id
 *   4. /history/{prompt_id} 폴링 → 완료 시 출력 노드의 비디오 파일명
 *   5. /view 로 다운로드 → outputPath(.mp4). webm 등이면 ffmpeg 로 mp4 변환
 *
 * 설정(core/comfy-config.js):
 *   baseUrl       ComfyUI 주소 (기본 http://127.0.0.1:8188)
 *   workflowPath  API 포맷 워크플로 JSON 경로 (ComfyUI '저장(API 포맷)')
 *   imageNodeId   LoadImage 노드 id (빈값=class_type 'LoadImage' 자동탐지)
 *   promptNodeId  긍정 프롬프트 노드 id (빈값='CLIPTextEncode' 첫 노드 자동탐지)
 *   timeoutSec    한 영상 최대 대기 (기본 600)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let _ffmpegPath = null;
try {
  _ffmpegPath = require('ffmpeg-static');
  if (_ffmpegPath && _ffmpegPath.includes('app.asar') && !_ffmpegPath.includes('app.asar.unpacked')) {
    _ffmpegPath = _ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch {}

class ComfyEngine {
  constructor(cfg = {}, logger = () => {}) {
    this.baseUrl = (cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    this.workflowPath = cfg.workflowPath || '';
    this.imageNodeId = cfg.imageNodeId || '';
    this.promptNodeId = cfg.promptNodeId || '';
    this.timeoutSec = Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 600;
    // SDXL 이미지(t2i) 설정
    this.imageCheckpoint = cfg.imageCheckpoint || 'dreamshaperXL_sfwLightningDPMSDE.safetensors';
    this.imageSteps = Number(cfg.imageSteps) > 0 ? Number(cfg.imageSteps) : 8;
    this.imageCfg = Number(cfg.imageCfg) > 0 ? Number(cfg.imageCfg) : 2.0;
    this.imageSampler = cfg.imageSampler || 'dpmpp_sde';
    this.imageScheduler = cfg.imageScheduler || 'karras';
    this.imageNegative = cfg.imageNegative || '';
    this.imageTimeoutSec = Number(cfg.imageTimeoutSec) > 0 ? Number(cfg.imageTimeoutSec) : 180;
    this.imageWorkflowPath = cfg.imageWorkflowPath || '';
    this.imagePromptNodeId = cfg.imagePromptNodeId || '';
    this.videoWidthNodeId = cfg.videoWidthNodeId || '';   // i2v 해상도 노드(빈값=title 자동탐지)
    this.videoHeightNodeId = cfg.videoHeightNodeId || '';
    this.videoDurationNodeId = cfg.videoDurationNodeId || ''; // i2v 길이(초) 노드
    this.videoMaxSec = Number(cfg.videoMaxSec) > 0 ? Number(cfg.videoMaxSec) : 0; // 0 = 캡 없음(그룹 TTS 길이 그대로)
    this.videoFps = Number(cfg.videoFps) > 0 ? Number(cfg.videoFps) : 0; // 0=초 모드(LTX), >0=프레임 모드(Wan)
    this.clientId = 'priming_' + Math.random().toString(36).slice(2, 10);
    this.log = logger;
  }

  // 서버 헬스 체크 — /system_stats
  async health() {
    try {
      const r = await fetch(this.baseUrl + '/system_stats', { method: 'GET' });
      return r.ok;
    } catch { return false; }
  }

  // 이미지 업로드 → ComfyUI input 파일명
  async _uploadImage(imagePath) {
    const data = fs.readFileSync(imagePath);
    const fd = new FormData();
    fd.append('image', new Blob([data]), path.basename(imagePath));
    fd.append('type', 'input');
    fd.append('overwrite', 'true');
    const r = await fetch(this.baseUrl + '/upload/image', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`이미지 업로드 실패 (${r.status})`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  // 워크플로 로드 + 이미지/프롬프트/seed 주입
  // i2v 출력 비율 — LTX 워크플로의 width/height(PrimitiveInt) 노드를 비율에 맞게 설정.
  //   (워크플로가 720×1280 등으로 고정돼 있으면 그대로면 항상 9:16 이 나오므로 덮어씀)
  _videoDims(aspect) {
    if (aspect === '16:9') return { w: 1280, h: 720 };
    if (aspect === '1:1') return { w: 960, h: 960 };
    return { w: 720, h: 1280 }; // 9:16 기본
  }
  _setVideoDims(graph, aspect) {
    const d = this._videoDims(aspect);
    const setVal = (id, v) => { if (id && graph[id] && graph[id].inputs && 'value' in graph[id].inputs) { graph[id].inputs.value = v; return true; } return false; };
    let wDone = setVal(this.videoWidthNodeId, d.w);
    let hDone = setVal(this.videoHeightNodeId, d.h);
    if (wDone && hDone) return;
    // 자동 탐지 — value 를 가진 노드 중 _meta.title 이 width/height 인 것.
    for (const id of Object.keys(graph)) {
      const n = graph[id];
      if (!n.inputs || typeof n.inputs.value !== 'number') continue;
      const t = ((n._meta && n._meta.title) || '').toLowerCase();
      if (!wDone && /width/.test(t)) { n.inputs.value = d.w; wDone = true; }
      else if (!hDone && /height/.test(t)) { n.inputs.value = d.h; hDone = true; }
    }
  }
  // i2v 길이 — 그룹 TTS 재생시간으로 설정. 초 모드(LTX)면 초, 프레임 모드(Wan, videoFps>0)면 프레임(4n+1).
  //   길이 노드의 value/length/num_frames/frames 중 있는 필드(리터럴)에 기록. videoMaxSec>0 일 때만 상한.
  _setVideoDuration(graph, durSec) {
    const ceil = Math.max(1, Math.ceil(Number(durSec) || 0));
    const sec = this.videoMaxSec > 0 ? Math.min(this.videoMaxSec, ceil) : ceil;
    let target = sec; // 초 모드(LTX)
    if (this.videoFps > 0) { // 프레임 모드(Wan): frames = sec×fps → 4n+1 보정
      let f = Math.round(sec * this.videoFps);
      target = Math.max(5, Math.round((f - 1) / 4) * 4 + 1);
    }
    const FIELDS = ['value', 'length', 'num_frames', 'frames', 'frame_count', 'video_frames'];
    const setOn = (n) => { if (!n || !n.inputs) return false; for (const f of FIELDS) { if (f in n.inputs && typeof n.inputs[f] !== 'object') { n.inputs[f] = target; return true; } } return false; };
    if (this.videoDurationNodeId && graph[this.videoDurationNodeId] && setOn(graph[this.videoDurationNodeId])) return target;
    for (const id of Object.keys(graph)) {
      const n = graph[id]; if (!n.inputs) continue;
      const t = ((n._meta && n._meta.title) || '').toLowerCase();
      if (/duration|length|frames|프레임|길이/.test(t) && setOn(n)) return target;
    }
    return target;
  }
  _buildGraph(uploadName, prompt, aspect, durSec) {
    if (!this.workflowPath || !fs.existsSync(this.workflowPath)) {
      throw new Error('워크플로(API 포맷 JSON) 경로가 설정되지 않았습니다 — ⚙ ComfyUI 설정에서 지정하세요.');
    }
    let wf = JSON.parse(fs.readFileSync(this.workflowPath, 'utf8'));
    // 일부 사용자는 UI 포맷(노드 배열)을 저장 → API 포맷(노드 맵)만 지원
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') {
      throw new Error('UI 포맷 워크플로입니다. ComfyUI 에서 "저장(API 포맷)"으로 다시 저장하세요.');
    }
    const graph = JSON.parse(JSON.stringify(wf)); // 깊은 복사

    // 이미지 노드 (LoadImage) — imageNodeId 지정 시 그 노드만, 없으면 모든 LoadImage 에 동일 이미지.
    //   (FLF2V 처럼 첫/끝 프레임 2개면 둘 다 그룹 이미지로 → 같은 프레임 기준 i2v)
    if (this.imageNodeId) {
      if (!graph[this.imageNodeId]) throw new Error(`imageNodeId(${this.imageNodeId}) 노드가 없습니다.`);
      graph[this.imageNodeId].inputs.image = uploadName;
    } else {
      const imgIds = Object.keys(graph).filter((id) => graph[id].class_type === 'LoadImage');
      if (!imgIds.length) throw new Error('LoadImage 노드를 찾지 못했습니다 (imageNodeId 설정 필요).');
      for (const id of imgIds) graph[id].inputs.image = uploadName;
    }

    // 프롬프트 노드 (CLIPTextEncode 첫 번째 = 긍정) — 있으면 주입
    if (prompt) {
      const pId = this.promptNodeId || Object.keys(graph).find((id) => graph[id].class_type === 'CLIPTextEncode' && 'text' in (graph[id].inputs || {}));
      if (pId && graph[pId] && graph[pId].inputs && 'text' in graph[pId].inputs) graph[pId].inputs.text = String(prompt);
    }

    // seed 랜덤화 — KSampler 류 (seed / noise_seed)
    for (const id of Object.keys(graph)) {
      const inp = graph[id].inputs || {};
      const rnd = Math.floor(Math.random() * 1e15);
      if (typeof inp.seed === 'number') inp.seed = rnd;
      if (typeof inp.noise_seed === 'number') inp.noise_seed = rnd;
    }
    // 출력 영상 비율을 프로젝트 비율에 맞춤 (워크플로 고정 해상도 덮어쓰기)
    if (aspect) this._setVideoDims(graph, aspect);
    // 영상 길이를 그룹 음성 길이에 맞춤 (캡 적용)
    if (durSec) this._setVideoDuration(graph, durSec);
    return graph;
  }

  async _queue(graph) {
    const r = await fetch(this.baseUrl + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`/prompt 큐 실패 (${r.status}): ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    if (j.node_errors && Object.keys(j.node_errors).length) {
      throw new Error('워크플로 노드 오류: ' + JSON.stringify(j.node_errors).slice(0, 300));
    }
    return j.prompt_id;
  }

  // history 폴링 → 출력 비디오 {filename, subfolder, type}
  async _waitVideo(promptId, abortSignal) {
    const deadline = Date.now() + this.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this.baseUrl + '/interrupt', { method: 'POST' }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1500));
      let hist;
      try {
        const r = await fetch(this.baseUrl + `/history/${promptId}`);
        if (!r.ok) continue;
        hist = await r.json();
      } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      const status = entry.status && entry.status.status_str;
      if (status === 'error') throw new Error('ComfyUI 실행 오류 (history status=error)');
      const outputs = entry.outputs || {};
      // SaveVideo / VHS_VideoCombine / CreateVideo 등 — 출력 객체의 모든 배열을 훑어 비디오 파일을 찾음.
      for (const nodeId of Object.keys(outputs)) {
        const o = outputs[nodeId] || {};
        for (const key of Object.keys(o)) {
          const arr = o[key];
          if (Array.isArray(arr)) {
            const vid = arr.find((x) => x && (/\.(mp4|webm|mov|mkv)$/i.test(x.filename || '') || /video|mp4|webm/i.test(x.format || '')));
            if (vid) return vid;
          }
        }
      }
      // outputs 있는데 비디오가 없으면 완료됐지만 비디오 출력이 없는 것
      if (Object.keys(outputs).length) throw new Error('출력에 비디오 파일이 없습니다 — SaveVideo/VHS_VideoCombine 출력 노드와 mp4 저장을 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초) — ComfyUI 생성이 끝나지 않음`);
  }

  async _download(vid, outputPath) {
    const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' });
    const r = await fetch(this.baseUrl + '/view?' + q.toString());
    if (!r.ok) throw new Error(`/view 다운로드 실패 (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    const isMp4 = /\.mp4$/i.test(vid.filename);
    if (isMp4) { fs.writeFileSync(outputPath, buf); return outputPath; }
    // webm/mov 등 → ffmpeg 로 mp4 변환
    const tmp = outputPath.replace(/\.mp4$/i, '') + path.extname(vid.filename || '.webm');
    fs.writeFileSync(tmp, buf);
    if (_ffmpegPath && fs.existsSync(_ffmpegPath)) {
      const rr = spawnSync(_ffmpegPath, ['-y', '-i', tmp, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath], { stdio: 'ignore' });
      try { fs.unlinkSync(tmp); } catch {}
      if (rr.status === 0 && fs.existsSync(outputPath)) return outputPath;
      throw new Error('ffmpeg mp4 변환 실패');
    }
    // ffmpeg 없으면 원본 확장자 그대로 (Vrew 호환 안 될 수 있음)
    return tmp;
  }

  // ── SDXL 텍스트→이미지(t2i) ──────────────────────────────
  // 비율별 native(SDXL 1MP) + 업스케일 목표.
  _imageDims(aspect) {
    if (aspect === '16:9') return { w: 1344, h: 768, uw: 1920, uh: 1080 };
    if (aspect === '1:1') return { w: 1024, h: 1024, uw: 1080, uh: 1080 };
    return { w: 768, h: 1344, uw: 1080, uh: 1920 }; // 9:16 기본
  }
  // 내장 SDXL 그래프(API 포맷) — native 생성 → lanczos 업스케일 → 저장.
  _buildSdxlGraph({ positive, negative, w, h, uw, uh }) {
    const seed = Math.floor(Math.random() * 1e15);
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: this.imageCheckpoint } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: String(positive || ''), clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: String(negative || ''), clip: ['4', 1] } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      '3': { class_type: 'KSampler', inputs: { seed, steps: this.imageSteps, cfg: this.imageCfg, sampler_name: this.imageSampler, scheduler: this.imageScheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '10': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: uw, height: uh, crop: 'disabled', image: ['8', 0] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'priming', images: ['10', 0] } },
    };
  }
  // 커스텀 t2i 워크플로 로드 + 프롬프트/seed 주입.
  _buildImageWorkflow(positive) {
    let wf = JSON.parse(fs.readFileSync(this.imageWorkflowPath, 'utf8'));
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') throw new Error('UI 포맷 워크플로입니다. "저장(API 포맷)"으로 저장하세요.');
    const graph = JSON.parse(JSON.stringify(wf));
    if (positive) {
      const pId = this.imagePromptNodeId || Object.keys(graph).find((id) => graph[id].class_type === 'CLIPTextEncode' && 'text' in (graph[id].inputs || {}));
      if (pId && graph[pId] && graph[pId].inputs) graph[pId].inputs.text = String(positive);
    }
    for (const id of Object.keys(graph)) {
      const inp = graph[id].inputs || {};
      const rnd = Math.floor(Math.random() * 1e15);
      if (typeof inp.seed === 'number') inp.seed = rnd;
      if (typeof inp.noise_seed === 'number') inp.noise_seed = rnd;
    }
    return graph;
  }
  // history → 출력 이미지 {filename, subfolder, type}
  async _waitImage(promptId, abortSignal) {
    const deadline = Date.now() + this.imageTimeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this.baseUrl + '/interrupt', { method: 'POST' }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1000));
      let hist;
      try { const r = await fetch(this.baseUrl + `/history/${promptId}`); if (!r.ok) continue; hist = await r.json(); } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 실행 오류');
      const outputs = entry.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const o = outputs[nodeId] || {};
        for (const key of Object.keys(o)) {
          const arr = o[key];
          if (Array.isArray(arr)) {
            const img = arr.find((x) => x && /\.(png|jpe?g|webp)$/i.test(x.filename || ''));
            if (img) return img;
          }
        }
      }
      if (Object.keys(outputs).length) throw new Error('출력에 이미지가 없습니다 — SaveImage 노드를 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.imageTimeoutSec}초)`);
  }
  async _downloadImage(img, outputPath) {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    const r = await fetch(this.baseUrl + '/view?' + q.toString());
    if (!r.ok) throw new Error(`/view 다운로드 실패 (${r.status})`);
    fs.writeFileSync(outputPath, Buffer.from(await r.arrayBuffer()));
    return outputPath;
  }
  /**
   * 텍스트 → 이미지 1장. 성공 시 { success:true, imagePath }.
   */
  async textToImage({ prompt, negative, aspect, outputPath, abortSignal }) {
    try {
      if (!(await this.health())) return { success: false, error: `ComfyUI 연결 실패 (${this.baseUrl})` };
      let graph;
      if (this.imageWorkflowPath && fs.existsSync(this.imageWorkflowPath)) {
        graph = this._buildImageWorkflow(prompt);
      } else {
        const d = this._imageDims(aspect);
        graph = this._buildSdxlGraph({ positive: prompt, negative: negative || this.imageNegative, w: d.w, h: d.h, uw: d.uw, uh: d.uh });
      }
      const promptId = await this._queue(graph);
      const img = await this._waitImage(promptId, abortSignal);
      const out = await this._downloadImage(img, outputPath);
      return { success: true, imagePath: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 이미지 1장 → 비디오. 성공 시 { success:true, videoPath }.
   */
  async imageToVideo({ imagePath, prompt, outputPath, abortSignal, aspect, durationSec }) {
    if (!imagePath || !fs.existsSync(imagePath)) return { success: false, error: '이미지 없음' };
    try {
      if (!(await this.health())) return { success: false, error: `ComfyUI 연결 실패 (${this.baseUrl}) — 실행 여부/주소 확인` };
      const uploadName = await this._uploadImage(imagePath);
      const wantSec = durationSec ? (this.videoMaxSec > 0 ? Math.min(this.videoMaxSec, Math.max(1, Math.ceil(durationSec))) : Math.max(1, Math.ceil(durationSec))) : null;
      this.log(`[Comfy] 업로드: ${uploadName} → 큐 등록 (${aspect || '9:16'}${wantSec ? `, ${wantSec}초` : ''})…`);
      const graph = this._buildGraph(uploadName, prompt, aspect, durationSec);
      const promptId = await this._queue(graph);
      this.log(`[Comfy] prompt_id=${promptId} 생성 대기…`);
      const vid = await this._waitVideo(promptId, abortSignal);
      const out = await this._download(vid, outputPath);
      this.log(`[Comfy] 완료 → ${path.basename(out)}`);
      return { success: true, videoPath: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = { ComfyEngine };
