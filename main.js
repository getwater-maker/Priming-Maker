/**
 * main.js — Electron 메인 프로세스. 창 생성 + IPC 오케스트레이션.
 * 권위 데이터(Project 인스턴스)는 여기 메모리(S)에 보유, 렌더러로는 DTO만 전달.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const P = require('./core/pipeline');
const { getModeProfile } = require('./core/mode-profiles');

// 현재 작업 모드 — open-script 가 설정한 S.mode, 또는 파싱 결과/프로젝트에서 추론.
function currentMode() {
  return (S.parsed && S.parsed.mode) || S.mode || 'shorts';
}
// .vrew(및 SRT) 파일명 — 대본 파일명과 동일. 한 파일에 편이 여럿(쇼츠 3편)이면 _N 접미.
function vrewBaseName(pr) {
  const src = S.scriptPath ? path.basename(S.scriptPath).replace(/\.md$/i, '')
    : (S.parsed && S.parsed.fileTitle) || getModeProfile(currentMode()).vrewPrefix;
  const base = _safeFolder(src);
  const n = (S.parsed && S.parsed.projects) ? S.parsed.projects.length : 1;
  return n > 1 ? `${base}_${pr.shortsNum}` : base;
}
// 로그 라벨 — 롱폼은 '롱폼', 쇼츠는 '쇼츠N'. (롱폼 프로젝트도 내부 shortsNum=1 이라 라벨만 모드로 구분)
function prLabel(pr) {
  const lf = (pr && pr.mode === 'longform') || currentMode() === 'longform';
  return lf ? '롱폼' : `쇼츠${pr ? pr.shortsNum : ''}`;
}
// 롱폼 분할옵션 — 프리셋의 split 객체(롱폼 전용) 우선, 없으면 평면 필드.
function presetThresholds(preset) {
  if (!preset) return {};
  const s = preset.split || {};
  const pick = (a, b) => (a != null ? a : b);
  return {
    introSentenceSize: pick(s.introSentenceSize, preset.introSentenceSize),
    mainSentenceSize: pick(s.mainSentenceSize, preset.mainSentenceSize),
    shortLen: pick(s.shortLen, preset.shortLen),
    longLen: pick(s.longLen, preset.longLen),
    splitMode: pick(s.splitMode, preset.splitMode) || 'h3',
  };
}
// 영상 엔진 → Grok 클립 길이. 'grok'=자동(그룹 TTS 기준 6/10초, pipeline 에서 결정), 레거시 'grok10'=10s 고정.
function grokDurOf(engine) { return engine === 'grok10' ? '10s' : 'auto'; }
// 영상 엔진별 그룹 캡(초) — renderer _clipMaxSec 와 동일 (flow 8 / comfy 8 / grok 10).
//   Grok 은 그룹 TTS≤6→6초·>6→10초 자동이므로 캡을 10초로 둬야 6초 초과 그룹이 생긴다.
function clipMaxOf(videoEngine) { return videoEngine === 'flow' ? 8.0 : videoEngine === 'comfy' ? 8.0 : 10.0; }
// AI 고지 결정 — 양쪽 모드 모두 사용자 선택(want)을 따른다. 기본값(롱폼 ON / 쇼츠 OFF)은 렌더러가 정함.
//   롱폼은 켜면 5초 후 5초간 표시(기존 타이밍 유지). 쇼츠는 preset 의 타이밍을 그대로 사용.
const AI_NOTICE_TEXT = '본 영상의 음성과 이미지는 AI 도구를 활용하여 제작되었습니다.';
function resolveAiNotice(preset, want) {
  if (!preset) return preset;
  const base = { text: AI_NOTICE_TEXT, ...(preset.aiNotice || {}) };
  if (currentMode() === 'longform') {
    return { ...preset, aiNotice: { ...base, enabled: !!want, startMode: 'seconds', startSeconds: 5, durationSeconds: 5 } };
  }
  return { ...preset, aiNotice: { ...base, enabled: !!want } };
}

// 로컬 이미지/영상 미리보기용 커스텀 프로토콜 (app ready 전에 등록 필요).
//   ⚠️ bootstrap.js 가 라이트 업데이터를 await 한 뒤 main.js 를 require 하므로, 이 시점엔 app 이 이미
//   ready 일 수 있다. ready 이후엔 registerSchemesAsPrivileged 가 예외를 던져 main.js 로딩이 거기서
//   멈추고 창이 안 뜬다. → bootstrap.js 가 await 이전에 먼저 등록하고, 여기선 ready 가 아닐 때만 시도.
if (!app.isReady()) {
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'media', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
    ]);
  } catch (_) {}
}

let win = null;
const S = { parsed: null, scriptPath: null, outRoot: null, preset: null, ttsMgr: null, flowEng: null, flowEngProfileDir: null, abort: false, mode: 'longform',
  // 작업 소요시간(초) — 백엔드에서 단계별 측정해 DTO 로 전송(make-all 의 각 단계 시간도 실시간 표시).
  timings: { tts: 0, image: 0, video: 0, make: 0 },
  // 모드별 작업 큐 — 각 모드(롱폼/쇼츠)가 대본 여러 개(items)를 순서대로 보관.
  //   item = { id, parsed, scriptPath, outRoot, settings, status }. activeId = 현재 편집/표시 중인 항목.
  //   S.parsed/scriptPath/outRoot 는 '활성 항목'의 미러 — 기존 코드 전부 그대로 동작.
  modes: { longform: { items: [], activeId: null }, shorts: { items: [], activeId: null } } };

let _qSeq = 0;
const newItemId = () => 'q' + (++_qSeq);
function activeItem() {
  const q = S.modes[S.mode]; if (!q) return null;
  return q.items.find((x) => x.id === q.activeId) || null;
}
// 활성 항목 → S.parsed/scriptPath/outRoot 미러 동기화 (없으면 비움)
function syncActiveToS() {
  const it = activeItem();
  S.parsed = it ? it.parsed : null;
  S.scriptPath = it ? it.scriptPath : null;
  S.outRoot = it ? it.outRoot : null;
}
// 현재 S.* 를 활성 항목에 반영(제자리 편집 저장). 항목이 없으면 새로 만들지 않음.
function storeActive() {
  const it = activeItem();
  if (it && S.parsed) { it.parsed = S.parsed; it.scriptPath = S.scriptPath; it.outRoot = S.outRoot; }
  scheduleAutoSave(); // set-aspect/merge-groups 등 pushDtoUpdate 안 거치는 변경도 자동저장
}
// 현재 모드 큐에 항목 추가 + 활성화 + S.* 미러 갱신.
//   같은 scriptPath 가 이미 큐에 있으면 새로 만들지 않고 그 항목을 갱신·활성화(중복·자동저장 충돌 방지).
function addItem(parsed, scriptPath, outRoot, settings) {
  const q = S.modes[S.mode];
  let it = scriptPath ? q.items.find((x) => x.scriptPath === scriptPath) : null;
  if (it) { it.parsed = parsed; it.outRoot = outRoot; if (settings) it.settings = settings; }
  else { it = { id: newItemId(), parsed, scriptPath, outRoot, settings: settings || null, status: 'idle' }; q.items.push(it); }
  q.activeId = it.id;
  S.parsed = parsed; S.scriptPath = scriptPath; S.outRoot = outRoot;
  scheduleAutoSave(); writeWorkspace();
  return it;
}
// (Step1) 모드당 1개 유지 — 큐를 비우고 새 항목 1개로 교체. (Step2 에서 append 로 전환 예정)
function setSingleItem(parsed, scriptPath, outRoot) {
  const q = S.modes[S.mode];
  q.items = []; q.activeId = null;
  return addItem(parsed, scriptPath, outRoot);
}
// 지정 모드로 전환 — 그 모드 활성 항목을 S.* 로 복원(재파싱 없음).
function activateMode(m) {
  S.mode = (m === 'longform') ? 'longform' : 'shorts';
  syncActiveToS();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860,
    title: 'Priming',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#faf6f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // 렌더러(React/Vite): dev 는 PM_DEV_URL(HMR 서버), prod 는 빌드된 정적 파일.
  const devUrl = process.env.PM_DEV_URL;
  if (devUrl) { win.loadURL(devUrl); win.webContents.openDevTools({ mode: 'detach' }); }
  else win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));

  // 진단(PM_DIAG=1): 렌더러 콘솔/크래시를 stdout 으로 포워딩 후 자동 종료 — 스모크 검증용.
  if (process.env.PM_DIAG) {
    win.webContents.on('console-message', (_e, level, message) => {
      process.stdout.write(`[renderer:${level}] ${message}\n`);
    });
    win.webContents.on('render-process-gone', (_e, d) => process.stdout.write(`[render-gone] ${JSON.stringify(d)}\n`));
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(
        'JSON.stringify({root: !!document.querySelector("#root"), cards: !!document.querySelector("#cards"), header: document.querySelector("h1")?.textContent, hasApi: !!window.api})'
      ).then((r) => {
        process.stdout.write(`[diag] ${r}\n`);
        try { fs.writeFileSync(path.join(os.homedir(), '.priming-maker', 'diag.txt'), r); } catch (_) {}
      }).catch((e) => process.stdout.write(`[diag-err] ${e.message}\n`));
      setTimeout(() => app.quit(), 2500);
    });
  }
}

function _mimeOf(p) {
  const e = path.extname(p).toLowerCase();
  return ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg' })[e] || 'application/octet-stream';
}

app.whenReady().then(() => {
  // media://<encoded-abs-path> → 로컬 파일. Range 직접 처리(비디오 스트리밍 — net.fetch(file://)는 Range에서 ERR_UNEXPECTED).
  protocol.handle('media', (request) => {
    let p = decodeURIComponent(request.url.slice('media://'.length)).replace(/^\/+/, '');
    try {
      const stat = fs.statSync(p);
      const mime = _mimeOf(p);
      const range = request.headers.get('Range');
      const m = range && /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        const len = end - start + 1;
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        fs.closeSync(fd);
        return new Response(buf, { status: 206, headers: {
          'Content-Type': mime, 'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
        } });
      }
      return new Response(fs.readFileSync(p), { status: 200, headers: {
        'Content-Type': mime, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes',
      } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
  // 시작은 항상 빈 화면(초기화 상태) — 지난 세션 큐 자동복원 안 함(사용자 요청). 대본은 직접 열기.
  //   (각 대본의 작업물은 .smproj 자동저장에 남아 있어, 대본을 다시 열면 그 대본만 이어집니다.)
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // 자동 업데이트는 bootstrap.js 의 auto-updater 모듈이 담당 (PrimingFlow 방식)
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { writeSnapshotSync(); writeWorkspace(); } catch {} // 종료 직전 마지막 변경·큐 구성 보장
  try { if (S.flowEng && S.flowEng.context) S.flowEng.context.close(); } catch {}
});

const log = (line) => { if (win && !win.isDestroyed()) win.webContents.send('log', String(line)); };

// 버전 표시 — app.getVersion() 은 electron 시작 시점의 package.json(=이번 실행 업데이트 적용 전) 을
//   캐시해 한 박자 늦는다. 라이트 업데이터는 main.js 로드 전에 package.json 을 교체하므로,
//   파일에서 직접 읽으면 방금 적용된 최신 버전이 보인다.
ipcMain.handle('get-app-version', () => {
  try { return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).version || app.getVersion(); }
  catch { try { return app.getVersion(); } catch { return ''; } }
});

ipcMain.handle('list-presets', () => {
  try { return P.listPresets(); } catch (e) { return []; }
});
// 모드별 기본값(음성배속·화면비 등) — 렌더러가 mode-profiles 를 단일 출처로 참조.
ipcMain.handle('get-mode-profiles', () => {
  const { MODE_PROFILES } = require('./core/mode-profiles');
  return MODE_PROFILES;
});
ipcMain.handle('list-styles', () => {
  try { return require('./core/style-store').loadAll().map((s) => ({ id: s.id, name: s.name, prompt: s.prompt || '' })); }
  catch (e) { return []; }
});
// ComfyUI(i2v) 설정 get/set + 연결 테스트
ipcMain.handle('get-comfy-config', () => require('./core/comfy-config').load());
ipcMain.handle('set-comfy-config', (_e, patch = {}) => require('./core/comfy-config').save(patch || {}));
ipcMain.handle('test-comfy', async () => {
  const cfg = require('./core/comfy-config').load();
  const { ComfyEngine } = require('./comfy-engine');
  const ok = await new ComfyEngine(cfg, log).health();
  log(ok ? `✓ ComfyUI 연결 OK (${cfg.baseUrl})` : `✗ ComfyUI 연결 실패 (${cfg.baseUrl})`);
  return { ok, baseUrl: cfg.baseUrl };
});
// Ollama(LLM 프롬프트 자동작성) 설정 get/set + 연결 테스트 + 모델 목록
ipcMain.handle('get-ollama-config', () => require('./core/ollama-config').load());
ipcMain.handle('set-ollama-config', (_e, patch = {}) => require('./core/ollama-config').save(patch || {}));
async function ollamaTags(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, models: [] };
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (e) { return { ok: false, error: e.message, models: [] }; }
  finally { clearTimeout(t); }
}
ipcMain.handle('test-ollama', async () => {
  const cfg = require('./core/ollama-config').load();
  const r = await ollamaTags(cfg.baseUrl);
  if (!r.ok) { log(`✗ Ollama 연결 실패 (${cfg.baseUrl}) — ${r.error}`); return { ok: false, error: r.error, baseUrl: cfg.baseUrl, models: [] }; }
  const hasModel = r.models.includes(cfg.model);
  log(`✓ Ollama 연결 OK (${cfg.baseUrl}) — 모델 ${r.models.length}개${hasModel ? `, '${cfg.model}' 설치됨` : `, ⚠ '${cfg.model}' 미설치`}`);
  return { ok: true, baseUrl: cfg.baseUrl, models: r.models, hasModel };
});
ipcMain.handle('list-ollama-models', async () => {
  const cfg = require('./core/ollama-config').load();
  return (await ollamaTags(cfg.baseUrl)).models;
});
// 이미지 순환 설정 — 풀에 넣을 엔진/순서 (Genspark↔Flow 등)
ipcMain.handle('get-image-rotation', () => require('./core/image-rotation').load());
ipcMain.handle('set-image-rotation', (_e, patch) => require('./core/image-rotation').save(patch || {}));

// LoRA 데이터셋 수집 설정 — Genspark/Flow 이미지를 학습용으로 적립
ipcMain.handle('get-lora-collect', () => { const L = require('./core/lora-collect'); return { ...L.load(), count: L.count() }; });
ipcMain.handle('set-lora-collect', (_e, patch) => { const L = require('./core/lora-collect'); const c = L.save(patch || {}); return { ...c, count: L.count() }; });
ipcMain.handle('pick-lora-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const L = require('./core/lora-collect'); const c = L.save({ dir: r.filePaths[0] }); return { ...c, count: L.count() };
});
ipcMain.handle('open-lora-folder', () => { try { const dir = require('./core/lora-collect').load().dir; fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } catch (e) { log('LoRA 폴더 열기 오류: ' + e.message); } return true; });

// Flow 멀티계정 — 목록/추가/삭제/한도/로그인
ipcMain.handle('get-flow-accounts', () => require('./core/flow-accounts').list());
ipcMain.handle('add-flow-account', (_e, label) => { require('./core/flow-accounts').add(label); return require('./core/flow-accounts').list(); });
ipcMain.handle('remove-flow-account', (_e, id) => { require('./core/flow-accounts').remove(id); return require('./core/flow-accounts').list(); });
ipcMain.handle('rename-flow-account', (_e, args = {}) => { require('./core/flow-accounts').rename(args.id, args.label); return require('./core/flow-accounts').list(); });
ipcMain.handle('set-flow-cap', (_e, n) => { require('./core/flow-accounts').setCap(n); return require('./core/flow-accounts').list(); });
ipcMain.handle('flow-login', async (_e, args = {}) => {
  const accId = (args && args.accId) || 'default';
  log(`🔑 Flow 로그인 창 열기 (${accId}) — 열린 크롬에서 직접 로그인하세요 (쿠키 저장됨)`);
  try {
    const eng = getFlowEng(flowProfileDir(accId));
    await eng.login();
    log('✓ Flow 로그인 완료(쿠키 저장). 이 계정으로 이미지 생성 가능합니다.');
    return { ok: true };
  } catch (e) { log('Flow 로그인 오류: ' + e.message); return { ok: false, error: e.message }; }
});

// Genspark 멀티계정
ipcMain.handle('get-genspark-accounts', () => require('./core/genspark-accounts').list());
ipcMain.handle('add-genspark-account', (_e, label) => { require('./core/genspark-accounts').add(label); return require('./core/genspark-accounts').list(); });
ipcMain.handle('remove-genspark-account', (_e, id) => { require('./core/genspark-accounts').remove(id); return require('./core/genspark-accounts').list(); });
ipcMain.handle('rename-genspark-account', (_e, args = {}) => { require('./core/genspark-accounts').rename(args.id, args.label); return require('./core/genspark-accounts').list(); });
ipcMain.handle('set-genspark-cap', (_e, n) => { require('./core/genspark-accounts').setCap(n); return require('./core/genspark-accounts').list(); });
ipcMain.handle('genspark-login', async (_e, args = {}) => {
  const accId = (args && args.accId) || 'default';
  log(`🔑 Genspark 로그인 (${accId}) — 열린 크롬에서 직접 로그인하세요 (쿠키 저장됨)`);
  try {
    const { GensparkEngine } = require('./genspark-engine');
    const eng = new GensparkEngine({ profileId: accId, logger: log });
    await eng.login();
    log('✓ Genspark 로그인 완료(쿠키 저장).');
    return { ok: true };
  } catch (e) { log('Genspark 로그인 오류: ' + e.message); return { ok: false, error: e.message }; }
});

// Grok(X) 멀티계정 — 영상
ipcMain.handle('get-grok-accounts', () => require('./core/grok-accounts').list());
ipcMain.handle('add-grok-account', (_e, label) => { require('./core/grok-accounts').add(label); return require('./core/grok-accounts').list(); });
ipcMain.handle('remove-grok-account', (_e, id) => { require('./core/grok-accounts').remove(id); return require('./core/grok-accounts').list(); });
ipcMain.handle('rename-grok-account', (_e, args = {}) => { require('./core/grok-accounts').rename(args.id, args.label); return require('./core/grok-accounts').list(); });
ipcMain.handle('set-grok-cap', (_e, n) => { require('./core/grok-accounts').setCap(n); return require('./core/grok-accounts').list(); });
ipcMain.handle('grok-login', async (_e, args = {}) => {
  const accId = (args && args.accId) || 'default';
  log(`🔑 Grok(X) 로그인 (${accId}) — 열린 크롬에서 X 계정으로 로그인하세요`);
  try {
    const { GrokEngine } = require('./grok-engine');
    const eng = new GrokEngine({ profileId: accId, logger: log });
    await eng.login();
    log('✓ Grok 로그인 완료(쿠키 저장).');
    return { ok: true };
  } catch (e) { log('Grok 로그인 오류: ' + e.message); return { ok: false, error: e.message }; }
});
// 참조음성 목록 — ~/.flow-app/ref-audio 의 음성 파일들 (드롭다운 + 미리듣기용)
ipcMain.handle('list-ref-audio', () => {
  const dir = path.join(os.homedir(), '.flow-app', 'ref-audio');
  try {
    return fs.readdirSync(dir).filter((f) => /\.(wav|mp3|flac|m4a)$/i.test(f)).map((f) => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
});
// 참조음성 폴더 열기 — 선택된 참조음성이 있으면 그 폴더, 없으면 기본 ref-audio 폴더.
//   (같은 이름의 .txt 파일이 참조텍스트로 자동 사용되므로, 사용자가 wav+txt 를 이 폴더에서 관리)
ipcMain.handle('open-ref-folder', (_e, p) => {
  let dir = path.join(os.homedir(), '.flow-app', 'ref-audio');
  try { if (p && fs.existsSync(p)) dir = path.dirname(p); } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { shell.openPath(dir); } catch {}
  return true;
});

// 대본(.md) 내용으로 롱폼/쇼츠 자동 판별 — '## 쇼츠 N' 헤더가 있으면 쇼츠, 없으면 롱폼.
//   (사용자가 탭을 잘못 골라 열어도 대본 형식에 맞는 모드로 연다.) 파일을 못 읽으면 null.
function detectScriptMode(scriptPath) {
  let txt = '';
  try { txt = fs.readFileSync(scriptPath, 'utf8'); } catch { return null; }
  if (/^##\s*쇼츠\s*\d/m.test(txt)) return 'shorts';            // 쇼츠 편 헤더 → 쇼츠 (확정)
  const mq = txt.match(/^>\s?.*$/m);                              // 메타 줄(>)의 화면비 = 보조 신호
  if (mq && /9:16/.test(mq[0]) && !/16:9/.test(mq[0])) return 'shorts';
  return 'longform';
}
// 작업본(스냅샷) 복원 시, 원본 .md 에서 형식(grouped/cut/prose)을 다시 판별.
//   옛 스냅샷엔 형식 정보가 없어 직접 나눈 그룹(grouped)이 TTS 후 자동 재구성으로 합쳐지던 문제 방지.
//   .md 를 못 읽으면 null → 호출부에서 'grouped'(안전: 재구성 안 함) 로 폴백.
function detectFormatFromScript(scriptPath) {
  try {
    if (scriptPath && fs.existsSync(scriptPath)) {
      const { parseCutScript } = require('./core/cut-script-parser');
      return parseCutScript(fs.readFileSync(scriptPath, 'utf8')).format || null;
    }
  } catch (_) {}
  return null;
}

ipcMain.handle('open-script', async (_e, args = {}) => {
  const preset = P.getPreset(args.presetName || null);
  const opt = { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] };
  if (preset && preset.scriptFolder && fs.existsSync(preset.scriptFolder)) opt.defaultPath = preset.scriptFolder;
  const r = await dialog.showOpenDialog(win, opt);
  if (r.canceled || !r.filePaths[0]) return null;
  const scriptPath = r.filePaths[0];
  S.scriptPath = scriptPath;
  // 대본 형식 자동 판별 — 탭 선택과 무관하게 대본에 맞는 모드로 연다(잘못 열기 방지). 실패 시 탭 모드.
  const detectedMode = detectScriptMode(scriptPath);
  const requestedMode = (args.mode === 'longform') ? 'longform' : 'shorts';
  S.mode = detectedMode || requestedMode;
  if (detectedMode && detectedMode !== requestedMode) {
    log(`🔀 대본 형식 감지 → ${detectedMode === 'longform' ? '롱폼' : '쇼츠'} 모드로 자동 전환`);
  }
  S.preset = preset;
  S.outRoot = computeOutRoot(scriptPath, preset, S.mode);

  // 자동저장 복원 포함 파싱(구글독스식 이어받기)
  const { parsed, note: restoreNote } = buildParsedForScript(scriptPath, S.mode, preset);
  S.parsed = parsed;
  ensureDirs(S.outRoot); // media/tts/subtitles 먼저 생성
  // 큐에 추가(append) + 활성화. (이전 항목은 같은 객체 참조라 이미 최신 — storeActive 불필요)
  addItem(S.parsed, S.scriptPath, S.outRoot);
  log(`대본 열기(${S.mode}): ${S.parsed.fileTitle}`);
  if (restoreNote) log(restoreNote);
  log(`편수 ${S.parsed.projects.length} · 출력 ${S.outRoot}`);
  return { dto: P.toDTO(S.parsed), scriptPath, outRoot: S.outRoot, queue: queueDTO(), mode: S.mode };
});

// 출력 경로 = <채널 outputFolder>/<대본파일명(확장자 제외)>/
//   그 안에 media/(이미지+영상) · tts/(음성) · subtitles/(SRT) 하위폴더 + 쇼츠N.vrew.
//   Windows 금지문자만 제거(대괄호·공백은 유지).
function _safeFolder(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}
function computeOutRoot(scriptPath, preset, mode) {
  const folder = _safeFolder(path.basename(scriptPath).replace(/\.md$/i, ''));
  // 모드별 출력폴더(롱폼/쇼츠) 우선, 없으면 공용 outputFolder, 그것도 없으면 ./output
  const modeOut = preset && (mode === 'longform' ? preset.outLong : preset.outShort);
  const outBase = modeOut || (preset && preset.outputFolder) || path.join(__dirname, 'output');
  return path.join(outBase, folder);
}
// 쇼츠별 폴더: media-N(이미지+영상) · tts-N(음성) · subtitles-N(SRT). 루트에 쇼츠N.vrew.
function shortsDirs(outRoot, n) {
  const d = { media: path.join(outRoot, `media-${n}`), tts: path.join(outRoot, `tts-${n}`), subtitles: path.join(outRoot, `subtitles-${n}`) };
  for (const k of Object.keys(d)) { try { fs.mkdirSync(d[k], { recursive: true }); } catch {} }
  return d;
}
function ensureDirs(outRoot) {
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  if (S.parsed) for (const pr of S.parsed.projects) shortsDirs(outRoot, pr.shortsNum);
}

ipcMain.handle('tts-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, dry = false, presetName = null, speed = 1.15 } = args;
  const clipMaxSec = (args.clipMaxSec && Number(args.clipMaxSec) > 0) ? Number(args.clipMaxSec) : 8.0; // 영상 엔진별 그룹 캡(Grok 6/Flow 8)
  S.abort = false;
  if (!dry) {
    S.preset = P.getPreset(presetName);
    if (!S.preset) throw new Error('프리셋을 찾을 수 없습니다.');
    log(`프리셋 "${S.preset.name}" (${S.preset.engine}, 음성 배속 ${speed}x) 연결 중…`);
    const { mgr, ok } = await P.makeTtsManager(log, S.preset.engine);
    if (!ok) throw new Error(`TTS 엔진 '${S.preset.engine}' 미가동 (백엔드 확인)`);
    S.ttsMgr = mgr;
  }

  const _ttsT0 = Date.now();
  S.timings.tts = 0;
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const ttsDir = shortsDirs(S.outRoot, pr.shortsNum).tts;
    if (S.abort) { log('⏹ 중단됨'); break; }
    if (dry) { P.fillSilent(pr, ttsDir); log(`✓ ${prLabel(pr)} 무음 오디오`); }
    else { await P.fillTts(pr, S.preset, S.ttsMgr, ttsDir, log, () => S.abort, speed, pushDtoUpdate); log(`✓ ${prLabel(pr)} 음성 완료`); }
    // 음성변환 직후: (쇼츠만) 문장 기준 clipMaxSec(영상 엔진별 6/8초) 미만 단위로 그룹 자동 재구성.
    //   롱폼은 group-builder 가 이미 의미 단위로 묶었으므로 8초 재패킹을 건너뛴다.
    if (getModeProfile(currentMode()).grouping.strategy === 'tts-greedy' && pr.format !== 'grouped') {
      const m = P.mergeGroupsByTts(pr, clipMaxSec);
      log(`  ↳ ${clipMaxSec}초 미만 단위로 그룹 재구성: ${m.before} → ${m.after}개`);
    } else if (pr.format === 'grouped') {
      log(`  ↳ 작성된 그룹 구조 유지 (그룹 ${pr.groups.length}개) — 자동 재구성 생략`);
    }
    pushDtoUpdate();
  }
  S.timings.tts = (Date.now() - _ttsT0) / 1000;
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

ipcMain.handle('export-vrew', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, presetName = null, captionStyle = null, captionMaxChars = 7, aiNotice = false } = args;
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  let preset = S.preset || P.getPreset(presetName);
  if (preset && captionStyle) {
    preset = { ...preset, captionStyle: { ...(preset.captionStyle || {}), ...captionStyle } };
  }
  preset = resolveAiNotice(preset, aiNotice); // 롱폼=항상 / 쇼츠=사용자 선택
  const outs = [];
  const incomplete = [];
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const miss = missingVisualGroups(pr);
    if (miss.length) {
      incomplete.push({ label: prLabel(pr), nums: miss });
      log(`⛔ ${prLabel(pr)} — 이미지 미생성 그룹 ${miss.length}개 (G${miss.join(', G')}) → .vrew 건너뜀`);
      continue;
    }
    const dirs = shortsDirs(S.outRoot, pr.shortsNum);
    const baseName = vrewBaseName(pr);
    const vrewPath = path.join(S.outRoot, `${baseName}.vrew`);
    try {
      const res = await P.buildProjectVrew(pr, vrewPath, preset, log, captionMaxChars); // 배속은 음성에 이미 반영
      P.writeSrt(pr, path.join(dirs.subtitles, `${baseName}.srt`), captionMaxChars);
      outs.push({ shortsNum: pr.shortsNum, vrewPath, clipCount: res.clipCount, imageCount: res.imageCount });
      log(`✓ ${baseName}.vrew (clip ${res.clipCount}, image ${res.imageCount})`);
      shell.openPath(vrewPath); // 생성 즉시 Vrew로 열어 바로 렌더 가능
    } catch (e) {
      log(`✗ ${prLabel(pr)} 실패: ${e.message}`);
    }
  }
  warnIncompleteVisuals(incomplete);
  return { outRoot: S.outRoot, outs };
});

// Flow 이미지 — FlowAutomator는 win(IPC send)이 필요해 main에서 처리.
// customPrompts에 group.imagePrompt를 그대로 넣어 번역 없이 사용.
// Flow는 임시폴더에 생성 → 결과를 쇼츠N_images/cutM.ext 로 복사 (Genspark와 동일 위치, _flow 폴더 안 만듦).
// 크롬 프로필 정리 — stale 락 제거 + 복원 프롬프트 억제(비정상 종료 후 about:blank 창 누적 방지)
function cleanChromeProfile(profileDir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch {}
  }
  for (const sub of ['Default', '']) {
    try {
      const pref = path.join(profileDir, sub, 'Preferences');
      if (fs.existsSync(pref)) {
        const j = JSON.parse(fs.readFileSync(pref, 'utf8'));
        j.profile = j.profile || {};
        j.profile.exit_type = 'Normal';
        j.profile.exited_cleanly = true;
        fs.writeFileSync(pref, JSON.stringify(j));
      }
    } catch {}
  }
}

// 계정 id → 프로필 폴더.
function flowProfileDir(accId) { return path.join(os.homedir(), '.flow-app', 'profiles', accId || 'default'); }
// FlowAutomator 단일 인스턴스 유지. 활성 계정(프로필)이 바뀌면 기존 크롬을 닫고 새 프로필로 교체
//   → 동시에 크롬 여러 개 뜨는 것 방지(계정은 한 번에 하나만 사용).
function getFlowEng(profileDir) {
  if (S.flowEng && S.flowEngProfileDir === profileDir) return S.flowEng;
  if (S.flowEng) { try { if (S.flowEng.context) S.flowEng.context.close(); } catch {} S.flowEng = null; }
  fs.mkdirSync(profileDir, { recursive: true });
  cleanChromeProfile(profileDir);
  const { FlowAutomator } = require('./flow-engine');
  S.flowEng = new FlowAutomator(win, profileDir);
  S.flowEngProfileDir = profileDir;
  return S.flowEng;
}
// Flow 크롬 창을 닫고 정리 — 작업(이미지/영상 생성)이 끝나면 호출해 창을 남기지 않는다.
//   (재사용은 한 번의 만들기 실행 안에서만. 다음 실행은 getFlowEng 가 새로 띄움.)
async function closeFlowEng() {
  const eng = S.flowEng;
  if (!eng) return;
  S.flowEng = null; S.flowEngProfileDir = null;
  try {
    if (typeof eng._closeContextAndCleanup === 'function') await eng._closeContextAndCleanup('작업 완료');
    else if (eng.context) await eng.context.close();
  } catch {}
}

async function runFlowImages(project, imagesDir, logger, styleId, onlyNums) {
  fs.mkdirSync(imagesDir, { recursive: true });
  // 대상 = (onlyNums 있으면 그 그룹만) + 아직 이미지 없는 그룹. 순환에서 '남은 것만' 이어 만들 때 사용.
  const targets = project.groups.filter((g) => (!onlyNums || onlyNums.includes(g.num)) && !(g.imagePath && fs.existsSync(g.imagePath)));
  if (!targets.length) { logger('[Flow] 생성할 그룹 없음 (이미 채워짐)'); return; }
  const workDir = path.join(os.tmpdir(), `sm_flow_${project.shortsNum}_${Date.now().toString(36)}`);
  fs.mkdirSync(workDir, { recursive: true });
  // 멀티계정 순환 — 오늘 한도 안 찬 첫 계정 선택. 전부 소진이면 중단(throw → 상위 순환이 다음 엔진으로).
  const FlowAccounts = require('./core/flow-accounts');
  const acc = FlowAccounts.pickActive();
  if (!acc) throw new Error('모든 Flow 계정의 오늘 한도가 찼습니다 — ⚙Flow 계정에서 한도를 늘리거나 계정을 추가하세요.');
  const cap = FlowAccounts.load().dailyCap;
  const used = FlowAccounts.list().accounts.find((a) => a.id === acc.id);
  logger(`🔑 Flow 계정: ${acc.label} (오늘 ${used ? used.used : 0}/${cap}) · 대상 ${targets.length}장`);
  const profileDir = flowProfileDir(acc.id);
  const eng = getFlowEng(profileDir);
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  // 대상 그룹만 제출. 나레이션(프롬프트 없을 때 Flow 가 번역) + 커스텀 프롬프트(있으면 공통 빌더로 동일 프롬프트).
  const paragraphs = targets.map((g) => project.getSentencesOfGroup(g).map((s) => s.text).join(' ').trim() || `cut${g.num}`);
  const customPrompts = targets.map((g) => (g.imagePrompt && g.imagePrompt.trim()) ? P.buildImagePrompt(stylePrompt, g.imagePrompt) : null);
  const imgDir = path.join(workDir, 'images');
  // 대상(targets) 순서로 매핑 — Flow 출력은 제출 순서(01,02…) = targets 순서. 이미 채워진 그룹은 건드리지 않음.
  const mapOnce = (final) => {
    let files = [];
    try { files = fs.readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort(); } catch { return 0; }
    let n = 0;
    targets.forEach((g, i) => {
      if (g.imagePath && g.imagePath.startsWith(imagesDir) && fs.existsSync(g.imagePath)) return;
      let f = files.find((x) => x.startsWith(String(i + 1).padStart(2, '0')));
      if (!f && final) f = files[i];
      if (!f) return;
      const ext = path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
      const dest = path.join(imagesDir, `${String(g.num).padStart(2, '0')}${ext}`);
      try { fs.copyFileSync(path.join(imgDir, f), dest); g.imagePath = dest; g.imageStatus = 'done'; n++; if (final && logger) logger(`[Flow] G${g.num} 이미지 첨부`); }
      catch (e) { if (logger) logger(`이미지 복사 실패 G${g.num}: ${e.message}`); }
    });
    return n;
  };
  const poll = setInterval(() => { if (mapOnce(false) > 0) pushDtoUpdate(); }, 2500);
  try {
    await eng.run({
      paragraphs, customPrompts, mediaType: 'image',
      ratio: project.aspect || '9:16', outputDir: workDir, style: styleId || 'cinematic',
      withSubtitle: false, vrewOnly: false, skipVrew: true,
      antiDetect: { enabled: true, preset: '기본' }, profileId: acc.id,
    });
  } finally {
    clearInterval(poll);
  }
  const total = mapOnce(true);
  logger(`[Flow] 이미지 매핑 완료 ${total}/${targets.length}`);
  const usedNow = FlowAccounts.markUsed(acc.id, targets.length);
  if (usedNow >= cap) logger(`⚠ Flow 계정 "${acc.label}" 오늘 한도(${cap}) 도달 → 다음 실행은 다른 계정 사용`);
  pushDtoUpdate();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
}

// ── 이미지 순환(rotation) ── 순서대로 엔진을 돌며 '남은(미생성) 그룹'만 생성. 한 엔진이 한도면 다음 엔진으로 이어감.
//   startEngine = 사용자가 고른 엔진(맨 앞 우선). ComfyUI 는 순환 제외(별도 단독).
async function runRotatingImages(project, imagesDir, logger, styleId, startEngine, onlyNums) {
  const Rot = require('./core/image-rotation');
  const order = Rot.activeOrder(startEngine);
  if (!order.length) { logger('⚠ 순환 엔진이 비어있음 — ⚙ 순환 설정 확인'); return; }
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const need = () => project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !(g.imagePath && fs.existsSync(g.imagePath)) && (!onlyNums || onlyNums.includes(g.num)));
  logger(`🔄 이미지 순환: ${order.join(' → ')}`);
  for (const engineId of order) {
    if (S.abort) { logger('⏹ 중단됨'); break; }
    const remaining = need();
    if (!remaining.length) break;
    const nums = remaining.map((g) => g.num);
    logger(`🔄 [${engineId}] 남은 ${remaining.length}장 생성 시도 (그룹 ${nums.join(',')})`);
    try {
      if (engineId === 'genspark') {
        // Genspark 멀티계정: 한 계정이 한도면 다음 계정으로, 계정 모두 소진 시 다음 엔진으로.
        const GsAcc = require('./core/genspark-accounts');
        const accounts = GsAcc.activeAccounts();
        if (!accounts.length) { logger('⚠ 모든 Genspark 계정 오늘 한도 — 다음 엔진으로'); continue; }
        for (const acc of accounts) {
          if (S.abort) break;
          const stillNeed = need(); if (!stillNeed.length) break;
          const ns = stillNeed.map((g) => g.num);
          logger(`🔑 Genspark 계정: ${acc.label} — 남은 ${stillNeed.length}장`);
          const r = await P.generateImagesGenspark(project, imagesDir, logger, () => S.abort, stylePrompt, ns, pushDtoUpdate, acc.id);
          if (r && r.ok) GsAcc.markUsed(acc.id, r.ok); // 성공분만 카운트
          if (r && r.limitReached) { logger(`⚠ Genspark 계정 "${acc.label}" 한도 — 다음 계정/엔진으로`); continue; }
          break; // 한도가 아닌 이유로 끝남(나머지는 차단/실패) → Genspark 더 시도 무의미
        }
      } else if (engineId === 'flow') {
        await runFlowImages(project, imagesDir, logger, styleId, nums);
      } else if (engineId === 'comfy') {
        await runComfyImages(project, imagesDir, logger, styleId);
      } else { logger(`(건너뜀) 알 수 없는 엔진: ${engineId}`); }
    } catch (e) {
      logger(`⚠ ${engineId} 중단(${e.message}) — 다음 엔진으로 이어감`);
      continue;
    }
  }
  const left = need();
  if (left.length) logger(`⚠ 순환 엔진 모두 소진 — ${left.length}장 미생성 (그룹 ${left.map((g) => g.num).join(',')})`);
  else logger('✅ 순환 이미지 생성 완료');
  collectForLora(project, styleId, logger); // 📦 Genspark/Flow 이미지를 LoRA 데이터셋에 적립
}

// 📦 LoRA 학습용 데이터셋 적립 — Genspark/Flow 이미지만(ComfyUI 제외), 중복은 해시로 1회.
function collectForLora(project, styleId, logger) {
  let Lora; try { Lora = require('./core/lora-collect'); } catch { return; }
  if (!Lora.load().enabled) return;
  let n = 0;
  for (const g of project.groups) {
    if (!g.imagePath || !fs.existsSync(g.imagePath)) continue;
    if (g.imageEngine === 'comfy') continue;          // ComfyUI 결과는 학습 오염 방지로 제외
    if (!g.imagePrompt || !g.imagePrompt.trim()) continue;
    const r = Lora.collect({ imagePath: g.imagePath, prompt: g.imagePrompt, styleId, script: (S.parsed && S.parsed.fileTitle) || '', num: g.num, engine: g.imageEngine || null });
    if (r && r.added) n++;
  }
  if (n && logger) logger(`📦 LoRA 수집: ${n}장 적립 (총 ${Lora.count()}장)`);
}

// ComfyUI(SDXL) 이미지 — HTTP API(브라우저 X). 그룹별 g.imagePrompt 로 텍스트→이미지. 로컬/런팟 공용.
async function runComfyImages(project, imagesDir, logger, styleId, onlyNums) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const cfg = require('./core/comfy-config').load();
  const { ComfyEngine } = require('./comfy-engine');
  const eng = new ComfyEngine(cfg, logger);
  if (!(await eng.health())) throw new Error(`ComfyUI 연결 실패 (${cfg.baseUrl}) — ComfyUI 실행/주소 확인 (⚙ Comfy)`);
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const pfx = stylePrompt ? `${stylePrompt}, ` : '';
  let done = 0, total = 0;
  for (const g of project.groups) {
    if (S.abort) { logger('⏹ 중단됨'); break; }
    if (onlyNums && !onlyNums.includes(g.num)) continue;     // 범위 지정 시 그 그룹만
    if (!g.imagePrompt || !g.imagePrompt.trim()) continue; // 프롬프트 없으면 건너뜀(autoFillPrompts 가 먼저 채움)
    if (g.imagePath && fs.existsSync(g.imagePath)) continue; // 이미 있음(캐시 프리필/이전 생성)
    total++;
    const out = path.join(imagesDir, `${String(g.num).padStart(2, '0')}.png`);
    logger(`🖼 ComfyUI(SDXL) G${g.num} 생성…`);
    const r = await eng.textToImage({ prompt: pfx + g.imagePrompt, aspect: project.aspect || '9:16', outputPath: out, abortSignal: () => S.abort });
    if (r.success) { g.imagePath = out; g.imageStatus = 'done'; g.imageEngine = 'comfy'; done++; pushDtoUpdate(); } // comfy 표시 → LoRA 수집 제외
    else logger(`✗ G${g.num} 실패: ${r.error}`);
  }
  logger(`[ComfyUI] 이미지 ${done}/${total} 완료`);
  pushDtoUpdate();
}

// Flow 영상 (i2v) — 앞에서 N개 그룹의 이미지를 프레임/애셋으로 붙여 Veo 영상화. 결과 → group.videoPath.
async function runFlowVideos(project, mediaDir, logger, opts = {}) {
  const { model = 'Veo 3.1 - Lite', count = 'x1', onlyNums = null } = opts;
  // 범위(onlyNums) 그룹만, 없으면 이미지 있는 전체. (랜덤 개수 방식 폐지)
  const targets = (onlyNums && onlyNums.length)
    ? project.groups.filter((g) => onlyNums.includes(g.num) && g.imagePath && fs.existsSync(g.imagePath))
    : project.groups.filter((g) => g.imagePath && fs.existsSync(g.imagePath));
  if (!targets.length) { logger('Flow 영상: 이미지가 있는 대상 그룹이 없음 (먼저 이미지 생성)'); return; }

  const workDir = path.join(os.tmpdir(), `sm_flowv_${project.shortsNum}_${Date.now().toString(36)}`);
  fs.mkdirSync(workDir, { recursive: true });
  const FlowAccounts = require('./core/flow-accounts');
  const vacc = FlowAccounts.pickActive() || { id: 'default' };
  const eng = getFlowEng(flowProfileDir(vacc.id));

  const paragraphs = targets.map((g) => (project.getSentencesOfGroup(g)[0] || {}).text || `cut${g.num}`);
  const customPrompts = targets.map((g) => g.videoPrompt || g.motionNote || 'natural slow motion, cinematic feel');
  const frameImages = targets.map((g) => g.imagePath);
  targets.forEach((g) => { g.videoStatus = 'generating'; });
  pushDtoUpdate();
  logger(`[Flow] 영상 ${targets.length}개 생성 (모델 ${model}, ${count}, i2v)…`);

  const imgDir = path.join(workDir, 'images');
  try {
    await eng.run({
      paragraphs, customPrompts, mediaType: 'video', model, count,
      ratio: project.aspect || '9:16', outputDir: workDir,
      withSubtitle: false, vrewOnly: false, skipVrew: true, frameImages,
      antiDetect: { enabled: true, preset: '기본' }, profileId: 'default',
    });
  } catch (e) { logger('Flow 영상 오류: ' + e.message); }

  // 출력 .mp4 → 대상 그룹 videoPath 매핑 (파일명 앞 2자리 = 순번, 폴백 순서)
  let files = [];
  try { files = fs.readdirSync(imgDir).filter((f) => /\.mp4$/i.test(f)).sort(); } catch {}
  targets.forEach((g, i) => {
    const num = String(i + 1).padStart(2, '0');
    const f = files.find((x) => x.startsWith(num)) || files[i];
    if (!f) { g.videoStatus = 'fail'; return; }
    const dest = path.join(mediaDir, `${String(g.num).padStart(2, '0')}.mp4`);
    try { fs.copyFileSync(path.join(imgDir, f), dest); g.videoPath = dest; g.videoStatus = 'done'; logger(`[Flow] G${g.num} 영상 첨부`); }
    catch (e) { g.videoStatus = 'fail'; logger(`영상 복사 실패 G${g.num}: ${e.message}`); }
  });
  pushDtoUpdate();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
}

// 워크폴더 이미지 → media-N/NN.ext 로 매핑 (이미 매핑된 그룹은 건너뜀, 멱등). 신규 매핑 수 반환.
function mapFlowImagesOnce(project, imgDir, mediaDir, allowOrder, logger) {
  let files = [];
  try { files = fs.readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort(); } catch { return 0; }
  let n = 0;
  project.groups.forEach((g, i) => {
    if (g.imagePath && g.imagePath.startsWith(mediaDir) && fs.existsSync(g.imagePath)) return; // 이미 매핑됨
    const num = String(i + 1).padStart(2, '0');
    let f = files.find((x) => x.startsWith(num));
    if (!f && allowOrder) f = files[i];
    if (!f) return;
    const ext = path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
    const dest = path.join(mediaDir, `${String(g.num).padStart(2, '0')}${ext}`);
    try { fs.copyFileSync(path.join(imgDir, f), dest); g.imagePath = dest; g.imageStatus = 'done'; n++; if (logger) logger(`[Flow] G${g.num} 이미지 첨부`); }
    catch (e) { if (logger) logger(`이미지 복사 실패 G${g.num}: ${e.message}`); }
  });
  return n;
}
// 모드별 큐(적재된 대본 목록) 메타데이터 — 렌더러 큐 UI 용. 매 DTO 갱신에 첨부.
function queueDTO() {
  const mk = (mode) => {
    const q = S.modes[mode];
    return {
      activeId: q.activeId,
      items: q.items.map((it) => ({
        id: it.id,
        title: (it.parsed && it.parsed.fileTitle) || (it.scriptPath ? path.basename(it.scriptPath) : '대본'),
        file: it.scriptPath ? path.basename(it.scriptPath) : '',
        projects: (it.parsed && it.parsed.projects) ? it.parsed.projects.length : 0,
        status: it.status || 'idle',
        settings: it.settings || null, // 대본별 생성 설정(채널·스타일·배속·엔진·영상범위)
        active: it.id === q.activeId,
      })),
    };
  };
  return { mode: S.mode, longform: mk('longform'), shorts: mk('shorts') };
}
function pushDtoUpdate() {
  try { if (win && !win.isDestroyed() && S.parsed) { const d = P.toDTO(S.parsed); d.timings = { ...S.timings }; d.queue = queueDTO(); win.webContents.send('dto-update', d); } } catch {}
  scheduleAutoSave(); // 데이터가 바뀔 때마다(디바운스) 자동저장
}

// ── 이미지 캐시(재활용) ── 키 = imagePrompt + style + aspect + engine. (H3=프롬프트 고정 → 잘 맞음)
// 생성 전 프리필 — 캐시에 있으면 media-N 으로 복사하고 g.imagePath 설정(엔진이 건너뜀).
function prefillImageCache(project, mediaDir, styleId, engine) {
  const MC = require('./core/media-cache');
  let n = 0;
  for (const g of project.groups) {
    if (!g.imagePrompt || !g.imagePrompt.trim()) continue;
    if (g.imagePath && fs.existsSync(g.imagePath)) continue;
    const hit = MC.get(MC.imageKey(g.imagePrompt, styleId || '', project.aspect || '9:16', engine));
    if (!hit) continue;
    try { fs.mkdirSync(mediaDir, { recursive: true }); const out = path.join(mediaDir, `${String(g.num).padStart(2, '0')}.${hit.ext}`); fs.copyFileSync(hit.file, out); g.imagePath = out; g.imageStatus = 'done'; n++; } catch {}
  }
  if (n) { log(`♻ 이미지 ${n}개 재활용(캐시)`); pushDtoUpdate(); }
  return n;
}
// 생성 후 — 새로 만든 이미지를 캐시에 저장(다음 동일 작업 시 재활용).
function cacheGeneratedImages(project, styleId, engine) {
  const MC = require('./core/media-cache');
  for (const g of project.groups) {
    if (!g.imagePrompt || !g.imagePath || !fs.existsSync(g.imagePath)) continue;
    MC.put(MC.imageKey(g.imagePrompt, styleId || '', project.aspect || '9:16', engine), g.imagePath, path.extname(g.imagePath).slice(1));
  }
}
// 이미지 생성이 필요한(프롬프트 있고 아직 이미지 없는) 그룹 수.
function imagesNeeded(project) {
  return project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !(g.imagePath && fs.existsSync(g.imagePath))).length;
}

// 생성된 영상을 1080p 로 업스케일 (Real-ESRGAN 애니 모델, 없으면 ffmpeg 폴백). videoPath 교체.
async function maybeUpscale(project, logger, enabled) {
  if (!enabled) return;
  const targets = project.groups.filter((g) => g.videoPath && fs.existsSync(g.videoPath) && !/_1080\.mp4$/i.test(g.videoPath));
  if (!targets.length) return;
  const Upscaler = require('./core/upscaler');
  const [W, H] = (project.aspect === '1:1') ? [1080, 1080] : (project.aspect === '16:9') ? [1920, 1080] : [1080, 1920];
  for (const g of targets) {
    if (S.abort) { logger('⏹ 업스케일 중단'); break; }
    const out = g.videoPath.replace(/\.mp4$/i, '_1080.mp4');
    try {
      logger(`⬆ G${g.num} 영상 업스케일 → ${W}x${H}…`);
      const r = await Upscaler.upscaleVideo(g.videoPath, out, { width: W, height: H, logger, abortSignal: () => S.abort });
      if (r && r.ok) { g.videoPath = out; pushDtoUpdate(); }
    } catch (e) { logger(`업스케일 실패 G${g.num}: ${e.message}`); }
  }
}

// ComfyUI(LTX 등) i2v — 대상 그룹의 이미지를 ComfyUI API 로 영상화 → group.videoPath.
async function runComfyVideos(project, mediaDir, logger, opts = {}) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const { onlyNums = null } = opts;
  const cfg = require('./core/comfy-config').load();
  const { ComfyEngine } = require('./comfy-engine');
  // 범위(onlyNums) 그룹만, 없으면 이미지 있는 전체. (랜덤 개수 방식 폐지)
  const targets = (onlyNums && onlyNums.length)
    ? project.groups.filter((g) => onlyNums.includes(g.num) && g.imagePath && fs.existsSync(g.imagePath))
    : project.groups.filter((g) => g.imagePath && fs.existsSync(g.imagePath));
  if (!targets.length) { logger('Comfy 영상: 이미지가 있는 대상 그룹이 없음 (먼저 이미지 생성)'); return; }
  const eng = new ComfyEngine(cfg, logger);
  const MC = require('./core/media-cache');
  logger(`[Comfy] ${targets.length}개 영상 생성 (${cfg.baseUrl})…`);
  for (const g of targets) {
    if (S.abort) { logger('⏹ 중단'); break; }
    if (g.videoPath && fs.existsSync(g.videoPath)) continue;
    const outputPath = path.join(mediaDir, `${String(g.num).padStart(2, '0')}.mp4`);
    const ck = MC.videoKey(g.videoPrompt || g.motionNote || '', g.imagePath, project.aspect || '9:16', 'comfy-ltx');
    const hit = MC.get(ck);
    if (hit) { try { fs.copyFileSync(hit.file, outputPath); g.videoPath = outputPath; g.videoSourceImage = g.imagePath; g.videoStatus = 'done'; logger(`♻ G${g.num} 영상 재활용(캐시)`); pushDtoUpdate(); continue; } catch {} }
    g.videoStatus = 'generating'; pushDtoUpdate();
    // 영상 길이 = 그룹 TTS 음성 길이(문장 합산). videoMaxSec(기본 10초)로 상한은 comfy-engine 이 적용.
    //   (groupDurationSec 은 모델 그룹에 없음 → 문장에서 직접 계산)
    const ttsLen = project.getSentencesOfGroup(g).reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
    const wantDur = cfg.matchVideoToAudio === false ? null : (ttsLen > 0 ? ttsLen : null);
    if (wantDur) logger(`[Comfy] G${g.num} 영상 길이 = 그룹 TTS ${ttsLen.toFixed(1)}초${cfg.videoMaxSec > 0 ? ` (캡 ${cfg.videoMaxSec}초)` : ' (캡 없음)'}`);
    const res = await eng.imageToVideo({ imagePath: g.imagePath, prompt: g.videoPrompt || g.motionNote || null, outputPath, abortSignal: () => S.abort, aspect: project.aspect || '9:16', durationSec: wantDur });
    if (res.success && res.videoPath) { g.videoPath = res.videoPath; g.videoSourceImage = g.imagePath; g.videoStatus = 'done'; MC.put(ck, res.videoPath, 'mp4'); logger(`✓ G${g.num} 영상`); }
    else { g.videoStatus = 'fail'; logger(`✗ G${g.num} 영상 실패: ${res.error}`); }
    pushDtoUpdate();
  }
}

// 긴 대본 대응 — 그룹들을 "요청서 추정 크기" 기준 청크로 분할 (Set<"sn-num"> 배열).
//   롱폼 한 편이 수만 자라 한 번에 보내면 LLM 컨텍스트를 초과(Ollama 기본 ~4K) → 응답이 깨짐.
//   대본 길이 + 그룹당 오버헤드(라벨·이미지/영상 줄)를 합산해, 고정 규칙헤더 포함 maxReqChars 이하로 묶음.
//   → 문장모드(작은 그룹 다수, 오버헤드가 큼)·H3모드(큰 그룹 소수) 둘 다 안전.
const PROMPT_HEADER_CHARS = 1600;   // 고정 규칙 헤더 대략
const PROMPT_PER_GROUP_OVERHEAD = 110; // 그룹당 라벨/플레이스홀더 줄
function chunkGroupKeys(projects, maxReqChars = 4500, includeFn = null) {
  const chunks = [];
  let cur = new Set();
  let curChars = PROMPT_HEADER_CHARS;
  for (const pr of projects) {
    for (const g of pr.groups) {
      if (includeFn && !includeFn(g)) continue;   // 예: 프롬프트 없는 그룹만
      const full = pr.getSentencesOfGroup(g).map((s) => s.text || '').join(' ');
      const cost = full.length + PROMPT_PER_GROUP_OVERHEAD;
      const key = `${pr.shortsNum}-${g.num}`;
      if (cur.size > 0 && curChars + cost > maxReqChars) { chunks.push(cur); cur = new Set(); curChars = PROMPT_HEADER_CHARS; }
      cur.add(key);
      curChars += cost;
    }
  }
  if (cur.size > 0) chunks.push(cur);
  return chunks;
}

// 청크별로 LLM 호출 → 매핑 누적. callAnswer(reqText) → Promise<string>(LLM 답변).
async function generatePromptsChunked(projects, opts, callAnswer, logger) {
  const PromptIO = require('./core/prompt-io');
  const chunks = chunkGroupKeys(projects, 4500, opts && opts.includeFn);
  if (!chunks.length) { logger('대상 그룹 없음 (이미 프롬프트 보유)'); return { groups: 0, img: 0, vid: 0, sanitized: [] }; }
  let groups = 0, img = 0, vid = 0; const sanitized = [];
  for (let i = 0; i < chunks.length; i++) {
    if (S.abort) { logger('⏹ 중단됨'); break; }
    const reqText = PromptIO.buildPromptRequestText(projects, { ...(opts || {}), onlyKeys: chunks[i] });
    if (chunks.length > 1) logger(`🧩 프롬프트 생성 ${i + 1}/${chunks.length} (${chunks[i].size}그룹)…`);
    const answer = await callAnswer(reqText);
    const r = PromptIO.applyPromptsToProjects(projects, answer);
    groups += r.groups; img += r.img; vid += r.vid;
    if (r.sanitized) sanitized.push(...r.sanitized);
    pushDtoUpdate();
  }
  return { groups, img, vid, sanitized };
}

// 프롬프트 없는 그룹(prose/롱폼 대본 등) → 이미지 생성 전에 LLM 으로 내용 맞는 영어 프롬프트 자동 생성.
// Ollama 1순위 → Gemini 키 → 나레이션 폴백. 이미 프롬프트 있으면 아무것도 안 함.
async function autoFillPrompts(projects, logger) {
  const need = projects.some((pr) => pr.groups.some((g) => !g.imagePrompt || !g.imagePrompt.trim()));
  if (!need) return;
  const PromptIO = require('./core/prompt-io');
  // 1순위: 로컬/원격 Ollama (무료) — 도달 가능하면 사용
  const oc = require('./core/ollama-config').load();
  const tags = await ollamaTags(oc.baseUrl);
  if (tags.ok) {
    try {
      logger(`🤖 프롬프트 없는 그룹 — Ollama(${oc.model})로 내용 맞는 프롬프트 자동 생성 중…`);
      const r = await generatePromptsChunked(projects, { includeFn: (g) => !g.imagePrompt || !g.imagePrompt.trim() }, (req) => PromptIO.callLlmTextApi('ollama', '', req, { baseUrl: oc.baseUrl, model: oc.model }), logger);
      logger(`📥 프롬프트 자동 생성 완료(Ollama) — ${r.groups}개 그룹 (🖼${r.img}·🎬${r.vid})`);
      return;
    } catch (e) { logger('Ollama 프롬프트 생성 실패: ' + e.message + ' — Gemini/나레이션으로 폴백'); }
  }
  // 2순위: Gemini 키
  let key = '';
  try { key = (require('./tts/secret-store').get('gemini') || {}).key || ''; } catch {}
  if (!key.trim()) { logger('⚠ 프롬프트 없는 그룹 — Ollama 미도달 & Gemini 키 없음(⚙에서 설정 권장). 지금은 나레이션으로 진행됩니다.'); return; }
  try {
    logger('🤖 프롬프트 없는 그룹 — Gemini API로 내용 맞는 프롬프트 자동 생성 중…');
    const r = await generatePromptsChunked(projects, { includeFn: (g) => !g.imagePrompt || !g.imagePrompt.trim() }, (req) => PromptIO.callLlmTextApi('gemini', key, req), logger);
    logger(`📥 프롬프트 자동 생성 완료(Gemini) — ${r.groups}개 그룹 (🖼${r.img}·🎬${r.vid})`);
  } catch (e) { logger('프롬프트 자동 생성 실패: ' + e.message + ' (나레이션으로 진행)'); }
}

ipcMain.handle('image-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, engine = 'genspark', styleId = null } = args;
  S.abort = false;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  // 프롬프트 없는 그룹 → API로 자동 생성 (내용 맞는 이미지)
  await autoFillPrompts(S.parsed.projects.filter((p) => !shortsNum || p.shortsNum === shortsNum), log);
  const _imgT0 = Date.now();
  S.timings.image = 0;
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    if (S.abort) { log('⏹ 중단됨'); break; }
    log(`🖼 ${prLabel(pr)} 이미지 생성 (${engine}${styleId ? ', 스타일=' + styleId : ''})…`);
    try {
      const mediaDir = shortsDirs(S.outRoot, pr.shortsNum).media;
      prefillImageCache(pr, mediaDir, styleId, engine); // ♻ 캐시에 있는 그룹은 먼저 채움(엔진이 건너뜀)
      if (imagesNeeded(pr) === 0) {
        log(`♻ ${prLabel(pr)} 전부 캐시 재활용 — 생성 생략`);
      } else if (engine === 'comfy') {
        await runComfyImages(pr, mediaDir, log, styleId); // ComfyUI 는 단독(순환 제외)
      } else {
        await runRotatingImages(pr, mediaDir, log, styleId, engine); // genspark/flow → 순환(한도 시 자동 이어감)
      }
      cacheGeneratedImages(pr, styleId, engine); // 새로 만든 이미지 캐시에 저장
      log(`✓ ${prLabel(pr)} 이미지 완료`);
    } catch (e) {
      log(`✗ ${prLabel(pr)} 이미지 실패: ${e.message}`);
    }
    pushDtoUpdate(); // 생성된 이미지(g.imagePath)를 UI 썸네일에 즉시 반영
  }
  try { await closeFlowEng(); } catch {} // Flow 이미지 창 닫고 마무리
  S.timings.image = (Date.now() - _imgT0) / 1000;
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 비주얼(이미지) 미생성 그룹 번호 — 이미지도 영상도 없는 그룹.
//   쇼츠는 이미지→영상 변환이므로 영상이 있으면 이미지가 있었던 것 → 둘 중 하나라도 있으면 OK.
//   imagePrompt 가 있는(=비주얼이 있어야 하는) 그룹만 검사.
function missingVisualGroups(project) {
  return (project.groups || []).filter((g) => {
    if (!(g.imagePrompt && String(g.imagePrompt).trim())) return false; // 비주얼 대상 그룹만
    const hasImg = g.imagePath && fs.existsSync(g.imagePath);
    const hasVid = g.videoPath && fs.existsSync(g.videoPath);
    return !hasImg && !hasVid;
  }).map((g) => g.num);
}
// 미생성 그룹이 있는 편들을 팝업으로 알림. incomplete = [{ label, nums }]
function warnIncompleteVisuals(incomplete) {
  if (!incomplete || !incomplete.length) return;
  const detail = incomplete.map((x) => `• ${x.label}: G${x.nums.join(', G')}`).join('\n');
  log(`⛔ 이미지 미생성으로 .vrew 미생성: ${incomplete.length}건`);
  try {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '이미지 미생성 — .vrew 를 만들지 않았습니다',
      message: '일부 그룹의 이미지가 생성되지 않아 해당 편의 .vrew 를 만들지 않았습니다.',
      detail: `${detail}\n\n해당 그룹의 이미지를 생성한 뒤 다시 시도하세요.\n(쇼츠는 이미지 생성 후 영상으로 변환됩니다.)`,
      buttons: ['확인'],
    });
  } catch {}
}

// Grok 요청(전체) 한도로 작업을 멈췄을 때 안내 팝업. info = { reset }(재사용 시각 텍스트).
function warnGrokLimit(info) {
  log(`⛔ Grok 요청 한도로 작업 중단${info && info.reset ? ` — ${info.reset}` : ''}`);
  try {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Grok 요청 한도 도달 — 작업을 멈췄습니다',
      message: 'Grok 비디오 생성 요청 한도에 도달해 더 진행하지 않고 멈췄습니다.',
      detail: `${info && info.reset ? info.reset + ' 무렵 다시 사용할 수 있습니다.\n\n' : ''}한도가 풀린 뒤 다시 "만들기"를 누르면, 이미 만들어진 TTS·이미지·비디오는 재사용하고 빠진 비디오만 이어서 생성합니다.\n(추후: 다른 Grok 계정 또는 Flow 로 자동 전환 예정)`,
      buttons: ['확인'],
    });
  } catch {}
}

// 영상화할 그룹 번호 — 범위(fromNum~toNum) 안의 그룹. 범위 미지정이면 전체 그룹.
//   (랜덤/개수 방식은 폐지 — 사용자가 N~N 범위로 지정)
function rangeNums(project, fromNum, toNum) {
  if (fromNum == null || toNum == null) return project.groups.map((g) => g.num);
  const a = Math.min(Number(fromNum), Number(toNum)), b = Math.max(Number(fromNum), Number(toNum));
  return project.groups.filter((g) => g.num >= a && g.num <= b).map((g) => g.num);
}

ipcMain.handle('video-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, fromNum = null, toNum = null, engine = 'grok', flowVideoModel = 'Veo 3.1 - Lite', flowCount = 'x1', upscale = false, imgEngine = 'rotate', styleId = null } = args;
  if (engine === 'none') { log('비디오 엔진 "없음" — 이미지만 사용, 비디오 생성 안 함'); return P.toDTO(S.parsed); }
  S.abort = false;
  S.grokLimit = null;
  const _vidT0 = Date.now();
  S.timings.video = 0;
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    if (S.abort) { log('⏹ 중단됨'); break; }
    const videoDir = shortsDirs(S.outRoot, pr.shortsNum).media; // 영상도 media-N 폴더
    const onlyNums = rangeNums(pr, fromNum, toNum); // N~N 범위 그룹 (랜덤 폐지)
    const rangeLbl = ` · G${onlyNums[0]}~${onlyNums[onlyNums.length - 1]}`;
    // 영상은 이미지가 있어야 함 — 범위 그룹 중 이미지 없는 게 있으면 먼저 생성(비어있는 것만 채움).
    const needImg = pr.groups.filter((g) => onlyNums.includes(g.num) && g.imagePrompt && g.imagePrompt.trim() && !(g.imagePath && fs.existsSync(g.imagePath)));
    if (needImg.length && !S.abort) {
      log(`🖼 영상 전 — 이미지 없는 ${needImg.length}개 그룹 먼저 생성 (그룹 ${needImg.map((g) => g.num).join(',')})`);
      try {
        prefillImageCache(pr, videoDir, styleId, imgEngine);
        if (imgEngine === 'comfy') await runComfyImages(pr, videoDir, log, styleId, onlyNums);
        else await runRotatingImages(pr, videoDir, log, styleId, imgEngine, onlyNums);
        cacheGeneratedImages(pr, styleId, imgEngine);
      } catch (e) { log(`이미지 선행 생성 오류: ${e.message}`); }
      pushDtoUpdate();
    }
    try {
      if (engine === 'flow') {
        log(`🎬 ${prLabel(pr)} 영상 생성 (Flow i2v${rangeLbl})…`);
        await runFlowVideos(pr, videoDir, log, { model: flowVideoModel, count: flowCount, onlyNums });
      } else if (engine === 'comfy') {
        log(`🎬 ${prLabel(pr)} 영상 생성 (ComfyUI i2v${rangeLbl})…`);
        await runComfyVideos(pr, videoDir, log, { onlyNums });
      } else {
        log(`🎬 ${prLabel(pr)} 비디오 생성 (Grok ${grokDurOf(engine) === 'auto' ? '자동 6/10초' : grokDurOf(engine)}${rangeLbl})…`);
        const vr = await P.generateHookVideosGrok(pr, videoDir, log, () => S.abort, 0, pushDtoUpdate, onlyNums, grokDurOf(engine));
        if (vr && vr.limitReached) { S.grokLimit = vr.limitReached; S.abort = true; log('⛔ Grok 요청 한도 도달 — 작업을 멈춥니다'); }
      }
      if (!S.abort) await maybeUpscale(pr, log, true); // 모든 영상 1080p 업스케일 (중단 시 생략)
      log(`✓ ${prLabel(pr)} 영상 완료`);
    } catch (e) {
      log(`✗ ${prLabel(pr)} 영상 실패: ${e.message}`);
    }
    pushDtoUpdate(); // 생성된 영상(g.videoPath)을 UI 썸네일에 즉시 반영
  }
  try { await closeFlowEng(); } catch {} // Flow 이미지/영상 창 닫고 마무리
  if (S.grokLimit) { warnGrokLimit(S.grokLimit); S.grokLimit = null; } // Grok 요청 한도 안내 팝업
  S.timings.video = (Date.now() - _vidT0) / 1000;
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 그룹에 이미지/비디오 직접 첨부 (썸네일 클릭 → 파일 선택)
ipcMain.handle('attach-asset', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum } = args;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '이미지/비디오', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }],
  });
  if (r.canceled || !r.filePaths[0]) return P.toDTO(S.parsed);
  const fp = r.filePaths[0];
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  const ext = path.extname(fp).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) {
    g.videoPath = fp; g.videoStatus = 'done';
    log(`첨부(영상) ${pr.title} G${groupNum}: ${path.basename(fp)}`);
  } else {
    g.imagePath = fp; g.imageStatus = 'done';
    log(`첨부(이미지) ${pr.title} G${groupNum}: ${path.basename(fp)}`);
  }
  return P.toDTO(S.parsed);
});

// 그룹 첨부 자산 삭제 (이미지/비디오 비우기)
ipcMain.handle('clear-asset', (_e, args = {}) => {
  if (!S.parsed) return null;
  const { shortsNum, groupNum } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (g) {
    g.imagePath = null; g.videoPath = null; g.imageStatus = 'idle'; g.videoStatus = 'idle'; g.videoSourceImage = null;
    log(`자산 삭제: ${pr.title} G${groupNum}`);
  }
  return P.toDTO(S.parsed);
});

// 채널(프리셋) 편집
ipcMain.handle('get-preset-detail', (_e, name) => {
  const all = require('./tts/preset-store').loadAll();
  return all.find((p) => p.name === name) || null;
});
ipcMain.handle('save-preset', (_e, args = {}) => {
  const store = require('./tts/preset-store');
  const p = store.loadAll().find((x) => x.name === args.name);
  if (!p) throw new Error('프리셋을 찾을 수 없습니다.');
  store.update(p.id, args.patch || {});
  log(`채널 "${args.name}" 설정 저장`);
  return store.loadAll().map((x) => ({ name: x.name, engine: x.engine, isDefault: !!x.isDefault }));
});
// Gemini API 키 (secret-store, gemini 엔진 공용) — GPU 없는 PC에서 음성 생성용
ipcMain.handle('get-gemini-key', () => {
  try { const s = require('./tts/secret-store').get('gemini'); return (s && s.key) || ''; } catch { return ''; }
});
ipcMain.handle('set-gemini-key', (_e, key) => {
  try { require('./tts/secret-store').set('gemini', { key: String(key || '').trim() }); log('Gemini API 키 저장됨'); return true; }
  catch (e) { log('Gemini 키 저장 실패: ' + e.message); return false; }
});

ipcMain.handle('pick-file', async (_e, args = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: args.filters || [{ name: 'All', extensions: ['*'] }] });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});
ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});

// 일괄 첨부 — 이미지/영상 파일들을 직접 다중선택. 파일명 앞 숫자 = 그룹번호 매핑. 같은 번호면 영상 우선.
ipcMain.handle('bulk-attach', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum } = args;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '이미지/영상', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }],
  });
  if (r.canceled || !r.filePaths.length) return P.toDTO(S.parsed);
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  if (!pr) return P.toDTO(S.parsed);
  const picked = r.filePaths; // 절대경로들
  const baseOf = (f) => path.basename(f);
  const isVid = (f) => /\.(mp4|mov|webm|m4v)$/i.test(f);
  const isImg = (f) => /\.(png|jpe?g|webp|gif)$/i.test(f);
  let cnt = 0;
  for (const g of pr.groups) {
    const matches = picked.filter((f) => {
      const mm = baseOf(f).match(/^0*(\d+)/);
      return mm && parseInt(mm[1], 10) === g.num && (isVid(f) || isImg(f));
    });
    if (!matches.length) continue;
    const vid = matches.find(isVid);
    const img = matches.find(isImg);
    if (vid) { g.videoPath = vid; g.videoStatus = 'done'; cnt++; }
    else if (img) { g.imagePath = img; g.imageStatus = 'done'; cnt++; }
  }
  log(`일괄첨부 ${pr.title}: 선택 ${picked.length}개 → ${cnt}개 그룹 매핑 (영상우선)`);
  return P.toDTO(S.parsed);
});

// ── 자동저장(구글독스식) ──────────────────────────────────────────────
//   변경이 멈추면 1.5초 뒤(또는 변경이 계속돼도 최대 8초마다) 스냅샷을 디스크에 기록.
//   임시파일→rename 으로 원자적 교체 → 쓰다 만 파일로 깨지지 않음.
//   재열기 시 자동복원(open-script)되므로 사용자가 저장 버튼을 누르지 않아도 작업이 보존됨.
function snapshotFile(scriptPath) {
  const sp = scriptPath || S.scriptPath;
  const projDir = path.join(os.homedir(), '.priming-maker', 'projects');
  const base = P.sanitize(path.basename(sp || 'project').replace(/\.md$/i, ''));
  return { projDir, file: path.join(projDir, base + '.smproj.json') };
}
// 대본(.md) 1개 → parsed 빌드(+자동저장 스냅샷 복원). open-script·큐복원 공용.
//   대본 미수정 → 작업본 그대로, 수정됨 → 새로 파싱 후 자산 overlay.
function buildParsedForScript(scriptPath, mode, preset) {
  let note = '', snap = null;
  try { const { file } = snapshotFile(scriptPath); if (fs.existsSync(file)) snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const sameMode = snap && ((snap.mode === 'longform' ? 'longform' : 'shorts') === mode);
  let mdMtime = 0; try { mdMtime = fs.statSync(scriptPath).mtimeMs; } catch {}
  let parsed;
  if (sameMode && snap.savedAt && snap.savedAt >= mdMtime) {
    const projects = projectsFromSnapshot(snap);
    const fmt = detectFormatFromScript(scriptPath) || 'grouped'; // 원본 .md 로 형식 재판별(옛 스냅샷 보정)
    for (const pr of projects) { pr.mode = mode; if (!pr.format) pr.format = fmt; }
    parsed = { fileTitle: snap.fileTitle, meta: snap.meta, projects, format: fmt, mode };
    note = `♻ 작업본 이어받기 (${new Date(snap.savedAt).toLocaleString()})`;
  } else {
    parsed = P.parseScript(scriptPath, mode, presetThresholds(preset));
    if (sameMode) { const n = overlaySnapshot(parsed, snap); if (n) note = `♻ 대본 수정 감지 — 기존 자산 ${n}개 복원`; }
  }
  applyIntroFromScript(parsed, scriptPath, mode); // 도입부(isIntro)는 .md 가 출처 — 항상 재계산(복원 대본 색 누락 방지)
  return { parsed, note };
}
// .md 의 '도입부' 영역(splitHybrid)에서 도입 문장 텍스트를 뽑아, 그룹의 문장과 매칭해 isIntro 재설정.
//   ★ 도입부는 대본 '앞쪽 연속 블록' — 도입 영역을 벗어나면 거기서 끝낸다(한 번 벗어나면 다시 도입 아님).
//     그룹의 '모든' 문장이 도입 문장일 때만 도입으로 판정 → 결말에서 도입 문구를 반복해도 오인식 안 함.
//   롱폼 전용. 스냅샷 구조(분할/병합)와 무관하게 정확.
function applyIntroFromScript(parsed, scriptPath, mode) {
  try {
    if (mode !== 'longform' || !parsed || !parsed.projects) return;
    const txt = fs.readFileSync(scriptPath, 'utf8');
    const { splitHybrid } = require('./core/sentence-splitter');
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const introSet = new Set(splitHybrid(txt).items.filter((it) => it.isIntro).map((it) => norm(it.text)));
    if (!introSet.size) return; // 도입부 헤더 없음 → 변경 안 함
    for (const pr of parsed.projects) {
      let inIntro = true; // 도입부는 앞쪽 연속 — 벗어나면 false 로 고정
      for (const g of pr.groups) {
        const sents = pr.getSentencesOfGroup(g);
        const isIntro = inIntro && sents.length > 0 && sents.every((s) => introSet.has(norm(s.text)));
        g.isIntro = isIntro;
        if (!isIntro) inIntro = false;
      }
    }
  } catch (e) { /* 실패 시 기존 값 유지 */ }
}
function buildSnapshot() {
  return {
    scriptPath: S.scriptPath, fileTitle: S.parsed.fileTitle, meta: S.parsed.meta, outRoot: S.outRoot, mode: currentMode(),
    savedAt: Date.now(),
    projects: S.parsed.projects.map((pr) => ({
      shortsNum: pr.shortsNum, title: pr.title, aspect: pr.aspect, hookCaption: pr.hookCaption, voice: pr.voice,
      format: pr.format || S.parsed.format || null, // 대본 형식 보존(grouped 면 자동 재구성 건너뜀)
      titleLine1: pr.titleLine1, titleLine2: pr.titleLine2,
      t1Size: pr.t1Size, t1Color: pr.t1Color, t1Align: pr.t1Align,
      t2Size: pr.t2Size, t2Color: pr.t2Color, t2Align: pr.t2Align,
      bgEnabled: pr.bgEnabled, bgFill: pr.bgFill, bgFillOp: pr.bgFillOp, bgStroke: pr.bgStroke,
      bgStrokeOp: pr.bgStrokeOp, bgStrokeW: pr.bgStrokeW, bgRound: pr.bgRound, bgDashed: pr.bgDashed,
      groups: pr.groups.map((g) => ({
        num: g.num, phase: g.phase, mode: g.mode, isI2V: g.isI2V, isIntro: g.isIntro,
        imagePrompt: g.imagePrompt, videoPrompt: g.videoPrompt, motionNote: g.motionNote,
        imagePath: g.imagePath, videoPath: g.videoPath,
        sentences: pr.getSentencesOfGroup(g).map((s) => ({ text: s.text, ttsAudioPath: s.ttsAudioPath, ttsDurationSec: s.ttsDurationSec, isIntro: s.isIntro })),
      })),
    })),
  };
}
function writeSnapshotSync() {
  if (!S.parsed) return null;
  try {
    const { projDir, file } = snapshotFile();
    fs.mkdirSync(projDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(buildSnapshot(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return file;
  } catch (e) { log('자동저장 실패: ' + (e && e.message)); return null; }
}
let _asTimer = null, _asPendingSince = 0;
function scheduleAutoSave() {
  if (!S.parsed) return;
  const now = Date.now();
  if (!_asPendingSince) _asPendingSince = now;
  if (_asTimer) clearTimeout(_asTimer);
  const wait = (now - _asPendingSince > 8000) ? 0 : 1500; // 최대 8초 안에는 무조건 기록(연속변경 기아 방지)
  _asTimer = setTimeout(flushAutoSave, wait);
}
function flushAutoSave() {
  if (_asTimer) { clearTimeout(_asTimer); _asTimer = null; }
  _asPendingSince = 0;
  const f = writeSnapshotSync();
  writeWorkspace(); // 큐 구성(목록/설정/상태)도 함께 저장
  if (f && win && !win.isDestroyed()) { try { win.webContents.send('autosaved', { file: f, at: Date.now() }); } catch {} }
}

// ── 작업 큐(워크스페이스) 영속 ── 어떤 대본들이 적재됐는지(목록/설정/상태/활성)를 저장.
//   대본 작업 내용 자체는 각 .smproj.json 에 있고, 여기엔 scriptPath·settings·status 만 기록.
function workspaceFile() { return path.join(os.homedir(), '.priming-maker', 'workspace.json'); }
function writeWorkspace() {
  try {
    const ser = (mode) => {
      const q = S.modes[mode];
      return { activeId: q.activeId, items: q.items.map((it) => ({ id: it.id, scriptPath: it.scriptPath, settings: it.settings || null, status: it.status || 'idle' })) };
    };
    const ws = { version: 1, mode: S.mode, longform: ser('longform'), shorts: ser('shorts') };
    const f = workspaceFile(); const tmp = f + '.tmp';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ws, null, 2), 'utf8'); fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}
// 앱 시작 시 큐 복원 — 저장된 대본들을 다시 파싱(+작업본 복원)해 큐 재구성.
function restoreWorkspace() {
  try {
    const f = workspaceFile(); if (!fs.existsSync(f)) return;
    const ws = JSON.parse(fs.readFileSync(f, 'utf8')); if (!ws) return;
    let restored = 0;
    for (const mode of ['longform', 'shorts']) {
      const wq = ws[mode]; if (!wq || !Array.isArray(wq.items)) continue;
      const q = S.modes[mode]; let activeNewId = null;
      for (const wi of wq.items) {
        if (!wi.scriptPath || !fs.existsSync(wi.scriptPath)) continue; // 사라진 대본 skip
        try {
          const preset = (wi.settings && wi.settings.presetName) ? P.getPreset(wi.settings.presetName) : null;
          const { parsed } = buildParsedForScript(wi.scriptPath, mode, preset);
          for (const pr of parsed.projects) pr.mode = mode;
          const outRoot = computeOutRoot(wi.scriptPath, preset, mode);
          const it = { id: newItemId(), parsed, scriptPath: wi.scriptPath, outRoot, settings: wi.settings || null,
            status: (wi.status === 'running' ? 'idle' : (wi.status || 'idle')) }; // 중단된 running 은 idle 로
          q.items.push(it); restored++;
          if (wi.id === wq.activeId) activeNewId = it.id;
        } catch (e) { log(`큐 항목 복원 실패(${path.basename(wi.scriptPath)}): ${e.message}`); }
      }
      q.activeId = activeNewId || (q.items.length ? q.items[q.items.length - 1].id : null);
    }
    S.mode = (ws.mode === 'longform') ? 'longform' : 'shorts';
    syncActiveToS();
    if (restored) log(`♻ 작업 큐 복원: ${restored}개 대본 (${S.mode})`);
  } catch (e) { log('큐 복원 실패: ' + (e && e.message)); }
}
// 스냅샷 JSON → Project[] 복원 (load-project / open-script 자동복원 공용)
function projectsFromSnapshot(snap) {
  const { Sentence, Group, Project, makeSentenceIder, finalizeGroupIds } = require('./core/project-model');
  return (snap.projects || []).map((ps) => {
    const sid = makeSentenceIder(); const sentences = []; const groups = [];
    (ps.groups || []).forEach((gs) => {
      const g = new Group({ num: gs.num, sentenceIds: [] });
      // isIntro: 신규 스냅샷은 저장값, 구 스냅샷은 phase 로 폴백(도입부 H2 → phase 에 '도입' 포함)
      const introFlag = gs.isIntro != null ? !!gs.isIntro : /도입/.test(gs.phase || '');
      Object.assign(g, { imagePrompt: gs.imagePrompt, videoPrompt: gs.videoPrompt, phase: gs.phase, title: gs.phase, mode: gs.mode, isI2V: gs.isI2V, isIntro: introFlag, motionNote: gs.motionNote, imagePath: gs.imagePath, videoPath: gs.videoPath });
      (gs.sentences || []).forEach((ss) => {
        const s = new Sentence({ id: sid(ss.text), num: sentences.length + 1, text: ss.text });
        s.groupId = g.id; s.ttsAudioPath = ss.ttsAudioPath || null; s.ttsDurationSec = ss.ttsDurationSec || null; s.isIntro = !!ss.isIntro;
        g.sentenceIds.push(s.id); sentences.push(s);
      });
      groups.push(g);
    });
    finalizeGroupIds(groups, sentences);
    const proj = new Project({ sentences, groups });
    Object.assign(proj, { format: ps.format || snap.format || null, aspect: ps.aspect, title: ps.title, shortsNum: ps.shortsNum, hookCaption: ps.hookCaption, voice: ps.voice,
      titleLine1: ps.titleLine1, titleLine2: ps.titleLine2,
      t1Size: ps.t1Size, t1Color: ps.t1Color, t1Align: ps.t1Align, t2Size: ps.t2Size, t2Color: ps.t2Color, t2Align: ps.t2Align,
      bgEnabled: ps.bgEnabled, bgFill: ps.bgFill, bgFillOp: ps.bgFillOp, bgStroke: ps.bgStroke,
      bgStrokeOp: ps.bgStrokeOp, bgStrokeW: ps.bgStrokeW, bgRound: ps.bgRound, bgDashed: ps.bgDashed });
    return proj;
  });
}
// 새로 파싱한 대본 위에 스냅샷의 "작업물"만 덮어쓰기(대본을 수정한 경우 — 자산/프롬프트 최대한 이어받기).
//   그룹번호 일치 + (문장 텍스트 동일할 때만) TTS 복원. 파일이 실제 존재하는 자산만 복원.
function overlaySnapshot(parsed, snap) {
  let touched = 0;
  const byShorts = new Map();
  (snap.projects || []).forEach((ps) => byShorts.set(ps.shortsNum, ps));
  for (const pr of parsed.projects) {
    const ps = byShorts.get(pr.shortsNum); if (!ps) continue;
    for (const k of ['title','aspect','hookCaption','voice','titleLine1','titleLine2','t1Size','t1Color','t1Align','t2Size','t2Color','t2Align','bgEnabled','bgFill','bgFillOp','bgStroke','bgStrokeOp','bgStrokeW','bgRound','bgDashed']) {
      if (ps[k] != null) pr[k] = ps[k];
    }
    const gmap = new Map(); (ps.groups || []).forEach((gs) => gmap.set(gs.num, gs));
    for (const g of pr.groups) {
      const gs = gmap.get(g.num); if (!gs) continue;
      if (gs.imagePrompt != null) g.imagePrompt = gs.imagePrompt;
      if (gs.videoPrompt != null) g.videoPrompt = gs.videoPrompt;
      if (gs.motionNote != null) g.motionNote = gs.motionNote;
      if (gs.imagePath && fs.existsSync(gs.imagePath)) { g.imagePath = gs.imagePath; g.imageStatus = 'done'; touched++; }
      if (gs.videoPath && fs.existsSync(gs.videoPath)) { g.videoPath = gs.videoPath; g.videoStatus = 'done'; }
      const sents = pr.getSentencesOfGroup(g);
      (gs.sentences || []).forEach((ss, i) => {
        const s = sents[i]; if (!s) return;
        if (ss.text && s.text && ss.text.trim() !== s.text.trim()) return; // 대본 문장이 바뀜 → TTS 복원 skip
        if (ss.ttsAudioPath && fs.existsSync(ss.ttsAudioPath)) { s.ttsAudioPath = ss.ttsAudioPath; s.ttsDurationSec = ss.ttsDurationSec || null; }
      });
    }
  }
  return touched;
}

// 프로젝트 저장/불러오기 (대본 1개 기준 스냅샷)
ipcMain.handle('save-project', async () => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const file = writeSnapshotSync();
  if (!file) throw new Error('저장 실패 — 로그를 확인하세요.');
  log(`💾 프로젝트 저장: ${file}`);
  return { file };
});
ipcMain.handle('load-project', async () => {
  const projDir = path.join(os.homedir(), '.priming-maker', 'projects');
  fs.mkdirSync(projDir, { recursive: true });
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: projDir, filters: [{ name: 'Shots 프로젝트', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const snap = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  const projects = projectsFromSnapshot(snap);
  S.scriptPath = snap.scriptPath; S.outRoot = snap.outRoot;
  S.mode = (snap.mode === 'longform') ? 'longform' : 'shorts';
  const fmt = detectFormatFromScript(snap.scriptPath) || 'grouped'; // 원본 .md 로 형식 재판별(옛 스냅샷 보정)
  for (const pr of projects) { pr.mode = S.mode; if (!pr.format) pr.format = fmt; }
  S.parsed = { fileTitle: snap.fileTitle, meta: snap.meta, projects, format: fmt, mode: S.mode };
  addItem(S.parsed, S.scriptPath, S.outRoot); // 현재 모드 큐에 추가 + 활성화
  log(`📂 프로젝트 불러오기(${S.mode}): ${r.filePaths[0]}`);
  return { dto: P.toDTO(S.parsed), scriptPath: S.scriptPath, outRoot: S.outRoot, mode: S.mode, queue: queueDTO() };
});

// ⚡ 전체 만들기 — TTS + 이미지 동시 → I2V 영상 → .vrew → 출력폴더 열기
// 전체 제작 코어 — 현재 활성 대본(S.parsed/S.outRoot)에 대해 TTS→이미지→영상→.vrew.
//   make-all(단건)·run-batch(순차 큐)가 공용. opts.openVrew/openFolder 로 자동열기 제어(큐 실행 시 끔).
async function runMakeAllCore(opts = {}) {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, engine = 'genspark', presetName = null, speed = null, captionStyle = null, captionMaxChars = 7, styleId = null, fromNum = null, toNum = null, dry = false, videoEngine = 'grok', flowVideoModel = 'Veo 3.1 - Lite', flowCount = 'x1', clipMaxSec = null, aiNotice = false, openVrew = true, openFolder = true } = opts;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  let preset = P.getPreset(presetName);
  // TTS 는 정속(1.0) — speed 값은 Vrew 배속(playbackRate)으로만 사용
  S.preset = preset;
  let ttsMgr = null;
  if (!dry && preset) {
    const { mgr, ok } = await P.makeTtsManager(log, preset.engine);
    if (!ok) throw new Error(`TTS 엔진 '${preset.engine}' 미가동`);
    ttsMgr = mgr;
  }
  S.abort = false;
  S.grokLimit = null; // 이번 실행 중 Grok 요청 한도 감지 여부(감지 시 작업 중단 + 팝업)
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  // 프롬프트 없는 그룹(prose 대본) → 이미지 전에 API로 자동 생성 (내용 맞는 이미지)
  if (!dry) { await autoFillPrompts(S.parsed.projects.filter((p) => !shortsNum || p.shortsNum === shortsNum), log); }
  const _makeT0 = Date.now();
  S.timings = { tts: 0, image: 0, video: 0, make: 0 }; // 이번 작업 단계별 시간 (누적)
  pushDtoUpdate();

  // 쇼츠 1·2·3 을 하나의 덩어리로 — 단계별 일괄 처리.
  //   예전: 쇼츠마다 [TTS→이미지→영상→.vrew] 를 끝까지 돌리고 다음 쇼츠.
  //   지금: 전 쇼츠의 TTS 를 1번 1그룹부터 마지막 쇼츠 마지막 그룹까지 먼저, 그다음 전 쇼츠 이미지,
  //         그다음 전 쇼츠 영상, 마지막에 전 쇼츠 .vrew. (사용자 요청)
  //   부수효과: 단계가 완전 순차라 ComfyUI(로컬 GPU) 이미지와 OmniVoice TTS 가 겹치지 않음 → VRAM 충돌 자동 해소.
  //   (트레이드오프: 예전 Genspark/Flow 의 'TTS∥이미지' 동시 실행은 사라짐 — 의도된 변경.)
  const projects = S.parsed.projects.filter((pr) => !shortsNum || pr.shortsNum === shortsNum);

  // ── 1단계: 음성(TTS) — 쇼츠1 1그룹부터 쇼츠N 마지막 그룹까지 ──
  log('🎙 1단계 — 음성(TTS) 일괄 변환…');
  for (const pr of projects) {
    if (S.abort) { log('⏹ 중단됨'); break; }
    const dirs = shortsDirs(S.outRoot, pr.shortsNum);
    const t0 = Date.now();
    try {
      if (dry) P.fillSilent(pr, dirs.tts);
      else await P.fillTts(pr, preset, ttsMgr, dirs.tts, log, () => S.abort, speed, pushDtoUpdate);
      // 음성 직후 그룹 재구성(쇼츠 모드만) — TTS 버튼(tts-build)과 동일. clipMaxSec 없으면 생략.
      if (!dry && clipMaxSec && getModeProfile(currentMode()).grouping.strategy === 'tts-greedy' && pr.format !== 'grouped') {
        const m = P.mergeGroupsByTts(pr, clipMaxSec);
        log(`  ↳ ${prLabel(pr)} ${clipMaxSec}초 미만 단위 그룹 재구성: ${m.before} → ${m.after}개`);
      } else if (pr.format === 'grouped') {
        log(`  ↳ ${prLabel(pr)} 작성된 그룹 구조 유지 (그룹 ${pr.groups.length}개) — 자동 재구성 생략`);
      }
      log(`✓ ${prLabel(pr)} 음성 완료`);
    } catch (e) { log(`${prLabel(pr)} 음성 오류: ${e.message}`); }
    S.timings.tts += (Date.now() - t0) / 1000;
    pushDtoUpdate();
  }

  // ── 2단계: 이미지 — 전 쇼츠 ──
  if (!dry && !S.abort) {
    log('🖼 2단계 — 이미지 일괄 생성…');
    for (const pr of projects) {
      if (S.abort) { log('⏹ 중단됨'); break; }
      const dirs = shortsDirs(S.outRoot, pr.shortsNum);
      prefillImageCache(pr, dirs.media, styleId, engine); // ♻ 캐시 재활용 먼저
      const t0 = Date.now();
      try {
        if (imagesNeeded(pr) > 0) {
          if (engine === 'comfy') await runComfyImages(pr, dirs.media, log, styleId); // ComfyUI 단독
          else await runRotatingImages(pr, dirs.media, log, styleId, engine);          // genspark/flow → 순환
        }
      } catch (e) { log(`${prLabel(pr)} 이미지 오류: ${e.message}`); }
      cacheGeneratedImages(pr, styleId, engine);
      S.timings.image += (Date.now() - t0) / 1000;
      pushDtoUpdate(); // 이미지 매핑(g.imagePath) UI 썸네일에 반영
    }
  }

  // ── 3단계: 비디오 — 전 쇼츠 (videoEngine='none'이면 비디오 없이 이미지만 사용) ──
  if (videoEngine === 'none') {
    log('🎬 3단계 — 비디오 없음(이미지만) — 건너뜀');
  } else if (!dry && !S.abort) {
    log('🎬 3단계 — 비디오 일괄 생성…');
    for (const pr of projects) {
      if (S.abort) { log('⏹ 중단됨'); break; }
      const dirs = shortsDirs(S.outRoot, pr.shortsNum);
      const vOnly = rangeNums(pr, fromNum, toNum); // I2V 범위(미지정=전체)
      const t0 = Date.now();
      try {
        if (videoEngine === 'flow') await runFlowVideos(pr, dirs.media, log, { model: flowVideoModel, count: flowCount, onlyNums: vOnly });
        else if (videoEngine === 'comfy') await runComfyVideos(pr, dirs.media, log, { onlyNums: vOnly });
        else {
          const vr = await P.generateHookVideosGrok(pr, dirs.media, log, () => S.abort, 0, pushDtoUpdate, vOnly, grokDurOf(videoEngine));
          if (vr && vr.limitReached) { S.grokLimit = vr.limitReached; S.abort = true; log('⛔ Grok 요청 한도 도달 — 작업을 멈춥니다 (한도 풀린 뒤 다시 만들기)'); }
        }
        if (!S.abort) await maybeUpscale(pr, log, true); // 모든 영상 1080p 업스케일 (중단 시 생략)
      } catch (e) { log(`${prLabel(pr)} 영상 실패: ${e.message}`); }
      S.timings.video += (Date.now() - t0) / 1000;
      pushDtoUpdate(); // 생성된 영상(g.videoPath)도 UI 에 반영
    }
  }

  // ── 4단계: .vrew — 전 쇼츠. (중단 시엔 .vrew 생성·이후 작업 모두 생략 — 사용자가 멈췄으면 뒤 작업 안 함) ──
  if (!S.abort) {
    log('📦 4단계 — .vrew 일괄 생성…');
    const incomplete = [];
    for (const pr of projects) {
      const miss = missingVisualGroups(pr);
      if (miss.length) {
        incomplete.push({ label: prLabel(pr), nums: miss });
        log(`⛔ ${prLabel(pr)} — 이미지 미생성 그룹 ${miss.length}개 (G${miss.join(', G')}) → .vrew 건너뜀`);
        continue;
      }
      let ep = preset;
      if (ep && captionStyle) ep = { ...ep, captionStyle: { ...(ep.captionStyle || {}), ...captionStyle } };
      ep = resolveAiNotice(ep, aiNotice); // 롱폼=항상 / 쇼츠=사용자 선택
      const dirs = shortsDirs(S.outRoot, pr.shortsNum);
      const baseName = vrewBaseName(pr);
      const vrewPath = path.join(S.outRoot, `${baseName}.vrew`);
      try {
        const res = await P.buildProjectVrew(pr, vrewPath, ep, log, captionMaxChars); // 배속은 음성에 이미 반영
        P.writeSrt(pr, path.join(dirs.subtitles, `${baseName}.srt`), captionMaxChars);
        log(`✓ ${pr.title}.vrew (clip ${res.clipCount})`);
        if (openVrew) shell.openPath(vrewPath);
      } catch (e) { log(`${prLabel(pr)} vrew 실패: ${e.message}`); }
    }
    warnIncompleteVisuals(incomplete);
  } else {
    log('⏹ 중단됨 — .vrew 생성 및 이후 작업 생략');
  }
  if (S.grokLimit) { warnGrokLimit(S.grokLimit); S.grokLimit = null; } // Grok 요청 한도로 멈춘 경우 안내 팝업
  if (ttsMgr) { try { await ttsMgr.stop(); } catch {} }
  try { await closeFlowEng(); } catch {} // Flow 이미지/영상 창 닫고 마무리
  S.timings.make = (Date.now() - _makeT0) / 1000;
  pushDtoUpdate();
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  if (openFolder && !S.abort) shell.openPath(S.outRoot); // 중단 시 탐색기 자동 열기 생략
  log(S.abort
    ? `⏹ 중단됨 — 완료된 자산만 보존 (TTS ${S.timings.tts.toFixed(1)}s · 이미지 ${S.timings.image.toFixed(1)}s · 비디오 ${S.timings.video.toFixed(1)}s)`
    : `⚡ 전체 제작 완료 (TTS ${S.timings.tts.toFixed(1)}s · 이미지 ${S.timings.image.toFixed(1)}s · 비디오 ${S.timings.video.toFixed(1)}s · 전체 ${S.timings.make.toFixed(1)}s)`);
}

ipcMain.handle('make-all', async (_e, args = {}) => {
  await runMakeAllCore({ ...args, openVrew: true, openFolder: true });
  return P.toDTO(S.parsed);
});

// ── 큐 순차 제작 ── 교차 순서(L1→S1→L2→S2…)는 렌더러가 plan 으로 전달. 한 항목씩 runMakeAllCore.
//   실패해도 해당 항목만 '실패' 표시 후 다음 진행. 자동열기는 끔(.vrew·폴더 폭주 방지).
ipcMain.handle('run-batch', async (_e, args = {}) => {
  const plan = Array.isArray(args.plan) ? args.plan : [];
  const common = args.common || {};
  if (!plan.length) throw new Error('실행할 대본이 큐에 없습니다.');
  S.abort = false;
  log(`⚡⚡ 큐 순차 제작 시작 — 총 ${plan.length}개`);
  let okN = 0, failN = 0;
  for (let i = 0; i < plan.length; i++) {
    if (S.abort) { log('⏹ 큐 중단됨 — 남은 대본 보존'); break; }
    const entry = plan[i] || {};
    storeActive(); // 직전 항목 편집분 저장
    S.mode = (entry.mode === 'longform') ? 'longform' : 'shorts';
    const q = S.modes[S.mode];
    const it = q.items.find((x) => x.id === entry.id);
    if (!it) { log(`(건너뜀) 큐 항목 없음 [${i + 1}/${plan.length}]`); continue; }
    q.activeId = it.id; syncActiveToS();
    if (!S.parsed) { log(`(건너뜀) 대본 비어있음 [${i + 1}/${plan.length}]`); continue; }
    it.status = 'running'; pushDtoUpdate();
    const label = (S.parsed.fileTitle) || (it.scriptPath || '');
    log(`▶ [${i + 1}/${plan.length}] ${S.mode === 'longform' ? '롱폼' : '쇼츠'} · ${label}`);
    const s = entry.settings || {};
    try {
      await runMakeAllCore({
        engine: s.imgEngine || 'genspark', presetName: s.presetName || null, speed: s.ttsSpeed || null,
        styleId: s.styleId || null,
        fromNum: (s.vidFrom != null && s.vidFrom !== '') ? parseInt(s.vidFrom, 10) : null,
        toNum: (s.vidTo != null && s.vidTo !== '') ? parseInt(s.vidTo, 10) : null,
        videoEngine: s.videoEngine || 'grok', flowVideoModel: s.flowVideoModel || 'Veo 3.1 - Lite', flowCount: s.flowCount || 'x1',
        captionStyle: common.captionStyle || null, captionMaxChars: common.captionMaxChars || 7,
        clipMaxSec: clipMaxOf(s.videoEngine || 'grok'), aiNotice: !!s.aiNotice, // 쇼츠 그룹 재구성 캡 + AI 고지(사용자 선택)
        dry: false, openVrew: false, openFolder: false,
      });
      it.status = 'done'; okN++;
    } catch (e) {
      it.status = 'failed'; failN++;
      log(`✗ 실패: ${label} — ${e.message} (다음 대본 계속)`);
    }
    pushDtoUpdate();
  }
  log(`⚡⚡ 큐 제작 종료 — 성공 ${okN} · 실패 ${failN}`);
  try { if (S.outRoot) shell.openPath(S.outRoot); } catch {}
  return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
});

const TITLE_FIELDS = new Set(['titleLine1', 'titleLine2', 't1Size', 't1Color', 't1Align', 't2Size', 't2Color', 't2Align',
  'bgEnabled', 'bgFill', 'bgFillOp', 'bgStroke', 'bgStrokeOp', 'bgStrokeW', 'bgRound', 'bgDashed']);
ipcMain.handle('set-title', (_e, args = {}) => {
  if (!S.parsed) return;
  const { shortsNum, field, value } = args;
  if (!TITLE_FIELDS.has(field)) return;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  if (pr) pr[field] = value;
});

// 미리보기 오디오 — 파일을 base64 data URL 로 반환 (media:// fetch 가 렌더러에서 막히는 경우 우회)
// 작업 중단 — generate 함수들의 abortSignal 이 S.abort 를 확인
ipcMain.handle('abort', () => {
  S.abort = true;
  // Flow 엔진은 자체 _stopped 플래그로 멈춤 — abort 시 명시적으로 stop() 호출
  try { if (S.flowEng && typeof S.flowEng.stop === 'function') S.flowEng.stop(); } catch {}
  log('⏹ 중단 요청 — 현재 단계 마치는 대로 멈춥니다');
});

// 초기화 — 현재 모드의 대본만 비움 (다른 모드 대본은 유지)
ipcMain.handle('reset-project', () => {
  S.abort = false;
  const q = S.modes[S.mode]; if (q) { q.items = []; q.activeId = null; } // 현재 모드 큐 비움
  syncActiveToS(); // S.parsed=null
  scheduleAutoSave(); writeWorkspace();
  log(`🆕 초기화(${S.mode}) — 현재 모드 큐 비움`);
  return { dto: null, queue: queueDTO() };
});

// ── 작업 큐 ── 현재 모드의 적재 대본 목록 조회/선택/제거. (mount 복원용 dto/mode 포함)
ipcMain.handle('list-queue', () => ({ queue: queueDTO(), dto: S.parsed ? P.toDTO(S.parsed) : null, mode: S.mode }));
ipcMain.handle('select-queue-item', (_e, args = {}) => {
  const id = args && args.id;
  const q = S.modes[S.mode];
  if (!q.items.find((x) => x.id === id)) return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
  q.activeId = id; syncActiveToS(); writeWorkspace();
  log(`↔ 대본 선택: ${(S.parsed && S.parsed.fileTitle) || ''}`);
  return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
});
ipcMain.handle('remove-queue-item', (_e, args = {}) => {
  const id = args && args.id;
  const q = S.modes[S.mode];
  q.items = q.items.filter((x) => x.id !== id);
  if (q.activeId === id) q.activeId = q.items.length ? q.items[q.items.length - 1].id : null;
  syncActiveToS();
  scheduleAutoSave(); writeWorkspace();
  log(`🗑 대본 제거 (남은 ${q.items.length}개)`);
  return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
});
// 활성 항목의 생성 설정 저장(대본별 개별). 렌더러 헤더 변경 시 디바운스로 전송.
ipcMain.handle('set-queue-settings', (_e, args = {}) => {
  const it = activeItem();
  if (it) { it.settings = (args && args.settings) || null; scheduleAutoSave(); writeWorkspace(); }
  return true;
});

// 그룹 1개만 TTS 변환 (그 그룹의 문장들)
ipcMain.handle('tts-group', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum, presetName = null, speed = null } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  const preset = S.preset || P.getPreset(presetName);
  if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
  const { mgr, ok } = await P.makeTtsManager(log, preset.engine);
  if (!ok) throw new Error(`TTS 엔진 '${preset.engine}' 미가동`);
  const ttsDir = shortsDirs(S.outRoot, shortsNum).tts;
  const sents = pr.getSentencesOfGroup(g);
  S.abort = false;
  log(`🎤 G${groupNum} TTS (${sents.length}문장)…`);
  await P.fillTtsList(sents, preset, mgr, ttsDir, log, () => S.abort, (speed && Number(speed) > 0) ? Number(speed) : 1.0, `G${groupNum}`, pushDtoUpdate);
  try { await mgr.stop(); } catch {}
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 그룹 1개만 영상 변환 (이미지 → i2v)
ipcMain.handle('video-group', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum, engine = 'grok', flowVideoModel = 'Veo 3.1 - Lite', flowCount = 'x1', upscale = false, imgEngine = 'rotate', styleId = null } = args;
  if (engine === 'none') { log('비디오 엔진 "없음" — 이미지만 사용, 비디오 생성 안 함'); return P.toDTO(S.parsed); }
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  S.abort = false;
  const videoDir = shortsDirs(S.outRoot, shortsNum).media;
  // 이미지가 없으면 먼저 생성(비어있는 것 채움) → 그 이미지로 영상.
  if (!g.imagePath || !fs.existsSync(g.imagePath)) {
    if (!g.imagePrompt || !g.imagePrompt.trim()) { log(`G${groupNum}: 이미지·프롬프트 없어 영상 생략`); return P.toDTO(S.parsed); }
    log(`🖼 G${groupNum} 이미지 없음 — 먼저 생성 후 영상`);
    try {
      prefillImageCache(pr, videoDir, styleId, imgEngine);
      if (imgEngine === 'comfy') await runComfyImages(pr, videoDir, log, styleId, [groupNum]);
      else await runRotatingImages(pr, videoDir, log, styleId, imgEngine, [groupNum]);
      cacheGeneratedImages(pr, styleId, imgEngine);
    } catch (e) { log(`이미지 선행 생성 오류: ${e.message}`); }
    pushDtoUpdate();
    if (!g.imagePath || !fs.existsSync(g.imagePath)) { log(`G${groupNum}: 이미지 생성 실패 — 영상 생략`); return P.toDTO(S.parsed); }
  }
  log(`🎬 G${groupNum} 영상 생성 (${engine})…`);
  // 단일 그룹 재생성 = 강제 새로 만들기 → 기존 영상·캐시 비우기.
  try {
    const MC = require('./core/media-cache');
    const engTag = engine === 'comfy' ? 'comfy-ltx' : 'grok';
    MC.del(MC.videoKey(g.videoPrompt || g.motionNote || '', g.imagePath, pr.aspect || '9:16', engTag));
    g.videoPath = null; g.videoStatus = 'generating'; pushDtoUpdate();
  } catch {}
  try {
    if (engine === 'flow') {
      await runFlowVideos(pr, videoDir, log, { model: flowVideoModel, count: flowCount, onlyNums: [groupNum] });
    } else if (engine === 'comfy') {
      await runComfyVideos(pr, videoDir, log, { onlyNums: [groupNum] });
    } else {
      await P.generateHookVideosGrok(pr, videoDir, log, () => S.abort, 0, pushDtoUpdate, [groupNum], grokDurOf(engine));
    }
    await maybeUpscale(pr, log, true);
    log(`✓ G${groupNum} 영상 완료`);
  } catch (e) { log(`✗ G${groupNum} 영상 실패: ${e.message}`); }
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 빈(또는 특정) 그룹 1개만 이미지 재생성 (Genspark 단일)
ipcMain.handle('regen-group', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum, styleId = null } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  if (!g.imagePrompt || !g.imagePrompt.trim()) { log(`G${groupNum}: 이미지 프롬프트 없음`); return P.toDTO(S.parsed); }
  S.abort = false;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const mediaDir = shortsDirs(S.outRoot, shortsNum).media;
  log(`🔄 ${prLabel(pr)} G${groupNum} 이미지 재생성 (Genspark)…`);
  try {
    g.imagePath = null; g.imageStatus = 'generating'; pushDtoUpdate(); // 강제 재생성(캐시 필터 우회)
    await P.generateImagesGenspark(pr, mediaDir, log, () => S.abort, stylePrompt, [groupNum], pushDtoUpdate);
    // 새 이미지를 캐시에 갱신(이후 재활용 시 이 결과 사용)
    const MC = require('./core/media-cache');
    if (g.imagePath && fs.existsSync(g.imagePath)) MC.put(MC.imageKey(g.imagePrompt, styleId || '', pr.aspect || '9:16', 'genspark'), g.imagePath, path.extname(g.imagePath).slice(1));
    log(`✓ G${groupNum} 재생성 완료`);
  } catch (e) { log(`✗ G${groupNum} 재생성 실패: ${e.message}`); }
  return P.toDTO(S.parsed);
});

