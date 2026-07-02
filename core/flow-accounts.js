'use strict';

/**
 * flow-accounts.js — Google Flow 멀티계정 순환 (~/.priming-maker/flow-accounts.json)
 *
 * 계정 1개 = 브라우저 프로필 1개(`~/.flow-app/profiles/<id>`). 각 프로필에 한 번씩 직접 로그인.
 * 순환 정책(보수적): 한 계정의 **오늘 사용량이 일일 한도(dailyCap)에 도달하면** 다음 계정으로 넘어간다.
 *   (배치마다 휙휙 바꾸지 않음 — 사람 같은 사용 패턴 유지가 목적)
 *
 * 저장: { accounts:[{id,label}], dailyCap, counts:{ id:{date,n} } }
 * 계정 미등록 시 'default' 단일 계정으로 폴백(기존 동작과 동일).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.priming-maker');
const FILE = path.join(DIR, 'flow-accounts.json');
const DEFAULTS = { accounts: [], dailyCap: 45, counts: {} };

function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function load() {
  try { if (fs.existsSync(FILE)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) {}
  return { ...DEFAULTS };
}
function save(c) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c, null, 2), 'utf8'); } catch (e) {}
  return c;
}
// 등록된 계정이 없으면 'default' 단일 계정으로 폴백.
function _accounts(c) {
  return (c.accounts && c.accounts.length) ? c.accounts : [{ id: 'default', label: '기본 계정' }];
}
function countToday(c, id) {
  const e = c.counts && c.counts[id];
  return (e && e.date === _today()) ? (e.n || 0) : 0;
}

// 차단/일시한도로 '쿨다운' 중인지 — cooldownUntil(ms) 이 미래면 잠시 쉬는 중.
function _cooling(c, id) {
  const e = c.counts && c.counts[id];
  return !!(e && e.date === _today() && e.cooldownUntil && Date.now() < e.cooldownUntil);
}
// 사용 가능 = 오늘 한도 미도달 + 쿨다운 아님.
function _available(c, id) {
  return countToday(c, id) < c.dailyCap && !_cooling(c, id);
}
function list() {
  const c = load();
  return { dailyCap: c.dailyCap, accounts: _accounts(c).map((a) => ({ ...a, used: countToday(c, a.id), available: _available(c, a.id), cooling: _cooling(c, a.id) })) };
}
function add(label) {
  const c = load();
  const id = 'flow-' + Date.now().toString(36);
  const accs = (c.accounts && c.accounts.length) ? c.accounts.slice() : [];
  accs.push({ id, label: String(label || '').trim() || `계정 ${accs.length + 1}` });
  c.accounts = accs;
  save(c);
  return { id };
}
function remove(id) {
  const c = load();
  c.accounts = (c.accounts || []).filter((a) => a.id !== id);
  if (c.counts && c.counts[id]) delete c.counts[id];
  save(c);
}
function rename(id, label) {
  const c = load();
  const accs = (c.accounts && c.accounts.length) ? c.accounts.slice() : [];
  const a = accs.find((x) => x.id === id);
  if (a) { a.label = String(label || '').trim() || a.label; c.accounts = accs; save(c); }
}
function setCap(n) {
  const c = load();
  c.dailyCap = Math.max(1, parseInt(n, 10) || 45);
  save(c);
  return c.dailyCap;
}
function markUsed(id, k = 1) {
  const c = load();
  const e = c.counts && c.counts[id];
  const sameDay = e && e.date === _today();
  const n = (sameDay ? (e.n || 0) : 0) + (parseInt(k, 10) || 0);
  c.counts = c.counts || {};
  c.counts[id] = { date: _today(), n, ...(sameDay && e.cooldownUntil ? { cooldownUntil: e.cooldownUntil } : {}) };
  save(c);
  return n;
}
// 오늘 사용 가능한 첫 계정 반환(한도 미도달 + 쿨다운 아님). 전부 불가면 null.
function pickActive() {
  const c = load();
  for (const a of _accounts(c)) {
    if (_available(c, a.id)) return a;
  }
  return null;
}
// 차단(비정상활동)/일시 한도 → 짧은 '쿨다운'(기본 30분). 하루 캡을 채우지 않으므로
//   0장 생성한 계정을 하루 종일 '소진'으로 태우지 않는다(오늘 카운트 n 은 그대로 유지).
function cooldown(id, minutes = 30) {
  const c = load();
  c.counts = c.counts || {};
  const cur = (c.counts[id] && c.counts[id].date === _today()) ? c.counts[id] : { date: _today(), n: 0 };
  cur.date = _today();
  cur.cooldownUntil = Date.now() + Math.max(1, parseInt(minutes, 10) || 30) * 60000;
  c.counts[id] = cur;
  save(c);
  return cur.cooldownUntil;
}
// 오늘 카운트·쿨다운 초기화 — id 지정 시 그 계정만, 없으면 전체. (잘못 소진된 계정 복구용)
function resetToday(id) {
  const c = load();
  c.counts = c.counts || {};
  if (id) delete c.counts[id];
  else c.counts = {};
  save(c);
  return list();
}

module.exports = { load, save, list, add, remove, rename, setCap, markUsed, pickActive, cooldown, resetToday, FILE };
