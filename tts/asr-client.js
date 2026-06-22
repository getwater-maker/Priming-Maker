/**
 * OmniVoice /asr-upload 클라이언트.
 * 음성 파일을 multipart 로 업로드해 Whisper STT 텍스트를 받는다.
 *
 * 메모리 정책: OmniVoice 가 PrimingFlow 의 근간 엔진. 백엔드 다운 시 다른 엔진
 * 자동 fallback 추가 금지 — 사용자가 OmniVoice 를 살리도록 명시 안내.
 */

const fs = require('fs');
const path = require('path');
const { getProvider } = require('./tts-config');

function _baseUrl() {
  const p = getProvider('omnivoice');
  return (p && p.baseUrl) ? p.baseUrl.replace(/\/+$/, '') : '';
}

/** secret-store 의 omnivoice.apiKey 가 있으면 X-API-Key 헤더 반환 — provider 와 동일 패턴 */
function _authHeaders() {
  try {
    const SecretStore = require('./secret-store');
    const s = SecretStore.get('omnivoice');
    if (s && s.apiKey) return { 'X-API-Key': s.apiKey };
  } catch (_) {}
  return {};
}

/**
 * /asr/status — Whisper 로드 여부 + 백엔드 도달 가능성. 실패해도 transcribe 는 시도 가능.
 */
async function checkAsrStatus() {
  const base = _baseUrl();
  if (!base) return { loaded: false, reachable: false };
  try {
    const res = await fetch(base + '/asr/status', { method: 'GET', headers: { ..._authHeaders() } });
    if (!res.ok) return { loaded: false, reachable: true };
    const j = await res.json();
    return { loaded: !!j.loaded, reachable: true };
  } catch (_) {
    return { loaded: false, reachable: false };
  }
}

/**
 * 음성 파일 → 텍스트.
 * @param {string} audioPath - 로컬 음성 파일 절대경로 (wav/mp3/m4a/flac)
 * @param {{ timeoutMs?: number }} [opts] - 기본 600초 (Whisper 첫 로드 시 5분+ 소요)
 * @returns {Promise<string>}
 */
async function transcribe(audioPath, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('오디오 파일이 없습니다: ' + audioPath);
  }
  const base = _baseUrl();
  if (!base) {
    throw new Error('OmniVoice baseUrl 미설정 — 서버 설정에서 URL 을 지정하세요.');
  }
  const url = base + '/asr-upload';
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 600000;

  const buf = fs.readFileSync(audioPath);
  const filename = path.basename(audioPath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('file', blob, filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', body: form, headers: { ..._authHeaders() }, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      throw new Error(`OmniVoice /asr-upload HTTP ${res.status} — ${detail.slice(0, 300) || res.statusText}`);
    }
    const j = await res.json();
    return String(j.text || '');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('STT 타임아웃 — OmniVoice 응답이 늦습니다. Whisper 첫 호출 시 5분+ 걸릴 수 있어요.');
    }
    throw new Error(`STT 실패: ${e.message}\n→ OmniVoice 백엔드(${base})가 켜져있고 /asr-upload 가 가능한지 확인하세요.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 긴 오디오 전사 — ffmpeg 로 청크 분할 후 순차 전사하여 합침.
 * 통째 업로드(메모리 1GB+) · 단일 10분 타임아웃 · 연결 끊김 시 전부 손실 문제를 회피.
 *   - 청크 길이 이하(여유 20%)면 분할 없이 단일 전사 (단 타임아웃은 넉넉히).
 *   - 청크별로 transcribe() 호출 → 실패는 그 청크만 영향. 진행률 콜백 제공.
 * @param {string} audioPath
 * @param {{ chunkSec?: number, timeoutMsPerChunk?: number,
 *           onProgress?: (p:{done:number,total:number,durationSec:number})=>void,
 *           abortSignal?: ()=>boolean }} [opts]
 * @returns {Promise<string>}
 */
async function transcribeLong(audioPath, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('오디오 파일이 없습니다: ' + audioPath);
  }
  const os = require('os');
  const media = require('../core/media-utils');
  const chunkSec = (opts.chunkSec > 0) ? opts.chunkSec : 900;                       // 기본 15분
  const perChunkTimeoutMs = (opts.timeoutMsPerChunk > 0) ? opts.timeoutMsPerChunk : 1800000; // 기본 30분/청크
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const aborted = () => (typeof opts.abortSignal === 'function' && opts.abortSignal());

  let dur = 0;
  try { dur = (await media.getMediaDuration(audioPath)) || 0; } catch (_) {}

  // 짧으면(청크 길이의 1.2배 이하) 분할 오버헤드 없이 단일 전사 — 단 타임아웃은 넉넉히.
  if (dur > 0 && dur <= chunkSec * 1.2) {
    onProgress({ done: 0, total: 1, durationSec: dur });
    const t = await transcribe(audioPath, { timeoutMs: perChunkTimeoutMs });
    onProgress({ done: 1, total: 1, durationSec: dur });
    return t;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stt-'));
  try {
    const chunks = await media.segmentAudio(audioPath, workDir, chunkSec);
    const total = chunks.length;
    const parts = [];
    for (let i = 0; i < total; i++) {
      if (aborted()) throw new Error('사용자 중단');
      onProgress({ done: i, total, durationSec: dur });
      const text = await transcribe(chunks[i], { timeoutMs: perChunkTimeoutMs });
      parts.push((text || '').trim());
    }
    onProgress({ done: total, total, durationSec: dur });
    return parts.filter(Boolean).join('\n');
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { transcribe, transcribeLong, checkAsrStatus };