// ── 이미지 프롬프트 내보내기/가져오기/API (prompt-io) ──────────────
const PromptIO = require('./core/prompt-io');

// 내보내기 — 그룹별 대본 요청서 텍스트 생성(렌더러가 클립보드 복사)
ipcMain.handle('export-prompts', (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { styleName = '' } = args;
  const text = PromptIO.buildPromptRequestText(S.parsed.projects, { styleName });
  log('📤 이미지 프롬프트 요청서 생성 — 웹 LLM(claude.ai 등)에 붙여넣으세요');
  return text;
});

// 가져오기 — 웹 LLM 답변 텍스트 파싱 → 그룹 프롬프트 매핑
ipcMain.handle('import-prompts', (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const text = String((args && args.text) || '');
  if (!text.trim()) { log('가져올 텍스트가 비어 있습니다'); return P.toDTO(S.parsed); }
  const r = PromptIO.applyPromptsToProjects(S.parsed.projects, text);
  if (r.groups > 0) {
    log(`📥 가져오기 적용 — ${r.groups}개 그룹 (🖼 이미지 ${r.img} · 🎬 영상 ${r.vid})`);
    if (r.sanitized.length) { log(`🛡 안전 치환 ${r.sanitized.length}건:`); r.sanitized.slice(0, 30).forEach((l) => log('   ' + l)); }
  } else {
    log('⚠ 인식된 프롬프트가 없습니다 — 답변에 `## [쇼츠-그룹]` 헤더가 그대로 있는지 확인하세요');
  }
  return P.toDTO(S.parsed);
});

