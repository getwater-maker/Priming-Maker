/**
 * Gemini API 사용량 일일 카운터.
 * 위치: ~/.flow-app/gemini-usage.json
 *
 * Google API 자체엔 quota 조회 endpoint 가 없어 클라이언트 측에서 직접 카운트.
 * 날짜가 바뀌면 자동 리셋 (로컬 자정 기준).
 *
 * 카운터 종류:
 *   tts_ok   : Gemini TTS 성공 호출 수
 *   tts_429  : Gemini TTS 한도 초과(429) 응답 수
 *   split_ok : ai-splitter Gemini 분할 성공 수
 *   split_429: ai-splitter Gemini 분할 429 수
 *   img_ok   : Gemini Image 생성 성공 수 (v1.13.49+)
 *   img_429  : Gemini Image 생성 429 수 (v1.13.49+)
 *
 * 사용:
 *   const Usage = require('./gemini-usage-store');
 *   Usage.bump('tts_ok');           // 성공 카운트 +1
 *   Usage.bump('tts_429');          // 429 카운트 +1
 *   const stats = Usage.todayStats();
 *   // → { date: '2026-05-09', tts_ok: 28, tts_429: 3, split_ok: 5, split_429: 0 }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'gemini-usage.json');

const VALID_KEYS = new Set(['tts_ok', 'tts_429', 'split_ok', 'split_429', 'img_ok', 'img_429']);

function _todayString() {
  // 로컬 자정 기준 YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function _emptyStats() {
  return { date: _todayString(), tts_ok: 0, tts_429: 0, split_ok: 0, split_429: 0, img_ok: 0, img_429: 0 };
}

function _load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      if (raw && raw.date === _todayString()) {
        return { ..._emptyStats(), ...raw, date: raw.date };
      }
    }
  } catch (_) {}
  return _emptyStats();
}

function _save(stats) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (_) {}
}

function bump(key) {
  if (!VALID_KEYS.has(key)) return;
  const s = _load();
  s[key] = (s[key] || 0) + 1;
  _save(s);
}

function todayStats() {
  return _load();
}

function reset() {
  _save(_emptyStats());
}

module.exports = { bump, todayStats, reset, STORE_PATH };
