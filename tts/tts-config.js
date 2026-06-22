/**
 * TTS 서버 설정 — provider 별 baseUrl 보관 (로컬 spawn 모드 폐지)
 * 위치: ~/.flow-app/tts-config.json
 *
 * 구조:
 * {
 *   "omnivoice":  { "baseUrl": "http://192.168.219.157:9881" },
 *   "supertonic": { "baseUrl": "http://127.0.0.1:9882" }
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const CONFIG_PATH = path.join(STORE_DIR, 'tts-config.json');

const DEFAULTS = {
  omnivoice:  { baseUrl: 'http://127.0.0.1:9881' },
  supertonic: { baseUrl: 'http://127.0.0.1:9882' },
};

function loadAll() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch (e) {
    console.error('[tts-config] 로드 실패:', e.message);
  }
  return { ...DEFAULTS };
}

function saveAll(cfg) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[tts-config] 저장 실패:', e.message);
    return false;
  }
}

function getProvider(id) {
  return loadAll()[id] || DEFAULTS[id] || { baseUrl: '' };
}

function setProvider(id, patch) {
  const all = loadAll();
  // mode 필드는 폐기됨 — 무시
  const { mode: _ignore, ...rest } = patch || {};
  all[id] = { ...(all[id] || DEFAULTS[id] || {}), ...rest };
  return saveAll(all);
}

module.exports = { loadAll, saveAll, getProvider, setProvider, CONFIG_PATH, DEFAULTS };
