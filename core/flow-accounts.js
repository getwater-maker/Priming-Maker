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

function list() {
  const c = load();
  return { dailyCap: c.dailyCap, accounts: _accounts(c).map((a) => ({ ...a, used: countToday(c, a.id) })) };
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
  const n = ((e && e.date === _today()) ? (e.n || 0) : 0) + (parseInt(k, 10) || 0);
  c.counts = c.counts || {};
  c.counts[id] = { date: _today(), n };
  save(c);
  return n;
}
// 오늘 한도가 안 찬 첫 계정 반환. 전부 소진이면 null.
function pickActive() {
  const c = load();
  for (const a of _accounts(c)) {
    if (countToday(c, a.id) < c.dailyCap) return a;
  }
  return null;
}

module.exports = { load, save, list, add, remove, rename, setCap, markUsed, pickActive, FILE };
