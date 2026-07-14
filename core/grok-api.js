'use strict';
// core/grok-api.js — xAI Grok Imagine 비디오 API (image-to-video). 브라우저 없이 REST.
//   제출: POST https://api.x.ai/v1/videos/generations
//     body { model:'grok-imagine-video', prompt, image(base64 data URI), duration(1~15), aspect_ratio, resolution }
//     → { request_id }
//   폴링: GET https://api.x.ai/v1/videos/{request_id} → { status: done|pending|failed|expired, video:{ url } }
//   인증: Authorization: Bearer <xAI 키>  (secret-store 'xai'). 사용량 과금 — 브라우저 Grok(SuperGrok) 구독과 별개.
//   ⚠ image 필드 형식(base64 vs URL)이 공식 문서에 명시가 약해 base64 data URI 로 보냄 — 실측 후 조정 가능.
const fs = require('fs');
const path = require('path');

function xaiKey() { try { return (require('../tts/secret-store').get('xai') || {}).key || ''; } catch { return ''; } }
function _mime(p) { const e = path.extname(p).toLowerCase(); return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg'; }
function _aspect(a) { return (a === '16:9' || a === '1:1' || a === '9:16') ? a : '16:9'; }

// image→video 1개. { success, url } | { success:false, error, limitReached? }
async function generateVideo({ imagePath, prompt, aspect, durationSec, key, logger = () => {}, abortSignal, timeoutMs = 420000 }) {
  key = key || xaiKey();
  if (!key) return { success: false, error: 'xAI API 키 없음 (⚙에서 설정)' };
  let image;
  try { const buf = fs.readFileSync(imagePath); image = `data:${_mime(imagePath)};base64,${buf.toString('base64')}`; }
  catch (e) { return { success: false, error: '이미지 읽기 실패: ' + e.message }; }
  const body = { model: 'grok-imagine-video', prompt: String(prompt || 'natural slow motion, cinematic feel'), image, aspect_ratio: _aspect(aspect), resolution: '720p' };
  if (durationSec) body.duration = Math.max(1, Math.min(15, Math.round(durationSec)));
  let reqId;
  try {
    const r = await fetch('https://api.x.ai/v1/videos/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
    if (!r.ok) return { success: false, error: `xAI ${r.status}: ${(j.error && (j.error.message || j.error)) || txt.slice(0, 200)}`, limitReached: r.status === 429 };
    reqId = j.request_id || j.id;
    if (!reqId) return { success: false, error: 'request_id 없음: ' + txt.slice(0, 200) };
  } catch (e) { return { success: false, error: '제출 실패: ' + String((e && e.message) || e) }; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal && abortSignal()) return { success: false, error: '중단됨' };
    await new Promise((res) => setTimeout(res, 3000));
    try {
      const r = await fetch(`https://api.x.ai/v1/videos/${reqId}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      const j = await r.json();
      const st = String(j.status || '').toLowerCase();
      if (st === 'failed' || st === 'expired') return { success: false, error: `xAI 작업 ${st}` };
      if (st === 'done' && j.video && j.video.url) return { success: true, url: j.video.url };
    } catch {}
  }
  return { success: false, error: `타임아웃 (${Math.round(timeoutMs / 1000)}초)` };
}

// image→video → mp4 파일. { success, videoPath } | { success:false, error }
async function generateVideoToFile(opts) {
  const r = await generateVideo(opts);
  if (!r.success) return r;
  try {
    const res = await fetch(r.url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) return { success: false, error: `영상 다운로드 실패 (${res.status})` };
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, Buffer.from(await res.arrayBuffer()));
    return { success: true, videoPath: opts.outputPath };
  } catch (e) { return { success: false, error: '다운로드 실패: ' + String((e && e.message) || e) }; }
}
function hasKey() { return !!xaiKey(); }
module.exports = { generateVideo, generateVideoToFile, hasKey, xaiKey };