// API 자동작성 — 등록된 LLM 키로 한 번에 프롬프트 작성 → 매핑
// 분할/재구성 후 미디어 파일명을 그룹 새 num 에 맞춤(겹침 방지: 높은 num 부터). g.imagePath/videoPath 갱신.
function renumberMediaFiles(project, mediaDir) {
  const groups = [...project.groups].sort((a, b) => b.num - a.num);
  for (const g of groups) {
    for (const key of ['imagePath', 'videoPath']) {
      const p = g[key];
      if (!p || !fs.existsSync(p)) continue;
      if (!p.startsWith(mediaDir)) continue; // media-N 안의 파일만(외부 첨부는 그대로)
      const ext = path.extname(p);
      const want = path.join(mediaDir, `${String(g.num).padStart(2, '0')}${ext}`);
      if (path.resolve(p) === path.resolve(want)) continue;
      try { if (fs.existsSync(want)) fs.rmSync(want, { force: true }); fs.renameSync(p, want); g[key] = want; } catch (e) {}
    }
  }
}

// 그룹 분할 — TTS 길이 절반(균형)에 가장 가까운 문장 경계에서 2개로. 두 새 그룹은 프롬프트/이미지 초기화.
//   다른 그룹의 프롬프트·자산은 절대 건드리지 않음(같은 Group 객체 유지). 미디어 파일은 새 num 에 맞춰 정렬.
ipcMain.handle('split-group', (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  if (!pr) throw new Error('편을 찾을 수 없습니다.');
  const { Group, finalizeGroupIds } = require('./core/project-model');
  const idx = pr.groups.findIndex((g) => g.num === groupNum);
  if (idx < 0) throw new Error('그룹을 찾을 수 없습니다.');
  const g = pr.groups[idx];
  const sents = pr.getSentencesOfGroup(g);
  if (sents.length < 2) throw new Error('이 그룹은 문장이 1개라 나눌 수 없습니다 (대본에서 문장을 더 나눠주세요).');
  // 균형 분할 — 누적 TTS 가 전체의 절반에 가장 가까운 경계
  const total = sents.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
  let acc = 0, best = 1, bestDiff = Infinity;
  for (let i = 1; i < sents.length; i++) {
    acc += (sents[i - 1].ttsDurationSec || 0);
    const diff = Math.abs(acc - total / 2);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  const firstS = sents.slice(0, best), secondS = sents.slice(best);
  const mk = (ss) => {
    const ng = new Group({ num: 0, sentenceIds: ss.map((s) => s.id) });
    ng.phase = g.phase; ng.title = g.phase; ng.isIntro = g.isIntro;
    ng.imagePrompt = null; ng.videoPrompt = null; ng.motionNote = null; // ★ 두 그룹 프롬프트 초기화
    ng.imagePath = null; ng.videoPath = null; ng.imageStatus = null; ng.videoStatus = null;
    ng.isI2V = false; ng.mode = 'motion';
    return ng;
  };
  pr.groups.splice(idx, 1, mk(firstS), mk(secondS)); // 원본 1개 → 새 2개로 교체(나머지 그대로)
  pr.groups.forEach((gg, i) => { gg.num = i + 1; });  // 재번호
  finalizeGroupIds(pr.groups, pr.sentences);          // sentence.groupId 재지정
  try { renumberMediaFiles(pr, shortsDirs(S.outRoot, pr.shortsNum).media); } catch {}
  storeActive(); pushDtoUpdate();
  const t1 = firstS.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
  const t2 = secondS.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
  log(`✂ ${prLabel(pr)} G${groupNum}(${total.toFixed(1)}초) → 2그룹 분할 (${t1.toFixed(1)}+${t2.toFixed(1)}초, ${firstS.length}+${secondS.length}문장). 두 그룹 프롬프트 초기화.`);
  return P.toDTO(S.parsed);
});

ipcMain.handle('generate-prompts-api', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { provider = 'gemini', styleName = '', fromNum = null, toNum = null } = args;
  S.abort = false;
  let callAnswer, label = provider;
  if (provider === 'ollama') {
    const oc = require('./core/ollama-config').load();
    const tags = await ollamaTags(oc.baseUrl);
    if (tags.ok) {
      log(`🤖 [ollama] ${oc.model} (${oc.baseUrl}) 프롬프트 자동 작성 시작…`);
      callAnswer = (req) => PromptIO.callLlmTextApi('ollama', '', req, { baseUrl: oc.baseUrl, model: oc.model });
    } else {
      // Ollama 미도달 → Gemini 키 있으면 폴백
      let key = ''; try { key = (require('./tts/secret-store').get('gemini') || {}).key || ''; } catch {}
      if (!key.trim()) throw new Error(`Ollama 서버에 연결할 수 없습니다 (${oc.baseUrl}). ⚙ Ollama 설정에서 주소를 확인하거나, ⚙ 채널편집에서 Gemini 키를 등록하세요.`);
      log(`⚠ Ollama 미도달(${oc.baseUrl}) → Gemini 폴백`);
      label = 'gemini'; callAnswer = (req) => PromptIO.callLlmTextApi('gemini', key, req);
    }
  } else {
    let key = '';
    try { const s = require('./tts/secret-store').get(provider); key = (s && s.key) || ''; } catch {}
    if (!key.trim()) throw new Error(`${provider.toUpperCase()} API 키가 없습니다 — ⚙ 채널편집에서 키를 등록하세요(현재 Gemini 키 입력 지원).`);
    log(`🤖 [${provider}] API 프롬프트 자동 작성 시작 (${PromptIO.LLM_TEXT_MODELS[provider]})…`);
    callAnswer = (req) => PromptIO.callLlmTextApi(provider, key, req);
  }
  // 빈 프롬프트만 채움 — 이미지 OR i2v(영상) 프롬프트가 비어있는 그룹만 (분할로 초기화된 그룹 등).
  //   이미 둘 다 있는 그룹은 건너뜀(덮어쓰지 않음).
  // 빈 프롬프트만 채움 — 이미지는 모든 그룹, i2v(영상)는 '영상 범위' 그룹만(롱폼=도입부). 범위 밖은 i2v 불요.
  const _lo = (fromNum != null && toNum != null) ? Math.min(Number(fromNum), Number(toNum)) : null;
  const _hi = (fromNum != null && toNum != null) ? Math.max(Number(fromNum), Number(toNum)) : null;
  const _inRange = (g) => (_lo == null) ? true : (g.num >= _lo && g.num <= _hi);
  const includeFn = (g) => (!g.imagePrompt || !g.imagePrompt.trim()) || (_inRange(g) && (!g.videoPrompt || !g.videoPrompt.trim()));
  const r = await generatePromptsChunked(S.parsed.projects, { styleName, includeFn }, callAnswer, log);
  if (r.groups > 0) {
    log(`📥 [${label}] 적용 — ${r.groups}개 그룹 (🖼 ${r.img} · 🎬 ${r.vid})`);
    if (r.sanitized.length) { log(`🛡 안전 치환 ${r.sanitized.length}건`); }
  } else {
    log(`⚠ [${label}] 응답에서 프롬프트를 인식하지 못했습니다`);
  }
  return P.toDTO(S.parsed);
});

