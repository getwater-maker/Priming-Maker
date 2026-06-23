'use strict';

/**
 * lora-collect.js — LoRA 학습용 이미지 데이터셋 수집기.
 *
 * Genspark/Flow 로 만든 "한국사에 맞는" 이미지를 한 폴더에 (이미지 + 캡션.txt) 쌍으로 적립한다.
 *   - 캡션 = `<trigger>, <대본 이미지프롬프트>` (스타일은 트리거에 배게 하고 내용만 캡션에).
 *   - 중복 방지: 파일 내용 sha1 해시. 같은 이미지는 한 번만.
 *   - ComfyUI(SDXL) 결과는 수집하지 않음(학습 오염 방지) — 호출부에서 제외.
 *
 * 설정: ~/.priming-maker/lora-collect.json  { enabled, dir, trigger }
 * 데이터셋: <dir>/<hash>.<ext> + <hash>.txt + manifest.json
 *   (kohya 학습 시 <dir> 를 그대로 또는 `N_joseon` 폴더로 옮겨 사용)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_DIR = path.join(os.homedir(), '.priming-maker');
const CONFIG_PATH = path.join(STORE_DIR, 'lora-collect.json');
// 데이터셋 기본 폴더 — 사용자 지정(고정 위치). 설정(lora-collect.json)이 우선이며 이건 폴백 기본값.
//   D: 가 없으면 첫 수집 시 mkdir 실패(무시) → ⚙에서 폴더 변경 가능.
const DEFAULT_DIR = 'D:/Priming-Maker/lora-dataset';

const DEFAULTS = { enabled: true, dir: DEFAULT_DIR, trigger: 'joseon' };

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULTS };
}
function save(patch) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const next = { ...load(), ...(patch || {}) };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) { return load(); }
}

function _manifestPath(dir) { return path.join(dir, 'manifest.json'); }
function _loadManifest(dir) {
  try { const f = _manifestPath(dir); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  return { items: [] };
}
function _saveManifest(dir, m) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(_manifestPath(dir), JSON.stringify(m, null, 2), 'utf8'); } catch (e) {}
}

function count() {
  const cfg = load();
  return _loadManifest(cfg.dir).items.length;
}

// 캡션 정리 — 스타일/보일러플레이트 제거된 '내용 프롬프트'에 트리거를 앞에 붙임.
function buildCaption(trigger, prompt) {
  const body = String(prompt || '').replace(/,?\s*(no text|no watermark)\b/gi, '').replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  const t = String(trigger || 'joseon').trim();
  return body ? `${t}, ${body}` : t;
}

// 이미지 1장 적립. 같은 내용(해시)이면 skip. 성공 시 {added:true}.
function collect({ imagePath, prompt, styleId, script, num, engine }) {
  const cfg = load();
  if (!cfg.enabled) return { added: false, reason: 'disabled' };
  if (!imagePath || !fs.existsSync(imagePath)) return { added: false, reason: 'no-file' };
  let buf;
  try { buf = fs.readFileSync(imagePath); } catch (e) { return { added: false, reason: 'read-fail' }; }
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const dir = cfg.dir || DEFAULT_DIR;
  const m = _loadManifest(dir);
  if (m.items.some((it) => it.hash === hash)) return { added: false, reason: 'dup' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(imagePath) || '.png').toLowerCase().replace('.jpeg', '.jpg');
    const base = hash;
    fs.writeFileSync(path.join(dir, base + ext), buf);
    const caption = buildCaption(cfg.trigger, prompt);
    fs.writeFileSync(path.join(dir, base + '.txt'), caption, 'utf8');
    m.items.push({ hash, file: base + ext, caption, engine: engine || null, styleId: styleId || null, script: script || null, num: num || null });
    _saveManifest(dir, m);
    return { added: true, hash };
  } catch (e) { return { added: false, reason: e.message }; }
}

module.exports = { load, save, collect, count, buildCaption, CONFIG_PATH, DEFAULT_DIR };
