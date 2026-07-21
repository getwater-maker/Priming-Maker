// core/qwen-design.js
// ─────────────────────────────────────────────────────────────────────────────
// Qwen3-TTS 보이스디자인 서버(qwen-design/qwen_design_server.py, 포트 9893)의
// "온디맨드 생명주기"를 앱(메인 프로세스)에서 관리한다.
//   start()  → venv 파이썬으로 서버 spawn → /health 가 loaded 될 때까지 대기(첫 실행은
//              모델 4.5GB 다운로드라 오래 걸림). 이미 떠 있으면 재사용.
//   generate() → POST /design (instruct/text/language) → wav Buffer 반환.
//   stop()   → POST /shutdown 후 프로세스 종료(= GPU VRAM 반납).
// 앱은 보이스디자인 모달을 열 때 start, 닫을 때 stop 하고, 그 사이엔 OmniVoice TTS 합성을
// 막는다(뮤텍스, main.js). → OmniVoice(유휴 ~3.3GB)+Qwen(~6GB) 동시 무거운 사용을 차단.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 9893;
const HOST = '127.0.0.1';

const S = { child: null, dir: null, started: false };

// 설정 파일(선택) — qwen-design 폴더를 옮겼을 때만 지정. 기본은 자동 탐색.
function _cfgPath() { return path.join(os.homedir(), '.shots-maker', 'qwen-design-config.json'); }
function _readCfgDir() {
  try { const c = JSON.parse(fs.readFileSync(_cfgPath(), 'utf8')); if (c && c.dir) return c.dir; } catch {}
  return null;
}

// qwen-design 폴더 탐색: 설정 → 앱 옆(__dirname/../qwen-design) → D:\Priming\qwen-design.
// venv\Scripts\python.exe 가 있는 곳을 정본으로 본다(= 최초설치.bat 로 만든 곳).
function resolveDir() {
  if (S.dir && _hasVenv(S.dir)) return S.dir;
  const cands = [
    _readCfgDir(),
    path.join(__dirname, '..', 'qwen-design'),
    path.join('D:', '\\', 'Priming', 'qwen-design'),
    'D:\\Priming\\qwen-design',
  ].filter(Boolean);
  for (const d of cands) { if (_hasVenv(d)) { S.dir = d; return d; } }
  // venv 없이 폴더만 있으면 그거라도(설치 전 안내용)
  for (const d of cands) { try { if (fs.existsSync(path.join(d, 'qwen_design_server.py'))) { S.dir = d; return d; } } catch {} }
  return null;
}
function _hasVenv(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, 'venv', 'Scripts', 'python.exe')); } catch { return false; }
}
function pythonExe(dir) { return path.join(dir, 'venv', 'Scripts', 'python.exe'); }

function isInstalled() { const d = resolveDir(); return !!(d && _hasVenv(d)); }

// ── HTTP 유틸(로컬, http 모듈) ──────────────────────────────────────────────
function _get(pathname, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: pathname, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
function _postJson(pathname, body, timeoutMs = 120000, binary = false) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: HOST, port: PORT, path: pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
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

// ── 생명주기 ────────────────────────────────────────────────────────────────
// start: 서버가 이미 loaded 면 즉시 반환. 아니면 spawn 후 loaded 될 때까지 폴링.
//   firstRun 은 모델 다운로드로 매우 오래 걸릴 수 있어 timeoutMs 를 크게(기본 20분).
async function start(logger = () => {}, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const h0 = await health();
  if (h0 && h0.loaded) { S.started = true; return { ok: true, reused: true }; }

  const dir = resolveDir();
  if (!dir) return { ok: false, error: 'qwen-design 폴더를 찾을 수 없음(최초설치.bat 실행 필요)' };
  if (!_hasVenv(dir)) return { ok: false, error: `설치 안 됨 — ${path.join(dir, '1_최초설치.bat')} 를 먼저 실행하세요` };

  // 이미 다른 프로세스(수동 실행 등)가 떠 있고 로딩 중이면 그걸 기다림
  if (!(h0 && (h0.loaded || h0.loading))) {
    logger('🎨 보이스디자인 서버 기동…');
    const py = pythonExe(dir);
    const child = spawn(py, ['qwen_design_server.py', '--port', String(PORT)], {
      cwd: dir, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    S.child = child;
    child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && logger('  [qwen] ' + l.trim())));
    child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && logger('  [qwen] ' + l.trim())));
    child.on('exit', (code) => { logger(`🎨 보이스디자인 서버 종료(code ${code})`); if (S.child === child) S.child = null; });
  } else {
    logger('🎨 보이스디자인 서버 이미 로딩 중 — 대기…');
  }

  // /health 폴링(loaded 대기)
  const t0 = Date.now();
  let announced = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await health();
    if (h && h.error) return { ok: false, error: h.error };
    if (h && h.loaded) { S.started = true; logger('🎨 보이스디자인 준비 완료'); return { ok: true }; }
    if (h && h.loading && !announced) { announced = true; logger('🎨 모델 로딩 중… (첫 실행은 4.5GB 다운로드로 수 분 소요)'); }
  }
  return { ok: false, error: '보이스디자인 서버 준비 시간 초과' };
}

// generate: 목소리 1개 생성 → { ok, buffer(wav) } 또는 { ok:false, error }
async function generate({ instruct, text, language = 'Korean' }, logger = () => {}) {
  const h = await health();
  if (!h) return { ok: false, error: '서버 미기동 — 먼저 start() 필요' };
  if (!h.loaded) return { ok: false, error: '모델 로딩 중 — 잠시 후 다시' };
  try {
    const r = await _postJson('/design', { instruct, text, language }, 180000, true);
    if (r.status === 200 && r.buffer && r.buffer.length > 44) return { ok: true, buffer: r.buffer };
    let msg = 'unknown'; try { msg = JSON.parse(r.buffer.toString('utf8')).error || msg; } catch {}
    return { ok: false, error: `생성 실패(${r.status}): ${msg}` };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

async function stop(logger = () => {}) {
  S.started = false;
  try { await _postJson('/shutdown', {}, 3000).catch(() => {}); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  if (S.child) { try { S.child.kill(); } catch {} S.child = null; }
  logger('🎨 보이스디자인 서버 정지(VRAM 반납)');
  return { ok: true };
}

async function status() {
  const h = await health();
  return { installed: isInstalled(), running: !!h, loaded: !!(h && h.loaded), loading: !!(h && h.loading), error: h && h.error || null, dir: resolveDir() };
}

module.exports = { start, generate, stop, status, health, isInstalled, resolveDir, PORT };
