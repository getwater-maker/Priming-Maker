/**
 * TTSManager — TTS provider 추상화 (OmniVoice 근간 + Gemini/Supertonic 보조)
 *
 * 지원:
 *   - omnivoice  : GPU 서버 (k2-fsa/OmniVoice, 포트 9881) — 원격 LAN/Tailscale
 *   - gemini     : Google Gemini TTS (API 키 필요)
 *   - supertonic : Supertonic-3 (로컬 CPU FastAPI, 포트 9882) — pre-defined voice
 *
 * OmniVoice 는 항상 원격 모드. GPU 머신에서 작업 스케줄러로 자동 시동된 백엔드에
 * baseUrl 로만 연결한다 (spawn 없음).
 *
 * Supertonic 은 로컬 머신에서 작업 스케줄러로 자동 시동되는 CPU 백엔드 — GPU PC
 * 없이도 동작하는 보조 엔진 (출장 시나리오 대비).
 */

'use strict';

class TTSManager {
  constructor(opts = {}) {
    this.opts = opts;
    this.providers = new Map();
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this._started = false;
    // 디스크 캐시 즉시 로드 — 첫 합성에서도 사전 적용되도록 (이전: 빈 [] 로 시작 →
    // fire-and-forget refresh 가 끝날 때까지 첫 합성은 사전 미적용)
    try {
      this._dictCache = require('./omnivoice-dict-store').loadAll();
    } catch (_) {
      this._dictCache = [];
    }
    this._dictRefreshAt = 0;
    this._DICT_TTL_MS = 60_000;
  }

  /**
   * provider 초기화. 한쪽이 실패해도 다른 쪽은 계속 활성.
   * Idempotent — 여러 번 호출해도 한 번만 실행.
   */
  async start() {
    if (this._started) return;
    this._started = true;

    // ─── gemini (API 키 필요) ───
    try {
      const { GeminiProvider } = require('./providers/gemini-provider');
      const p = new GeminiProvider();
      const ok = await p.init();
      if (ok) {
        this.providers.set('gemini', p);
        this.logger(`[TTS] Gemini 초기화 완료 (model: ${p.model})`);
      } else {
        this.logger('[TTS] Gemini: API 키 없음 — 🔑 키 버튼에서 설정 필요');
      }
    } catch (e) {
      this.logger(`[TTS] Gemini 초기화 실패: ${e.message}`);
    }

    // ─── omnivoice (원격 GPU) ───
    this._connectOmniVoice();

    // ─── supertonic (로컬 CPU) ───
    this._connectSupertonic();
  }

  /** OmniVoice 원격 모드 연결 — baseUrl 로 health 체크만 */
  async _connectOmniVoice() {
    const { getProvider: getCfg } = require('./tts-config');
    const cfg = getCfg('omnivoice');
    const baseUrl = cfg.baseUrl;

    if (!baseUrl) {
      this.logger('[TTS] OmniVoice 스킵 — 서버 URL 미설정 (🖧 서버 버튼에서 설정)');
      return;
    }

    const { OmniVoiceProvider } = require('./providers/omnivoice-provider');
    const provider = new OmniVoiceProvider({ baseUrl });
    this.logger(`[TTS] OmniVoice 연결 중... (${baseUrl})`);
    const ok = await provider.init();
    if (ok) {
      this.providers.set('omnivoice', provider);
      this.logger('[TTS] OmniVoice 연결 완료');
    } else {
      this.logger('[TTS] OmniVoice 연결 실패 (서버 미기동 또는 모델 로딩 중)');
    }
  }

  /** Supertonic-3 로컬 CPU 모드 연결 — baseUrl 로 health 체크만 */
  async _connectSupertonic() {
    const { getProvider: getCfg } = require('./tts-config');
    const cfg = getCfg('supertonic');
    const baseUrl = cfg.baseUrl;

    if (!baseUrl) {
      this.logger('[TTS] Supertonic 스킵 — 서버 URL 미설정');
      return;
    }

    const { SupertonicProvider } = require('./providers/supertonic-provider');
    const provider = new SupertonicProvider({ baseUrl });
    this.logger(`[TTS] Supertonic 연결 중... (${baseUrl})`);
    const ok = await provider.init();
    if (ok) {
      this.providers.set('supertonic', provider);
      this.logger('[TTS] Supertonic 연결 완료');
    } else {
      this.logger('[TTS] Supertonic 연결 실패 (백엔드 미기동 또는 모델 로딩 중)');
    }
  }

