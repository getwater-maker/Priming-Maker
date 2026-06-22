'use strict';

/**
 * image-rotation.js — 이미지 생성 "순환(rotation)" 설정 (~/.priming-maker/image-rotation.json)
 *
 * 한 엔진이 한도(Genspark 5시간/일일캡, Flow 계정 한도)에 걸리면 남은 이미지를 다음 엔진이 이어받는다.
 *   - 순환 풀: order 순서대로 시도, enabled=false 인 엔진은 제외.
 *   - ComfyUI 는 순환에서 제외(한국사 부적합) — 별도 단독 선택용. 추후 엔진 추가 시 order/enabled 에 넣으면 합류.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.priming-maker');
const CONFIG_PATH = path.join(STORE_DIR, 'image-rotation.json');

const DEFAULTS = {
  order: ['genspark', 'flow'],           // 기본 순서: Genspark → Flow
  enabled: { genspark: true, flow: true },
};

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { order: j.order || DEFAULTS.order, enabled: { ...DEFAULTS.enabled, ...(j.enabled || {}) } };
    }
  } catch (e) { /* ignore */ }
  return { order: [...DEFAULTS.order], enabled: { ...DEFAULTS.enabled } };
}

function save(patch) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const next = { ...load(), ...(patch || {}) };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) { return load(); }
}

// 활성(enabled) 엔진을 order 순서로. startEngine 이 주어지면 그 엔진을 맨 앞으로(사용자 선택 우선).
function activeOrder(startEngine) {
  const c = load();
  let list = (c.order || []).filter((e) => c.enabled && c.enabled[e] !== false);
  if (startEngine && list.includes(startEngine)) list = [startEngine, ...list.filter((e) => e !== startEngine)];
  else if (startEngine && (startEngine === 'genspark' || startEngine === 'flow')) list = [startEngine, ...list.filter((e) => e !== startEngine)];
  return list;
}

module.exports = { load, save, activeOrder, CONFIG_PATH, DEFAULTS };
