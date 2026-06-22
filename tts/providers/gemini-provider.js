/**
 * Google Gemini TTS
 * Gemini 2.5 Flash/Pro 의 native 음성 생성 (responseModalities: AUDIO)
 *
 * 인증: API 키 (Google AI Studio 에서 발급, https://aistudio.google.com/apikey)
 * 비용: 무료 quota (분당 호출수 제한, 일일 토큰 한도)
 *
 * 출력: PCM raw 24kHz 16-bit mono signed → WAV header 추가해서 반환.
 *       (msedge/azure 는 mp3, gemini 는 wav — 호출자에서 확장자만 분기)
 *
 * API 문서:
 *   https://ai.google.dev/gemini-api/docs/speech-generation
 */

const SecretStore = require('../secret-store');
const Usage = require('../gemini-usage-store');
const { quietPostJson } = require('../quiet-http');

const PROVIDER_ID = 'gemini';

// Circuit breaker (단계형) — TTS 측. ai-splitter 와 동일 정책:
//   첫 429   → 1시간 대기  (시간당 한도 또는 burst)
//   연속 429 → 24시간 대기 (일일 한도 — 다음날 자정에 reset)
// 60초 짧은 cycle 로 자동 재시도하면 사용자 PrimingFlow 띄워둔 시간만큼 누적됨.
let _gemini429Until = 0;
let _gemini429Streak = 0;
const SHORT_BREAKER_MS = 60 * 60 * 1000;       // 1시간
const LONG_BREAKER_MS  = 24 * 60 * 60 * 1000;  // 24시간

class GeminiProvider {
  constructor(opts = {}) {
    this.id = PROVIDER_ID;
    this.label = 'Google Gemini';
    this.ready = false;
    this.apiKey = null;
    this.voice = opts.voice || 'Kore';
    this.model = opts.model || 'gemini-3.1-flash-tts-preview';
  }

  async init() {
    const secret = SecretStore.get(PROVIDER_ID);
    if (!secret || !secret.key) {
      this.ready = false;
      return false;
    }
    this.apiKey = secret.key;
    this.ready = true;
    return true;
  }

