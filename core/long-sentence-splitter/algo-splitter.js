/**
 * 긴 문장 알고리즘 분할기 (8단계)
 *
 * 입력: 한국어 긴 문장 1개 + maxChars (기본 30)
 * 출력: 여러 짧은 클립 [{text, weight}]  — vrew Ken Burns 단위
 *
 * 분할 우선순위:
 *   1. 쉼표(,) 기준
 *   2. 한국어 접속사 (그러나, 그래서, 하지만 ...)
 *   3. 연결어미 ~고/~며/~지만/~으나/~어서/~아서 ... 직후
 *   4. 띄어쓰기 기준 강제 분할 (최후 수단)
 *
 * 후처리:
 *   - 너무 짧은 클립 (<5자) 은 인접 클립과 병합
 *   - 너무 긴 클립 (>maxChars*1.5) 은 재귀 1회 분할
 *   - 결과가 빈 배열이면 원본 문장 그대로 반환
 *
 * AI 분할기 폴백 — ai-splitter.js 가 호출 실패 시 이 알고리즘 사용
 */

// 자주 쓰는 한국어 접속사 (절 단위 분할에 적합)
const CONNECTIVES = [
  '그러나', '그래서', '하지만', '그리고', '따라서', '또한',
  '한편', '다만', '다음으로', '이어서', '그러므로', '그런데',
  '즉', '게다가', '특히',
];

// 연결어미 (어절 끝). 분할 후에도 의미 보존되는 자연스러운 절단점.
//   ~고 ~며 ~지만 ~으나 ~어서 ~아서 ~으니 ~으면 ~으며 ~는데 ~지만은 ~으면서
const CONNECTIVE_TAILS = [
  '지만', '으나', '어서', '아서', '으니', '으면', '으며', '는데', '면서',
  '하고', '되고', '있고', '하며', '되며', '있으나', '있어서', '있는데',
];

// 관형형/명사형 어미 (어절 끝). 의미 흐름을 약하게 끊는 위치 — 마지막 수단보다 우선
//   ~는 ~던 ~한 ~된 ~였던 (관형형)
const SOFT_TAILS = ['는', '던', '한', '된', '였던', '하는', '되는', '있는', '없는'];

const MIN_CLIP_LEN = 5;        // 이보다 짧으면 인접 클립과 병합 (유효 글자 기준)
const SOFT_MAX_FACTOR = 1.0;   // maxChars 보다 길면 무조건 재귀 분할 (사용자 예시에 맞춤)

// 유효 글자수 — 한글/영숫자만. 띄어쓰기·구두점 제외.
function _meaningful(text) {
  if (!text) return 0;
  const m = String(text).match(/[가-힣A-Za-z0-9]/g);
  return m ? m.length : 0;
}

// 한국어 발음 시간 가중치 — TTS 음성의 시간 슬라이스 추정에 사용.
// 글자수 비례보다 받침/구두점/숫자 발음 길이 차이를 반영해 sub-clip 경계 싱크 정확도 향상.
//
// 가중치:
//   - 한글 받침 없음:   1.0
//   - 한글 받침 있음:   1.3   (종성 발음이 약 30% 더 김)
//   - 숫자 1자:         1.2   (한국어로 1음절 + 살짝 길게)
//   - 영문 1자:         0.6   (한국어 음절 1개에 비해 짧음)
//   - 공백:             0
//   - 구두점 ,.?!;:     0.4   (해당 위치 pause 시간)
//   - 그 외:            0
function koSpeechWeight(text) {
  if (!text) return 0;
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      // 한글 음절: 종성(받침) 인덱스 = (code - 0xAC00) % 28, 0 이면 받침 없음
      const finalCons = (code - 0xAC00) % 28;
      w += finalCons === 0 ? 1.0 : 1.3;
    } else if (ch >= '0' && ch <= '9') {
      w += 1.2;
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      w += 0.6;
    } else if (ch === ',' || ch === '.' || ch === '?' || ch === '!' || ch === ';' || ch === ':') {
      w += 0.4;
    }
    // 공백/특수기호 — 0
  }
  return w;
}

/**
 * @param {string} text
 * @param {number} maxChars - 클립 1개의 권장 최대 글자수 (기본 30)
 * @returns {Array<{text: string, weight: number}>}
 *   weight = 글자수 비율 (TTS 음성 길이 추정에 사용 가능, vrew 가 직접 안 씀)
 */
