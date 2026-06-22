/**
 * caption-splitter.js — 한 문장 → Vrew 클립(자막 줄) 배열.
 *
 * 규칙:
 *   1. 쉼표(, ， 、)에서 끊는다 (쉼표는 앞 줄에 유지).
 *   2. 어절(띄어쓰기 토큰, 조사 포함)은 절대 쪼개지 않는다. 한 어절이 maxChars 를 넘으면
 *      그 어절만 한 줄(넘쳐도 1줄 유지 — "다." 같은 한 글자 고아 방지).
 *   3. 한 줄은 글자수(공백·문장부호 제외) maxChars(기본 7) 이하.
 *   4. 줄을 나눌 땐 줄 길이를 **균형**있게(최대 줄길이 최소화) — 의미 단위가 잘 살아남.
 *   5. 접속부사(그런데/그리고/하지만…)가 첫 어절이면 단독 줄.
 *
 * 글자수 카운트는 한글·영숫자만 (공백/쉼표/마침표/느낌표/물음표 제외).
 */

const CONNECTIVES = new Set([
  '그런데', '그리고', '하지만', '그러나', '그래서', '그러니', '그러면', '그러므로',
  '한편', '또한', '그래도', '그리하여', '즉', '결국', '따라서', '왜냐하면',
  '그렇지만', '다만', '반면', '오히려', '그러다', '그리고는', '게다가', '하물며',
]);

function meaningfulLen(s) {
  const m = String(s).match(/[가-힣A-Za-z0-9]/g);
  return m ? m.length : 0;
}

// 어절 배열 → 줄 배열. 줄 수 최소 + 최대 줄길이 최소(균형). 어절은 쪼개지 않음.
function wrapWords(words, maxChars) {
  const n = words.length;
  if (!n) return [];
  const w = words.map(meaningfulLen);
  const memo = new Array(n + 1);
  memo[n] = { lines: 0, maxLen: 0, cuts: [] };
  for (let i = n - 1; i >= 0; i--) {
    let best = null, sum = 0;
    for (let j = i; j < n; j++) {
      sum += w[j];
      const single = (j === i);
      if (sum > maxChars && !single) break;      // 여러 어절 줄은 max 초과 불가
      const rest = memo[j + 1];
      const cand = { lines: 1 + rest.lines, maxLen: Math.max(sum, rest.maxLen), cuts: [j + 1, ...rest.cuts] };
      if (!best || cand.lines < best.lines || (cand.lines === best.lines && cand.maxLen < best.maxLen)) best = cand;
      if (single && sum > maxChars) break;        // 긴 단일 어절: 그 어절만 한 줄
    }
    memo[i] = best;
  }
  const lines = []; let start = 0;
  for (const end of memo[0].cuts) { lines.push(words.slice(start, end).join(' ')); start = end; }
  return lines;
}

function splitCaptionLines(text, maxChars = 7) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return [];
  const segs = t.split(/(?<=[,，、])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const seg of segs) {
    let words = seg.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const first = words[0].replace(/[,，、.!?]+$/, '');
    if (words.length > 1 && CONNECTIVES.has(first)) { out.push(words[0]); words = words.slice(1); }
    out.push(...wrapWords(words, maxChars));
  }
  return out.length ? out : [t];
}

module.exports = { splitCaptionLines, meaningfulLen };

if (require.main === module) {
  const tests = [
    '그런데 같은 통금이라도, 매의 무게가 시각마다 달랐습니다.',
    '초저녁엔 가볍게, 깊은 밤엔 더 무겁게 다스렸지요.',
    '그 거리를 지킨 것은, 밤새 도는 순라군이라는 사람들이었습니다.',
  ];
  let i = 0;
  for (const t of tests) {
    console.log('\n' + t);
    splitCaptionLines(t, 7).forEach((l) => console.log(`  ${String(++i).padStart(2, '0')} | ${l}`));
  }
}
