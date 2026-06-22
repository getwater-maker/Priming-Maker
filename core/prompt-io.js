/**
 * prompt-io.js — 이미지/영상 프롬프트 내보내기·가져오기·API 자동작성 (PrimingFlow 포팅)
 *
 *  - buildPromptRequestText(project, {styleName}) : 그룹별 대본 요청서(웹 LLM 붙여넣기용) 생성
 *  - applyPromptsToProject(project, text)         : LLM 답변 파싱 → g.imagePrompt/videoPrompt 매핑(+안전 치환)
 *  - callLlmTextApi(provider, key, promptText)    : Gemini/Claude/OpenAI 텍스트 API 직접 호출
 *
 * Shots-maker 는 main 프로세스가 권위 데이터(Project)를 보유하므로 이 모듈은 main 에서 호출.
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── 🛡 안전 치환 규칙 (콘텐츠 필터 + 유튜브 수익화 안전) ──────────────
const PROMPT_SAFE_RULES = [
  [/\bworst traitors?\b/gi, 'controversial figure'],
  [/\bworst (?:person|man|figure|ruler|king)(?: in power)?\b/gi, 'controversial figure'],
  [/\bworst\b/gi, 'controversial'],
  [/\btraitors?\b/gi, 'controversial figure'],
  [/\btreason(ous)?\b/gi, 'political conflict'],
  [/\bbetray(?:al|ed|ing|s)?\b/gi, 'turning away'],
  [/\bdictators?\b/gi, 'powerful ruler'],
  [/\bdictatorship\b/gi, 'authoritarian era'],
  [/\btyrants?\b/gi, 'stern ruler'],
  [/\btyrann(?:y|ical|ies)\b/gi, 'stern rule'],
  [/\bdespot(?:ic|ism)?\b/gi, 'stern ruler'],
  [/\boppress(?:ed|ion|ive|es|ing)?\b/gi, 'strict control'],
  [/\btyrannize(?:d|s)?\b/gi, 'rule sternly'],
  [/\bcorrupt(?:ion|ed|s|ing)?\b/gi, 'troubled'],
  [/\bsuffering\b/gi, 'hardship'],
  [/\bsuffer(?:ed|s)?\b/gi, 'endure hardship'],
  [/\bkill(?:ed|ing|s)?\b/gi, 'defeat'],
  [/\bmurder(?:ed|ing|s)?\b/gi, 'downfall'],
  [/\bassassinat(?:e|ed|ion)\b/gi, 'sudden downfall'],
  [/\bexecut(?:e|ed|ing|ion|ions)\b/gi, 'solemn punishment scene'],
  [/\bbehead(?:ed|ing|s)?\b/gi, 'solemn punishment scene'],
  [/\bmassacres?\b/gi, 'great upheaval'],
  [/\bslaughter(?:ed|ing|s)?\b/gi, 'great upheaval'],
  [/\btortur(?:e|ed|ing|es)\b/gi, 'harsh ordeal'],
  [/\btorment(?:ed|ing|s)?\b/gi, 'burdened'],
  [/\bbloody\b/gi, 'dramatic'],
  [/\bbloods?(?:hed|tained)?\b/gi, 'dramatic'],
  [/\bgore\b/gi, ''],
  [/\bcorpses?\b/gi, 'fallen figure'],
  [/\bdead bodies?\b/gi, 'fallen figure'],
  [/\bdead body\b/gi, 'fallen figure'],
  [/\bsuicide\b/gi, 'tragic end'],
  [/\bbeautiful (?:women|woman|girls?|ladies)\b/gi, 'court attendants'],
  [/\bpleasures?\b/gi, 'entertainment'],
  [/\bseduc(?:e|ed|tive|tion)\b/gi, 'charm'],
  [/\b(?:nude|naked)\b/gi, 'figure'],
  [/\bsexual(?:ly)?\b/gi, ''],
  [/\bconcubines?\b/gi, 'court ladies'],
  [/배신자/g, '문제적 인물'],
  [/처형|참수/g, '엄숙한 형벌 장면'],
  [/학살|도륙/g, '대혼란'],
  [/유혈|피투성이/g, '극적인'],
  [/시신|시체/g, '쓰러진 인물'],
  [/고문/g, '시련'],
  [/독재자|폭군/g, '강압적 통치자'],
  [/독재|폭정/g, '강압적 통치'],
  [/탄압|억압/g, '강한 통제'],
  [/부패/g, '혼란'],
  [/고통|괴롭힘/g, '고난'],
];

function sanitizeImagePrompt(text) {
  if (!text) return { text, changed: [] };
  let out = String(text);
  const changed = [];
  for (const [re, rep] of PROMPT_SAFE_RULES) {
    const hits = out.match(re);
    if (hits && hits.length) {
      changed.push(...hits.map((h) => h.trim()).filter(Boolean));
      out = out.replace(re, rep);
    }
  }
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').trim();
  return { text: out, changed: [...new Set(changed.map((s) => s.toLowerCase()))] };
}

// ── 요청서 생성 (그룹 = 이미지 1장) ─────────────────────
// projects: Project[] (한 파일의 여러 편). 헤더는 편-그룹 복합 라벨 `## [쇼츠-그룹]` 로 충돌 방지.
// 영상(🎬) 줄은 g.isI2V 그룹에만 요청. styleName 있으면 화풍 안내.
function buildPromptRequestText(projects, opts = {}) {
  const list = Array.isArray(projects) ? projects : [projects];
  const styleName = (opts.styleName || '').trim();
  // 모드 인식 — 롱폼(16:9 가로) vs 쇼츠(9:16 세로). 프로젝트의 mode/aspect 에서 판정.
  const isLf = !!(list[0] && list[0].mode === 'longform');
  const aspect = (list[0] && list[0].aspect) || (isLf ? '16:9' : '9:16');
  const kind = isLf ? '롱폼' : '쇼츠';
  const L = [];
  L.push(`# 이미지 프롬프트 요청 — Priming (${kind} ${aspect})`);
  L.push('');
  L.push('아래 각 그룹(= 이미지 1장)에 대해 **영어 이미지 생성 프롬프트**를 작성해 주세요. **(영상)** 표시 그룹은 **영어 영상 모션 프롬프트**도 함께 작성합니다.');
  L.push('');
  L.push('규칙:');
  L.push(isLf
    ? '- 결과물은 가로 **16:9 롱폼(가로형)**입니다 — 인물·배경을 가로로 넓게 배치한 **와이드(landscape) 구도**로, 좌우 여백과 배경을 살려 묘사하세요.'
    : '- 결과물은 세로 **9:16 쇼츠(세로형)**입니다 — 인물·핵심 피사체를 **중앙**에 두고 **세로(portrait) 구도**로 묘사하세요.');
  L.push('- **🕰 시대·배경 명시 (필수)**: 대본 전체 맥락에서 시대·시기·장소·문화권을 스스로 판단해, 모든 프롬프트에 그 시대 배경을 **영어로 일관되게** 명시하세요 (예: `Joseon Dynasty Korea`, `Korean people with black hair`). 모든 그룹에서 같은 시대·동일 인물을 유지하세요.');
  L.push('- 전체 대본 맥락을 고려해 **등장인물의 성별·나이·외모·복장을 명시**하고, 모든 그룹에서 동일 인물은 동일하게 유지하세요.');
  L.push('- 각 프롬프트는 그 그룹 장면을 시각적으로 묘사하세요 (인물·배경·구도·분위기·조명). 영어로 작성.');
  L.push('- **🛡 안전 필터 회피**: 생성기 필터에 걸리는 단어(traitor·kill·blood·execution·massacre·torture·suicide·corpse 등)는 직접 쓰지 말고 **시각적 장면·표정·분위기·조명**으로만 표현하세요.');
  L.push('- **🛡 유튜브 수익화 안전(필수)**: 유혈·시신·잔혹·고문·선정성·혐오 상징·실제 인물 비방 금지. 폭력·비극은 실루엣·그림자·뒷모습·여운으로 상징적으로 표현하고, 인물은 다치지 않은 온전한 모습으로 그리세요.');
  L.push(`- 화풍(스타일)은 앱이 자동으로 입힙니다${styleName ? ` (현재 스타일: "${styleName}")` : ''} — 화풍 키워드는 생략해도 됩니다.`);
  L.push('- **(영상)** 표시 그룹은 이미지를 영상으로 변환합니다. `영상:` 줄에 **영어 영상 모션 프롬프트**를 쓰되 반드시 역동적으로 움직이도록: ① 카메라워크(slow push-in, dolly, orbit, tilt) ② 인물·사물 동작 ③ 환경 생동감(바람·먼지·불씨·눈). 속도/강도(slow/gentle vs fast/intense)도 명시. 표시 없는 그룹의 `영상:` 줄은 생략 가능.');
  L.push('- **출력 형식**: 아래 `## [편-그룹] 라벨` 헤더를 그대로 두고(예: `## [1-2]`), 각 헤더 아래에 다음 두 줄로 적어 주세요. 다른 설명/번호는 넣지 마세요.');
  L.push('    이미지: <영어 이미지 프롬프트>');
  L.push('    영상: <영어 영상 모션 프롬프트 — (영상) 그룹만>');
  L.push('');
  L.push('---');
  L.push('');
  for (const project of list) {
    const sn = project.shortsNum;
    L.push(isLf ? `# ── ${kind} ──` : `# ── ${kind} ${sn} ──`);
    L.push('');
    for (const g of project.groups) {
      // 청크 생성 — onlyKeys(Set<"sn-num">) 지정 시 그 그룹만 요청서에 포함 (긴 대본 분할용).
      if (opts.onlyKeys && !opts.onlyKeys.has(`${sn}-${g.num}`)) continue;
      const gnum2 = String(g.num).padStart(2, '0');
      const isVid = !!g.isI2V;
      const label = (isLf ? `그룹 ${gnum2}` : `${kind} ${sn} · 그룹 ${gnum2}`) + (isVid ? ' (영상)' : '') + (g.phase ? ` — ${g.phase}` : '');
      L.push(`## [${sn}-${g.num}] ${label}`);
      const full = project.getSentencesOfGroup(g)
        .map((s) => String(s.text || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean).join(' ');
      L.push(`- 대본: ${full}`);
      L.push('');
      L.push('이미지: (여기에 영어 이미지 프롬프트)');
      if (isVid) L.push('영상: (여기에 영어 영상 모션 프롬프트 — 역동적 카메라워크 + 인물 동작 + 환경 움직임)');
      L.push('');
    }
  }
  return L.join('\n');
}

// ── LLM 답변 파싱 → 그룹 매핑 (편-그룹 복합 라벨 `## [쇼츠-그룹]`) ──────
function applyPromptsToProjects(projects, text) {
  const list = Array.isArray(projects) ? projects : [projects];
  const strip = (s) => String(s || '').replace(/^["'`*\s]+|["'`*\s]+$/g, '').trim();
  // 플레이스홀더/빈값/모델이 흔히 쓰는 "없음" 표기(N/A·none·없음·- 등) → 프롬프트로 취급 안 함.
  const isPlaceholder = (s) => !s || /여기에|placeholder|<.*프롬프트.*>/i.test(s)
    || /^(n\s*\/?\s*a|none|없음|생략|해당\s*없음|x|-+|\.+)$/i.test(String(s).trim());
  const re = /##\s*\[(\d+)-(\d+)\][^\n]*\n([\s\S]*?)(?=\n##\s*\[\d+-\d+\]|$)/g;
  let m, groups = 0, img = 0, vid = 0;
  const sanitized = [];
  while ((m = re.exec(text)) !== null) {
    const sn = parseInt(m[1], 10);
    const num = parseInt(m[2], 10);
    const lines = (m[3] || '').split('\n').map((l) => l.trim());
    let imgP = '', vidP = '', mm;
    for (const l of lines) {
      if ((mm = l.match(/^[-*]?\s*(?:이미지|image)\s*[:：]\s*(.+)$/i))) imgP = strip(mm[1]);
      else if ((mm = l.match(/^[-*]?\s*(?:영상|비디오|video|motion)\s*[:：]\s*(.+)$/i))) vidP = strip(mm[1]);
    }
    if (!imgP && !vidP) {
      const cleaned = lines.filter((l) => l && !/^[-*]?\s*대본\s*[:：]/.test(l) && !/여기에.*프롬프트/.test(l)
        && l !== '---' && !/^```/.test(l) && !/^##/.test(l));
      imgP = strip(cleaned.join(' '));
    }
    if (isPlaceholder(imgP)) imgP = '';
    if (isPlaceholder(vidP)) vidP = '';
    const pr = list.find((p) => p.shortsNum === sn);
    const g = pr && pr.groups.find((x) => x.num === num);
    if (!g) continue;
    let did = false;
    if (imgP) { const s = sanitizeImagePrompt(imgP); if (s.changed.length) sanitized.push(`쇼츠${sn} #${num} 이미지: ${s.changed.join(', ')}`); g.imagePrompt = s.text; img++; did = true; }
    if (vidP) { const s2 = sanitizeImagePrompt(vidP); if (s2.changed.length) sanitized.push(`쇼츠${sn} #${num} 영상: ${s2.changed.join(', ')}`); g.videoPrompt = s2.text; g.isI2V = true; vid++; did = true; }
    if (did) groups++;
  }
  return { groups, img, vid, sanitized };
}

// ── LLM 텍스트 API ──────────────────────────────────────
const LLM_TEXT_MODELS = { gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-4-5', openai: 'gpt-4o', ollama: 'gemma4:latest' };

// http/https 둘 다 지원 (Ollama 는 로컬 http) — timeout 조절 가능
function postJsonAny(urlStr, headers, bodyObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('잘못된 URL: ' + urlStr)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
    const opts = {
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {}),
      timeout: timeoutMs,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, json, raw: data }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`요청 시간 초과(${Math.round(timeoutMs / 1000)}초)`)); });
    req.write(payload);
    req.end();
  });
}

function httpsPostJson(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('잘못된 URL: ' + urlStr)); return; }
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
    const opts = {
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {}),
      timeout: 120000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, json, raw: data }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('요청 시간 초과(120초)')); });
    req.write(payload);
    req.end();
  });
}

async function callLlmTextApi(provider, key, promptText, opts = {}) {
  const model = opts.model || LLM_TEXT_MODELS[provider];
  if (provider === 'ollama') {
    // 로컬/원격(Tailscale) Ollama — GPU 서버(이 PC)에서 실행. API 키 불필요.
    const base = String(opts.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const url = `${base}/api/chat`;
    const r = await postJsonAny(url, {}, {
      model: model || 'gemma4:latest', stream: false,
      // num_ctx: 청크 입력 + 출력이 기본 컨텍스트(2~4K)를 넘어 잘리는 문제 방지(12K). num_predict: 출력 충분히.
      options: { temperature: 0.7, num_ctx: 12288, num_predict: 4096 },
      messages: [{ role: 'user', content: promptText }],
    }, 600000); // LLM 생성 — 3060 오프로딩 대비 넉넉히(10분)
    if (r.status !== 200) throw new Error(`Ollama ${r.status}: ${(r.json && r.json.error) || (r.raw || '').slice(0, 300)}`);
    const text = (r.json && r.json.message && r.json.message.content) || '';
    if (!text) throw new Error('Ollama 응답에 텍스트가 없습니다 (모델명/서버주소 확인)');
    return text;
  }
  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await httpsPostJson(url, {}, { contents: [{ parts: [{ text: promptText }] }] });
    if (r.status !== 200) throw new Error(`Gemini API ${r.status}: ${(r.json && r.json.error && r.json.error.message) || (r.raw || '').slice(0, 300)}`);
    const text = (r.json && r.json.candidates && r.json.candidates[0] && r.json.candidates[0].content && r.json.candidates[0].content.parts || []).map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini 응답에 텍스트가 없습니다 (안전필터 차단 가능)');
    return text;
  }
  if (provider === 'claude') {
    const url = 'https://api.anthropic.com/v1/messages';
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const r = await httpsPostJson(url, headers, { model, max_tokens: 8192, messages: [{ role: 'user', content: promptText }] });
    if (r.status !== 200) throw new Error(`Claude API ${r.status}: ${(r.json && r.json.error && r.json.error.message) || (r.raw || '').slice(0, 300)}`);
    const text = ((r.json && r.json.content) || []).map((b) => b.text || '').join('') || '';
    if (!text) throw new Error('Claude 응답에 텍스트가 없습니다');
    return text;
  }
  if (provider === 'openai') {
    const url = 'https://api.openai.com/v1/chat/completions';
    const r = await httpsPostJson(url, { Authorization: `Bearer ${key}` }, { model, messages: [{ role: 'user', content: promptText }] });
    if (r.status !== 200) throw new Error(`OpenAI API ${r.status}: ${(r.json && r.json.error && r.json.error.message) || (r.raw || '').slice(0, 300)}`);
    const text = (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || '';
    if (!text) throw new Error('OpenAI 응답에 텍스트가 없습니다');
    return text;
  }
  throw new Error('알 수 없는 provider: ' + provider);
}

module.exports = { buildPromptRequestText, applyPromptsToProjects, sanitizeImagePrompt, callLlmTextApi, LLM_TEXT_MODELS };