function splitLongSentenceAlgo(text, maxChars = 30) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  // 짧은 문장은 그대로 (유효 글자수 기준)
  if (_meaningful(trimmed) <= maxChars) return _toClips([trimmed]);

  let parts = _splitByComma(trimmed);

  // 쉼표만으로 부족하면 접속사 기준 분할
  if (parts.length === 1) parts = _splitByConnectives(trimmed);

  // 그래도 부족하면 연결어미 (~지만, ~으나, ~어서) 기준 분할
  if (parts.length === 1) parts = _splitByTails(trimmed, CONNECTIVE_TAILS);

  // 그래도 부족하면 관형형 어미 (~는, ~한, ~된) 기준 — 의미 살짝 끊기는 위치
  if (parts.length === 1) parts = _splitByTails(trimmed, SOFT_TAILS);

  // 그래도 부족하면 띄어쓰기 기준 강제 절반 분할
  if (parts.length === 1) parts = _splitByMidSpace(trimmed);

  // 너무 긴 클립은 재귀 분할.
  // 안전장치: 이번 단계에서 분할 진척이 없으면 (parts.length === 1) 재귀 금지 —
  // 모든 splitter 가 [text] 만 반환하는 입력(공백·구두점 없는 긴 단어 등)이 들어오면
  // 같은 문자열로 무한 재귀에 빠짐 (RangeError: Maximum call stack size exceeded).
  const madeProgress = parts.length > 1;
  const expanded = [];
  for (const p of parts) {
    if (madeProgress && _meaningful(p) > maxChars * SOFT_MAX_FACTOR) {
      const sub = splitLongSentenceAlgo(p, maxChars);
      if (sub.length > 1) expanded.push(...sub.map(c => c.text));
      else expanded.push(p);
    } else {
      expanded.push(p);
    }
  }

  // 너무 짧은 클립 병합 (유효 글자수 기준)
  const merged = _mergeShort(expanded, MIN_CLIP_LEN);

  return _toClips(merged.length > 0 ? merged : [trimmed]);
}

// ─── 내부 ─────────────────────────────────────────────

function _toClips(arr) {
  // weight = TTS 음성 시간 슬라이스 비율. 한국어 발음 시간 가중치 기반.
  const lens = arr.map(t => Math.max(0.1, koSpeechWeight(t)));
  const total = lens.reduce((s, n) => s + n, 0) || 1;
  return arr.map((t, i) => ({
    text: t.trim(),
    weight: lens[i] / total,
  })).filter(c => c.text.length > 0);
}

function _splitByComma(text) {
  return text.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
}

function _splitByConnectives(text) {
  const sorted = [...CONNECTIVES].sort((a, b) => b.length - a.length);
  for (const conn of sorted) {
    const re = new RegExp(`(^|\\s)(${conn})(?=\\s)`);
    const m = text.match(re);
    if (m && m.index !== undefined) {
      const cutIdx = m.index + (m[1] ? m[1].length : 0);
      const left = text.slice(0, cutIdx).trim();
      const right = text.slice(cutIdx).trim();
      // 분할점 좌·우 모두 유효 글자수 MIN_CLIP_LEN 이상이어야
      if (_meaningful(left) >= MIN_CLIP_LEN && _meaningful(right) >= MIN_CLIP_LEN) {
        return [left, right];
      }
    }
  }
  return [text];
}

function _splitByTails(text, tailList) {
  // 어절 끝의 어미 — 어절 단위로 검사 (단어 사이 공백 기준)
  const tokens = text.split(/\s+/);
  if (tokens.length <= 2) return [text];

  // 가능한 모든 분할점을 찾아서 가장 균형 잡힌 (유효 글자수 기준) 것 선택
  const candidates = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    for (const tail of tailList) {
      if (tok.endsWith(tail) && tok.length > tail.length) {
        const left = tokens.slice(0, i + 1).join(' ');
        const right = tokens.slice(i + 1).join(' ');
        const lL = _meaningful(left);
        const lR = _meaningful(right);
        if (lL >= MIN_CLIP_LEN && lR >= MIN_CLIP_LEN) {
          candidates.push({
            left, right,
            score: Math.abs(lL - lR),
          });
          break;
        }
      }
    }
  }
  if (candidates.length === 0) return [text];
  candidates.sort((a, b) => a.score - b.score);
  return [candidates[0].left, candidates[0].right];
}

function _splitByMidSpace(text) {
  // 정확히 가운데 띄어쓰기에서 강제 분할 (의미 손상 가능, 최후의 수단)
  const tokens = text.split(/\s+/);
  if (tokens.length <= 1) return [text];
  const mid = Math.ceil(tokens.length / 2);
  const left = tokens.slice(0, mid).join(' ');
  const right = tokens.slice(mid).join(' ');
  if (left && right) return [left, right];
  return [text];
}

function _mergeShort(arr, minLen) {
  const out = [];
  for (const p of arr) {
    if (out.length > 0 && _meaningful(p) < minLen) {
      out[out.length - 1] += ' ' + p;
    } else {
      out.push(p);
    }
  }
  // 마지막 클립이 너무 짧으면 직전 클립과 병합 (유효 글자수 기준)
  if (out.length >= 2 && _meaningful(out[out.length - 1]) < minLen) {
    out[out.length - 2] += ' ' + out.pop();
  }
  return out;
}

module.exports = { splitLongSentenceAlgo, koSpeechWeight };
