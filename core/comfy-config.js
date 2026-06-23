'use strict';

/**
 * comfy-config.js — ComfyUI i2v 설정 (~/.priming-maker/comfy-config.json)
 * RunPod 전환 시 baseUrl 만 바꾸면 됨.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.priming-maker');
const CONFIG_PATH = path.join(STORE_DIR, 'comfy-config.json');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  workflowPath: '',     // i2v(영상) ComfyUI '저장(API 포맷)' JSON 경로 (LTX 등)
  imageNodeId: '',      // 빈값=LoadImage 자동탐지
  promptNodeId: '',     // 빈값=CLIPTextEncode 자동탐지
  timeoutSec: 1800,     // 한 영상 최대 대기(초) — 로컬 LTX 풀 워크플로는 10분+ 걸려 넉넉히
  clipSeconds: 8,       // 그룹 캡(쇼츠 TTS 그룹화)용 클립 길이
  // ── ComfyUI SDXL 이미지(t2i) 설정 ──────────────────
  imageCheckpoint: 'dreamshaperXL_sfwLightningDPMSDE.safetensors', // SDXL 체크포인트 파일명
  imageSteps: 8,        // Lightning: 8스텝
  imageCfg: 2.0,        // Lightning: cfg 2
  imageSampler: 'dpmpp_sde',
  imageScheduler: 'karras',
  imageNegative: 'photorealistic, realistic photo, 3d render, multiple people, two heads, duplicate, cloned face, extra head, extra limbs, deformed, bad hands, blurry, watermark, text, nsfw, chinese, hanfu, qing dynasty, japanese, kimono',
  imageTimeoutSec: 180, // 이미지 1장 최대 대기
  imageWorkflowPath: '', // (선택) 커스텀 t2i API 워크플로. 비우면 내장 SDXL 그래프 사용
  imagePromptNodeId: '', // 커스텀 워크플로의 긍정 프롬프트 노드 id
  // i2v 출력 해상도 노드(비율 맞춤용) — 빈값이면 _meta.title 이 width/height 인 PrimitiveInt 자동탐지.
  videoWidthNodeId: '',
  videoHeightNodeId: '',
  // i2v 영상 길이 = 그룹 TTS 길이에 맞춤. Duration 노드(초) 설정. 빈값이면 title 'Duration' 자동탐지.
  videoDurationNodeId: '',
  videoMaxSec: 0,         // 영상 최대 길이(초) — 0 = 캡 없음(그룹 TTS 길이 그대로). >0 이면 그 값으로 상한.
  matchVideoToAudio: true, // 영상 길이를 그룹 TTS 재생시간에 맞춤 (ComfyUI/LTX/Wan)
  // 길이 단위 — 0 = 초(LTX Duration 노드). >0 = 프레임(Wan 등): frames = ceil(초)×fps 를 4n+1 로 보정.
  //   Wan 2.2 i2v 는 보통 16fps → videoFps=16. (이때 길이 노드의 length/num_frames/value 에 프레임수 기록)
  videoFps: 0,
};

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULTS };
}

function save(patch) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const next = { ...load(), ...(patch || {}) };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) { return load(); }
}

module.exports = { load, save, CONFIG_PATH, DEFAULTS };
