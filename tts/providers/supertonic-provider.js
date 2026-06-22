/**
 * Supertonic-3 Provider (로컬 CPU FastAPI 백엔드)
 * 백엔드: tts/supertonic-backend/api.py  포트 9882
 *
 * 특징:
 *   - CPU 전용으로 동작 (GPU PC 없이도 가능 — 출장 시나리오 대비)
 *   - pre-defined voice 만 지원 (M1/F1/M2/F2 ...). Voice Clone 미지원
 *   - 31 언어 지원 (lang 파라미터로 제어, 기본 'ko')
 *   - speed/silence_duration 네이티브 지원
 *
 * voice 목록은 init() 시 백엔드 /voices 에서 받아 정적 캐시.
 * UI 가 sync 로 getVoices() 를 호출하므로 실패 시 fallback 목록 사용.
 */

'use strict';

const { quietGet } = require('../quiet-http');

const PROVIDER_ID = 'supertonic';
const DEFAULT_BASE_URL = 'http://127.0.0.1:9882';
// Supertonic-3 model 의 pre-defined voice 10종 (HuggingFace voice_styles/ 폴더 기준)
// 백엔드 연결 후엔 /voices 로 받은 실제 목록이 우선됨 (init 에서 _cachedVoices 로 덮어씀).
const FALLBACK_VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'];

function _authHeaders() {
  try {
    const SecretStore = require('../secret-store');
    const s = SecretStore.get('supertonic');
    if (s && s.apiKey) return { 'X-API-Key': s.apiKey };
  } catch {}
  return {};
}

class SupertonicProvider {
  constructor(opts = {}) {
    this.id = PROVIDER_ID;
    this.label = 'Supertonic-3 (CPU 로컬)';
    this.ready = false;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = opts.timeout || 60000;
  }

  async init() {
    const res = await quietGet(this.baseUrl + '/health', { timeoutMs: 3000 });
    if (res.status !== 200) {
      this.ready = false;
      return false;
    }
    this.ready = true;

    // 백엔드 voice 목록을 정적 캐시에 저장 (UI getVoices 가 sync 라 미리 받아둠)
    try {
      const r = await fetch(this.baseUrl + '/voices', {
        headers: { ..._authHeaders() },
      });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          SupertonicProvider._cachedVoices = data.voices.slice();
        }
      }
    } catch (_) {
      // /voices 실패 — fallback 목록 사용
    }
    return true;
  }

  /**
   * @param {string} text
   * @param {object} opts
   *   voice           {string}  voice id (M1/F1/M2/F2)
   *   language        {string}  ISO lang code (ko/en/ja/...). 기본 'ko'
   *   speed           {number}  속도 배율 (0.25~4.0)
   *   silenceDuration {number}  문장 사이 무음(초). 기본 0.5
   */
  async synthesize(text, opts = {}) {
    if (!this.ready) throw new Error('Supertonic 백엔드 미준비');

    const payload = {
      text: String(text),
      voice_id: opts.voice || 'M1',
      lang: opts.language || 'ko',
      speed: opts.speed != null ? parseFloat(opts.speed) : 1.0,
      silence_duration: opts.silenceDuration != null ? parseFloat(opts.silenceDuration) : 0.5,
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);

    let response;
    try {
      response = await fetch(this.baseUrl + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._authHeaders() },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Supertonic 실패 (${response.status}): ${err.substring(0, 200)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const wavBuffer = Buffer.from(arrayBuffer);

    // WAV header 에서 sample rate 읽어 duration 계산
    const dataSize = Math.max(0, wavBuffer.length - 44);
    const sr = wavBuffer.length >= 28 ? wavBuffer.readUInt32LE(24) : 24000;
    const durationSec = Math.max(0.5, dataSize / (sr * 2));

    return {
      mp3Buffer: wavBuffer,
      durationSec,
      providerUsed: PROVIDER_ID,
      format: 'wav',
    };
  }

  async stop() {
    this.ready = false;
  }

  static getVoices() {
    const list = SupertonicProvider._cachedVoices || FALLBACK_VOICES;
    return list.map((v) => {
      const isMale = /^M/i.test(v);
      const isFemale = /^F/i.test(v);
      const symbol = isMale ? '♂' : isFemale ? '♀' : '';
      return {
        id: v,
        name: `${symbol} ${v} (Supertonic-3)`.trim(),
        gender: isMale ? 'male' : isFemale ? 'female' : null,
      };
    });
  }
}

SupertonicProvider._cachedVoices = null;

module.exports = { SupertonicProvider };
