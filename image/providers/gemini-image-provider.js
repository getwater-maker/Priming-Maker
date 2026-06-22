'use strict';

/**
 * Gemini 이미지 Provider — Nano Banana 2 (Gemini 3.1 Flash Image)
 *
 * RunPodComfyProvider 와 동일한 synth() 인터페이스로 ImageManager 에 등록된다.
 * GPU Pod 불필요 — Google Generative Language API 를 직접 호출.
 *
 * 모델 고정: gemini-3.1-flash-image  (UI 표시명 "Nano Banana 2")
 *   - 혹시 구글 API 식별자가 -preview 접미사를 요구하면 아래 MODEL 상수만 교체.
 *
 * API 키: SecretStore.get('gemini').key  (TTS Gemini 키 공유)
 *
 * 입력 prompt 는 메인 파이프라인에서 이미 영어로 번역된 상태로 들어온다.
 * 여기서는 16:9 비율 강제 + 안전필터 순화/재시도만 책임진다.
 */

const fs = require('fs');
const path = require('path');

const SecretStore = require('../../tts/secret-store');
const { quietPostJson } = require('../../tts/quiet-http');

let Usage = null;
try { Usage = require('../../tts/gemini-usage-store'); } catch { /* 사용량 추적 선택 */ }

// ── 모델 고정 (Nano Banana 2) ──────────────────────────────────────────────
// 구글 API 식별자에 -preview 접미사 필요 (2026-05 확인. models 목록 기준).
const MODEL = 'gemini-3.1-flash-image-preview';

// 16:9 기본 해상도 (보고용 — 실제 픽셀은 모델이 결정)
const DEFAULT_RATIO = '16:9';
const RATIO_SIZE = {
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1':  { width: 1024, height: 1024 },
  '4:3':  { width: 1184, height: 896 },
  '3:4':  { width: 896, height: 1184 },
};

// 안전필터를 자극할 수 있는 영어 표현 → 순화 (archive/flow-engine._sanitizeForPolicy 축약)
const POLICY_MAP = [
  [/\bkill(s|ed|ing)?\b/gi, 'defeats'],
  [/\bmurder(s|ed|ing)?\b/gi, 'confronts'],
  [/\bdead\b/gi, 'still'],
  [/\bdeath\b/gi, 'rest'],
  [/\bdie[sd]?\b/gi, 'falls'],
  [/\bdying\b/gi, 'resting'],
  [/\bblood(y)?\b/gi, 'red'],
  [/\bcorpse/gi, 'figure'],
  [/\bgore\b/gi, 'red'],
  [/\bweapon/gi, 'tool'],
  [/\bgun(s)?\b/gi, 'tool'],
  [/\bknife|dagger|sword/gi, 'blade prop'],
  [/\btopple(s|d)?\b/gi, 'challenge'],
  [/\boverthrow(s|n)?\b/gi, 'change'],
  [/\bnaked\b/gi, 'dressed'],
  [/\bnude\b/gi, 'dressed'],
  [/\btorture/gi, 'ordeal'],
  [/\bwar\b/gi, 'conflict'],
  [/\bbattle\b/gi, 'confrontation'],
  [/\bscream(s|ed|ing)?\b/gi, 'calls out'],
  [/\bterror/gi, 'tension'],
  [/\bhorror/gi, 'somber mood'],
  [/\bwound(s|ed)?\b/gi, 'mark'],
  [/\bboil\b/gi, 'small mark'],
  [/\bdisease|illness\b/gi, 'fatigue'],
];

function sanitizeForPolicy(text) {
  let out = String(text || '');
  for (const [re, rep] of POLICY_MAP) out = out.replace(re, rep);
  return out;
}

function bump(key) {
  try { if (Usage && typeof Usage.bump === 'function') Usage.bump(key); } catch {}
}

class GeminiImageProvider {
  constructor(opts = {}) {
    this.ready = false;
    this.label = 'Nano Banana 2 (Gemini)';
    this.opts = opts;
    this.model = MODEL;
  }

  /**
   * provider 는 항상 ready=true 로 등록한다.
   * 키는 synth() 호출 시점에 SecretStore 에서 재조회하므로, 앱 실행 중 키를
   * 나중에 등록해도 즉시 동작한다 (ImageManager.start 는 1회만 실행되므로
   * 여기서 키 유무로 ready 를 고정하면 stale 상태가 됨).
   */
  async init() {
    this.ready = true;
    const hasKey = SecretStore.has && SecretStore.has('gemini');
    this.hasKey = !!hasKey;
    if (!hasKey) console.warn('[gemini-image] Gemini API 키 미등록 — 키 등록 후 사용 가능');
    return true;
  }

  async stop() { this.ready = false; }