// 그룹 합치기 — TTS 시간 8초 미만 그룹들을 한 그룹으로 묶음 (TTS 변환 후 사용)
ipcMain.handle('merge-groups', (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null } = args;
  const clipMaxSec = (args.clipMaxSec && Number(args.clipMaxSec) > 0) ? Number(args.clipMaxSec) : 8.0;
  let total = 0, done = 0;
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const hasTts = pr.sentences.some((s) => s.ttsDurationSec != null);
    if (!hasTts) { log(`${prLabel(pr)}: TTS를 먼저 변환하세요 (시간 정보 없음)`); continue; }
    const r = P.mergeGroupsByTts(pr, clipMaxSec);
    log(`🔗 ${prLabel(pr)} 문장 기준 ${clipMaxSec}초 미만 단위 재구성: ${r.before}개 → ${r.after}개`);
    total += Math.abs(r.merged); done++;
  }
  if (!done) log('합칠 대상이 없습니다 — TTS 변환을 먼저 하세요.');
  return P.toDTO(S.parsed);
});

// 모드 전환 — 모드별로 보관된 대본을 활성화(재파싱·초기화 없음). 롱폼/쇼츠 대본은 독립.
ipcMain.handle('set-mode', (_e, args = {}) => {
  storeActive();                 // 현재 모드 작업물 보관
  activateMode(args.mode);       // 새 모드 것으로 전환
  writeWorkspace();
  log(`↔ 모드 전환: ${S.mode}${S.parsed ? '' : ' (이 모드 대본 없음 — 대본을 여세요)'}`);
  return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
});

