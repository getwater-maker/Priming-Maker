'use strict';
// core/grok-cooldown.js — Grok(영상) 주간/요청 한도 쿨다운 기억 (~/.priming-maker/grok-cooldown.json).
//   한도 감지 시 재설정 시각을 저장 → 그 전엔 영상 생성 시도를 건너뜀(헛되이 브라우저 띄우지 않음).
//   앱 재시작해도 유지. Genspark 계정별 쿨다운과 같은 취지(단, Grok 은 단일).
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.priming-maker', 'grok-cooldown.json');
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } }
function save(d) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); } catch {} }
// 현재 유효 쿨다운 { until, label } — 지났으면 { until:0 }.
function get() { const d = load(); return (d.until && d.until > Date.now()) ? { until: d.until, label: d.label || '' } : { until: 0, label: '' }; }
function set(until, label) { if (until && until > Date.now()) save({ until, label: label || '', ts: Date.now() }); return until; }
function clear() { save({}); }
module.exports = { get, set, clear, FILE };
