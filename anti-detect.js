/**
 * AntiDetect — 단락·세션 레이어의 휴먼화 / 계정 보호
 *
 * 출처: Roy's Automator (Chrome 확장) 의 ANTI_DETECT 객체와 헬퍼들 (sidepanel.js)
 * 적용 대상: PrimingFlow 의 Google Flow / Vrew 자동화
 *
 * 타이핑 레이어 휴먼화는 flow-engine.js 의 _typePromptHumanized 가 이미 담당.
 * 이 모듈은 그 위 단락·세션 레이어 (단락 간 대기, 12개마다 쿨다운, 일일 한도) 를 채운다.
 *
 * 비활성화(enabled=false) 시 모든 헬퍼는 기존 코드의 고정값을 반환 → 즉시 원복.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR  = path.join(os.homedir(), '.flow-app');
const STATE_PATH = path.join(STATE_DIR, 'anti-detect-state.json');

// 강도 프리셋 — UI 에는 이 3개만 노출
const PRESETS = {
  순함: { mean: 10000, jitter: 4000, cooldownEvery: 8,  longPause: 0.05, longMin: 20000, longMax: 40000 },
  기본: { mean: 14000, jitter: 6000, cooldownEvery: 12, longPause: 0.10, longMin: 30000, longMax: 60000 },
  강함: { mean: 18000, jitter: 8000, cooldownEvery: 6,  longPause: 0.15, longMin: 45000, longMax: 90000 },
};

// 타이핑 후 → 생성 클릭 전 (Roy's: 3~8초)
const PRE_SUBMIT_MIN = 3000;
const PRE_SUBMIT_MAX = 8000;

// 12개마다 강제 쿨다운 (Roy's: 2~5분)
const COOLDOWN_MIN = 120000;
const COOLDOWN_MAX = 300000;

// 403 / Rate Limit 적응형 쿨다운 (Roy's: 2~5분)
const RATE_LIMIT_MIN = 120000;
const RATE_LIMIT_MAX = 300000;

// 비활성화 시 fallback — 기존 flow-engine.js 의 고정값과 동일
const FALLBACK = {
  humanDelay: 2000, // flow-engine.js:592
  preSubmit:  500,  // flow-engine.js:450
  rateLimit:  60000, // flow-engine.js:37
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class AntiDetect {
  constructor(opts = {}) {
    this.enabled        = opts.enabled        !== false;          // 기본 ON
    this.dailyLimit     = Number.isFinite(opts.dailyLimit) ? opts.dailyLimit : 50; // 0 = 무제한
    this.onLimitReached = opts.onLimitReached === 'stop' ? 'stop' : 'warn';        // 기본 경고만
    this.profileId      = (opts.profileId != null && String(opts.profileId)) || 'default'; // 계정별 카운팅 키
    this.logger         = typeof opts.logger === 'function' ? opts.logger : () => {};

    this.preset = PRESETS[opts.preset] ? opts.preset : '기본';
    this.cfg    = PRESETS[this.preset];

    this.sessionCount = 0; // 세션 카운터 (인스턴스 생명주기)
    this._loadState();
  }

  // ─── 상태 영속화 ─────────────────────────────────

  _loadState() {
    let saved = null;
    try {
      if (fs.existsSync(STATE_PATH)) {
        saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      }
    } catch (e) {
      this.logger(`[AntiDetect] 상태 파일 로드 실패: ${e.message} (초기화)`);
    }

    const today = todayKey();
    if (saved && saved.date === today && Number.isFinite(saved.todayCount)) {
      // profiles: 계정별 오늘 카운트 맵 (구버전 상태엔 없을 수 있음 → 빈 객체)
      this.state = { date: today, todayCount: saved.todayCount, profiles: (saved.profiles && typeof saved.profiles === 'object') ? saved.profiles : {} };
    } else {
      // 자정 롤오버 또는 첫 실행
      this.state = { date: today, todayCount: 0, profiles: {} };
    }
  }

  // 현재 프로필(계정)의 오늘 성공 이미지 장수
  profileCount() {
    return (this.state.profiles && this.state.profiles[this.profileId]) || 0;
  }

  // 이미지 1장을 성공적으로 저장했을 때 호출 — 계정별 '성공' 장수 증가 (계정당 하루 한도 + 표시용).
  // 실패/시도는 세지 않는다(사용자 정책: 성공한 것만 카운트).
  registerGenerationSuccess() {
    if (!this.state.profiles) this.state.profiles = {};
    this.state.profiles[this.profileId] = (this.state.profiles[this.profileId] || 0) + 1;
    this._persist();
    return this.state.profiles[this.profileId];
  }

  // 계정별 오늘 성공 장수 맵 스냅샷 (표시용). { date, profiles:{id:count} }
  getProfileCounts() {
    return { date: this.state.date, profiles: { ...(this.state.profiles || {}) } };
  }

  _persist() {
    const data = JSON.stringify({
      date: this.state.date,
      todayCount: this.state.todayCount,
      profiles: this.state.profiles || {},
      lastSavedAt: Date.now(),
    });
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // 비동기 저장 — 실패해도 throw 하지 않음 (자동화 본 흐름에 영향 X)
      fs.writeFile(STATE_PATH, data, 'utf-8', (err) => {
        if (err) this.logger(`[AntiDetect] 상태 저장 실패: ${err.message}`);
      });
    } catch (e) {
      this.logger(`[AntiDetect] 상태 저장 실패: ${e.message}`);
    }
  }

  // ─── 핵심 API ───────────────────────────────────

  // 단락 간 대기 — Box-Muller 가우시안 + 긴 대기 확률
  // 비활성화 시 2000ms (기존 flow-engine.js:592 의 값)
  getHumanDelay() {
    if (!this.enabled) return FALLBACK.humanDelay;
    const { mean, jitter, longPause, longMin, longMax } = this.cfg;

    // 확률적 긴 대기 (사용자가 잠깐 자리 비운 패턴)
    if (Math.random() < longPause) {
      const long = Math.round(longMin + Math.random() * (longMax - longMin));
      this.logger(`☕ 자연스러운 긴 대기 (${Math.round(long / 1000)}초)`);
      return long;
    }

    // Box-Muller 변환으로 정규분포 샘플
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const std = jitter / 2;
    let delay = Math.round(mean + gauss * std);
    delay = Math.max(mean - jitter, Math.min(mean + jitter, delay));
    return delay;
  }

  // 타이핑 후 → 생성 클릭 전 균등분포 대기
  // 비활성화 시 500ms (기존 flow-engine.js:450 의 값)
  getPreSubmitDelay() {
    if (!this.enabled) return FALLBACK.preSubmit;
    return Math.round(PRE_SUBMIT_MIN + Math.random() * (PRE_SUBMIT_MAX - PRE_SUBMIT_MIN));
  }

  // 403 / Rate Limit 감지 시 적응형 쿨다운 (균등분포 2~5분)
  // 비활성화 시 60000ms (기존 flow-engine.js:37 의 값)
  getRateLimitCooldown() {
    if (!this.enabled) return FALLBACK.rateLimit;
    return Math.round(RATE_LIMIT_MIN + Math.random() * (RATE_LIMIT_MAX - RATE_LIMIT_MIN));
  }

  // 생성 클릭 직전 호출 — 카운터 증가 + N개마다 쿨다운 결정
  // 반환: { cooldownMs, todayCount, sessionCount }
  registerGenerationStart() {
    this.sessionCount++;
    this.state.todayCount++;   // 전체(시도) 카운터 — 기존 글로벌 경고용
    this._persist();

    let cooldownMs = 0;
    if (this.enabled && this.sessionCount > 0 && this.sessionCount % this.cfg.cooldownEvery === 0) {
      cooldownMs = Math.round(COOLDOWN_MIN + Math.random() * (COOLDOWN_MAX - COOLDOWN_MIN));
    }
    return {
      cooldownMs,
      todayCount: this.state.todayCount,
      sessionCount: this.sessionCount,
    };
  }

  // run() 진입 시 호출 — 일일 한도 사전 체크
  checkDailyLimit() {
    const limit = this.dailyLimit;
    const reached = limit > 0 && this.state.todayCount >= limit;
    return {
      reached,
      remaining: limit > 0 ? Math.max(0, limit - this.state.todayCount) : Infinity,
      shouldStop: reached && this.onLimitReached === 'stop',
      todayCount: this.state.todayCount,
      profileCount: this.profileCount(),   // 현재 계정의 오늘 횟수
      limit,
    };
  }

  // 단락 처리 진입 시 호출 — 한도 도달 후 추가 진입 시 경고/중단 결정
  // 경고는 인스턴스 라이프사이클 동안 첫 초과 시 한 번만 (이후 침묵)
  beforeNextGeneration() {
    if (!this.enabled || this.dailyLimit <= 0) return { proceed: true };
    if (this.state.todayCount >= this.dailyLimit) {
      if (this.onLimitReached === 'stop') {
        return { proceed: false, reason: `일일 한도 ${this.dailyLimit}회 도달 — 자동 중지` };
      }
      if (this._dailyLimitWarned) return { proceed: true };
      this._dailyLimitWarned = true;
      return { proceed: true, warn: `⚠️ 일일 한도 ${this.dailyLimit}회 초과 (현재 ${this.state.todayCount}회) — 계정 안전 주의` };
    }
    return { proceed: true };
  }

  // UI 표시용 상태 스냅샷
  getStatus() {
    return {
      enabled: this.enabled,
      preset: this.preset,
      dailyLimit: this.dailyLimit,
      todayCount: this.state.todayCount,
      sessionCount: this.sessionCount,
    };
  }
}

module.exports = { AntiDetect, PRESETS, STATE_PATH };