// 대본 수정 — 편집한 텍스트로 재파싱(+원본 .md 갱신).
ipcMain.handle('get-script-text', () => {
  try { return fs.readFileSync(S.scriptPath, 'utf8'); } catch { return ''; }
});
ipcMain.handle('apply-script-text', (_e, args = {}) => {
  const text = String((args && args.text) || '');
  if (!text.trim()) { log('대본 내용이 비어 있습니다'); return S.parsed ? P.toDTO(S.parsed) : null; }
  S.parsed = P.parseScriptText(text, currentMode(), presetThresholds(S.preset));
  storeActive();
  if (S.scriptPath) { try { fs.writeFileSync(S.scriptPath, text, 'utf8'); } catch (e) { log('대본 파일 저장 실패: ' + e.message); } }
  log(`✏ 대본 수정 적용 — 재파싱 (편 ${S.parsed.projects.length})`);
  return P.toDTO(S.parsed);
});

ipcMain.handle('set-aspect', (_e, value) => {
  if (!S.parsed) return null;
  const a = (value === '1:1') ? '1:1' : (value === '16:9') ? '16:9' : '9:16';
  for (const pr of S.parsed.projects) pr.aspect = a;
  log(`이미지/영상 비율 → ${a}`);
  return P.toDTO(S.parsed);
});

