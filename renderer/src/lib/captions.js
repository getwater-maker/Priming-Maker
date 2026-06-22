// 렌더러용 자막 분할 — core/caption-splitter 와 동일 규칙(어절 안 쪼갬, 균형 DP, 접속부사 단독).
export const CONNECTIVES = new Set(['그런데','그리고','하지만','그러나','그래서','그러니','그러면','그러므로','한편','또한','그래도','그리하여','즉','결국','따라서','왜냐하면','그렇지만','다만','반면','오히려','그러다','그리고는','게다가','하물며']);

export function mLen(s){ const m = String(s).match(/[가-힣A-Za-z0-9]/g); return m ? m.length : 0; }

function wrapWords(words, maxChars){
  const n = words.length; if(!n) return [];
  const w = words.map(mLen); const memo = new Array(n+1); memo[n] = { lines:0, maxLen:0, cuts:[] };
  for(let i=n-1;i>=0;i--){
    let best=null, sum=0;
    for(let j=i;j<n;j++){
      sum += w[j]; const single = (j===i);
      if(sum>maxChars && !single) break;
      const rest = memo[j+1];
      const cand = { lines:1+rest.lines, maxLen:Math.max(sum,rest.maxLen), cuts:[j+1,...rest.cuts] };
      if(!best || cand.lines<best.lines || (cand.lines===best.lines && cand.maxLen<best.maxLen)) best = cand;
      if(single && sum>maxChars) break;
    }
    memo[i] = best;
  }
  const lines=[]; let start=0;
  for(const end of memo[0].cuts){ lines.push(words.slice(start,end).join(' ')); start=end; }
  return lines;
}

export function splitLines(text, maxChars){
  const t = String(text||'').trim(); if(!t) return [];
  const segs = t.split(/(?<=[,，、])/).map(s=>s.trim()).filter(Boolean);
  const out=[];
  for(const seg of segs){
    let words = seg.split(/\s+/).filter(Boolean); if(!words.length) continue;
    const first = words[0].replace(/[,，、.!?]+$/,'');
    if(words.length>1 && CONNECTIVES.has(first)){ out.push(words[0]); words = words.slice(1); }
    out.push(...wrapWords(words, maxChars));
  }
  return out.length ? out : [t];
}