  /**
   * Gemini 이미지 API 1회 호출 → PNG 버퍼 반환.
   * 실패 시 { error, finishReason } 반환 (throw 안 함 — 호출부에서 재시도 판단).
   */
  async _callOnce(apiKey, prompt, aspectRatio) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ parts: [{ text: String(prompt) }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        // 신형 식별자 — 미지원이면 무시되며, 프롬프트 접미사가 비율을 보강
        imageConfig: { aspectRatio: aspectRatio || DEFAULT_RATIO },
      },
    };

    const res = await quietPostJson(url, body, { timeoutMs: 120000 });

    if (!res.ok) {
      if (res.status === 429) { bump('img_429'); return { error: 'RATE_LIMIT', status: 429 }; }
      const errText = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${errText.slice(0, 200)}`, status: res.status };
    }

    const json = await res.json().catch(() => null);
    if (!json) return { error: '응답 JSON 파싱 실패' };

    const finishReason = json?.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      return { error: 'SAFETY', finishReason };
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p?.inlineData?.mimeType?.startsWith('image/'));
    const b64 = imgPart?.inlineData?.data;
    if (!b64) {
      return { error: 'NO_IMAGE', finishReason: finishReason || 'unknown' };
    }
    return { buffer: Buffer.from(b64, 'base64'), mimeType: imgPart.inlineData.mimeType };
  }

  /**
   * 이미지 생성. RunPodComfyProvider.synth 와 동일 인터페이스.
   * @param {object} opts
   * @param {string} opts.prompt       - 영문 프롬프트 (파이프라인에서 번역 완료)
   * @param {string} opts.outputPath   - 결과 저장 절대경로 (.png)
   * @param {string} [opts.aspectRatio='16:9']
   * @param {number} [opts.width]      - 미사용 (호환용)
   * @param {number} [opts.height]     - 미사용 (호환용)
   * @param {Function} [opts.onProgress] - (0~1) 콜백
   * @returns {Promise<{path, width, height, durationMs, seed}>}
   */
  async synth(opts = {}) {
    const t0 = Date.now();
    const { prompt, outputPath, onProgress } = opts;
    const aspectRatio = opts.aspectRatio || DEFAULT_RATIO;

    if (!prompt) throw new Error('prompt 필수');
    if (!outputPath) throw new Error('outputPath 필수');

    const progress = (p) => { try { onProgress && onProgress(p); } catch {} };

    const secret = SecretStore.get('gemini');
    if (!secret || !secret.key) {
      throw new Error('Gemini API 키가 없습니다 — 🔑 설정 → Google Gemini 에서 키를 등록하세요.');
    }
    const apiKey = secret.key;

    // 16:9 비율 보강 — imageConfig 미지원 모델 대비 프롬프트 접미사도 첨부
    const ratioHint = aspectRatio === '16:9'
      ? ', 16:9 widescreen cinematic composition, no text, no watermark'
      : `, ${aspectRatio} aspect ratio, no text, no watermark`;
    const basePrompt = String(prompt).trim() + ratioHint;

    progress(0.1);

    // 시도 1: 원본 프롬프트
    let r = await this._callOnce(apiKey, basePrompt, aspectRatio);
    progress(0.5);

    // 시도 2: 안전필터/빈 이미지 → 순화 후 1회 재시도
    if (r.error && (r.error === 'SAFETY' || r.error === 'NO_IMAGE')) {
      const safePrompt = sanitizeForPolicy(basePrompt);
      if (safePrompt !== basePrompt) {
        console.warn(`[gemini-image] ${r.error} → 프롬프트 순화 후 재시도`);
        r = await this._callOnce(apiKey, safePrompt, aspectRatio);
      }
    }
    progress(0.8);

    if (r.error) {
      const map = {
        RATE_LIMIT: '한도 초과 (429) — 잠시 후 재시도',
        SAFETY: '안전 필터 거부 — 프롬프트 완화 필요',
        NO_IMAGE: '응답에 이미지 없음 (안전필터 또는 모델 응답 형식)',
      };
      throw new Error(map[r.error] || r.error);
    }

    // Gemini 는 JPEG/WebP 를 반환할 수 있으므로 실제 mime 에 맞춰 확장자 보정
    const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
    const wantExt = EXT_BY_MIME[r.mimeType] || '.png';
    let finalPath = outputPath;
    const curExt = path.extname(outputPath).toLowerCase();
    if (curExt !== wantExt) {
      finalPath = outputPath.slice(0, outputPath.length - curExt.length) + wantExt;
    }

    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, r.buffer);
    bump('img_ok');
    progress(1.0);

    const size = RATIO_SIZE[aspectRatio] || RATIO_SIZE[DEFAULT_RATIO];
    return {
      path: finalPath,
      width: size.width,
      height: size.height,
      durationMs: Date.now() - t0,
      seed: 0, // Gemini 는 시드 비노출
    };
  }
}

module.exports = { GeminiImageProvider, MODEL };