  /**
   * 외부에서 secret/baseUrl 변경 후 특정 provider 재초기화
   */
  async refreshProvider(id) {
    const existing = this.providers.get(id);
    if (existing && typeof existing.stop === 'function') {
      try { await existing.stop(); } catch {}
    }
    this.providers.delete(id);

    if (id === 'omnivoice') {
      await this._connectOmniVoice();
      return this.isAvailable(id);
    }

    if (id === 'supertonic') {
      await this._connectSupertonic();
      return this.isAvailable(id);
    }

    if (id === 'gemini') {
      try {
        const { GeminiProvider } = require('./providers/gemini-provider');
        const p = new GeminiProvider();
        const ok = await p.init();
        if (ok) {
          this.providers.set(id, p);
          this.logger(`[TTS] ${id} 재초기화 완료`);
          return true;
        }
        this.logger(`[TTS] ${id} 재초기화 — 인증 정보 부족`);
        return false;
      } catch (e) {
        this.logger(`[TTS] ${id} 재초기화 실패: ${e.message}`);
        return false;
      }
    }
    return false;
  }

  async stop() {
    for (const p of this.providers.values()) {
      if (typeof p.stop === 'function') {
        try { await p.stop(); } catch {}
      }
    }
    this.providers.clear();
    this._started = false;
  }

  /** provider 가 즉시 사용 가능한지 */
  isAvailable(id) {
    const p = this.providers.get(id);
    return !!(p && p.ready);
  }

  getProvider(id) {
    return this.providers.get(id) || null;
  }

  /** UI 가 보여줄 활성 provider 목록 */
  listAvailable() {
    return Array.from(this.providers.entries())
      .filter(([_, p]) => p.ready)
      .map(([id, p]) => ({ id, label: p.label || id }));
  }

  /**
   * 텍스트 → 오디오 buffer.
   * @param {string} text
   * @param {object} opts - { provider, voice, speed, ... }
   */
  async synthesize(text, opts = {}) {
    // 첫 호출(앱 시작 직후) 은 서버 동기화를 기다림 — 다른 노트북에서 LAN 으로 갱신된 사전 반영.
    // 이후 호출은 fire-and-forget (TTL 60초 안이면 refresh 도 스킵).
    if (this._dictRefreshAt === 0) {
      await this._maybeRefreshDictAsync();
    } else {
      this._maybeRefreshDictAsync();
    }
    // 순서: 사용자 사전 먼저 → 일반 정규화. 사전이 항상 우선되어 사용자 명시 발음이
    // 자동 숫자 변환에 덮이지 않게 보장 (예: 사전 "6월"→"유월" 이 정규화 "6월"→"육월"
    // 보다 우선되어야 한다).
    const { applyOmniVoiceDict, normalizeForTTS } = require('./text-pronouncer');
    const dictApplied = applyOmniVoiceDict(text, this._dictCache);
    const processed = normalizeForTTS(dictApplied);
    const id = opts.provider || 'omnivoice';
    const p = this.providers.get(id);
    if (!p || !p.ready) {
      throw new Error(`TTS provider '${id}' not available`);
    }
    return await p.synthesize(processed, opts);
  }

  /** 모달 저장 직후 호출 — 메모리 캐시를 즉시 디스크 최신값으로 교체 */
  invalidateDict() {
    this._dictRefreshAt = 0;
    try {
      const OmniDictStore = require('./omnivoice-dict-store');
      this._dictCache = OmniDictStore.loadAll();
    } catch (_) {
      this._dictCache = [];
    }
  }

  async _maybeRefreshDictAsync() {
    const now = Date.now();
    if (now - this._dictRefreshAt < this._DICT_TTL_MS) return;
    this._dictRefreshAt = now;
    try {
      const OmniDictStore = require('./omnivoice-dict-store');
      await OmniDictStore.refresh();
      this._dictCache = OmniDictStore.loadAll();
    } catch (_) {}
  }
}

// 모듈 레벨 싱글톤
let _instance = null;
function getInstance(opts) {
  if (!_instance) {
    _instance = new TTSManager(opts);
  } else if (opts && opts.logger && typeof opts.logger === 'function') {
    _instance.logger = opts.logger;
  }
  return _instance;
}

module.exports = { TTSManager, getInstance };
