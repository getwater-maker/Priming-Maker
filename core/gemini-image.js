// core/gemini-image.js
// ─────────────────────────────────────────────────────────────────────────────
// Nano Banana 2 Lite (Gemini 이미지 API)로 이미지 생성 — 브라우저 없이 API 로.
//   즉시 모드: generateContent(responseModalities:['IMAGE']) → 인라인 base64 이미지.
//   배치 모드: (예정) Gemini Batch API — 50% 저렴, 비동기 제출→회수.
// 모델명은 설정 가능(gemini-image-config). 기본 'gemini-3.1-flash-lite-image'(2026-06 출시).
// 키는 secret-store 'gemini'(음성 Gemini·프롬프트 API 와 공용).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_PATH = path.join(os.homedir(), '.shots-maker', 'gemini-image-config.json');
const DEFAULTS = {
  model: 'gemini-3.1-flash-lite-image',    // Nano Banana 2 Lite (공식 pricing 페이지 확인, 최저가·배치지원). ⚙에서 변경 가능.
  sendAspect: true,                        // generationConfig.imageConfig.aspectRatio 전송(미지원 모델이면 끄기)
};
function loadConfig() {
  try { const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); return { ...DEFAULTS, ...(j || {}) }; } catch { return { ...DEFAULTS }; }
}
function saveConfig(patch) {
  const cur = loadConfig(); const next = { ...cur, ...(patch || {}) };
  try { fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true }); fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2)); } catch {}
  return next;
}
function geminiKey() {
  try { return (require('../tts/secret-store').get('gemini') || {}).key || ''; } catch { return ''; }
}

// 즉시 이미지 생성 1장 → { ok, buffer, ext } | { ok:false, error }
async function generateImage({ prompt, aspect, key, model, sendAspect, timeoutMs = 120000 }) {
  key = key || geminiKey();
  if (!key) return { ok: false, error: 'Gemini API 키 없음 (⚙에서 설정)' };
  const cfg = loadConfig();
  model = model || cfg.model;
  const useAspect = sendAspect != null ? sendAspect : cfg.sendAspect;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const genCfg = { responseModalities: ['IMAGE'] };
  if (useAspect && aspect) genCfg.imageConfig = { aspectRatio: aspect };   // 예: '16:9' | '9:16' | '1:1'
  const body = { contents: [{ parts: [{ text: String(prompt || '') }] }], generationConfig: genCfg };
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await res.text();
    let json = {}; try { json = JSON.parse(txt); } catch {}
    if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${(json.error && json.error.message) || txt.slice(0, 200)}` };
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!img) return { ok: false, error: '이미지 응답 없음: ' + txt.slice(0, 200) };
    const mime = img.inlineData.mimeType || 'image/png';
    const ext = /jpe?g/i.test(mime) ? 'jpg' : (/webp/i.test(mime) ? 'webp' : 'png');
    return { ok: true, buffer: Buffer.from(img.inlineData.data, 'base64'), ext };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 즉시 이미지 생성 → 파일로 저장. { ok, path } | { ok:false, error }
async function generateImageToFile({ prompt, aspect, outPathNoExt, key, model }) {
  const r = await generateImage({ prompt, aspect, key, model });
  if (!r.ok) return r;
  const outPath = outPathNoExt + '.' + r.ext;
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, r.buffer); }
  catch (e) { return { ok: false, error: '저장 실패: ' + String((e && e.message) || e) }; }
  return { ok: true, path: outPath };
}

function hasKey() { return !!geminiKey(); }

// ── 배치 모드 (Gemini Batch API, 인라인 요청) — 50% 저렴, 최대 24h(보통 2~4h). 제출→회수 분리 ──
//   requests: [{ key, prompt, aspect }]. 입력(프롬프트)은 작아 인라인으로 충분(<20MB).
async function submitBatch({ requests, model, key, sendAspect, displayName, timeoutMs = 180000 }) {
  key = key || geminiKey();
  if (!key) return { ok: false, error: 'Gemini API 키 없음 (⚙에서 설정)' };
  if (!requests || !requests.length) return { ok: false, error: '요청이 비어있음' };
  const cfg = loadConfig();
  model = model || cfg.model;
  const useAspect = sendAspect != null ? sendAspect : cfg.sendAspect;
  const inline = requests.map((r) => {
    const genCfg = { responseModalities: ['IMAGE'] };
    if (useAspect && r.aspect) genCfg.imageConfig = { aspectRatio: r.aspect };
    return { request: { contents: [{ parts: [{ text: String(r.prompt || '') }] }], generationConfig: genCfg }, metadata: { key: String(r.key) } };
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchGenerateContent?key=${encodeURIComponent(key)}`;
  const body = { batch: { display_name: (displayName || 'priming-batch').slice(0, 120), input_config: { requests: { requests: inline } } } };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const txt = await res.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
    if (!res.ok) return { ok: false, error: `Gemini batch ${res.status}: ${(j.error && j.error.message) || txt.slice(0, 200)}` };
    const name = j.name || (j.metadata && j.metadata.name);
    if (!name) return { ok: false, error: '배치 name 없음: ' + txt.slice(0, 200) };
    return { ok: true, batchName: name, model, count: inline.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// 배치 상태 조회 + (완료 시) 결과 이미지 추출. { ok, state, done, results:[{key, ok, buffer, ext}|{key, ok:false, error}] }
async function checkBatch({ batchName, key, timeoutMs = 180000 }) {
  key = key || geminiKey();
  if (!key) return { ok: false, error: 'Gemini API 키 없음' };
  const url = `https://generativelanguage.googleapis.com/v1beta/${batchName}?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const txt = await res.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
    if (!res.ok) return { ok: false, error: `Gemini batch status ${res.status}: ${(j.error && j.error.message) || txt.slice(0, 200)}` };
    const state = (j.metadata && j.metadata.state) || j.state || (j.done ? 'JOB_STATE_SUCCEEDED' : 'JOB_STATE_RUNNING');
    const done = /SUCCEEDED|FAILED|CANCELLED|EXPIRED/i.test(state);
    const results = [];
    const inlined = (j.response && (j.response.inlinedResponses || j.response.inlineResponses)) || [];
    for (let i = 0; i < inlined.length; i++) {
      const item = inlined[i] || {};
      const k = (item.metadata && item.metadata.key) || item.key || String(i);
      if (item.error) { results.push({ key: k, ok: false, error: item.error.message || 'error' }); continue; }
      const parts = ((((item.response || {}).candidates || [])[0] || {}).content || {}).parts || [];
      const img = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!img) { results.push({ key: k, ok: false, error: '이미지 응답 없음' }); continue; }
      const mime = img.inlineData.mimeType || 'image/png';
      const ext = /jpe?g/i.test(mime) ? 'jpg' : (/webp/i.test(mime) ? 'webp' : 'png');
      results.push({ key: k, ok: true, buffer: Buffer.from(img.inlineData.data, 'base64'), ext });
    }
    return { ok: true, state, done, results };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = { generateImage, generateImageToFile, submitBatch, checkBatch, loadConfig, saveConfig, hasKey, CFG_PATH, DEFAULTS };
