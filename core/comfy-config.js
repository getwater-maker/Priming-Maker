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
  // ── ComfyUI 클라우드(comfy.org) 모드 ──────────────────
  //   cloud=true 면 baseUrl 을 https://cloud.comfy.org 로, 모든 요청 경로에 /api 접두 +
  //   X-API-Key 헤더를 붙이고, 진행 확인을 /api/job/{id}/status + /api/jobs/{id} 로 전환한다.
  //   (로컬/RunPod 는 cloud=false 그대로 — /system_stats·/prompt·/history·/view 사용)
  cloud: false,
  apiKey: '',           // ComfyUI 클라우드 계정 대시보드에서 발급한 API 키 (cloud=true 일 때 필수)
  workflowPath: '',     // i2v(영상) ComfyUI '저장(API 포맷)' JSON 경로 (LTX 등)
  imageNodeId: '',      // 빈값=LoadImage 자동탐지
  promptNodeId: '',     // 빈값=CLIPTextEncode 자동탐지
  timeoutSec: 1800,     // 한 영상 최대 대기(초) — 로컬 LTX 풀 워크플로는 10분+ 걸려 넉넉히
  clipSeconds: 8,       // 그룹 캡(쇼츠 TTS 그룹화)용 클립 길이
  // ── ComfyUI 이미지(t2i) 설정 — 커스텀 워크플로(Krea2 등) 전용 ──────────────────
  imageTimeoutSec: 180, // 이미지 1장 최대 대기
  imageWorkflowPath: '', // 커스텀 t2i API 워크플로(Krea2 등). 필수 — 없으면 이미지 생성 에러.
  imagePromptNodeId: '', // 커스텀 워크플로의 긍정 프롬프트 노드 id
  imageWidthNodeId: '',  // 커스텀 워크플로 해상도 노드(빈값=width·height 가진 latent 노드 자동탐지 후 비율 주입)
  imageHeightNodeId: '',
  // i2v 출력 해상도 노드(비율 맞춤용) — 빈값이면 _meta.title 이 width/height 인 PrimitiveInt 자동탐지.
  videoWidthNodeId: '',
  videoHeightNodeId: '',
  // i2v 영상 길이 = 그룹 TTS 길이에 맞춤. Duration 노드(초) 설정. 빈값이면 title 'Duration' 자동탐지.
  videoDurationNodeId: '',
  videoMaxSec: 0,         // 영상 최대 길이(초) — 0 = 캡 없음(그룹 TTS 길이 그대로). >0 이면 그 값으로 상한.
  matchVideoToAudio: true, // 영상 길이를 그룹 TTS 재생시간에 맞춤 (LTX, 초 단위)
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
