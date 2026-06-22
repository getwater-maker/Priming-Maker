/**
 * Genspark AI 이미지 생성 설정 store.
 * 위치: ~/.flow-app/genspark-config.json
 *
 * Genspark (genspark.ai/ai_image, Nano Banana 2) 브라우저 자동화용 설정.
 * grok-store.js 와 같은 패턴 (외부사이트 자동화 + 일일 한도 + 프로필 분리).
 *
 * 저장 항목:
 *   - profileId   : Genspark 자동화에 쓸 크롬 프로필 (Flow/Grok 과 별개로 분리 가능)
 *   - imageSize   : 이미지 크기 — '자동' | '0.5K' | '1K' | '2K' | '4K' (사용자 정책: 1K 고정)
 *   - ratio       : 종횡비 — '16:9' | '9:16' | '1:1' 등 (사용자 정책: 16:9 고정, 롱폼)
 *   - autoPrompt  : 자동 프롬프트 토글 — 반드시 false (우리가 만든 프롬프트를 그대로 입력)
 *   - maxDaily    : 하루 한도 (0 = 무제한 — Genspark 측 자체 한도/차단만 신뢰)
 *
 *   - todayCount  : 오늘 처리한 수
 *   - lastDate    : 'YYYY-MM-DD' — 날짜 바뀌면 todayCount 리셋
 *   - lastUsedAt  : 마지막 호출 시각 (휴먼 딜레이 계산용)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'genspark-config.json');

const DEFAULTS = {
  profileId: 'default',
  imageSize: '1K',     // 사용자 정책: 1K 고정
  ratio: '16:9',       // 사용자 정책: 16:9 고정 (롱폼)
  autoPrompt: false,   // 반드시 OFF — 우리 프롬프트를 그대로 입력
  batchSize: 6,        // 한 번에 제출할 프롬프트 수 (줄바꿈 나열 → N장 동시 생성). 1 이면 단일 모드.
                       // ⚠️ Genspark 은 한 번에 6장까지만 생성하고 그 이상은 "더 만들까요?" 확인을 물어
                       //    자동화가 멈춤 → 6 이하로 강제(load 에서 clamp). (2026-06-01 사용자 확인)
  // 0(무제한) 기본. 0 이상 양수면 그 값이 일일 한도.
  // 0 으로 두면 checkDailyLimit() 가 항상 통과 — Genspark 측 자체 한도/차단만 신뢰.
  maxDaily: 0,
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

      // batchSize 안전 클램프 — Genspark 1회 생성 한도(6장) 초과 방지 (기존 설정파일이 10이어도 6으로).
      merged.batchSize = Math.min(6, Math.max(1, parseInt(merged.batchSize, 10) || 6));

      // 날짜가 바뀌었으면 todayCount 리셋
      if (merged.lastDate !== _today()) {
        merged.todayCount = 0;
        merged.lastDate = _today();
        save(merged);
      }
      return merged;
    }
  } catch (e) {
    console.error('[genspark-store] 로드 실패:', e.message);
  }
  const seed = { ...DEFAULTS, lastDate: _today() };
  save(seed);
  return seed;
}

function save(cfg) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[genspark-store] 저장 실패:', e.message);
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
 *  maxDaily === 0 이면 무제한. */
function checkDailyLimit() {
  const cfg = load();
  if (cfg.maxDaily > 0 && cfg.todayCount >= cfg.maxDaily) {
    return {
      allowed: false,
      reason: `일일 한도 초과 (${cfg.todayCount}/${cfg.maxDaily}) — 내일 다시 시도하거나 maxDaily 를 늘리세요 (0 = 무제한)`,
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