  // PCM raw → WAV (header 44 bytes 추가)
  _pcmToWav(pcmBuffer, sampleRate = 24000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);                 // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  /**
   * @param {string} text
   * @param {object} opts - { voice }  (Gemini 는 speed/pitch 직접 지원 안 함)
   * @returns {Promise<{ mp3Buffer: Buffer, durationSec: number, providerUsed: 'gemini', format: 'wav' }>}
   */
  async synthesize(text, opts = {}) {
    if (!this.ready) throw new Error('Gemini provider not ready — API 키 미설정');

    // Circuit breaker — 최근 429 받았으면 호출 자체 스킵 (네트워크 round-trip 안 함).
    if (_gemini429Until > Date.now()) {
      const remainSec = Math.ceil((_gemini429Until - Date.now()) / 1000);
      const remainHuman = remainSec >= 3600
        ? `${Math.ceil(remainSec / 3600)}시간`
        : `${Math.ceil(remainSec / 60)}분`;
      throw new Error(`Gemini 한도 초과 — ${remainHuman} 후 자동 재시도 가능 (또는 OmniVoice / Supertonic 사용)`);
    }

    const voice = opts.voice || this.voice;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      contents: [{
        parts: [{ text: String(text) }],
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    };

    // quietPostJson — fetch 대신 Node http 사용 (DevTools 콘솔에 빨간 에러 안 찍힘)
    const response = await quietPostJson(url, body, { timeoutMs: 60000 });

    if (!response.ok) {
      if (response.status === 429) {
        Usage.bump('tts_429');
        _gemini429Streak++;
        const breakerMs = (_gemini429Streak >= 2) ? LONG_BREAKER_MS : SHORT_BREAKER_MS;
        _gemini429Until = Date.now() + breakerMs;
      }
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini TTS 실패 (${response.status}): ${errText.substring(0, 200)}`);
    }

    const json = await response.json();
    _gemini429Streak = 0;  // 성공했으니 streak 초기화
    const audioData = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini 응답에 오디오 데이터 없음');
    }

    Usage.bump('tts_ok');

    const pcmBuffer = Buffer.from(audioData, 'base64');
    const wavBuffer = this._pcmToWav(pcmBuffer, 24000);
    const durationSec = Math.max(0.5, pcmBuffer.length / (24000 * 2));

    // 주의: 인터페이스 일관성을 위해 mp3Buffer 키 사용. 실제 데이터는 WAV.
    // format: 'wav' 표시로 호출자가 확장자 분기 가능.
    return {
      mp3Buffer: wavBuffer,
      durationSec,
      providerUsed: 'gemini',
      format: 'wav',
    };
  }

  async stop() {
    this.ready = false;
  }

  static getVoices() {
    // Gemini 2.5 prebuilt voices 30개 — 남/여 분류 (커뮤니티 청취 기반 추정)
    // 출처: https://ai.google.dev/gemini-api/docs/speech-generation
    // gender 가 부정확하다 느끼면 사용자가 직접 들어보고 알려주면 수정
    return [
      // ─── 여성 voices (♀) ──────────────────────────
      { id: 'Zephyr',       name: '♀ Zephyr (밝은)',          gender: 'female' },
      { id: 'Aoede',        name: '♀ Aoede (가벼운)',         gender: 'female' },
      { id: 'Kore',         name: '♀ Kore (확실한)',          gender: 'female' },
      { id: 'Leda',         name: '♀ Leda (젊은)',            gender: 'female' },
      { id: 'Callirrhoe',   name: '♀ Callirrhoe (편안한)',    gender: 'female' },
      { id: 'Autonoe',      name: '♀ Autonoe (밝은)',         gender: 'female' },
      { id: 'Despina',      name: '♀ Despina (부드러운)',     gender: 'female' },
      { id: 'Erinome',      name: '♀ Erinome (명확한)',       gender: 'female' },
      { id: 'Laomedeia',    name: '♀ Laomedeia (밝은)',       gender: 'female' },
      { id: 'Achernar',     name: '♀ Achernar (부드러운)',    gender: 'female' },
      { id: 'Gacrux',       name: '♀ Gacrux (성숙한)',        gender: 'female' },
      { id: 'Pulcherrima',  name: '♀ Pulcherrima (앞선)',     gender: 'female' },
      { id: 'Vindemiatrix', name: '♀ Vindemiatrix (온화한)',  gender: 'female' },
      { id: 'Sulafat',      name: '♀ Sulafat (따뜻한)',       gender: 'female' },

      // ─── 남성 voices (♂) ──────────────────────────
      { id: 'Puck',         name: '♂ Puck (경쾌한)',          gender: 'male' },
      { id: 'Charon',       name: '♂ Charon (정보적)',        gender: 'male' },
      { id: 'Fenrir',       name: '♂ Fenrir (활기찬)',        gender: 'male' },
      { id: 'Orus',         name: '♂ Orus (확고한)',          gender: 'male' },
      { id: 'Iapetus',      name: '♂ Iapetus (명확한)',       gender: 'male' },
      { id: 'Algieba',      name: '♂ Algieba (부드러운)',     gender: 'male' },
      { id: 'Algenib',      name: '♂ Algenib (자갈자갈)',     gender: 'male' },
      { id: 'Rasalgethi',   name: '♂ Rasalgethi (정보적)',    gender: 'male' },
      { id: 'Achird',       name: '♂ Achird (친근한)',        gender: 'male' },
      { id: 'Zubenelgenubi', name: '♂ Zubenelgenubi (자유)',  gender: 'male' },
      { id: 'Sadachbia',    name: '♂ Sadachbia (활동적)',     gender: 'male' },
      { id: 'Sadaltager',   name: '♂ Sadaltager (잘아는)',    gender: 'male' },
      { id: 'Schedar',      name: '♂ Schedar (균형)',         gender: 'male' },
      { id: 'Enceladus',    name: '♂ Enceladus (숨소리)',     gender: 'male' },
      { id: 'Umbriel',      name: '♂ Umbriel (편안한)',       gender: 'male' },
      { id: 'Alnilam',      name: '♂ Alnilam (단호한)',       gender: 'male' },
    ];
  }
}

module.exports = { GeminiProvider };
