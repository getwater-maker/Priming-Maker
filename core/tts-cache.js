'use strict';

/**
 * tts-cache.js — 문장 음성 캐시 (~/.shots-maker/tts-cache/)
 *
 * 같은 (문장 텍스트 + 배속 + 목소리 설정) 이면 재합성 없이 캐시 파일을 재활용한다.
 * 키 = sha1(text + speedFactor + 엔진/참조음성/시드/언어 등). 텍스트나 목소리가 바뀌면 키가 달라져
 * 자동으로 재합성된다(잘못된 재활용 방지).
 *
 * index.json: { <key>: { dur, ext, ts } }  — 캐시 파일의 음성 길이/확장자.
 * 캐시 파일: <key>.<ext> (mp3 또는 wav, 배속 적용된 최종본).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.shots-maker', 'tts-cache');
const INDEX = path.join(DIR, 'index.json');

function _idx() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; } }
function _saveIdx(x) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(x)); } catch {} }

// 캐시 키 — 텍스트 + 배속 + 목소리 정체성(엔진/참조음성/참조텍스트/시드/cfg/언어/instruct).
function keyFor(text, sf, opts = {}) {
  const sig = JSON.stringify({
    t: String(text || ''),
    sf: Number(sf) || 1,
    e: opts.provider || '',
    r: opts.refAudioPath || '',
    rt: opts.refText || '',
    sd: opts.seed != null ? opts.seed : '',
    cfg: opts.cfgValue != null ? opts.cfgValue : '',
    it: opts.inferenceTimesteps != null ? opts.inferenceTimesteps : '',
    lang: opts.language || '',
    ins: opts.instruct || '',
  });
  return crypto.createHash('sha1').update(sig).digest('hex');
}

// 캐시 적중 시 { file, dur, ext }, 없으면 null.
function get(key) {
  const e = _idx()[key];
  if (!e) return null;
  const file = path.join(DIR, `${key}.${e.ext}`);
  if (!fs.existsSync(file)) return null;
  return { file, dur: e.dur, ext: e.ext };
}

// 합성 결과를 캐시에 저장(파일 복사 + 인덱스 기록).
function put(key, srcPath, dur, ext) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(srcPath, path.join(DIR, `${key}.${ext}`));
    const idx = _idx();
    idx[key] = { dur, ext, ts: Date.now() };
    _saveIdx(idx);
  } catch {}
}

// 캐시 전체 삭제 — 'TTS삭제' 에서 호출(다음 변환이 캐시 재활용 없이 새로 합성되도록).
function clearAll() {
  let n = 0;
  try {
    if (fs.existsSync(DIR)) {
      for (const f of fs.readdirSync(DIR)) { try { fs.unlinkSync(path.join(DIR, f)); n++; } catch {} }
    }
  } catch {}
  try { _saveIdx({}); } catch {}
  return n;
}

module.exports = { keyFor, get, put, clearAll, DIR };
