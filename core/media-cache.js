'use strict';

/**
 * media-cache.js — 이미지/영상 재활용 캐시 (~/.shots-maker/media-cache/)
 *
 * 내용(프롬프트) 기반 캐시. 같은 그룹이라도 프롬프트가 같으면 재생성 없이 재활용.
 *   - 이미지 키 = sha1(imagePrompt + style + aspect + engine)
 *   - 영상  키 = sha1(videoPrompt + 원본이미지 내용해시 + aspect + engine)  ← i2v 는 원본 이미지에 의존
 *
 * H3 분할: 섹션=그룹이 고정이라 프롬프트가 안 바뀜 → 재활용 잘 됨.
 * 문장 분할: 그룹 내용이 바뀌면 프롬프트가 달라져 자동 재생성(잘못된 재활용 방지).
 *
 * index.json: { <key>: { ext, ts } }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.shots-maker', 'media-cache');
const INDEX = path.join(DIR, 'index.json');

function _idx() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; } }
function _saveIdx(x) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(x)); } catch {} }
function _sha(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function _fileHash(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}

function imageKey(prompt, style, aspect, engine) {
  return _sha(JSON.stringify({ k: 'img', p: String(prompt || ''), s: style || '', a: aspect || '', e: engine || '' }));
}
function videoKey(prompt, srcImagePath, aspect, engine) {
  return _sha(JSON.stringify({ k: 'vid', p: String(prompt || ''), img: _fileHash(srcImagePath), a: aspect || '', e: engine || '' }));
}

function get(key) {
  const e = _idx()[key];
  if (!e) return null;
  const file = path.join(DIR, `${key}.${e.ext}`);
  if (!fs.existsSync(file)) return null;
  return { file, ext: e.ext };
}
function put(key, srcPath, ext) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const e = (ext || path.extname(srcPath).slice(1) || 'png').toLowerCase();
    fs.copyFileSync(srcPath, path.join(DIR, `${key}.${e}`));
    const idx = _idx();
    idx[key] = { ext: e, ts: Date.now() };
    _saveIdx(idx);
  } catch {}
}
// 캐시 항목 삭제 — 재생성(regen) 시 옛 결과를 지워 새로 만들게 함.
function del(key) {
  try {
    const idx = _idx();
    const e = idx[key];
    if (e) { try { fs.unlinkSync(path.join(DIR, `${key}.${e.ext}`)); } catch {} delete idx[key]; _saveIdx(idx); }
  } catch {}
}

module.exports = { imageKey, videoKey, get, put, del, DIR };
