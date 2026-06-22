/**
 * API 키 저장/로드
 * 위치: ~/.flow-app/tts-secrets.json
 *
 * 1차: 평문 저장 (PrimingFlow 단독 사용 가정).
 * 추후 강화: AES 암호화 또는 Windows Credential Manager.
 *
 * 사용:
 *   SecretStore.set('azure', { key: 'xxx', region: 'eastasia' });
 *   const s = SecretStore.get('azure');
 *   SecretStore.has('gemini');
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET_DIR = path.join(os.homedir(), '.flow-app');
const SECRET_PATH = path.join(SECRET_DIR, 'tts-secrets.json');

function loadAll() {
  try {
    if (fs.existsSync(SECRET_PATH)) {
      return JSON.parse(fs.readFileSync(SECRET_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[secret-store] 로드 실패:', e.message);
  }
  return {};
}

function saveAll(data) {
  try {
    fs.mkdirSync(SECRET_DIR, { recursive: true });
    fs.writeFileSync(SECRET_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[secret-store] 저장 실패:', e.message);
    return false;
  }
}

function get(providerId) {
  const all = loadAll();
  return all[providerId] || null;
}

function set(providerId, secret) {
  const all = loadAll();
  all[providerId] = secret;
  return saveAll(all);
}

function remove(providerId) {
  const all = loadAll();
  delete all[providerId];
  return saveAll(all);
}

function has(providerId) {
  const s = get(providerId);
  return !!(s && Object.keys(s).length > 0);
}

module.exports = { get, set, remove, has, SECRET_PATH };
