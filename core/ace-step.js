// core/ace-step.js
// ─────────────────────────────────────────────────────────────────────────────
// ACE-Step 음악 서버(ace-step/ace_step_server.py, 포트 9894)의 온디맨드 생명주기를
// 앱(메인 프로세스)에서 관리한다. Qwen 보이스디자인(core/qwen-design.js)과 동일 패턴.
//   start()    → venv 파이썬으로 서버 spawn(--cpu-offload) → /health loaded 대기(첫 실행은 모델 14GB 다운로드).
//   generate() → POST /generate {tags,lyrics,durationSec} → wav Buffer.
//   stop()     → POST /shutdown 후 프로세스 종료(= GPU VRAM 반납).
// 음악 생성 동안 앱은 TTS(OmniVoice)·Qwen 을 막아(뮤텍스, main.js) GPU 동시 사용을 피한다.
// cpu-offload: 연산은 GPU, 안 쓰는 가중치만 CPU RAM 에 얹어 VRAM 절약(OmniVoice 3.3GB 와 공존).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 9894;
const HOST = '127.0.0.1';

const S = { child: null, dir: null };

function _readCfgDir() {
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.shots-maker', 'ace-step-config.json'), 'utf8')); if (c && c.dir) return c.dir; } catch {}
  return null;
}
function _hasVenv(dir) { try { return !!dir && fs.existsSync(path.join(dir, 'venv', 'Scripts', 'python.exe')); } catch { return false; } }
function pythonExe(dir) { return path.join(dir, 'venv', 'Scripts', 'python.exe'); }

// ace-step 폴더 탐색: 설정 → 앱 옆(../ace-step) → D:\Priming-Maker\ace-step.
function resolveDir() {
  if (S.dir && _hasVenv(S.dir)) return S.dir;
  const cands = [_readCfgDir(), path.join(__dirname, '..', 'ace-step'), 'D:\\Priming-Maker\\ace-step'].filter(Boolean);
  for (const d of cands) { if (_hasVenv(d)) { S.dir = d; return d; } }
  for (const d of cands) { try { if (fs.existsSync(path.join(d, 'ace_step_server.py'))) { S.dir = d; return d; } } catch {} }
  return null;
}
function isInstalled() { const d = resolveDir(); return !!(d && _hasVenv(d)); }

function _get(pathname, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: pathname, timeout: timeoutMs }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
function _postJson(pathname, body, timeoutMs, binary = false) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: HOST, port: PORT, path: pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (binary && res.statusCode === 200) return resolve({ status: res.statusCode, buffer: raw });
        let json = {}; try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
        resolve({ status: res.statusCode, json, buffer: raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data); req.end();
  });
}
async function health() { try { const r = await _get('/health', 3000); return r.json || {}; } catch { return null; } }

// start: 이미 loaded 면 즉시 반환. 아니면 spawn 후 loaded 될 때까지 폴링(첫 실행은 모델 14GB 다운로드로 오래).
async function start(logger = () => {}, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const h0 = await health();
  if (h0 && h0.loaded) return { ok: true, reused: true };
  const dir = resolveDir();
  if (!dir) return { ok: false, error: 'ace-step 폴더를 찾을 수 없음(최초설치.bat 실행 필요)' };
  if (!_hasVenv(dir)) return { ok: false, error: `설치 안 됨 — ${path.join(dir, '1_최초설치.bat')} 를 먼저 실행하세요` };

  if (!(h0 && (h0.loaded || h0.loading))) {
    logger('🎵 ACE-Step 음악 서버 기동…');
    const child = spawn(pythonExe(dir), ['ace_step_server.py', '--port', String(PORT), '--cpu-offload'], {
      cwd: dir, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    S.child = child;
    child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && logger('  [ace] ' + l.trim())));
    child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && logger('  [ace] ' + l.trim())));
    child.on('exit', (code) => { logger(`🎵 ACE-Step 서버 종료(code ${code})`); if (S.child === child) S.child = null; });
  } else {
    logger('🎵 ACE-Step 서버 이미 로딩 중 — 대기…');
  }

  const t0 = Date.now(); let announced = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await health();
    if (h && h.error) return { ok: false, error: h.error };
    if (h && h.loaded) { logger('🎵 ACE-Step 준비 완료'); return { ok: true }; }
    if (h && h.loading && !announced) { announced = true; logger('🎵 음악 모델 로딩 중… (첫 실행은 14GB 다운로드로 오래 걸립니다)'); }
  }
  return { ok: false, error: 'ACE-Step 서버 준비 시간 초과' };
}

// generate: 곡 1개 → { ok, buffer(wav) } | { ok:false, error }. 음악 생성은 오래 걸려 timeout 넉넉히(10분).
async function generate({ tags, lyrics, durationSec }, logger = () => {}) {
  const h = await health();
  if (!h) return { ok: false, error: '서버 미기동' };
  if (!h.loaded) return { ok: false, error: '모델 로딩 중' };
  try {
    const r = await _postJson('/generate', { tags, lyrics: lyrics || '', durationSec: durationSec || 180 }, 10 * 60 * 1000, true);
    if (r.status === 200 && r.buffer && r.buffer.length > 44) return { ok: true, buffer: r.buffer };
    let msg = 'unknown'; try { msg = JSON.parse(r.buffer.toString('utf8')).error || msg; } catch {}
    return { ok: false, error: `생성 실패(${r.status}): ${msg}` };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function stop(logger = () => {}) {
  try { await _postJson('/shutdown', {}, 3000).catch(() => {}); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  if (S.child) { try { S.child.kill(); } catch {} S.child = null; }
  logger('🎵 ACE-Step 서버 정지(VRAM 반납)');
  return { ok: true };
}

async function status() {
  const h = await health();
  return { installed: isInstalled(), running: !!h, loaded: !!(h && h.loaded), loading: !!(h && h.loading), error: h && h.error || null, dir: resolveDir() };
}

module.exports = { start, generate, stop, status, health, isInstalled, resolveDir, PORT };
