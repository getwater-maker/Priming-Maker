'use strict';

/**
 * ollama-config.js — 로컬/원격 Ollama LLM 설정 (~/.priming-maker/ollama-config.json)
 *
 * GPU 서버(이 PC, RTX3060)에서 Ollama 가 돌고, 이미지/영상 프롬프트를 그룹 내용에 맞게 자동 생성한다.
 * 다른 PC나 외부(노트북)에서 앱을 쓸 때는 baseUrl 만 GPU PC 의 LAN/Tailscale IP 로 바꾸면 된다.
 *   (Ollama 는 OLLAMA_HOST=0.0.0.0:11434 로 띄워 LAN 노출, 외부는 Tailscale IP 사용)
 *
 * 모델 선택(12GB / RTX3060 풀-GPU 기준):
 *   - gemma4:latest (=e4b, ≈9.6GB)  → VRAM 안에 다 올라감 → 빠름. 프롬프트 작성에 충분. (권장)
 *   - gemma4:26b   (≈17GB)          → 12GB 초과 → RAM 오프로딩 → 느림. (비권장)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.priming-maker');
const CONFIG_PATH = path.join(STORE_DIR, 'ollama-config.json');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434', // 다른 PC/외부에선 GPU PC 의 LAN(192.168.x.x) 또는 Tailscale(100.x.x.x) IP
  model: 'gemma4:latest',            // 12GB 풀-GPU 적정 (e4b ≈9.6GB). 26b 는 오프로딩=느림
};

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

module.exports = { load, save, CONFIG_PATH, DEFAULTS };
