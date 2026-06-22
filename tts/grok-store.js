/**
 * Grok Imagine 비디오 변환 설정 store.
 * 위치: ~/.flow-app/grok-config.json
 *
 * 저장 항목:
 *   - profileId               : Grok 자동화에 쓸 X 계정 프로필 (Flow 와 별개로 분리 가능)
 *   - defaultMotionPrompt     : 모션 프롬프트 비워뒀을 때 fallback
 *   - videoQuality            : 'standard' | 'hd' (Grok 옵션, 미정 — 페이지 분석 후 확정)
 *   - maxDailyVideos          : 하루 한도 (X Premium 정책 고려)
 *
 *   - todayCount              : 오늘 처리한 수
 *   - lastDate                : 'YYYY-MM-DD' — 날짜 바뀌면 todayCount 리셋
 *
 *   - lastUsedAt              : 마지막 호출 시각 (휴먼 딜레이 계산용)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'grok-config.json');

const DEFAULTS = {
  profileId: 'default',
  defaultMotionPrompt: 'dynamic cinematic camera movement, smooth push-in, subjects and environment in natural motion (wind, drifting dust and embers), lively energetic feel',
  videoResolution: '720p',     // '480p' | '720p' (사용자 정책: 720p 기본)
  videoDuration:   '10s',      // '6s' | '10s' (사용자 정책: 10s 기본)
  videoAspect:     '16:9 Widescreen',  // '16:9 Widescreen' | '9:16 Vertical' | '1:1 Square' | '2:3 Tall' | '3:2 Wide'
  // 모션 프롬프트 타이핑 속도 — 글자당 고정 ms (길이와 무관하게 일관). 'fast'|'normal'|'slow'|'instant'
  typingSpeed:     'normal',
  // v1.13.42: 사용자 요청으로 기본값 0(무제한) 로 변경. 0 이상 양수면 그 값이 일일 한도.
  // 0 으로 두면 checkDailyLimit() 가 항상 통과 — Grok 측 자체 한도/차단만 신뢰.
  maxDailyVideos: 0,
  todayCount: 0,
  lastDate: '',
  lastUsedAt: 0,
};

function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      const merged = { ...DEFAULTS, ...data };

      // v1.13.48: 1회성 마이그레이션 — v1.13.42 의 무제한(0) 정책이 코드 DEFAULTS 만
      // 바뀌고 기존 사용자 파일은 옛 한도값(예: 30, 50) 그대로였던 함정 해소.
      // _v48_migrated 플래그 없으면 maxDailyVideos > 0 인 옛 값을 0(무제한)으로 강제.
      // 사용자가 명시적으로 한도 걸고 싶으면 마이그레이션 후 파일 다시 수정하면 됨.
      if (!merged._v48_migrated) {
        if (merged.maxDailyVideos > 0) {
          merged.maxDailyVideos = 0;
        }
        merged._v48_migrated = true;
        save(merged);
      }

      // 날짜가 바뀌었으면 todayCount 리셋
      if (merged.lastDate !== _today()) {
        merged.todayCount = 0;
        merged.lastDate = _today();
        save(merged);
      }
      return merged;
    }
  } catch (e) {
    console.error('[grok-store] 로드 실패:', e.message);
  }
  const seed = { ...DEFAULTS, lastDate: _today(), _v48_migrated: true };
  save(seed);
  return seed;
}

function save(cfg) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[grok-store] 저장 실패:', e.message);
    return false;
  }
}

function update(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  save(next);
  return next;
}

/** 일일 한도 안에 있는지 확인 + 초과 시 사유 반환.
 *  v1.13.42: maxDailyVideos === 0 이면 무제한 (anti-detect 모듈의 dailyLimit=0 패턴과 동일). */
function checkDailyLimit() {
  const cfg = load();
  if (cfg.maxDailyVideos > 0 && cfg.todayCount >= cfg.maxDailyVideos) {
    return {
      allowed: false,
      reason: `일일 한도 초과 (${cfg.todayCount}/${cfg.maxDailyVideos}) — 내일 다시 시도하거나 maxDailyVideos 를 늘리세요 (0 = 무제한)`,
      cfg,
    };
  }
  return { allowed: true, cfg };
}

/** 한 번 사용 기록 */
function markUsed() {
  const cur = load();
  return update({
    todayCount: cur.todayCount + 1,
    lastUsedAt: Date.now(),
  });
}

module.exports = { load, save, update, checkDailyLimit, markUsed, STORE_PATH, DEFAULTS };