// 롱폼 재분할 — 분할옵션(도입부/본론/짧은/긴) 변경 시 대본을 새 임계값으로 다시 파싱.
//   ⚠ 재파싱이라 기존 TTS/이미지 매핑은 초기화됨(PrimingFlow 자동 재분할과 동일).
ipcMain.handle('resplit', (_e, args = {}) => {
  if (!S.parsed || !S.scriptPath) throw new Error('대본을 먼저 여세요.');
  if (currentMode() !== 'longform') return P.toDTO(S.parsed);
  const splitMode = args.splitMode === 'sentence' ? 'sentence' : 'h3';
  const th = { introSentenceSize: args.intro, mainSentenceSize: args.main, shortLen: args.short, longLen: args.long, splitMode };
  S.parsed = P.parseScript(S.scriptPath, 'longform', th);
  storeActive();
  const g = S.parsed.projects[0] ? S.parsed.projects[0].groups.length : 0;
  log(`🔁 롱폼 재분할(${splitMode === 'h3' ? 'H3 섹션' : '문장'}): 도입부 ${args.intro} · 본론 ${args.main} · 짧은 ${args.short} · 긴 ${args.long} → 그룹 ${g}개`);
  return P.toDTO(S.parsed);
});

// 도입부 비디오 준비 — 도입부(phase 도입) 문장만 TTS → 10초 기준으로 도입부 그룹 재배치(I2V/LTX 10초 한계).
ipcMain.handle('intro-video-prep', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const pr = S.parsed.projects[0];
  if (!pr) return P.toDTO(S.parsed);
  const preset = S.preset || P.getPreset(args.presetName || null);
  if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
  const speed = (args.speed && Number(args.speed) > 0) ? Number(args.speed) : 1.0;
  const introSents = pr.sentences.filter((s) => s.isIntro);
  if (!introSents.length) { log('도입부 문장이 없습니다 — 대본에 "## 도입" 헤더가 필요합니다.'); return P.toDTO(S.parsed); }
  S.abort = false;
  log(`🎬 도입부 ${introSents.length}문장 TTS 후 10초 재배치…`);
  const { mgr, ok } = await P.makeTtsManager(log, preset.engine);
  if (!ok) throw new Error(`TTS 엔진 '${preset.engine}' 미가동`);
  const ttsDir = shortsDirs(S.outRoot, pr.shortsNum).tts;
  await P.fillTtsList(introSents, preset, mgr, ttsDir, log, () => S.abort, speed, '도입부', pushDtoUpdate);
  try { await mgr.stop(); } catch {}
  const { regroupIntroByTtsDuration } = require('./core/group-builder');
  const res = regroupIntroByTtsDuration(pr, { maxSec: 10 });
  log(`✓ 도입부 10초 재배치 완료 (10초 초과 그룹 ${res.overGroupIds.length}개)`);
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

ipcMain.handle('read-audio', (_e, p) => {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.wav' ? 'audio/wav' : (ext === '.mp3' || ext === '.mpga' || ext === '.mpeg') ? 'audio/mpeg' : 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

ipcMain.handle('open-folder', async () => {
  if (!S.outRoot) return;
  fs.mkdirSync(S.outRoot, { recursive: true });
  shell.openPath(S.outRoot);
});
