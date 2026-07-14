'use strict';

/**
 * accounts.js — 서비스별 멀티계정 저장소 팩토리 (flow-accounts.js 와 동일 구조의 범용판).
 *   makeAccountStore('genspark') → ~/.priming-maker/genspark-accounts.json
 *   계정 1개 = 브라우저 프로필 1개(엔진의 profileId). 오늘 사용량이 dailyCap 도달 시 다음 계정으로.
 *   계정 미등록 시 'default' 단일 계정으로 폴백(기존 동작과 동일).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.priming-maker');

function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// defaultCap: 서비스별 기본 일일 한도. 0(또는 음수) = 무제한(앱이 막지 않고 엔진의 실제 한도 감지에만 의존).
//   Flow/Grok 은 45(구글·X 차단 예방), Genspark 은 0(Genspark 자체 한도 메시지로만 전환).
function makeAccountStore(service, idPrefix, defaultCap = 45) {
  const FILE = path.join(DIR, `${service}-accounts.json`);
  const DEFAULTS = { accounts: [], dailyCap: defaultCap, counts: {} };
  const prefix = idPrefix || service;

  function load() {
    try { if (fs.existsSync(FILE)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) {}
    return { ...DEFAULTS };
  }
  function save(c) {
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c, null, 2), 'utf8'); } catch (e) {}
    return c;
  }
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
    const id = prefix + '-' + Date.now().toString(36);
    const accs = (c.accounts && c.accounts.length) ? c.accounts.slice() : [];
    accs.push({ id, label: String(label || '').trim() || `계정 ${accs.length + 1}` });
    c.accounts = accs; save(c);
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
    const v = parseInt(n, 10);
    // 0 = 무제한 허용. 음수/비정상은 서비스 기본값으로.
    c.dailyCap = (Number.isFinite(v) && v >= 0) ? v : defaultCap;
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
  // 서비스 실제 한도 도달 시 재설정 시각까지 계정 잠금 — 엔진이 감지한 "N시에 재설정" 메시지 기반.
  //   쿨다운 중 계정은 pickActive/activeAccounts 에서 제외 → 순환이 접속 시도 없이 다음 엔진으로 직행.
  function setCooldown(id, untilTs) {
    const c = load();
    c.cooldowns = c.cooldowns || {};
    c.cooldowns[id] = untilTs;
    save(c);
    return untilTs;
  }
  function cooldownUntil(id) {
    const c = load();
    const t = c.cooldowns && c.cooldowns[id];
    return (t && t > Date.now()) ? t : 0; // 지난 쿨다운 = 0(해제)
  }
  function _cooling(c, id) {
    const t = c.cooldowns && c.cooldowns[id];
    return !!(t && t > Date.now());
  }
  function pickActive() {
    const c = load();
    const unlimited = !(c.dailyCap > 0); // dailyCap<=0 → 앱 캡 무제한
    for (const a of _accounts(c)) { if (!_cooling(c, a.id) && (unlimited || countToday(c, a.id) < c.dailyCap)) return a; }
    return null;
  }
  // 오늘 한도 안 찬 계정들(순서대로) — 순환에서 한 계정 소진 시 다음 계정으로.
  //   dailyCap<=0(무제한)이면 항상 모든 계정 활성 — 엔진이 실제 한도 메시지를 감지할 때만 전환.
  //   단, 쿨다운(실제 한도 재설정 대기) 중 계정은 무제한이어도 제외.
  function activeAccounts() {
    const c = load();
    const base = _accounts(c).filter((a) => !_cooling(c, a.id));
    if (!(c.dailyCap > 0)) return base;
    return base.filter((a) => countToday(c, a.id) < c.dailyCap);
  }

  return { load, save, list, add, remove, rename, setCap, markUsed, setCooldown, cooldownUntil, pickActive, activeAccounts, FILE };
}

module.exports = { makeAccountStore };
