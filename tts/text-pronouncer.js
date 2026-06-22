/**
 * OmniVoice 합성 직전 텍스트 발음 치환
 * - 프로젝트 사전 우선, 글로벌 사전 후순위
 * - 같은 source 면 프로젝트 사전이 우선
 * - source 길이가 긴 항목 먼저 매칭 (substring 치환 순서 보장)
 */

'use strict';

/**
 * @param {string} text        원본 텍스트
 * @param {Array}  globalDict  [{source, pron, enabled}]  글로벌 사전
 * @returns {string}
 */
function applyOmniVoiceDict(text, globalDict) {
  const entries = (globalDict || []).filter(e => e.source && e.pron && e.enabled !== false);
  // 긴 source 먼저 매칭
  entries.sort((a, b) => b.source.length - a.source.length);
  let out = String(text || '');
  for (const { source, pron } of entries) {
    out = out.split(source).join(pron);
  }
  return out;
}

/**
 * 0 ~ 9999 정수를 한자어 한국어 숫자로 변환.
 * 예: 12 → "십이", 100 → "백", 2024 → "이천이십사"
 * 5자리 이상(만 단위 +)은 그대로 두고 caller 가 알아서 처리.
 */
function numToHangulSino(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '영';
  if (n < 0 || n > 9999) return String(n);
  const digits = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const units  = ['', '십', '백', '천'];
  const str = String(n);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const d = +str[i];
    if (d === 0) continue;
    const unit = units[str.length - 1 - i];
    if (d === 1 && unit) {
      // 일+단위 는 단위 단독으로 (예: 100→"백", 10→"십")
      result += unit;
    } else {
      result += digits[d] + unit;
    }
  }
  return result;
}

/**
 * 한자어 단위(년/월/일/회/등/번/세기/세대/세/분/초/도/위/대) 뒤 아라비아 숫자를
 * 한국어 한자어 숫자로 변환. OmniVoice 모델이 아라비아 숫자를 "십 십이년" 같은
 * 이상한 발음으로 합성하는 문제 회피.
 *
 * 변환 단위 화이트리스트 (한자어 숫자가 자연스러운 단위만 — 명/개/마리/살 같은
 * 고유어 단위는 제외해서 부작용 방지):
 *   년 · 월 · 일 · 회 · 차 · 등 · 번 · 호 · 위 · 도(°/도) · 분 · 초 · 세기 · 세대 · 세
 *
 * 예: "12년 전" → "십이년 전",  "1418년" → "천사백십팔년",  "3월 5일" → "삼월 오일"
 */
function _convertSinoNumbersBeforeUnits(text) {
  // 단위 패턴: 한 글자 또는 두 글자 단위. 더 긴 단위 우선 매칭(세기/세대 > 세) 위해 정렬.
  const UNITS = ['세기', '세대', '년', '월', '일', '회', '차', '등', '번', '호', '위', '도', '분', '초', '세'];
  // 정렬: 긴 것 먼저
  const unitsAlt = UNITS.slice().sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`(\\d{1,4})(?=(?:${unitsAlt})\\b|(?:${unitsAlt})[^가-힣A-Za-z0-9])`, 'g');
  return text.replace(re, (m, num) => numToHangulSino(parseInt(num, 10)));
}

/**
 * TTS 합성 직전 일반 정규화 — 사전 적용 다음에 호출 (사용자 명시 사전이 항상 우선).
 * - 숫자 ~ 숫자  →  숫자에서 숫자  (반각 ~ / wave dash 〜 / 전각 ～ 모두 처리)
 *   예: "50~60명" → "50에서 60명"
 * - 한자어 단위(년/월/일 등) 앞 아라비아 숫자 → 한국어 한자어 숫자로 변환
 *   예: "12년 전" → "십이년 전"  (OmniVoice 가 안정적으로 발음)
 */
function normalizeForTTS(text) {
  let out = String(text || '');
  out = out.replace(/(\d+)\s*[~〜～]\s*(\d+)/g, '$1에서 $2');
  out = _convertSinoNumbersBeforeUnits(out);
  return out;
}

module.exports = { applyOmniVoiceDict, normalizeForTTS, numToHangulSino };
