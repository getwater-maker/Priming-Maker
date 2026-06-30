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
    this.cloud = !!cfg.cloud;            // ComfyUI 클라우드(comfy.org) 모드
    this.apiKey = cfg.apiKey || '';      // X-API-Key (클라우드 전용)
    // 클라우드인데 baseUrl 이 로컬(127.0.0.1)로 남아있으면 공식 호스트로 보정
    let base = (cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    if (this.cloud && /127\.0\.0\.1|localhost/.test(base)) base = 'https://cloud.comfy.org';
    this.baseUrl = base;
    this.workflowPath = cfg.workflowPath || '';
    this.imageNodeId = cfg.imageNodeId || '';
    this.promptNodeId = cfg.promptNodeId || '';
    this.timeoutSec = Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 600;
    // 이미지(t2i) — 커스텀 워크플로(Krea2 등) 전용. imageWorkflowPath 필수.
    this.imageTimeoutSec = Number(cfg.imageTimeoutSec) > 0 ? Number(cfg.imageTimeoutSec) : 180;
    this.imageWorkflowPath = cfg.imageWorkflowPath || '';
    this.imagePromptNodeId = cfg.imagePromptNodeId || '';
    this.imageWidthNodeId = cfg.imageWidthNodeId || '';   // 커스텀 이미지 워크플로 해상도 노드(빈값=자동탐지)
    this.imageHeightNodeId = cfg.imageHeightNodeId || '';
    this.videoWidthNodeId = cfg.videoWidthNodeId || '';   // i2v 해상도 노드(빈값=title 자동탐지)
    this.videoHeightNodeId = cfg.videoHeightNodeId || '';
    this.videoDurationNodeId = cfg.videoDurationNodeId || ''; // i2v 길이(초) 노드
    this.videoMaxSec = Number(cfg.videoMaxSec) > 0 ? Number(cfg.videoMaxSec) : 0; // 0 = 캡 없음(그룹 TTS 길이 그대로)
    // 오디오(t2a) — ACE-Step 음악. '플리' 모드 전용. audioWorkflowPath 필수.
    this.audioWorkflowPath = cfg.audioWorkflowPath || '';
    this.audioTagsNodeId = cfg.audioTagsNodeId || '';
    this.audioLyricsNodeId = cfg.audioLyricsNodeId || '';
    this.audioDurationNodeId = cfg.audioDurationNodeId || '';
    this.audioTimeoutSec = Number(cfg.audioTimeoutSec) > 0 ? Number(cfg.audioTimeoutSec) : 600;
    this.audioTrimSilence = cfg.audioTrimSilence !== false; // 기본 ON — 생성 후 앞/뒤 무음 트림
    this.clientId = 'priming_' + Math.random().toString(36).slice(2, 10);
    this.log = logger;
  }

  // 경로 빌더 — 클라우드면 /api 접두. 로컬은 그대로.
  _url(p) { return this.baseUrl + (this.cloud ? '/api' : '') + p; }
  // 헤더 빌더 — 클라우드면 X-API-Key 부착. (FormData 업로드 시 Content-Type 은 fetch 가 자동 설정하도록 비움)
  _headers(extra = {}) {
    const h = { ...extra };
    if (this.cloud && this.apiKey) h['X-API-Key'] = this.apiKey;
    return h;
  }

  // 서버 헬스 체크 — 로컬: /system_stats, 클라우드: API 키 존재 확인(실제 인증오류는 /prompt 응답에서 표면화)
  async health() {
    if (this.cloud) {
      if (!this.apiKey) { this.log('[Comfy] ⚠ 클라우드 모드인데 API 키가 비어 있습니다 (⚙ ComfyUI 설정).'); return false; }
      return true;
    }
    try {
      const r = await fetch(this._url('/system_stats'), { method: 'GET' });
      return r.ok;
    } catch { return false; }
  }

  // 출력 객체(노드맵)에서 비디오/이미지/오디오 파일 1개 추출 — 로컬/클라우드 공용.
  //   kind: 'audio' = 오디오(mp3/flac/wav/...) / truthy = 비디오 / falsy = 이미지 (기존 boolean 호환)
  _scanMedia(outputs, kind) {
    outputs = outputs || {};
    const match = (x) => {
      if (!x) return false;
      if (kind === 'audio') return /\.(mp3|flac|wav|ogg|opus|m4a)$/i.test(x.filename || '') || /audio|flac|mp3|wav/i.test(x.format || '');
      if (kind) return /\.(mp4|webm|mov|mkv)$/i.test(x.filename || '') || /video|mp4|webm/i.test(x.format || '');
      return /\.(png|jpe?g|webp)$/i.test(x.filename || '');
    };
    for (const nodeId of Object.keys(outputs)) {
      const o = outputs[nodeId] || {};
      for (const key of Object.keys(o)) {
        const arr = o[key];
        if (Array.isArray(arr)) { const m = arr.find(match); if (m) return m; }
      }
    }
    return null;
  }

  // 클라우드 응답에서 outputs 노드맵 위치 추출 (구조 변동 대비 여러 위치 탐색).
  _extractOutputs(j) {
    if (!j || typeof j !== 'object') return {};
    if (j.outputs) return j.outputs;
    if (j.job && j.job.outputs) return j.job.outputs;
    if (j.result && j.result.outputs) return j.result.outputs;
    // history 형태({prompt_id:{outputs}}) 가능성
    for (const k of Object.keys(j)) { if (j[k] && j[k].outputs) return j[k].outputs; }
    return j; // 최후: 통째로 스캔
  }

  // 클라우드 폴링 — /api/job/{id}/status 로 상태 확인 → completed 시 /api/jobs/{id} 에서 outputs.
  async _waitCloud(promptId, abortSignal, timeoutSec, kind) {
    const kindLabel = kind === 'audio' ? '오디오' : kind ? '비디오' : '이미지';
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) throw new Error('중단됨');
      await new Promise((res) => setTimeout(res, 2000));
      let st;
      try {
        const r = await fetch(this._url(`/job/${promptId}/status`), { headers: this._headers() });
        if (r.status === 401 || r.status === 403) throw new Error('API 키 인증 실패 (401/403) — 키를 확인하세요.');
        if (!r.ok) continue;
        st = await r.json();
      } catch (e) { if (/인증/.test(e.message)) throw e; continue; }
      const status = (st && (st.status || st.state) || '').toLowerCase();
      if (status === 'failed' || status === 'cancelled' || status === 'error') {
        throw new Error(`클라우드 작업 ${status}: ${JSON.stringify(st).slice(0, 200)}`);
      }
      if (status === 'completed' || status === 'success') {
        const r2 = await fetch(this._url(`/jobs/${promptId}`), { headers: this._headers() });
        if (!r2.ok) throw new Error(`작업 상세 조회 실패 (${r2.status})`);
        const j = await r2.json();
        const media = this._scanMedia(this._extractOutputs(j), kind);
        if (media) return media;
        throw new Error(`출력에서 ${kindLabel}를 찾지 못했습니다 — 응답: ${JSON.stringify(j).slice(0, 300)}`);
      }
    }
    throw new Error(`타임아웃 (${timeoutSec}초) — 클라우드 생성이 끝나지 않음`);
  }

  // 이미지 업로드 → ComfyUI input 파일명
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

  // 워크플로 로드 + 이미지/프롬프트/seed 주입
  // i2v 출력 비율·해상도 — LTX 워크플로의 width/height(PrimitiveInt) 노드에 주입.
  //   저해상(≈480p)으로 생성 → 이후 Real-ESRGAN 으로 1080p 업스케일(maybeUpscale, 로컬 자동).
  //   클라우드면 낮은 해상도 = 크레딧·시간 절약. 32의 배수(LTX 요건) 유지.
  _videoDims(aspect) {
    if (aspect === '16:9') return { w: 832, h: 480 };
    if (aspect === '1:1') return { w: 640, h: 640 };
    return { w: 480, h: 832 }; // 9:16 기본
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
  // i2v 길이(LTX 초 단위) — 그룹 TTS 재생시간으로 설정. videoMaxSec>0 일 때만 상한.
  //   길이 노드의 value/length 등 있는 필드(리터럴)에 기록.
  _setVideoDuration(graph, durSec) {
    const ceil = Math.max(1, Math.ceil(Number(durSec) || 0));
    const sec = this.videoMaxSec > 0 ? Math.min(this.videoMaxSec, ceil) : ceil;
    const target = sec;
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
    const r = await fetch(this._url('/prompt'), {
      method: 'POST', headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (r.status === 401 || r.status === 403) throw new Error('API 키 인증 실패 (401/403) — ⚙ ComfyUI 설정의 키를 확인하세요.');
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
    if (this.cloud) return this._waitCloud(promptId, abortSignal, this.timeoutSec, true);
    const deadline = Date.now() + this.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this._url('/interrupt'), { method: 'POST', headers: this._headers() }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1500));
      let hist;
      try {
        const r = await fetch(this._url(`/history/${promptId}`));
        if (!r.ok) continue;
        hist = await r.json();
      } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      const status = entry.status && entry.status.status_str;
      if (status === 'error') throw new Error('ComfyUI 실행 오류 (history status=error)');
      const outputs = entry.outputs || {};
      // SaveVideo / VHS_VideoCombine / CreateVideo 등 — 출력 객체의 모든 배열을 훑어 비디오 파일을 찾음.
      const vid = this._scanMedia(outputs, true);
      if (vid) return vid;
      // outputs 있는데 비디오가 없으면 완료됐지만 비디오 출력이 없는 것
      if (Object.keys(outputs).length) throw new Error('출력에 비디오 파일이 없습니다 — SaveVideo/VHS_VideoCombine 출력 노드와 mp4 저장을 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.timeoutSec}초) — ComfyUI 생성이 끝나지 않음`);
  }

  async _download(vid, outputPath) {
    const q = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' });
    // 클라우드 /api/view 는 서명 URL 로 302 리다이렉트 → fetch 가 자동 추적.
    const r = await fetch(this._url('/view') + '?' + q.toString(), { headers: this._headers() });
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

  // 비율별 t2i 해상도 — 커스텀 워크플로의 EmptyLatentImage 에 주입(롱폼 16:9 / 쇼츠 9:16).
  _imageDims(aspect) {
    if (aspect === '16:9') return { w: 1344, h: 768 };
    if (aspect === '1:1') return { w: 1024, h: 1024 };
    return { w: 768, h: 1344 }; // 9:16 기본
  }
  // 커스텀 t2i 워크플로(Krea2 등) 로드 + 프롬프트/해상도/seed 주입.
  _buildImageWorkflow(positive, aspect) {
    let wf = JSON.parse(fs.readFileSync(this.imageWorkflowPath, 'utf8'));
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') throw new Error('UI 포맷 워크플로입니다. "저장(API 포맷)"으로 저장하세요.');
    const graph = JSON.parse(JSON.stringify(wf));
    if (positive) {
      const pId = this.imagePromptNodeId || Object.keys(graph).find((id) => graph[id].class_type === 'CLIPTextEncode' && 'text' in (graph[id].inputs || {}));
      if (pId && graph[pId] && graph[pId].inputs) graph[pId].inputs.text = String(positive);
    }
    // 📐 해상도 — 프로젝트 비율(롱폼 16:9 / 쇼츠 9:16 / 1:1)에 맞춰 EmptyLatentImage 의 width/height 주입.
    //   워크플로의 ResolutionSelector 등 고정 해상도를 덮어써서, 롱폼·쇼츠 모두 한 워크플로로 처리.
    //   imageWidthNodeId/imageHeightNodeId 가 지정되면 그 노드(value/width/height)에 기록(커스텀 노드 대응).
    const dim = this._imageDims(aspect);
    const setNum = (id, keys, val) => {
      const inp = id && graph[id] && graph[id].inputs;
      if (!inp) return false;
      for (const k of keys) { if (k in inp) { inp[k] = val; return true; } }
      return false;
    };
    let wSet = setNum(this.imageWidthNodeId, ['value', 'width'], dim.w);
    let hSet = setNum(this.imageHeightNodeId, ['value', 'height'], dim.h);
    if (!wSet || !hSet) {
      // 자동 — width·height 입력을 함께 가진 latent 노드(EmptyLatentImage/EmptySD3LatentImage 등)에 직접 주입.
      for (const id of Object.keys(graph)) {
        const inp = graph[id].inputs || {};
        if (('width' in inp) && ('height' in inp)) {
          if (!wSet) inp.width = dim.w;
          if (!hSet) inp.height = dim.h;
          wSet = hSet = true;
          break;
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
  // history → 출력 이미지 {filename, subfolder, type}
  async _waitImage(promptId, abortSignal) {
    if (this.cloud) return this._waitCloud(promptId, abortSignal, this.imageTimeoutSec, false);
    const deadline = Date.now() + this.imageTimeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this._url('/interrupt'), { method: 'POST', headers: this._headers() }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1000));
      let hist;
      try { const r = await fetch(this._url(`/history/${promptId}`)); if (!r.ok) continue; hist = await r.json(); } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 실행 오류');
      const outputs = entry.outputs || {};
      const img = this._scanMedia(outputs, false);
      if (img) return img;
      if (Object.keys(outputs).length) throw new Error('출력에 이미지가 없습니다 — SaveImage 노드를 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.imageTimeoutSec}초)`);
  }
  async _downloadImage(img, outputPath) {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    const r = await fetch(this._url('/view') + '?' + q.toString(), { headers: this._headers() });
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
      if (!this.imageWorkflowPath || !fs.existsSync(this.imageWorkflowPath)) {
        return { success: false, error: '이미지 워크플로(Krea2 등 API JSON)가 지정되지 않았습니다 — ⚙ Comfy 에서 지정하세요.' };
      }
      const graph = this._buildImageWorkflow(prompt, aspect);
      const promptId = await this._queue(graph);
      const img = await this._waitImage(promptId, abortSignal);
      const out = await this._downloadImage(img, outputPath);
      return { success: true, imagePath: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ── ACE-Step 음악(t2a) — '플리' 모드 ───────────────────────────────────
  // 길이(초) 주입 — EmptyAceStepLatentAudio 의 seconds 우선, 없으면 title 자동탐지.
  _setAudioDuration(graph, durSec) {
    const sec = Math.max(1, Math.round(Number(durSec) || 0));
    const FIELDS = ['seconds', 'value', 'length', 'duration'];
    const setOn = (n) => { if (!n || !n.inputs) return false; for (const f of FIELDS) { if (f in n.inputs && typeof n.inputs[f] !== 'object') { n.inputs[f] = sec; return true; } } return false; };
    if (this.audioDurationNodeId && graph[this.audioDurationNodeId] && setOn(graph[this.audioDurationNodeId])) return sec;
    for (const id of Object.keys(graph)) { const n = graph[id]; if (n.inputs && 'seconds' in n.inputs && typeof n.inputs.seconds !== 'object') { n.inputs.seconds = sec; return sec; } }
    for (const id of Object.keys(graph)) { const n = graph[id]; if (!n.inputs) continue; const t = ((n._meta && n._meta.title) || '').toLowerCase(); if (/duration|length|seconds|길이/.test(t) && setOn(n)) return sec; }
    return sec;
  }
  // ACE-Step 워크플로 로드 + tags(스타일)/lyrics(가사)/길이/seed 주입.
  _buildAudioWorkflow(tags, lyrics, durSec) {
    let wf = JSON.parse(fs.readFileSync(this.audioWorkflowPath, 'utf8'));
    if (wf.nodes && !wf['1'] && typeof wf.nodes === 'object') throw new Error('UI 포맷 워크플로입니다. "저장(API 포맷)"으로 저장하세요.');
    const graph = JSON.parse(JSON.stringify(wf));
    const setText = (id, keys, val) => { const inp = id && graph[id] && graph[id].inputs; if (!inp) return false; for (const k of keys) { if (k in inp && typeof inp[k] !== 'object') { inp[k] = String(val); return true; } } return false; };
    let tagsDone = this.audioTagsNodeId ? setText(this.audioTagsNodeId, ['tags', 'text'], tags) : false;
    let lyricsDone = this.audioLyricsNodeId ? setText(this.audioLyricsNodeId, ['lyrics', 'text'], lyrics || '') : false;
    // 자동탐지 — 'tags' 입력을 가진 노드(TextEncodeAceStepAudio)에 tags·lyrics 주입.
    if (!tagsDone || !lyricsDone) {
      for (const id of Object.keys(graph)) {
        const inp = graph[id].inputs || {};
        if (!tagsDone && 'tags' in inp && typeof inp.tags !== 'object') { inp.tags = String(tags); tagsDone = true; }
        if (!lyricsDone && 'lyrics' in inp && typeof inp.lyrics !== 'object') { inp.lyrics = String(lyrics || ''); lyricsDone = true; }
        if (tagsDone && lyricsDone) break;
      }
    }
    // tags 노드 못 찾으면 CLIPTextEncode 첫 텍스트 노드에 태그 주입(폴백)
    if (!tagsDone) {
      const pId = Object.keys(graph).find((id) => graph[id].class_type === 'CLIPTextEncode' && 'text' in (graph[id].inputs || {}));
      if (pId) { graph[pId].inputs.text = String(tags); tagsDone = true; }
    }
    if (durSec) this._setAudioDuration(graph, durSec);
    for (const id of Object.keys(graph)) { const inp = graph[id].inputs || {}; const rnd = Math.floor(Math.random() * 1e15); if (typeof inp.seed === 'number') inp.seed = rnd; if (typeof inp.noise_seed === 'number') inp.noise_seed = rnd; }
    if (!tagsDone) throw new Error('스타일(tags) 노드를 찾지 못했습니다 — ⚙ Comfy 에서 태그 노드 ID를 지정하세요.');
    return graph;
  }
  async _waitAudio(promptId, abortSignal) {
    if (this.cloud) return this._waitCloud(promptId, abortSignal, this.audioTimeoutSec, 'audio');
    const deadline = Date.now() + this.audioTimeoutSec * 1000;
    while (Date.now() < deadline) {
      if (abortSignal && abortSignal()) { try { await fetch(this._url('/interrupt'), { method: 'POST', headers: this._headers() }); } catch {} throw new Error('중단됨'); }
      await new Promise((res) => setTimeout(res, 1500));
      let hist;
      try { const r = await fetch(this._url(`/history/${promptId}`)); if (!r.ok) continue; hist = await r.json(); } catch { continue; }
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 실행 오류');
      const outputs = entry.outputs || {};
      const au = this._scanMedia(outputs, 'audio');
      if (au) return au;
      if (Object.keys(outputs).length) throw new Error('출력에 오디오가 없습니다 — SaveAudio(MP3/FLAC) 출력 노드를 확인하세요.');
    }
    throw new Error(`타임아웃 (${this.audioTimeoutSec}초)`);
  }
  // 앞/뒤 무음 트림 — ACE-Step 가 요청 길이를 못 채워 남긴 꼬리 무음 제거(곡 중간은 보존).
  //   areverse 트릭으로 양 끝만 자른다(가운데 침묵은 유지). ffmpeg 없거나 실패 시 원본 유지.
  _trimSilence(filePath) {
    if (!_ffmpegPath || !fs.existsSync(_ffmpegPath) || !fs.existsSync(filePath)) return filePath;
    const ext = path.extname(filePath).toLowerCase();
    const tmp = filePath.replace(/(\.[^.]+)$/, '_trim$1');
    const af = 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,areverse,'
             + 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,areverse';
    const codec = ext === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2']
      : ext === '.flac' ? ['-c:a', 'flac']
      : ext === '.wav' ? ['-c:a', 'pcm_s16le'] : [];
    try {
      const rr = spawnSync(_ffmpegPath, ['-y', '-i', filePath, '-af', af, ...codec, tmp], { stdio: 'ignore' });
      if (rr.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) {
        fs.unlinkSync(filePath); fs.renameSync(tmp, filePath);
        this.log('[Comfy] 무음 트림 적용 (실제 음악 길이로)');
      } else if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); }
    } catch { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} }
    return filePath;
  }
  // 오디오 다운로드 — ComfyUI 출력 확장자(mp3/flac 등)를 보존해 저장. 실제 저장 경로 반환.
  async _downloadAudio(au, outputPath) {
    const q = new URLSearchParams({ filename: au.filename, subfolder: au.subfolder || '', type: au.type || 'output' });
    const r = await fetch(this._url('/view') + '?' + q.toString(), { headers: this._headers() });
    if (!r.ok) throw new Error(`/view 다운로드 실패 (${r.status})`);
    const srcExt = (path.extname(au.filename || '') || '.mp3').toLowerCase();
    const finalPath = outputPath.replace(/\.[^.]+$/, '') + srcExt;
    fs.writeFileSync(finalPath, Buffer.from(await r.arrayBuffer()));
    return finalPath;
  }
  /**
   * 스타일(tags) + 가사(lyrics) → 음악 1곡(ACE-Step). 성공 시 { success:true, audioPath }.
   */
  async textToAudio({ tags, lyrics, durationSec, outputPath, abortSignal }) {
    try {
      if (!(await this.health())) return { success: false, error: `ComfyUI 연결 실패 (${this.baseUrl})` };
      if (!this.audioWorkflowPath || !fs.existsSync(this.audioWorkflowPath)) {
        return { success: false, error: 'ACE-Step 워크플로(API JSON)가 지정되지 않았습니다 — ⚙ Comfy 에서 지정하세요.' };
      }
      const graph = this._buildAudioWorkflow(tags, lyrics, durationSec);
      this.log(`[Comfy] ACE-Step 큐 등록${durationSec ? ` (${Math.round(durationSec)}초)` : ''}…`);
      const promptId = await this._queue(graph);
      const au = await this._waitAudio(promptId, abortSignal);
      const out = await this._downloadAudio(au, outputPath);
      if (this.audioTrimSilence) this._trimSilence(out);
      this.log(`[Comfy] 음악 완료 → ${path.basename(out)}`);
      return { success: true, audioPath: out };
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
