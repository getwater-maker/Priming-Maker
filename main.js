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
const { parsePlaylistText } = require('./core/parsers/playlist-parser');

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
function clipMaxOf(videoEngine) { return 10.0; } // Grok=10초 캡 (그룹 TTS≤6→6초·>6→10초 자동)
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
  modes: { longform: { items: [], activeId: null }, shorts: { items: [], activeId: null }, playlist: { items: [], activeId: null }, book: { items: [], activeId: null } } };

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
// 모드 4-way 정규화 (롱폼/쇼츠/플리/출판)
function normMode(m) { return m === 'longform' ? 'longform' : m === 'playlist' ? 'playlist' : m === 'book' ? 'book' : 'shorts'; }
// 지정 모드로 전환 — 그 모드 활성 항목을 S.* 로 복원(재파싱 없음).
function activateMode(m) {
  S.mode = normMode(m);
  syncActiveToS();
}
// 현재 모드 기준 렌더러 DTO — 플리/출판은 별도 형식, 그 외는 프로젝트 DTO.
function currentDTO() {
  if (!S.parsed) return null;
  if (S.mode === 'playlist' || S.parsed.kind === 'playlist') return playlistDTO(S.parsed);
  if (S.mode === 'book' || S.parsed.kind === 'book') return bookDTO(S.parsed);
  return P.toDTO(S.parsed);
}
// 플리 파싱본 → 렌더러 DTO (생성 상태·오디오 경로 포함).
function playlistDTO(parsed) {
  return {
    kind: 'playlist',
    fileTitle: parsed.fileTitle || '플레이리스트',
    concept: parsed.concept || '',
    bgImagePath: parsed.bgImagePath || null,   // 전 곡 공통 배경 이미지 (첨부 or Krea2 생성)
    bgVideoPath: parsed.bgVideoPath || null,    // 전 곡 공통 배경 영상 (첨부 or LTX 생성) — 있으면 미리보기 우선
    tracks: (parsed.tracks || []).map((t) => ({
      num: t.num, title: t.title, tags: t.tags, lyrics: t.lyrics || '',
      durationSec: t.durationSec || 0,
      status: t.status || 'idle', // idle | generating | done | fail
      audioPath: t.audioPath || null,
      error: t.error || null,
    })),
  };
}

// 출판(book) 파싱본 → 렌더러 DTO — 구조 요약(섹션 목록·부/장 트리·메타·표지·규격).
function bookDTO(parsed) {
  const BK = require('./core/parsers/book-parser');
  const SC = require('./core/book/spine-calc');
  const PP = require('./core/book/platform-presets');
  const { metaPlatformId } = require('./core/book/html-builder');
  const meta = parsed.meta || {};
  const platformId = metaPlatformId(meta);
  const pf = PP.getPlatform(platformId);
  const trimId = meta.trim && PP.TRIM_SIZES[meta.trim] ? meta.trim : pf.defaultTrim;
  const paperId = meta.paper && PP.PAPERS[meta.paper] ? meta.paper : pf.defaultPaper;
  const flaps = !!(meta.flaps && !/^(없음|no|off|false|x)$/i.test(String(meta.flaps).trim()));
  const pages = parsed._lastPages || 0;
  const spread = SC.coverSpread({ platformId, trimId, paperId, totalPages: pages, flaps });
  const secDTO = (s) => ({ key: s.key, label: s.label, title: s.title, lineStart: s.lineStart, blocks: (s.blocks || []).length });
  return {
    kind: 'book',
    fileTitle: parsed.fileTitle || '책',
    scriptPath: S.scriptPath || null,
    meta,
    front: (parsed.front || []).map(secDTO),
    back: (parsed.back || []).map(secDTO),
    parts: (parsed.parts || []).map((p) => ({
      title: p.title, num: p.num, lineStart: p.lineStart,
      chapters: (p.chapters || []).map((c) => ({ num: c.num, title: c.title, lineStart: c.lineStart, blocks: (c.blocks || []).length })),
    })),
    covers: (parsed.covers || []).map(secDTO),
    footnoteCount: Object.keys(parsed.footnotes || {}).length,
    reserved: BK.reservedSections(),
    fontOptions: require('./core/book/html-builder').FONT_OPTIONS,
    colophonFieldDefs: require('./core/book/html-builder').COLOPHON_FIELDS,
    coverImagePath: parsed.coverImagePath || null,
    coverCheck: parsed._coverCheck || null,
    lastPages: pages,
    platformId, trimId, paperId, flaps, spread,
    layoutSaved: (activeItem() && activeItem().settings && activeItem().settings.book) || {},
    platforms: Object.entries(PP.PLATFORMS).map(([id, p]) => ({ id, label: p.label, trims: p.trims, note: p.note, minPages: p.minPages })),
    trims: Object.entries(PP.TRIM_SIZES).map(([id, t]) => ({ id, label: t.label })),
    papers: Object.keys(PP.PAPERS),
  };
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
  // 화면 내 검색(Ctrl+F) — Electron 내장 find-in-page. 렌더된 텍스트를 찾아 강조·이동. 모든 모드 공통.
  win.webContents.on('found-in-page', (_e, r) => {
    try { win.webContents.send('find-result', { active: r.activeMatchOrdinal || 0, total: r.matches || 0 }); } catch {}
  });
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
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg',
    '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4' })[e] || 'application/octet-stream';
}

app.whenReady().then(() => {
  // media://<encoded-abs-path> → 로컬 파일. Range 직접 처리(비디오 스트리밍 — net.fetch(file://)는 Range에서 ERR_UNEXPECTED).
  protocol.handle('media', (request) => {
    // 쿼리/프래그먼트 제거 — 미리보기 캐시버스터(?t=…)가 파일 경로를 오염시키지 않게
    let p = decodeURIComponent(request.url.slice('media://'.length)).split(/[?#]/)[0].replace(/^\/+/, '');
    try {
      const stat = fs.statSync(p);
      const mime = _mimeOf(p);
      const range = request.headers.get('Range');
      const { Readable } = require('stream');
      const m = range && /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        // Range 요청 — 해당 구간만 스트림(동기 readSync 로 통째 읽으면 여러 영상 동시 로드 시 메인 프로세스가 멈춤).
        const start = parseInt(m[1], 10);
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        const len = end - start + 1;
        return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status: 206, headers: {
          'Content-Type': mime, 'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
        } });
      }
      // Range 없는 전체 요청 — 파일을 통째 메모리로 올리지 않고 스트림(일괄첨부로 큰 mp4 여러 개가 동시에 로드돼도 안 멈춤).
      return new Response(Readable.toWeb(fs.createReadStream(p)), { status: 200, headers: {
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
  try { return require('./core/style-store').loadAll().map((s) => ({ id: s.id, name: s.name, prompt: s.prompt || '', isBuiltIn: !!s.isBuiltIn })); }
  catch (e) { return []; }
});
// 이미지 스타일 편집(사용자 스타일만 추가/수정/삭제/순서 — 기본 스타일은 스토어가 보호)
ipcMain.handle('add-style', (_e, style = {}) => {
  try { return require('./core/style-store').add(style || {}); } catch (e) { return null; }
});
ipcMain.handle('update-style', (_e, args = {}) => {
  try { return require('./core/style-store').update(args.id, { name: args.name, prompt: args.prompt }); } catch (e) { return null; }
});
ipcMain.handle('remove-style', (_e, id) => {
  try { return require('./core/style-store').remove(id); } catch (e) { return false; }
});
ipcMain.handle('move-style', (_e, args = {}) => {
  try { return require('./core/style-store').moveStyle(args.id, args.direction); } catch (e) { return false; }
});

// 발음사전 — 자막은 대본 그대로 두고 TTS 만 교정. entry = { source, pron, enabled }.
//   source(대본 표기)를 pron(발음 표기)로 치환해 합성(text-pronouncer.applyOmniVoiceDict). 자막엔 미반영.
ipcMain.handle('dict-list', () => {
  try { return require('./tts/omnivoice-dict-store').loadAll(); } catch (e) { return []; }
});
ipcMain.handle('dict-save', (_e, entries = []) => {
  try {
    const clean = (Array.isArray(entries) ? entries : [])
      .map((x) => ({ source: String(x.source || '').trim(), pron: String(x.pron || '').trim(), enabled: x.enabled !== false }))
      .filter((x) => x.source && x.pron);
    require('./tts/omnivoice-dict-store').saveAll(clean);
    try { require('./tts/tts-manager').getInstance().invalidateDict(); } catch {} // 메모리 캐시 즉시 갱신
    return clean;
  } catch (e) { return null; }
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
// Nano Banana 2 Lite (Gemini 이미지 API) 설정 — 모델명·비율전송
ipcMain.handle('get-gemini-image-config', () => { try { return require('./core/gemini-image').loadConfig(); } catch { return {}; } });
ipcMain.handle('set-gemini-image-config', (_e, patch) => { try { return require('./core/gemini-image').saveConfig(patch || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
// ── ComfyUI(z-image) 이미지 설정 — 로컬/클라우드 공용. 워크플로 JSON(API 포맷) 지정. ──
ipcMain.handle('get-comfy-image-config', () => { try { return require('./core/comfy-image').loadConfig(); } catch { return {}; } });
ipcMain.handle('set-comfy-image-config', (_e, patch) => { try { return require('./core/comfy-image').saveConfig(patch || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('pick-comfy-workflow', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ComfyUI API 워크플로', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0] }; // 목록 등록·이름·활성 지정은 렌더러가 setComfyImageConfig 로 처리
});
ipcMain.handle('test-comfy-image', async () => {
  try { const CI = require('./core/comfy-image'); const eng = new CI.ComfyImage(CI.loadConfig(), log); const ok = await eng.health(); log(ok ? `✓ ComfyUI 연결 OK (${eng.baseUrl})` : `✗ ComfyUI 연결 실패 (${eng.baseUrl})`); return { ok, baseUrl: eng.baseUrl }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// ComfyUI 비디오(i2v) 설정 — Wan 2.2 / LTX 등 워크플로 (이미지 comfy 와 별개 config)
ipcMain.handle('get-comfy-video-config', () => { try { return require('./core/comfy-video').loadConfig(); } catch { return {}; } });
ipcMain.handle('set-comfy-video-config', (_e, patch) => { try { return require('./core/comfy-video').saveConfig(patch || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('pick-comfy-video-workflow', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ComfyUI API 워크플로', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0] };
});
ipcMain.handle('test-comfy-video', async () => {
  try { const CV = require('./core/comfy-video'); const eng = new CV.ComfyVideo(CV.loadConfig(), log); const ok = await eng.health(); log(ok ? `✓ ComfyUI 비디오 연결 OK (${eng.baseUrl})` : `✗ ComfyUI 비디오 연결 실패 (${eng.baseUrl})`); return { ok, baseUrl: eng.baseUrl }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ── 나노바나나2 Lite 배치(Batch API) — 제출/회수 분리. 활성 대본 기준. 50% 저렴, 결과는 몇 시간 뒤. ──
function _aspectFor(pr) { return pr.aspect === '9:16' ? '9:16' : (pr.aspect === '1:1' ? '1:1' : '16:9'); }
ipcMain.handle('gemini-batch-submit', async (_e, args = {}) => {
  if (!S.parsed || !S.parsed.projects) return { ok: false, error: '대본을 먼저 여세요.' };
  const GI = require('./core/gemini-image');
  if (!GI.hasKey()) return { ok: false, error: 'Gemini API 키 없음 — ⚙ 채널편집에서 Gemini 키를 넣으세요.' };
  const styleId = args.styleId || null;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const requests = []; const items = [];
  for (const pr of S.parsed.projects) {
    for (const g of pr.groups) {
      if (g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g)) {
        const key = `s${pr.shortsNum}g${g.num}`;
        requests.push({ key, prompt: (stylePrompt ? stylePrompt + ', ' : '') + g.imagePrompt, aspect: _aspectFor(pr) });
        items.push({ key, shortsNum: pr.shortsNum, groupNum: g.num });
      }
    }
  }
  if (!requests.length) return { ok: false, error: '배치로 만들 이미지가 없습니다 (이미 다 있음).' };
  log(`🌙 배치 제출 중… ${requests.length}장 (나노바나나2 Lite API)`);
  const r = await GI.submitBatch({ requests, displayName: (S.parsed.fileTitle || 'priming') });
  if (!r.ok) { log('배치 제출 실패: ' + r.error); return r; }
  require('./core/gemini-batch-store').add({
    batchName: r.batchName, model: r.model, scriptPath: S.scriptPath, outRoot: S.outRoot,
    title: S.parsed.fileTitle || '', items, styleId, count: r.count, state: 'JOB_STATE_PENDING',
    submittedAt: Date.now(), collected: false,
  });
  log(`🌙 배치 제출 완료 — ${r.count}장 (${r.batchName}). 몇 시간 뒤 「📥 배치 회수」로 가져오세요. (앱 껐다 켜도 유지)`);
  return { ok: true, batchName: r.batchName, count: r.count };
});
ipcMain.handle('gemini-batch-status', () => {
  try {
    const BS = require('./core/gemini-batch-store');
    const job = S.scriptPath ? BS.pendingForScript(S.scriptPath) : null;
    return { hasJob: !!job, job: job ? { count: job.count, state: job.state, submittedAt: job.submittedAt } : null };
  } catch { return { hasJob: false }; }
});
ipcMain.handle('gemini-batch-retrieve', async () => {
  if (!S.parsed || !S.scriptPath) return { ok: false, error: '대본을 먼저 여세요.' };
  const BS = require('./core/gemini-batch-store'); const GI = require('./core/gemini-image');
  const job = BS.pendingForScript(S.scriptPath);
  if (!job) return { ok: false, error: '이 대본으로 제출한 배치가 없습니다.' };
  log(`📥 배치 상태 확인… (${job.title || job.batchName})`);
  const c = await GI.checkBatch({ batchName: job.batchName });
  if (!c.ok) { log('배치 상태 확인 실패: ' + c.error); return { ok: false, error: c.error }; }
  BS.update(job.batchName, { state: c.state });
  if (!c.done) { log(`⏳ 배치 진행 중: ${c.state} — 잠시 뒤 다시 회수해 주세요.`); return { ok: true, done: false, state: c.state }; }
  if (!/SUCCEEDED/i.test(c.state)) { log(`⚠ 배치 종료 상태: ${c.state} (실패/취소/만료)`); BS.update(job.batchName, { collected: true }); return { ok: true, done: true, state: c.state, saved: 0 }; }
  const byKey = {}; job.items.forEach((it) => { byKey[it.key] = it; });
  let saved = 0;
  for (const r of c.results) {
    const it = byKey[r.key]; if (!it) continue;
    if (!r.ok) { log(`  ✗ ${r.key}: ${r.error}`); continue; }
    try {
      const dir = shortsDirs(job.outRoot, it.shortsNum).media;
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${String(it.groupNum).padStart(2, '0')}.${r.ext}`);
      fs.writeFileSync(out, r.buffer); saved++;
      const pr = S.parsed.projects.find((p) => p.shortsNum === it.shortsNum);
      const g = pr && pr.groups.find((x) => x.num === it.groupNum);
      if (g) { g.imagePath = out; g.imageStatus = 'done'; }
    } catch (e) { log(`  저장 실패 ${r.key}: ${e.message}`); }
  }
  BS.update(job.batchName, { state: c.state, collected: true, collectedAt: Date.now(), saved });
  log(`📥 배치 회수 완료 — ${saved}/${job.count}장 저장·매핑`);
  storeActive(); pushDtoUpdate();
  return { ok: true, done: true, state: c.state, saved, dto: P.toDTO(S.parsed) };
});

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
// Genspark 한도 쿨다운(재설정 시각) 조회 — 한도 감지 시 기억한 재설정 시각을 UI 에 표시.
//   genspark-accounts.json(cooldowns)에 영속되므로 앱 재시작해도 유지. 여러 계정이면 가장 이른(먼저 풀리는) 시각.
ipcMain.handle('genspark-cooldown', () => {
  try {
    const GsAcc = require('./core/genspark-accounts');
    const accs = (GsAcc.list().accounts) || [];
    const times = accs.map((a) => GsAcc.cooldownUntil(a.id)).filter((t) => t > 0);
    if (!times.length) return { until: 0, label: '' };
    const until = Math.min(...times);
    return { until, label: fmtClock(until) };
  } catch { return { until: 0, label: '' }; }
});
// Grok 한도 쿨다운 조회 — 영상 재설정 시각(재시작해도 유지). 헤더 뱃지 표시용.
ipcMain.handle('grok-cooldown', () => { try { return require('./core/grok-cooldown').get(); } catch { return { until: 0, label: '' }; } });
// 화면 내 검색(Ctrl+F) — 렌더된 텍스트 찾기/이동. text 빈값=검색 종료.
ipcMain.handle('find-in-page', (_e, args = {}) => {
  if (!win) return;
  const text = String(args.text || '');
  if (!text) { try { win.webContents.stopFindInPage('clearSelection'); } catch {} return; }
  try { win.webContents.findInPage(text, { forward: args.forward !== false, findNext: !!args.findNext, matchCase: false }); } catch {}
});
ipcMain.handle('find-stop', () => { try { if (win) win.webContents.stopFindInPage('clearSelection'); } catch {} });
ipcMain.handle('genspark-login', async (_e, args = {}) => {
  const accId = (args && args.accId) || 'default';
  log(`🔑 Genspark 로그인 (${accId}) — 열린 크롬에서 직접 로그인하세요 (쿠키 저장됨)`);
  try {
    const { GensparkEngine } = require('./genspark-engine');
    const eng = new GensparkEngine({ profileId: accId, logger: log });
    await eng.login(async () => {
      // 창을 연 채로, 사용자가 로그인 마치고 버튼 누를 때까지 대기 (자동 감지 미사용)
      await dialog.showMessageBox(win, {
        type: 'info', buttons: ['로그인 완료'], defaultId: 0, noLink: true,
        title: 'Genspark 로그인',
        message: '열린 크롬 창에서 Genspark(구글) 로그인을 완료하세요.',
        detail: '로그인을 마친 뒤 이 [로그인 완료] 버튼을 누르면 쿠키가 저장되고 창이 닫힙니다.',
      });
    });
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
    await eng.login(async () => {
      await dialog.showMessageBox(win, {
        type: 'info', buttons: ['로그인 완료'], defaultId: 0, noLink: true,
        title: 'Grok(X) 로그인',
        message: '열린 크롬 창에서 X(트위터) 계정으로 로그인을 완료하세요.',
        detail: '로그인을 마친 뒤 이 [로그인 완료] 버튼을 누르면 쿠키가 저장되고 창이 닫힙니다.',
      });
    });
    log('✓ Grok 로그인 완료(쿠키 저장).');
    return { ok: true };
  } catch (e) { log('Grok 로그인 오류: ' + e.message); return { ok: false, error: e.message }; }
});

// ── STT (음성·영상 → 텍스트) — OmniVoice Whisper. 원본과 같은 폴더에 같은 이름 .txt 생성. ──
//   동영상은 ffmpeg 로 오디오 추출 후 전사. 긴 파일은 asr-client 가 청크 분할. ■ 중단(S.abort)으로 멈춤.
const STT_VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts', '.mpg', '.mpeg', '.wmv']);
ipcMain.handle('stt-transcribe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'STT 할 음성·영상 파일 선택 (여러 개 가능)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '음성·영상', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mpg', 'mpeg', 'wmv'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };

  const media = require('./core/media-utils');
  const asr = require('./tts/asr-client');
  S.abort = false;

  try {
    const st = await asr.checkAsrStatus();
    if (!st.reachable) log('⚠ OmniVoice(STT) 백엔드 연결 안 됨 — Whisper 서버가 켜져 있는지 확인하세요. 그래도 시도합니다.');
    else if (!st.loaded) log('ℹ Whisper 모델 미로드 — 첫 파일은 모델 로딩으로 5분+ 걸릴 수 있습니다.');
  } catch {}

  const results = [];
  for (const file of r.filePaths) {
    if (S.abort) { log('⏹ STT 중단됨'); break; }
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const ext = path.extname(file).toLowerCase();
    const outTxt = path.join(dir, base + '.txt');
    let audioPath = file;
    let tmpAudio = null;
    log(`🎧 STT 시작: ${path.basename(file)}`);
    try {
      if (STT_VIDEO_EXT.has(ext)) {
        tmpAudio = path.join(os.tmpdir(), `pf-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
        log('  ↳ 동영상에서 오디오 추출 중…');
        await media.extractAudioMp3(file, tmpAudio);
        audioPath = tmpAudio;
      }
      const text = await asr.transcribeLong(audioPath, {
        abortSignal: () => S.abort,
        onProgress: (p) => { if (p && p.total > 1) log(`  … 전사 ${p.done}/${p.total} 청크`); },
      });
      fs.writeFileSync(outTxt, String(text || '').trim() + '\n', 'utf8');
      log(`✓ 저장: ${path.basename(outTxt)} (${String(text || '').length}자)`);
      results.push({ file, txt: outTxt, ok: true });
    } catch (e) {
      log(`✗ STT 실패 (${path.basename(file)}): ${e.message}`);
      results.push({ file, ok: false, error: e.message });
    } finally {
      if (tmpAudio) { try { fs.rmSync(tmpAudio, { force: true }); } catch {} }
    }
  }
  const okN = results.filter((x) => x.ok).length;
  log(`🎧 STT 완료: 성공 ${okN}/${results.length}`);
  return { ok: true, results };
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

// ── Qwen3-TTS 보이스디자인 (온디맨드 서버 9893) ───────────────────────────────
//   모달 열 때 start(서버 기동+모델 로딩) → generate(설명→wav, ref-audio 폴더 저장) → 모달 닫을 때 stop.
//   start 되면 S.voiceDesignActive=true → 그동안 음성변환(OmniVoice)을 막아 VRAM 동시 사용(OOM) 차단.
const QD = require('./core/qwen-design');
ipcMain.handle('qwen-design-status', async () => {
  try { return await QD.status(); } catch (e) { return { installed: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('qwen-design-start', async () => {
  if (S.musicActive) { log('⚠ 음악 생성 중에는 보이스디자인을 열 수 없습니다. 끝난 뒤 다시 시도하세요.'); return { ok: false, error: 'gpu-busy' }; }
  const r = await QD.start(log).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (r && r.ok) S.voiceDesignActive = true;
  return r;
});
ipcMain.handle('qwen-design-stop', async () => {
  S.voiceDesignActive = false;
  return await QD.stop(log).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
});
ipcMain.handle('qwen-design-generate', async (_e, args = {}) => {
  const instruct = (args.instruct || '').trim();
  const text = (args.text || '').trim() || '안녕하세요. 이 목소리로 이야기를 들려드리겠습니다.';
  if (!instruct) return { ok: false, error: '목소리 설명이 비어 있습니다' };
  const r = await QD.generate({ instruct, text, language: args.language || 'Korean' }, log);
  if (!r.ok) return r;
  // 미리듣기용 임시 파일에만 저장(아직 참조음성 목록엔 넣지 않음) — 저장 버튼을 눌러야 정식 등록.
  try {
    const tmpDir = path.join(os.homedir(), '.shots-maker', 'voicedesign-temp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, 'preview.wav');
    fs.writeFileSync(tmpPath, r.buffer);
    S.vdLastTemp = tmpPath; S.vdLastText = text;   // 저장 시 이 wav + 이 문장(=참조텍스트) 사용
    return { ok: true, tempPath: tmpPath, text };
  } catch (e) { return { ok: false, error: '임시 저장 실패: ' + String((e && e.message) || e) }; }
});
// 저장: 방금 생성한 미리듣기 wav 를 사용자가 지정한 파일명으로 ref-audio 에 정식 등록(+.txt 참조텍스트).
ipcMain.handle('qwen-design-save', async (_e, args = {}) => {
  if (!S.vdLastTemp || !fs.existsSync(S.vdLastTemp)) return { ok: false, error: '먼저 목소리를 생성하세요' };
  let name = String(args.filename || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\.wav$/i, '').trim();
  if (!name) return { ok: false, error: '파일명을 입력하세요' };
  try {
    const dir = path.join(os.homedir(), '.flow-app', 'ref-audio');
    fs.mkdirSync(dir, { recursive: true });
    let base = name, i = 2;
    while (fs.existsSync(path.join(dir, base + '.wav'))) { base = name + '_' + i; i++; }  // 같은 이름 있으면 _2, _3…
    const wavPath = path.join(dir, base + '.wav');
    fs.copyFileSync(S.vdLastTemp, wavPath);
    fs.writeFileSync(path.join(dir, base + '.txt'), S.vdLastText || '', 'utf8');  // 같은 이름 .txt = 참조텍스트
    log(`🎨 참조음성 저장: ${base}.wav (+ ${base}.txt)`);
    return { ok: true, path: wavPath, name: base + '.wav' };
  } catch (e) { return { ok: false, error: '저장 실패: ' + String((e && e.message) || e) }; }
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
// 플리 스펙(.md) 파싱 — 파일 읽어 playlist-parser 로.
function parsePlaylistFile(specPath) {
  const text = fs.readFileSync(specPath, 'utf8');
  return parsePlaylistText(text);
}
// 플리 출력 루트 — <채널 outputFolder>/<스펙파일명>/ (곡은 이 폴더에 NN_제목.mp3)
function playlistOutRoot(specPath, preset) {
  const folder = _safeFolder(path.basename(specPath).replace(/\.md$/i, ''));
  const outBase = (preset && (preset.outLong || preset.outputFolder)) || path.join(__dirname, 'output');
  return path.join(outBase, '플리', folder);
}
// 출판 출력 루트 — <채널 outputFolder>/출판/<원고파일명>/ (내지·표지 PDF + _work 빌드폴더)
function bookOutRoot(scriptPath, preset) {
  const folder = _safeFolder(path.basename(scriptPath).replace(/\.md$/i, ''));
  const outBase = (preset && (preset.outLong || preset.outputFolder)) || path.join(__dirname, 'output');
  return path.join(outBase, '출판', folder);
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

// 'TTS삭제' — 이미 만든 음성 파일(tts-N)·재활용 캐시를 지우고 화면 시간기록 초기화.
//   다음에 변환 버튼을 누르면 캐시 재활용 없이 전부 새로 합성된다.
ipcMain.handle('delete-tts', async () => {
  if (!S.parsed || !S.parsed.projects) { log('열린 대본이 없습니다.'); return currentDTO(); }
  let files = 0;
  for (const pr of S.parsed.projects) {
    if (S.outRoot) {
      try {
        const dir = shortsDirs(S.outRoot, pr.shortsNum).tts;
        if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); files++; } catch {} }
      } catch {}
    }
    for (const s of pr.sentences) { s.ttsAudioPath = null; s.ttsDurationSec = null; }  // 화면 시간기록 제거
  }
  let cached = 0;
  try { cached = require('./core/tts-cache').clearAll(); } catch {}
  log(`🗑 TTS 삭제 완료 — 음성파일 ${files}개 + 재활용캐시 ${cached}개 삭제, 시간기록 초기화. (다음 변환은 전부 새로 합성)`);
  pushDtoUpdate();
  return currentDTO();
});

ipcMain.handle('tts-build', (_e, args = {}) => enqueueTtsJob('전체 TTS 변환', async () => {
  { const _b = gpuBusyReason(); if (_b) { log(`⚠ ${_b} 중에는 음성변환을 할 수 없습니다. 끝난 뒤 다시 시도하세요.`); return { ok: false, error: 'gpu-busy' }; } }
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, dry = false, presetName = null, speed = 1.15, force = false } = args;
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
    else { if (force) log(`🔁 ${prLabel(pr)} 전체 다시 변환 (기존 음성·캐시 무시)`); await P.fillTts(pr, S.preset, S.ttsMgr, ttsDir, log, () => S.abort, speed, pushDtoUpdate, force); log(`✓ ${prLabel(pr)} 음성 완료`); }
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
}));

// Premiere Pro 임포트용 XML(FCP7 xmeml) — 편별 시퀀스 파일 생성. Premiere: 파일 > 가져오기.
ipcMain.handle('export-premiere', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, captionMaxChars = 7 } = args;
  const { buildPremiereXml } = require('./core/premiere-xml');
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  const outs = [];
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const baseName = vrewBaseName(pr);
    const xmlPath = path.join(S.outRoot, `${baseName}_premiere.xml`);
    // ttsDir 전달 — 오디오를 프로젝트 하위 tts-N 폴더 정본(<num>.mp3)으로 참조(캐시/임시 경로 방지).
    const r = await buildPremiereXml(pr, { outPath: xmlPath, ttsDir: shortsDirs(S.outRoot, pr.shortsNum).tts, log });
    if (r.success) {
      outs.push(r.xmlPath);
      // 자막(.srt) 을 XML 옆에 같이 생성 — Premiere 「캡션 가져오기」용.
      //   ⚠ Premiere 는 BOM 없는 UTF-8 한글 srt 를 인코딩 오인(깨짐/미표시)하는 사례가 있어 BOM 을 붙인다.
      try {
        const srtPath = path.join(S.outRoot, `${baseName}_premiere.srt`);
        P.writeSrt(pr, srtPath, captionMaxChars);
        const buf = fs.readFileSync(srtPath);
        if (!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) fs.writeFileSync(srtPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]));
        log(`   📄 자막: ${baseName}_premiere.srt (UTF-8 BOM)`);
      }
      catch (e) { log(`   ⚠ srt 생성 실패: ${e.message}`); }
    }
    else log(`✗ ${prLabel(pr)} 프리미어 XML 실패: ${r.error}`);
  }
  if (outs.length) { try { shell.openPath(S.outRoot); } catch {} }
  return { outs };
});

// BGM 오디오 경로 해석 — 메모리(pr._bgmPath) 우선, 없으면 media 폴더의 bgm_*.mp3 재사용
//   (다른 실행·재시작·💾재export 에서도 이미 만든 BGM 을 자동으로 찾아 .vrew 에 포함).
function resolveBgmPath(pr) {
  if (pr._bgmPath && fs.existsSync(pr._bgmPath)) return pr._bgmPath;
  try {
    const mediaDir = shortsDirs(S.outRoot, pr.shortsNum).media;
    const files = fs.readdirSync(mediaDir).filter((f) => /^bgm_.*\.(mp3|wav)$/i.test(f));
    const pick = files.find((f) => /_loop\.mp3$/i.test(f)) || files[0]; // 루프(전체 길이) 우선 — 원본(.wav)은 폴백
    if (pick) return path.join(mediaDir, pick);
  } catch {}
  return null;
}
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
    // ⚡만들기에서 생성한 BGM(또는 media 폴더에 이미 있는 bgm mp3)이 있으면 재export(.vrew)에도 포함.
    let ep = preset;
    const _bgmPath = resolveBgmPath(pr);
    if (_bgmPath) {
      ep = { ...ep, bgm: { enabled: true, audioPath: _bgmPath, volume: (pr._bgmVolume != null ? pr._bgmVolume : 0.15), loop: true } };
      log(`🎵 ${prLabel(pr)} .vrew 에 BGM 포함: ${path.basename(_bgmPath)}`);
    }
    try {
      const res = await P.buildProjectVrew(pr, vrewPath, ep, log, captionMaxChars); // 배속은 음성에 이미 반영
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
  const FlowAccounts = require('./core/flow-accounts');
  // 이미지 모델(기본 Nano Banana 2 / 선택 시 Nano Banana 2 Lite 등) — ⚙ 순환 설정에 저장.
  const flowImageModel = require('./core/image-rotation').load().flowImageModel;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const cap = FlowAccounts.load().dailyCap;
  const acctTotal = FlowAccounts.list().accounts.length;
  const tried = new Set(); // 이번 호출에서 이미 시도한 계정 (Flow 계정 순환용)
  // 라운드로빈: 마지막 사용 계정의 '다음'부터 — 단건 재생성을 연달아 눌러도 한 계정에 몰리지 않게 분산.
  const nextAcc = () => FlowAccounts.pickNext(tried);
  let loopGuard = 0;

  // ── Flow 계정 내 순환 ── 남은 그룹이 있고 활성 계정이 있는 한, 계정을 바꿔가며 채운다.
  //   한 계정이 한도(45)·차단(비정상활동)·0장이면 그 계정을 오늘 쉬게(rest) 하고 다음 계정으로.
  //   (사용자 요청: Genspark 한도 후 Flow 로 넘어오면 Flow 계정 1→2→3→4 도 순환해야 함)
  while (!S.abort) {
    const targets = project.groups.filter((g) => (!onlyNums || onlyNums.includes(g.num)) && !hasVisual(g));
    if (!targets.length) { if (loopGuard === 0) logger('[Flow] 생성할 그룹 없음 (이미 이미지/영상 있음)'); break; }
    const acc = nextAcc();
    if (!acc) { logger('⚠ 모든 Flow 계정 시도/소진 — 남은 이미지는 순환의 다음 엔진으로'); break; }
    tried.add(acc.id);
    if (++loopGuard > acctTotal + 2) { logger('⚠ Flow 계정 순환 안전장치 작동 — 중단'); break; }
    logger(`🔑 Flow 계정: ${acc.label} (오늘 ${acc.used}/${cap}) · 대상 ${targets.length}장 · 모델 ${flowImageModel}`);

    const workDir = path.join(os.tmpdir(), `sm_flow_${project.shortsNum}_${acc.id}_${Date.now().toString(36)}`);
    const imgDir = path.join(workDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const eng = getFlowEng(flowProfileDir(acc.id));
    const paragraphs = targets.map((g) => project.getSentencesOfGroup(g).map((s) => s.text).join(' ').trim() || `cut${g.num}`);
    const customPrompts = targets.map((g) => (g.imagePrompt && g.imagePrompt.trim()) ? P.buildImagePrompt(stylePrompt, g.imagePrompt) : null);
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
    let res = null;
    try {
      res = await eng.run({
        paragraphs, customPrompts, mediaType: 'image', model: flowImageModel,
        ratio: project.aspect || '9:16', outputDir: workDir, style: styleId || 'cinematic',
        withSubtitle: false, vrewOnly: false, skipVrew: true,
        antiDetect: { enabled: true, preset: '기본' }, profileId: acc.id,
      });
    } catch (e) { logger(`[Flow] ${acc.label} 실행 오류: ${e.message}`); }
    finally { clearInterval(poll); }

    const made = mapOnce(true);
    FlowAccounts.markUsed(acc.id, made); // ✅ 실제 성공분만 카운트 (기존: 대상 전체 → 과다 카운트 버그)
    logger(`[Flow] ${acc.label} 이미지 매핑 ${made}/${targets.length}`);
    pushDtoUpdate();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    if (S.abort) break;

    // 한도(rateExhausted)·차단(비정상활동) → 이 계정 오늘 쉬게(rest) 하고 다음 계정으로.
    //   0장(생성 실패, 예: Flow UI 셀렉터 문제)은 계정 탓이 아닐 수 있어 하루 캡(rest)은 안 하고 이번 호출만 건너뜀.
    if (res && res.rateExhausted) {
      FlowAccounts.cooldown(acc.id, 30); // 하루 캡 대신 30분 쿨다운 — 0장이어도 계정을 하루 종일 태우지 않음
      logger(`⚠ Flow 계정 "${acc.label}" 한도/차단 — 30분 쿨다운 후 재사용, 지금은 다음 계정으로 순환`);
    } else if (made === 0) {
      logger(`⚠ Flow 계정 "${acc.label}" 생성 0장 — 다음 계정으로 (Flow UI 문제일 수 있음, 계정 한도는 유지)`);
    }
    // 남은 그룹 있으면 while 재진입 → nextAcc 가 tried 제외한 다음 계정 선택
  }
}

// ── 이미지 순환(rotation) ── 순서대로 엔진을 돌며 '남은(미생성) 그룹'만 생성. 한 엔진이 한도면 다음 엔진으로 이어감.
//   startEngine = 사용자가 고른 엔진(맨 앞 우선). ComfyUI 는 순환 제외(별도 단독).
// Nano Banana 2 Lite (Gemini 이미지 API) — 브라우저 없이 API 로 이미지 생성. imgEngine==='gemini' 일 때.
async function runGeminiImages(project, imagesDir, logger, styleId, onlyNums) {
  const GI = require('./core/gemini-image');
  if (!GI.hasKey()) { logger('⚠ Gemini API 키 없음 — ⚙ 채널편집의 「Gemini 키」를 설정하세요.'); return; }
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const targets = project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g) && (!onlyNums || onlyNums.includes(g.num)));
  if (!targets.length) return;
  try { fs.mkdirSync(imagesDir, { recursive: true }); } catch {}
  const model = GI.loadConfig().model;
  logger(`🍌 Nano Banana 2 Lite (Gemini API · ${model}) — ${targets.length}장 즉시 생성`);
  for (const g of targets) {
    if (S.abort) { logger('⏹ 중단됨'); break; }
    const prompt = P.buildImagePrompt(stylePrompt, g.imagePrompt);
    const base = path.join(imagesDir, String(g.num).padStart(2, '0'));
    const r = await GI.generateImageToFile({ prompt, aspect: project.aspect || '9:16', outPathNoExt: base });
    if (r.ok) { g.imagePath = r.path; logger(`  ✓ G${g.num} → ${path.basename(r.path)}`); pushDtoUpdate(); }
    else { logger(`  ✗ G${g.num} 실패: ${r.error}`); }
  }
}

// ComfyUI(z-image 등) — 로컬 또는 comfy.org 클라우드. imgEngine==='comfy' 일 때. 워크플로 JSON(API 포맷) 필요.
async function runComfyImages(project, imagesDir, logger, styleId, onlyNums) {
  const CI = require('./core/comfy-image');
  const cfg = CI.loadConfig();
  if (!cfg.workflowPath) { logger('⚠ ComfyUI 워크플로 미지정 — ⚙ ComfyUI 에서 워크플로(API 포맷 JSON)를 지정하세요.'); return; }
  const eng = new CI.ComfyImage(cfg, logger);
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const targets = project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g) && (!onlyNums || onlyNums.includes(g.num)));
  if (!targets.length) return;
  try { fs.mkdirSync(imagesDir, { recursive: true }); } catch {}
  // 활성 워크플로 이름(하드코딩 'z-image' 아님) — 실제 선택된 모델(Z-image/Krea2 등)을 로그에 표기.
  const _wf = (cfg.workflows || []).find((w) => w.path === cfg.workflowPath);
  const _wfName = _wf ? _wf.name : path.basename(cfg.workflowPath).replace(/\.json$/i, '');
  logger(`🧩 ComfyUI ${cfg.cloud ? '클라우드' : '로컬'}(${_wfName}) — ${targets.length}장 생성 (${eng.baseUrl})`);
  if (!cfg.cloud) { logger('  🧹 로컬 VRAM 정리(이전 모델 언로드) — OOM 방지'); await eng.freeMemory(); } // 12GB: 비디오 Wan 등 비우고 이미지 모델 로드
  for (const g of targets) {
    if (S.abort) { logger('⏹ 중단됨'); break; }
    const prompt = P.buildImagePrompt(stylePrompt, g.imagePrompt);
    const base = path.join(imagesDir, String(g.num).padStart(2, '0') + '.png');
    const r = await eng.textToImage({ prompt, aspect: project.aspect || '9:16', outputPath: base, abortSignal: () => S.abort });
    if (r.success) { g.imagePath = r.imagePath; g.imageStatus = 'done'; logger(`  ✓ G${g.num} → ${path.basename(r.imagePath)}`); pushDtoUpdate(); }
    else { logger(`  ✗ G${g.num} 실패: ${r.error}`); }
  }
}

// Genspark 한도 메시지의 재설정 시각 파싱 — "AI Image 5시간 제한에 도달했습니다. 7월 14일 오후 3:39에 재설정됩니다"
//   파싱 성공 → 그 시각(ms). 실패 → 지금+60분(보수적 기본). 24시간 초과로 파싱되면 오파싱으로 보고 기본값.
function parseLimitResetTime(msg) {
  const FALLBACK = Date.now() + 60 * 60 * 1000;
  const m = String(msg || '').match(/(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!m) return FALLBACK;
  let h = parseInt(m[4], 10) % 12;
  if (m[3] === '오후') h += 12;
  const now = new Date();
  let d = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10), h, parseInt(m[5], 10));
  if (d.getTime() <= Date.now()) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), h, parseInt(m[5], 10)); // 연말 경계
  const ts = d.getTime();
  if (ts - Date.now() > 24 * 60 * 60 * 1000) return FALLBACK; // 5시간 제한인데 하루 넘게 나오면 오파싱
  return ts;
}
const fmtClock = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// Grok 한도 재설정 시각 파싱 — "20일 (월) 오후 3:23에 재설정"(요일·월 생략 가능) · "7월 14일 오후 6:01에 다시 사용" · "오후 6:01".
//   월+일 있으면 그날, 일만 있으면 이번달(지났으면 다음달) 그 날짜, 시각만 있으면 오늘(지났으면 내일). 8일 넘게 나오면 오파싱=0.
function parseGrokReset(msg) {
  const s = String(msg || ''); const now = new Date();
  const t = s.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/); if (!t) return 0;
  let h = parseInt(t[2], 10) % 12; if (t[1] === '오후') h += 12; const mm = parseInt(t[3], 10);
  const md = s.match(/(\d{1,2})월\s*(\d{1,2})일/); const dOnly = s.match(/(\d{1,2})일/);
  let d;
  if (md) { d = new Date(now.getFullYear(), +md[1] - 1, +md[2], h, mm); if (d.getTime() <= Date.now()) d = new Date(now.getFullYear() + 1, +md[1] - 1, +md[2], h, mm); }
  else if (dOnly) { const day = +dOnly[1]; d = new Date(now.getFullYear(), now.getMonth(), day, h, mm); if (d.getTime() <= Date.now()) d = new Date(now.getFullYear(), now.getMonth() + 1, day, h, mm); }
  else { d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mm); if (d.getTime() <= Date.now()) d = new Date(d.getTime() + 86400000); }
  const ts = d.getTime();
  if (ts - Date.now() > 8 * 24 * 3600 * 1000) return 0;
  return ts;
}
function grokCoolUntil() { try { return require('./core/grok-cooldown').get().until || 0; } catch { return 0; } }
function recordGrokCooldown(vr) {
  try {
    const reset = (vr && typeof vr === 'object') ? (vr.reset || '') : '';
    const until = parseGrokReset(reset);
    if (until) { require('./core/grok-cooldown').set(until, fmtClock(until)); log(`⏸ Grok 한도 — ${fmtClock(until)}까지 영상 생성 건너뜀(재설정 시각 기억, 앱 재시작해도 유지)`); }
    else if (reset) log(`⏸ Grok 한도 — 재설정 텍스트 "${reset}" 시각 파싱 실패 (로그의 [DUMP 한도영역] 공유 시 고정)`);
    else log('⏸ Grok 한도 — 재설정 시각 미확인 (빨간 시계 팝업 못 읽음 — 로그의 [DUMP 한도영역] 공유 요망)');
  } catch {}
}

// Grok Imagine 비디오 API (image→video, 브라우저 없이 REST). 이미지 있는 그룹만 i2v.
//   videoEngine='grok-api' 경로. 사용량 과금(SuperGrok 구독과 별개) — xAI 키(secret-store 'xai') 필요.
async function runGrokApiVideos(pr, mediaDir, onlyNums) {
  const GA = require('./core/grok-api');
  if (!GA.hasKey()) { log('⚠ xAI API 키가 없습니다 — 헤더 ⚙(Grok API)에서 키를 입력하세요.'); return; }
  const targets = pr.groups.filter((g) => (g.imagePath && fs.existsSync(g.imagePath)) && (!onlyNums || onlyNums.includes(g.num)) && !(g.videoPath && fs.existsSync(g.videoPath)));
  if (!targets.length) { log('🎬 Grok API — 영상화할(이미지 있는) 그룹이 없습니다'); return; }
  fs.mkdirSync(mediaDir, { recursive: true });
  log(`🎬 ${prLabel(pr)} 비디오 생성 (Grok API · ${targets.length}개 그룹)…`);
  for (const g of targets) {
    if (S.abort) { log('⏹ 중단됨'); break; }
    const sents = pr.getSentencesOfGroup(g);
    const totalSec = sents.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
    const durationSec = totalSec > 0 ? Math.max(1, Math.min(15, Math.ceil(totalSec))) : 6;
    const prompt = (g.videoPrompt && g.videoPrompt.trim()) || (g.motionNote && g.motionNote.trim()) || 'natural slow motion, subtle camera movement, cinematic';
    const out = path.join(mediaDir, `${String(g.num).padStart(2, '0')}.mp4`);
    g.videoStatus = 'generating'; pushDtoUpdate();
    log(`  · G${g.num} → Grok API (${durationSec}초, ${pr.aspect})…`);
    try {
      const r = await GA.generateVideoToFile({ imagePath: g.imagePath, prompt, aspect: pr.aspect, durationSec, outputPath: out, abortSignal: () => S.abort, logger: log });
      if (r.success) { g.videoPath = r.videoPath; g.videoStatus = 'done'; log(`  ✓ G${g.num} 완료`); }
      else { g.videoStatus = 'fail'; log(`  ✗ G${g.num} 실패: ${r.error}`); if (r.limitReached) { log('⛔ xAI 429 — 사용량/결제 한도. 작업을 멈춥니다'); S.abort = true; } }
    } catch (e) { g.videoStatus = 'fail'; log(`  ✗ G${g.num} 오류: ${e.message}`); }
    pushDtoUpdate();
  }
}

// ComfyUI i2v (Wan 2.2 5B / LTX 등) — 이미지 있는 그룹만. workflowPath 지정 시 그 워크플로 사용.
async function runComfyVideos(pr, mediaDir, onlyNums, workflowPath) {
  const CV = require('./core/comfy-video');
  const cfg = CV.loadConfig();
  if (workflowPath) cfg.workflowPath = workflowPath;
  if (!cfg.workflowPath || !fs.existsSync(cfg.workflowPath)) { log('⚠ ComfyUI 비디오 워크플로가 없습니다 — ⚙ ComfyUI 비디오에서 등록하세요.'); return; }
  const targets = pr.groups.filter((g) => (g.imagePath && fs.existsSync(g.imagePath)) && (!onlyNums || onlyNums.includes(g.num)) && !(g.videoPath && fs.existsSync(g.videoPath)));
  if (!targets.length) { log('🎬 ComfyUI i2v — 영상화할(이미지 있는) 그룹이 없습니다'); return; }
  const eng = new CV.ComfyVideo(cfg, log);
  const wfName = (cfg.workflows.find((w) => w.path === cfg.workflowPath) || {}).name || path.basename(cfg.workflowPath);
  log(`🎬 ${prLabel(pr)} 비디오 생성 (ComfyUI ${cfg.cloud ? '클라우드' : '로컬'}·${wfName} · ${targets.length}개 그룹)…`);
  if (!cfg.cloud) { log('  🧹 로컬 VRAM 정리(이전 모델 언로드) — OOM 방지'); await eng.freeMemory(); } // 12GB: 이미지 모델 비우고 Wan 로드
  for (const g of targets) {
    if (S.abort) { log('⏹ 중단됨'); break; }
    const sents = pr.getSentencesOfGroup(g);
    const totalSec = sents.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
    const durationSec = totalSec > 0 ? Math.ceil(totalSec) : 5;
    const prompt = (g.videoPrompt && g.videoPrompt.trim()) || (g.motionNote && g.motionNote.trim()) || 'natural slow motion, subtle camera movement, cinematic';
    const out = path.join(mediaDir, `${String(g.num).padStart(2, '0')}.mp4`);
    g.videoStatus = 'generating'; pushDtoUpdate();
    log(`  · G${g.num} → ComfyUI i2v (${Math.min(durationSec, cfg.videoMaxSec > 0 ? cfg.videoMaxSec : durationSec)}초, ${pr.aspect})…`);
    const r = await eng.imageToVideo({ imagePath: g.imagePath, prompt, aspect: pr.aspect, durationSec, outputPath: out, abortSignal: () => S.abort });
    if (r.success) { g.videoPath = r.videoPath; g.videoStatus = 'done'; log(`  ✓ G${g.num} 완료`); }
    else { g.videoStatus = 'fail'; log(`  ✗ G${g.num} 실패: ${r.error}`); if (/중단/.test(r.error || '')) break; }
    pushDtoUpdate();
  }
}

// 비디오 생성 디스패치 — 'grok-api'=REST API, 'comfy[::path]'=ComfyUI i2v, 그 외('grok'/'grok10')=브라우저 Grok.
async function genGroupVideos(pr, mediaDir, onlyNums, videoEngine) {
  if (videoEngine === 'grok-api') { await runGrokApiVideos(pr, mediaDir, onlyNums); return {}; }
  if (videoEngine === 'comfy' || (typeof videoEngine === 'string' && videoEngine.indexOf('comfy::') === 0)) {
    const wf = videoEngine.indexOf('comfy::') === 0 ? videoEngine.slice(7) : '';
    await runComfyVideos(pr, mediaDir, onlyNums, wf);
    return {};
  }
  return P.generateHookVideosGrok(pr, mediaDir, log, () => S.abort, 0, pushDtoUpdate, onlyNums, grokDurOf(videoEngine));
}

async function runRotatingImages(project, imagesDir, logger, styleId, startEngine, onlyNums) {
  // 유료(나노바나나 API) 선택 시 순환을 건너뛰고 Gemini API 로 직접 생성.
  if (startEngine === 'gemini') return runGeminiImages(project, imagesDir, logger, styleId, onlyNums);
  if (startEngine === 'comfy') return runComfyImages(project, imagesDir, logger, styleId, onlyNums);
  const Rot = require('./core/image-rotation');
  const order = Rot.activeOrder(startEngine);
  if (!order.length) { logger('⚠ 순환 엔진이 비어있음 — ⚙ 순환 설정 확인'); return; }
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const need = () => project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g) && (!onlyNums || onlyNums.includes(g.num)));
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
        //   한도 감지 시 메시지의 '재설정 시각'을 기억(쿨다운) → 그 전엔 접속 시도 없이 바로 다음 엔진으로.
        const GsAcc = require('./core/genspark-accounts');
        const accounts = GsAcc.activeAccounts();
        if (!accounts.length) {
          const cools = GsAcc.list().accounts.map((a) => ({ a, t: GsAcc.cooldownUntil(a.id) })).filter((x) => x.t);
          const till = cools.length ? ` (한도 재설정 ${fmtClock(Math.min(...cools.map((x) => x.t)))} 이후 재시도)` : '';
          logger(`⏭ Genspark 건너뜀 — 모든 계정 한도/쿨다운${till} → 다음 엔진으로`);
          continue;
        }
        for (const acc of accounts) {
          if (S.abort) break;
          const stillNeed = need(); if (!stillNeed.length) break;
          const ns = stillNeed.map((g) => g.num);
          logger(`🔑 Genspark 계정: ${acc.label} — 남은 ${stillNeed.length}장`);
          const r = await P.generateImagesGenspark(project, imagesDir, logger, () => S.abort, stylePrompt, ns, pushDtoUpdate, acc.id);
          if (r && r.ok) GsAcc.markUsed(acc.id, r.ok); // 성공분만 카운트
          if (r && r.limitReached) {
            if (r.limitReached === '__STALL__') {
              // 한도 메시지 없이 침묵 정체 — 재설정 시각을 알 수 없으니 30분 추정 쿨다운. (실제론 과부하로 더 빨리 풀릴 수도)
              const until = Date.now() + 30 * 60 * 1000;
              GsAcc.setCooldown(acc.id, until);
              logger(`⏸ Genspark 계정 "${acc.label}" 침묵 정체(무응답) — ${fmtClock(until)}까지 건너뜀(추정, 메시지 없음) → 다음 계정/엔진으로`);
            } else {
              const until = parseLimitResetTime(typeof r.limitReached === 'string' ? r.limitReached : '');
              GsAcc.setCooldown(acc.id, until);
              logger(`⏸ Genspark 계정 "${acc.label}" 한도 — ${fmtClock(until)}까지 이 계정 건너뜀(재설정 시각 기억) → 다음 계정/엔진으로`);
            }
            continue;
          }
          break; // 한도가 아닌 이유로 끝남(나머지는 차단/실패) → Genspark 더 시도 무의미
        }
      } else if (engineId === 'flow') {
        await runFlowImages(project, imagesDir, logger, styleId, nums);
      } else if (engineId === 'gemini') {
        await runGeminiImages(project, imagesDir, logger, styleId, nums);
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
        projects: (it.parsed && (it.parsed.projects ? it.parsed.projects.length
          : it.parsed.parts ? it.parsed.parts.reduce((n, p) => n + p.chapters.length, 0)
          : (it.parsed.tracks || []).length)) || 0,
        status: it.status || 'idle',
        settings: it.settings || null, // 대본별 생성 설정(채널·스타일·배속·엔진·영상범위)
        active: it.id === q.activeId,
      })),
    };
  };
  return { mode: S.mode, longform: mk('longform'), shorts: mk('shorts'), playlist: mk('playlist'), book: mk('book') };
}
function pushDtoUpdate() {
  try { if (win && !win.isDestroyed() && S.parsed) { const d = currentDTO(); if (d) { d.timings = { ...S.timings }; d.queue = queueDTO(); win.webContents.send('dto-update', d); } } } catch {}
  scheduleAutoSave(); // 데이터가 바뀔 때마다(디바운스) 자동저장
}

// ── 이미지 캐시(재활용) ── 키 = imagePrompt + style + aspect + engine. (H3=프롬프트 고정 → 잘 맞음)
// 생성 전 프리필 — 캐시에 있으면 media-N 으로 복사하고 g.imagePath 설정(엔진이 건너뜀).
function prefillImageCache(project, mediaDir, styleId, engine) {
  const MC = require('./core/media-cache');
  let n = 0;
  for (const g of project.groups) {
    if (!g.imagePrompt || !g.imagePrompt.trim()) continue;
    if (hasVisual(g)) continue; // 이미지/영상 이미 있으면 캐시 프리필도 건너뜀
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
// 그룹에 이미지 '또는' 비디오가 이미 있으면 비주얼 완성 — 이미지 생성 건너뛰기 판정.
//   (일괄첨부로 영상만 넣은 그룹에 이미지를 또 만들던 문제 방지)
function hasVisual(g) {
  return !!((g.imagePath && fs.existsSync(g.imagePath)) || (g.videoPath && fs.existsSync(g.videoPath)));
}
// 이미지 생성이 필요한(프롬프트 있고 아직 이미지·영상 둘 다 없는) 그룹 수.
function imagesNeeded(project) {
  return project.groups.filter((g) => g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g)).length;
}

// 생성된 영상을 1080p 로 업스케일 (Real-ESRGAN 애니 모델, 없으면 ffmpeg 폴백). videoPath 교체.
async function maybeUpscale(project, logger, enabled) {
  if (!enabled) return;
  const targets = project.groups.filter((g) => g.videoPath && fs.existsSync(g.videoPath) && !/_1080\.mp4$/i.test(g.videoPath));
  if (!targets.length) return;
  const Upscaler = require('./core/upscaler');
  const [W, H] = (project.aspect === '1:1') ? [1080, 1080] : (project.aspect === '16:9') ? [1920, 1080] : [1080, 1920];
  let done = 0;
  for (const g of targets) {
    if (S.abort) { logger('⏹ 업스케일 중단'); break; }
    const out = g.videoPath.replace(/\.mp4$/i, '_1080.mp4');
    g.videoStatus = 'upscaling'; pushDtoUpdate(); // ← 어느 그룹을 업스케일 중인지 UI 썸네일에 표시
    try {
      logger(`⬆ [${done + 1}/${targets.length}] G${g.num} 영상 업스케일 → ${W}x${H}…`);
      const r = await Upscaler.upscaleVideo(g.videoPath, out, { width: W, height: H, logger, abortSignal: () => S.abort });
      if (r && r.ok) { g.videoPath = out; }
    } catch (e) { logger(`업스케일 실패 G${g.num}: ${e.message}`); }
    g.videoStatus = 'done'; done++; pushDtoUpdate(); // ← 표시 해제(영상은 그대로 존재)
  }
  logger(`⬆ 업스케일 완료 (${done}/${targets.length})`);
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
// ★ 이미 이미지/영상이 붙은 그룹(일괄첨부·삼국지처럼 사전 렌더된 이미지)은 제외 — 어차피 이미지 생성을
//   건너뛰므로(hasVisual) 프롬프트가 쓸모없다. 예전엔 imagePrompt 텍스트 유무만 봐서, 이미지 다 붙어도
//   대본에 `> 🖼️ 이미지:` 줄이 없으면 Ollama 가 전 그룹 프롬프트를 헛생성해 실행이 크게 지연됐다.
async function autoFillPrompts(projects, logger) {
  const needsPrompt = (g) => (!g.imagePrompt || !g.imagePrompt.trim()) && !hasVisual(g);
  const need = projects.some((pr) => pr.groups.some(needsPrompt));
  if (!need) return;
  const PromptIO = require('./core/prompt-io');
  // 1순위: 로컬/원격 Ollama (무료) — 도달 가능하면 사용
  const oc = require('./core/ollama-config').load();
  const tags = await ollamaTags(oc.baseUrl);
  if (tags.ok) {
    try {
      logger(`🤖 프롬프트 없는 그룹 — Ollama(${oc.model})로 내용 맞는 프롬프트 자동 생성 중…`);
      const r = await generatePromptsChunked(projects, { includeFn: needsPrompt }, (req) => PromptIO.callLlmTextApi('ollama', '', req, { baseUrl: oc.baseUrl, model: oc.model }), logger);
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
    const r = await generatePromptsChunked(projects, { includeFn: needsPrompt }, (req) => PromptIO.callLlmTextApi('gemini', key, req), logger);
    logger(`📥 프롬프트 자동 생성 완료(Gemini) — ${r.groups}개 그룹 (🖼${r.img}·🎬${r.vid})`);
  } catch (e) { logger('프롬프트 자동 생성 실패: ' + e.message + ' (나레이션으로 진행)'); }
}

// 대본 → ACE-Step BGM 무드 태그. moodOverride(작업바 수동값) → 대본 `배경음악:` 줄 → Ollama → Gemini → 기본값.
const BGM_DEFAULT_MOOD = 'calm, cinematic, ambient, soft piano, slow tempo, warm, instrumental';
async function deriveBgmMood(project, moodOverride, logger) {
  if (moodOverride && String(moodOverride).trim()) return String(moodOverride).trim();
  // 대본에 적힌 배경음악 프롬프트(파서가 proj.bgmMood 로 넣음) — 자동 분석보다 우선.
  if (project && project.bgmMood && String(project.bgmMood).trim()) {
    logger('  BGM 무드 = 대본 지정값 사용');
    return String(project.bgmMood).trim();
  }
  const PromptIO = require('./core/prompt-io');
  const sample = [project.title || project.fileTitle || '', ...project.sentences.slice(0, 8).map((s) => s.text || '')].join(' ').slice(0, 800);
  const req = [
    '다음 영상 대본의 분위기에 어울리는 "배경음악 스타일"을 ACE-Step 태그로 만들어줘.',
    '규칙: 쉼표로 구분된 영어 태그 한 줄만 출력(설명·따옴표·줄바꿈 금지). 반드시 instrumental 포함, 보컬 없음.',
    '예: calm, cinematic, ambient piano, slow tempo, warm, instrumental',
    '대본: ' + sample,
  ].join('\n');
  const sanitize = (t) => String(t || '').replace(/[\r\n]+/g, ' ').replace(/^\s*tags?\s*[:：]/i, '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
  const ensureInst = (t) => (/instrumental/i.test(t) ? t : `${t}, instrumental`);
  // 1순위 Ollama
  try {
    const oc = require('./core/ollama-config').load();
    const r = await ollamaTags(oc.baseUrl);
    if (r.ok) {
      const t = sanitize(await PromptIO.callLlmTextApi('ollama', '', req, { baseUrl: oc.baseUrl, model: oc.model }));
      if (t) return ensureInst(t);
    }
  } catch (e) { logger('  BGM 무드 Ollama 실패: ' + e.message); }
  // 2순위 Gemini
  try {
    let key = ''; try { key = (require('./tts/secret-store').get('gemini') || {}).key || ''; } catch {}
    if (key.trim()) {
      const t = sanitize(await PromptIO.callLlmTextApi('gemini', key, req));
      if (t) return ensureInst(t);
    }
  } catch (e) { logger('  BGM 무드 Gemini 실패: ' + e.message); }
  return BGM_DEFAULT_MOOD;
}

ipcMain.handle('image-build', (_e, args = {}) => {
  const { shortsNum = null, engine = 'genspark', styleId = null } = args;
  // 단건 재생성(regen-group)과 같은 직렬 큐 — 브라우저 충돌(진행 중 작업 강제 종료) 방지
  return enqueueImageJob(shortsNum ? `${shortsNum}편 이미지 생성` : '이미지 전체 생성', async () => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
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
      } else {
        await runRotatingImages(pr, mediaDir, log, styleId, engine); // Flow+Genspark 순환(한도 시 자동 이어감)
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
  // Grok(브라우저) 한도 쿨다운 중이면 브라우저 접속 없이 건너뜀 (grok-api/comfy 는 해당 없음)
  if (engine === 'grok' || engine === 'grok10') {
    const _gc = grokCoolUntil();
    if (_gc) { log(`⏭ Grok 한도 — ${fmtClock(_gc)}까지 영상 생성 건너뜀 (재설정 후 다시 시도)`); return P.toDTO(S.parsed); }
  }
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
    const needImg = pr.groups.filter((g) => onlyNums.includes(g.num) && g.imagePrompt && g.imagePrompt.trim() && !hasVisual(g));
    if (needImg.length && !S.abort) {
      log(`🖼 영상 전 — 이미지 없는 ${needImg.length}개 그룹 먼저 생성 (그룹 ${needImg.map((g) => g.num).join(',')})`);
      try {
        prefillImageCache(pr, videoDir, styleId, imgEngine);
        await runRotatingImages(pr, videoDir, log, styleId, imgEngine, onlyNums);
        cacheGeneratedImages(pr, styleId, imgEngine);
      } catch (e) { log(`이미지 선행 생성 오류: ${e.message}`); }
      pushDtoUpdate();
    }
    try {
      {
        if (engine === 'grok' || engine === 'grok10') log(`🎬 ${prLabel(pr)} 비디오 생성 (Grok ${grokDurOf(engine) === 'auto' ? '자동 6/10초' : grokDurOf(engine)}${rangeLbl})…`);
        const vr = await genGroupVideos(pr, videoDir, onlyNums, engine);
        if (vr && vr.limitReached) { S.grokLimit = { reset: (vr && vr.reset) || '' }; recordGrokCooldown(vr); S.abort = true; log('⛔ Grok 요청 한도 도달 — 작업을 멈춥니다'); }
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
  let defaultPath; // vrew 미디어(자산) 출력 폴더가 바로 뜨도록 — 대본 폴더 대신.
  try { const d = shortsDirs(S.outRoot, shortsNum); if (d && d.media) { fs.mkdirSync(d.media, { recursive: true }); defaultPath = d.media; } } catch {}
  const r = await dialog.showOpenDialog(win, {
    defaultPath,
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
    // 단계별 삭제: 영상이 있으면 영상만 지워 이미지가 다시 보이게, 영상이 없으면 이미지를 지워 빈칸으로.
    if (g.videoPath) {
      g.videoPath = null; g.videoStatus = 'idle'; g.videoSourceImage = null;
      log(`영상 삭제: ${pr.title} G${groupNum} (이미지 유지)`);
    } else {
      g.imagePath = null; g.imageStatus = 'idle';
      log(`이미지 삭제: ${pr.title} G${groupNum}`);
    }
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
  return store.loadAll().map((x) => ({ name: x.name, engine: x.engine, isDefault: !!x.isDefault, group: x.group || '' }));
});
// 채널 추가 — 현재(또는 지정) 채널 설정을 복사해 새 이름으로 생성.
ipcMain.handle('add-preset', (_e, args = {}) => {
  const store = require('./tts/preset-store');
  const name = String((args && args.name) || '').trim();
  if (!name) throw new Error('채널 이름을 입력하세요.');
  const all = store.loadAll();
  if (all.some((p) => p.name === name)) throw new Error('같은 이름의 채널이 이미 있습니다.');
  const src = all.find((p) => p.name === ((args && args.fromName) || '')) || store.getDefault() || all[0] || {};
  const copy = { ...src };
  delete copy.id; delete copy.isDefault;       // 새 id 부여 + 기본채널 플래그 제거
  copy.name = name;
  store.add(copy);
  log(`채널 "${name}" 추가 (복사 원본: ${src.name || '기본값'})`);
  return P.listPresets();
});
// 채널 이름 변경 — id 는 유지하고 name 만 교체. 큐 항목이 참조하던 옛 이름도 새 이름으로 옮김.
ipcMain.handle('rename-preset', (_e, args = {}) => {
  const store = require('./tts/preset-store');
  const oldName = String((args && args.oldName) || '').trim();
  const newName = String((args && args.newName) || '').trim();
  if (!newName) throw new Error('새 채널 이름을 입력하세요.');
  const all = store.loadAll();
  const p = all.find((x) => x.name === oldName);
  if (!p) throw new Error('채널을 찾을 수 없습니다.');
  if (newName !== oldName && all.some((x) => x.name === newName)) throw new Error('같은 이름의 채널이 이미 있습니다.');
  store.update(p.id, { name: newName });
  // 현재 세션 큐 항목·활성 프리셋의 채널 이름 참조 갱신(옛 이름 → 새 이름)
  try {
    for (const m of Object.keys(S.modes || {})) {
      for (const it of (S.modes[m].items || [])) {
        if (it.settings && it.settings.presetName === oldName) it.settings.presetName = newName;
      }
    }
    if (S.preset && S.preset.name === oldName) S.preset.name = newName;
  } catch {}
  log(`채널 이름 변경: "${oldName}" → "${newName}"`);
  return P.listPresets();
});
// 채널 삭제 — 마지막 1개는 보호.
ipcMain.handle('remove-preset', (_e, args = {}) => {
  const store = require('./tts/preset-store');
  const name = String((args && args.name) || '').trim();
  const all = store.loadAll();
  if (all.length <= 1) throw new Error('마지막 채널은 삭제할 수 없습니다.');
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error('채널을 찾을 수 없습니다.');
  store.remove(p.id);
  log(`채널 "${name}" 삭제`);
  return P.listPresets();
});
// Gemini API 키 (secret-store, gemini 엔진 공용) — GPU 없는 PC에서 음성 생성용
ipcMain.handle('get-gemini-key', () => {
  try { const s = require('./tts/secret-store').get('gemini'); return (s && s.key) || ''; } catch { return ''; }
});
ipcMain.handle('set-gemini-key', (_e, key) => {
  try { require('./tts/secret-store').set('gemini', { key: String(key || '').trim() }); log('Gemini API 키 저장됨'); return true; }
  catch (e) { log('Gemini 키 저장 실패: ' + e.message); return false; }
});
// xAI API 키 (secret-store 'xai') — Grok Imagine 비디오 API(grok-api 엔진)용. console.x.ai 에서 발급.
ipcMain.handle('get-xai-key', () => {
  try { const s = require('./tts/secret-store').get('xai'); return (s && s.key) || ''; } catch { return ''; }
});
ipcMain.handle('set-xai-key', (_e, key) => {
  try { require('./tts/secret-store').set('xai', { key: String(key || '').trim() }); log('xAI API 키 저장됨'); return true; }
  catch (e) { log('xAI 키 저장 실패: ' + e.message); return false; }
});
// TTS 서버 주소(OmniVoice/Supertonic) — PC마다 다름(LAN/Tailscale). 다른 PC에서 메인 GPU 서버를 가리키게 설정.
ipcMain.handle('get-tts-servers', () => { try { return require('./tts/tts-config').loadAll(); } catch { return {}; } });
ipcMain.handle('set-tts-server', (_e, args = {}) => {
  try {
    const id = args.id;
    let baseUrl = String(args.baseUrl || '').trim().replace(/\/+$/, '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl; // 스킴 없이 입력해도 동작
    baseUrl = baseUrl.replace(/(:\d+)(?::\d+)+$/, '$1');                          // 포트 중복 오타 보정
    if (id !== 'omnivoice' && id !== 'supertonic') throw new Error('알 수 없는 TTS provider');
    require('./tts/tts-config').setProvider(id, { baseUrl });
    log(`TTS 서버 주소 저장: ${id} → ${baseUrl || '(비움)'}`);
    return require('./tts/tts-config').loadAll();
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('test-tts-server', async (_e, args = {}) => {
  try { const { quietGet } = require('./tts/quiet-http'); const base = String(args.baseUrl || '').trim().replace(/\/$/, ''); const r = await quietGet(base + '/health', { timeoutMs: 5000 }); return { ok: r.status === 200, status: r.status, error: r.error }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
  let defaultPath; // vrew 미디어(자산) 출력 폴더가 바로 뜨도록 — 대본 폴더 대신.
  try { const d = shortsDirs(S.outRoot, shortsNum); if (d && d.media) { fs.mkdirSync(d.media, { recursive: true }); defaultPath = d.media; } } catch {}
  const r = await dialog.showOpenDialog(win, {
    defaultPath,
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
      bgmPath: pr._bgmPath || null, bgmVolume: pr._bgmVolume != null ? pr._bgmVolume : null, // BGM 재사용(재시작 후 💾 재export)
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
  if (S.parsed.kind === 'playlist' || S.parsed.kind === 'book') return null; // 플리/출판은 워크스페이스+원본(.md)이 진실 — .smproj 스냅샷 불필요
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
// 큐 전체 직렬화 (workspace 자동저장 + '큐 저장' 공용). 대본경로·설정·상태만 저장(작업물은 .smproj).
function serializeQueue() {
  const ser = (mode) => {
    const q = S.modes[mode];
    return { activeId: q.activeId, items: q.items.map((it) => ({ id: it.id, scriptPath: it.scriptPath, settings: it.settings || null, status: it.status || 'idle' })) };
  };
  return { version: 1, mode: S.mode, longform: ser('longform'), shorts: ser('shorts'), playlist: ser('playlist'), book: ser('book') };
}
function writeWorkspace() {
  try {
    const ws = serializeQueue();
    const f = workspaceFile(); const tmp = f + '.tmp';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ws, null, 2), 'utf8'); fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}
// 앱 시작 시 큐 복원 — 저장된 대본들을 다시 파싱(+작업본 복원)해 큐 재구성.
function applyWorkspace(ws, opts = {}) {
  try {
    if (!ws) return 0;
    if (opts.clear) { for (const m of ['longform', 'shorts', 'playlist', 'book']) { const q = S.modes[m]; if (q) { q.items = []; q.activeId = null; } } }
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
    // 플리 — 스펙(.md)을 playlist-parser 로 재파싱해 복원.
    if (ws.playlist && Array.isArray(ws.playlist.items)) {
      const q = S.modes.playlist; let activeNewId = null;
      for (const wi of ws.playlist.items) {
        if (!wi.scriptPath || !fs.existsSync(wi.scriptPath)) continue;
        try {
          const parsed = parsePlaylistFile(wi.scriptPath);
          const it = { id: newItemId(), parsed, scriptPath: wi.scriptPath, outRoot: playlistOutRoot(wi.scriptPath, S.preset),
            settings: wi.settings || null, status: (wi.status === 'running' ? 'idle' : (wi.status || 'idle')) };
          q.items.push(it); restored++;
          if (wi.id === ws.playlist.activeId) activeNewId = it.id;
        } catch (e) { log(`플리 복원 실패(${path.basename(wi.scriptPath)}): ${e.message}`); }
      }
      q.activeId = activeNewId || (q.items.length ? q.items[q.items.length - 1].id : null);
    }
    // 출판(book) — 원고(.md)를 book-parser 로 재파싱해 복원. 다중 파일이면 settings.book.files 재합침.
    if (ws.book && Array.isArray(ws.book.items)) {
      const BK = require('./core/parsers/book-parser');
      const q = S.modes.book; let activeNewId = null;
      for (const wi of ws.book.items) {
        const savedFiles = (wi.settings && wi.settings.book && Array.isArray(wi.settings.book.files)) ? wi.settings.book.files : null;
        const paths = (savedFiles || [wi.scriptPath]).filter((p) => p && fs.existsSync(p));
        if (!paths.length) continue;
        try {
          const files = paths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
          const parsed = BK.parseBookFiles(files, path.basename(paths[0]).replace(/\.md$/i, ''));
          if (wi.settings && wi.settings.book && wi.settings.book.coverImage) parsed.coverImagePath = wi.settings.book.coverImage;
          const folderKey = parsed.meta.title || path.basename(paths[0]).replace(/\.md$/i, '');
          const it = { id: newItemId(), parsed, scriptPath: paths[0], outRoot: bookOutRoot(folderKey + '.md', S.preset),
            settings: wi.settings || null, status: (wi.status === 'running' ? 'idle' : (wi.status || 'idle')) };
          q.items.push(it); restored++;
          if (wi.id === ws.book.activeId) activeNewId = it.id;
        } catch (e) { log(`출판 복원 실패(${path.basename(paths[0])}): ${e.message}`); }
      }
      q.activeId = activeNewId || (q.items.length ? q.items[q.items.length - 1].id : null);
    }
    S.mode = normMode(ws.mode);
    syncActiveToS();
    if (restored) log(`♻ 작업 큐 복원: ${restored}개 대본 (${S.mode})`);
    return restored;
  } catch (e) { log('큐 복원 실패: ' + (e && e.message)); return 0; }
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
    if (ps.bgmPath && fs.existsSync(ps.bgmPath)) { proj._bgmPath = ps.bgmPath; proj._bgmVolume = ps.bgmVolume; }
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
// 저장 전용 폴더 — 작업(.smproj.json)·큐(.pmqueue.json) 파일만 모임. 전체삭제 대상. (자동이어받기 projects/ 와 분리)
function savesDir() { const d = path.join(os.homedir(), '.priming-maker', 'saves'); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }
function _saveStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
ipcMain.handle('save-project', async () => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  writeSnapshotSync(); // 자동이어받기(projects/) 최신화는 유지
  const snap = buildSnapshot();
  if (!snap) throw new Error('저장 실패 — 로그를 확인하세요.');
  const base = (_safeFolder(S.parsed.fileTitle || 'project') || 'project').slice(0, 50);
  const file = path.join(savesDir(), `작업_${base}_${_saveStamp()}.smproj.json`);
  try { fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8'); } catch (e) { throw new Error('저장 실패: ' + e.message); }
  log(`💾 작업 저장: ${path.basename(file)}`);
  return { file };
});
ipcMain.handle('load-project', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: savesDir(), filters: [{ name: 'Priming 작업', extensions: ['smproj.json', 'json'] }] });
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
  { const _b = gpuBusyReason(); if (_b) { log(`⚠ ${_b} 중에는 제작을 할 수 없습니다. 끝난 뒤 다시 시도하세요.`); return; } }
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const outRoot = S.outRoot; const parsed = S.parsed; // 실행 시작 시점 고정 — 진행 중 다른 큐를 선택해 S.outRoot/S.parsed 가 바뀌어도 이 작업은 제 대본·폴더로 저장(오염 방지)
  const { shortsNum = null, engine = 'genspark', presetName = null, speed = null, captionStyle = null, captionMaxChars = 7, styleId = null, fromNum = null, toNum = null, dry = false, videoEngine = 'grok', flowVideoModel = 'Veo 3.1 - Lite', flowCount = 'x1', clipMaxSec = null, aiNotice = false, bgm = null, openVrew = true, openFolder = true } = opts;
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
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  // 프롬프트 없는 그룹(prose 대본) → 이미지 전에 API로 자동 생성 (내용 맞는 이미지)
  if (!dry) { await autoFillPrompts(parsed.projects.filter((p) => !shortsNum || p.shortsNum === shortsNum), log); }
  const _makeT0 = Date.now();
  S.timings = { tts: 0, image: 0, video: 0, make: 0 }; // 이번 작업 단계별 시간 (누적)
  pushDtoUpdate();

  // 쇼츠 1·2·3 을 하나의 덩어리로 — 단계별 일괄 처리.
  //   예전: 쇼츠마다 [TTS→이미지→영상→.vrew] 를 끝까지 돌리고 다음 쇼츠.
  //   지금: 전 쇼츠의 TTS 를 1번 1그룹부터 마지막 쇼츠 마지막 그룹까지 먼저, 그다음 전 쇼츠 이미지,
  //         그다음 전 쇼츠 영상, 마지막에 전 쇼츠 .vrew. (사용자 요청)
  //   부수효과: 단계가 완전 순차라 ComfyUI(로컬 GPU) 이미지와 OmniVoice TTS 가 겹치지 않음 → VRAM 충돌 자동 해소.
  //   (트레이드오프: 예전 Genspark/Flow 의 'TTS∥이미지' 동시 실행은 사라짐 — 의도된 변경.)
  const projects = parsed.projects.filter((pr) => !shortsNum || pr.shortsNum === shortsNum);

  // ── 1·2단계: 음성(TTS) + 이미지 ──
  //   이미지가 로컬 GPU 를 안 쓰므로(Genspark/Flow 브라우저, 나노바나나 API) TTS(로컬 GPU)와 '병렬' → 더 빠름.
  //   또한 cut/prose 처럼 TTS 후 그룹 재구성이 일어나면 이미지가 그룹에 의존 → 안전하게 순차.
  const willRegroup = (pr) => (!dry && clipMaxSec && getModeProfile(currentMode()).grouping.strategy === 'tts-greedy' && pr.format !== 'grouped');
  // 이미지 = Flow+Genspark 순환(브라우저) — 로컬 GPU 미사용 → TTS(로컬 GPU)와 병렬 안전.
  const noLocalGpuImg = true;
  const canParallel = !dry && noLocalGpuImg && !projects.some(willRegroup);

  // ── 3단계 파이프라인 조건 ──
  //   Grok 비디오는 별도 크롬 프로필이라 이미지 브라우저(Genspark/Flow)와 충돌하지 않음 → 그룹 이미지(+그룹 TTS)가
  //   준비되는 즉시 그 그룹 영상을 시작(TTS∥이미지∥비디오 겹침). ('없음'은 파이프라인 대상 아님)
  const grokVideoPipeline = videoEngine === 'grok' || videoEngine === 'grok10';
  // Grok 한도 쿨다운 중이면 이번 실행에선 영상 생략(이미지만) — 헛되이 브라우저 띄우지 않음. 한도 풀린 뒤 영상만 이어서.
  const _grokCool = grokVideoPipeline ? grokCoolUntil() : 0;
  if (_grokCool) log(`⏭ Grok 한도 — ${fmtClock(_grokCool)}까지 영상 생략(이미지만 생성). 한도 풀린 뒤 '만들기'를 다시 누르면 빠진 영상만 이어서 만듭니다.`);
  const videoPipeline = canParallel && grokVideoPipeline;
  const needTtsForVideo = true; // 그룹 TTS 길이로 영상 길이를 정함
  let ttsStageDone = false, imageStageDone = false;

  const ttsStage = async () => {
    log('🎙 1단계 — 음성(TTS) 일괄 변환…');
    for (const pr of projects) {
      if (S.abort) { log('⏹ 중단됨'); break; }
      const dirs = shortsDirs(outRoot, pr.shortsNum);
      const t0 = Date.now();
      try {
        if (dry) P.fillSilent(pr, dirs.tts);
        else await P.fillTts(pr, preset, ttsMgr, dirs.tts, log, () => S.abort, speed, pushDtoUpdate);
        if (willRegroup(pr)) {
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
    ttsStageDone = true;
  };
  const imageStage = async () => {
    log('🖼 2단계 — 이미지 일괄 생성…');
    for (const pr of projects) {
      if (S.abort) { log('⏹ 중단됨'); break; }
      const dirs = shortsDirs(outRoot, pr.shortsNum);
      prefillImageCache(pr, dirs.media, styleId, engine); // ♻ 캐시 재활용 먼저
      const t0 = Date.now();
      try {
        if (imagesNeeded(pr) > 0) {
          await runRotatingImages(pr, dirs.media, log, styleId, engine); // Flow+Genspark 순환
        }
      } catch (e) { log(`${prLabel(pr)} 이미지 오류: ${e.message}`); }
      cacheGeneratedImages(pr, styleId, engine);
      S.timings.image += (Date.now() - t0) / 1000;
      pushDtoUpdate(); // 이미지 매핑(g.imagePath) UI 썸네일에 반영
    }
    imageStageDone = true;
  };

  // 그룹별 비디오 파이프라인 — 이미지(+필요 시 그 그룹 TTS)가 준비된 그룹부터 즉시 영상 생성.
  //   Comfy 클라우드 = 그룹 단건씩 / Grok = 준비된 그룹을 모아 배치(브라우저 기동 오버헤드 절약).
  const videoStage = async () => {
    if (_grokCool) return; // Grok 쿨다운 — 영상 단계 건너뜀
    const done = new Set();
    const vmap = new Map();
    for (const pr of projects) vmap.set(pr, rangeNums(pr, fromNum, toNum)); // I2V 범위(미지정=전체)
    const ttsReady = (pr, g) => {
      // Grok 'auto' 는 그룹 TTS 합으로 6s/10s 를 정하므로 TTS 필요. 고정(10s)이면 불필요.
      if (grokVideoPipeline) {
        if (grokDurOf(videoEngine) !== 'auto') return true;
      } else if (!needTtsForVideo) return true;
      const ss = pr.getSentencesOfGroup(g);
      return ss.length > 0 && ss.every((s) => s.ttsDurationSec != null);
    };
    while (!S.abort) {
      // 지금 준비된 그룹 전부 수집 (편 순서 유지)
      const ready = [];
      for (const pr of projects) {
        const vOnly = vmap.get(pr);
        for (const g of pr.groups) {
          if (done.has(g)) continue;
          if (!vOnly.includes(g.num)) { done.add(g); continue; }                          // 영상 범위 밖
          if (!(g.imagePath && fs.existsSync(g.imagePath)) || !ttsReady(pr, g)) continue;  // 아직 준비 안 됨
          ready.push({ pr, g });
        }
      }
      if (!ready.length) {
        if (ttsStageDone && imageStageDone) break; // 단계 끝 + 더 준비될 그룹 없음 → 종료
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      // 편(pr)별로 묶어 배치 처리 — Grok 은 호출당 브라우저를 새로 띄우므로 모아서 한 번에.
      const byPr = new Map();
      for (const x of ready) { if (!byPr.has(x.pr)) byPr.set(x.pr, []); byPr.get(x.pr).push(x.g); }
      for (const [pr, gs] of byPr) {
        if (S.abort) break;
        gs.forEach((g) => done.add(g));
        const nums = gs.map((g) => g.num);
        const dirs = shortsDirs(outRoot, pr.shortsNum);
        const t0 = Date.now();
        try {
          log(`🎬 G${nums.join(',G')} (${prLabel(pr)}) 이미지 준비 — 즉시 비디오 생성(파이프라인·Grok)…`);
          const vr = await P.generateHookVideosGrok(pr, dirs.media, log, () => S.abort, 0, pushDtoUpdate, nums, grokDurOf(videoEngine));
          if (vr && vr.limitReached) { S.grokLimit = { reset: (vr && vr.reset) || '' }; recordGrokCooldown(vr); S.abort = true; log('⛔ Grok 요청 한도 도달 — 작업을 멈춥니다 (한도 풀린 뒤 다시 만들기)'); }
          if (!S.abort) await maybeUpscale(pr, log, true);
        } catch (e) { log(`G${nums.join(',G')} 영상 실패: ${e.message}`); }
        S.timings.video += (Date.now() - t0) / 1000;
        pushDtoUpdate();
      }
    }
  };

  if (videoPipeline) {
    log(`⚡ 1·2·3단계 파이프라인 — TTS ∥ 이미지 ∥ 비디오(그룹 이미지 준비 즉시, ${grokVideoPipeline ? 'Grok' : 'Comfy 클라우드'})`);
    await Promise.all([ttsStage(), imageStage(), videoStage()]);
  } else if (canParallel) {
    log(`⚡ 1·2단계 병렬 — TTS ∥ 이미지(순환, 로컬 GPU 비충돌)`);
    await Promise.all([ttsStage(), imageStage()]);
  } else {
    await ttsStage();
    if (!dry && !S.abort) await imageStage();
  }

  // ── 3단계: 비디오 — 전 쇼츠 (videoEngine='none'이면 비디오 없이 이미지만 사용) ──
  if (videoEngine === 'none') {
    log('🎬 3단계 — 비디오 없음(이미지만) — 건너뜀');
  } else if (_grokCool) {
    log(`🎬 3단계 — Grok 한도(${fmtClock(_grokCool)} 재설정)로 영상 생략 — 이미지만 사용`);
  } else if (videoPipeline) {
    log('🎬 3단계 — 파이프라인에서 그룹별로 이미 생성 완료');
  } else if (!dry && !S.abort) {
    log('🎬 3단계 — 비디오 일괄 생성…');
    for (const pr of projects) {
      if (S.abort) { log('⏹ 중단됨'); break; }
      const dirs = shortsDirs(outRoot, pr.shortsNum);
      const vOnly = rangeNums(pr, fromNum, toNum); // I2V 범위(미지정=전체)
      const t0 = Date.now();
      try {
        const vr = await genGroupVideos(pr, dirs.media, vOnly, videoEngine);
        if (vr && vr.limitReached) { S.grokLimit = { reset: (vr && vr.reset) || '' }; recordGrokCooldown(vr); S.abort = true; log('⛔ Grok 요청 한도 도달 — 작업을 멈춥니다 (한도 풀린 뒤 다시 만들기)'); }
        if (!S.abort) await maybeUpscale(pr, log, true); // 모든 영상 1080p 업스케일 (중단 시 생략)
      } catch (e) { log(`${prLabel(pr)} 영상 실패: ${e.message}`); }
      S.timings.video += (Date.now() - t0) / 1000;
      pushDtoUpdate(); // 생성된 영상(g.videoPath)도 UI 에 반영
    }
  }

  // ── 3.5단계: 배경음(BGM) — ACE-Step 독립 서버(플리 음악과 동일 경로, ComfyUI 불필요).
  //   대본 무드 자동/수동 → ≤180초 생성 → 전체 길이 루프. (dry·중단·미설정·미설치면 생략) ──
  const bgmOn = !dry && bgm && bgm.enabled;
  if (bgmOn && !S.abort) {
    log('🎵 3.5단계 — 배경음(BGM) 생성…');
    const AS = require('./core/ace-step');
    if (!AS.isInstalled()) { log('⚠ ACE-Step 미설치(ace-step/1_최초설치.bat) — BGM 없이 진행'); }
    else if (S.voiceDesignActive) { log('⚠ 보이스디자인 사용 중 — BGM 없이 진행'); }
    else {
      S.musicActive = true; // BGM 생성 중 TTS·보이스디자인 차단(VRAM 뮤텍스)
      try {
        const st = await AS.start(log);
        if (!st.ok) { log(`⚠ ACE-Step 시작 실패: ${st.error} — BGM 없이 진행`); }
        else {
          const MU = require('./core/media-utils');
          for (const pr of projects) {
            if (S.abort) break;
            const totalSec = pr.sentences.reduce((a, s) => a + (s.ttsDurationSec || 0), 0);
            if (!totalSec) continue;
            const tags = await deriveBgmMood(pr, bgm.moodOverride, log);
            pr._bgmUsedMood = tags; // UI 표시용 — 실제 사용된 BGM 무드
            const dirs = shortsDirs(outRoot, pr.shortsNum);
            const raw = path.join(dirs.media, `bgm_${vrewBaseName(pr)}.wav`);
            log(`  ▶ ${prLabel(pr)} BGM (${Math.round(totalSec)}초 분량, 무드: ${tags.slice(0, 50)})`);
            const r = await AS.generate({ tags, lyrics: '', durationSec: Math.min(Math.ceil(totalSec), 180) }, log);
            if (!r.ok) { log(`  ⚠ BGM 생성 실패: ${r.error} — 이 편은 BGM 없이`); continue; }
            fs.writeFileSync(raw, r.buffer);
            pr._bgmPath = await MU.loopAudioTo(raw, totalSec, log);
            pr._bgmVolume = (bgm.volume != null ? bgm.volume : 0.15); // 💾 재export 에서 재사용
            log(`  ✓ ${prLabel(pr)} BGM`);
            pushDtoUpdate();
          }
        }
      } catch (e) { log(`⚠ BGM 단계 오류: ${e.message} — BGM 없이 진행`); }
      finally { try { await AS.stop(log); } catch {} S.musicActive = false; }
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
      const _bgmPath4 = bgmOn ? resolveBgmPath(pr) : null; // 메모리 없으면 media 폴더 bgm mp3 재사용
      if (_bgmPath4) { ep = { ...ep, bgm: { enabled: true, audioPath: _bgmPath4, volume: (bgm.volume != null ? bgm.volume : 0.15), loop: true } }; log(`🎵 ${prLabel(pr)} .vrew 에 BGM 포함: ${path.basename(_bgmPath4)}`); }
      const dirs = shortsDirs(outRoot, pr.shortsNum);
      const baseName = vrewBaseName(pr);
      const vrewPath = path.join(outRoot, `${baseName}.vrew`);
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
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  if (openFolder && !S.abort) shell.openPath(outRoot); // 중단 시 탐색기 자동 열기 생략
  log(S.abort
    ? `⏹ 중단됨 — 완료된 자산만 보존 (TTS ${S.timings.tts.toFixed(1)}s · 이미지 ${S.timings.image.toFixed(1)}s · 비디오 ${S.timings.video.toFixed(1)}s)`
    : `⚡ 전체 제작 완료 (TTS ${S.timings.tts.toFixed(1)}s · 이미지 ${S.timings.image.toFixed(1)}s · 비디오 ${S.timings.video.toFixed(1)}s · 전체 ${S.timings.make.toFixed(1)}s)`);
}

ipcMain.handle('make-all', (_e, args = {}) => enqueueTtsJob('전체 만들기', async () => {
  await runMakeAllCore({ ...args, openVrew: true, openFolder: true });
  return P.toDTO(S.parsed);
}));

// ── 큐 순차 제작 ── 교차 순서(L1→S1→L2→S2…)는 렌더러가 plan 으로 전달. 한 항목씩 runMakeAllCore.
//   실패해도 해당 항목만 '실패' 표시 후 다음 진행.
//   openEach(기본 true): 대본 완료 때마다 그 .vrew 를 순차적으로 자동 열기(단건과 동일). false 면 열지 않고
//   큐가 끝난 뒤 출력폴더만 1번 열기(창 폭주 방지). 폴더 열기(openFolder)는 항목마다는 끔 — 끝에 1번만.
ipcMain.handle('run-batch', (_e, args = {}) => enqueueTtsJob('큐 순차 제작', async () => {
  const plan = Array.isArray(args.plan) ? args.plan : [];
  const common = args.common || {};
  const openEach = args.openEach !== false; // 기본값 = 순차 열기
  if (!plan.length) throw new Error('실행할 대본이 큐에 없습니다.');
  S.abort = false;
  log(`⚡⚡ 큐 순차 제작 시작 — 총 ${plan.length}개`);
  let okN = 0, failN = 0, skipN = 0;
  for (let i = 0; i < plan.length; i++) {
    if (S.abort) { log('⏹ 큐 중단됨 — 남은 대본 보존'); break; }
    const entry = plan[i] || {};
    storeActive(); // 직전 항목 편집분 저장
    S.mode = (entry.mode === 'longform') ? 'longform' : 'shorts';
    const q = S.modes[S.mode];
    const it = q.items.find((x) => x.id === entry.id);
    if (!it) { log(`(건너뜀) 큐 항목 없음 [${i + 1}/${plan.length}]`); continue; }
    // 이미 완료(done)된 항목은 건너뜀 — 다시 만들지 않고 .vrew 도 다시 열지 않음(필요하면 vrew 버튼으로 열기).
    //   활성 전환(무거운 대본 재렌더)·vrew 재열기를 안 하므로 만들기 눌렀을 때 멈춤도 크게 줄어듦.
    if (it.status === 'done') { skipN++; log(`⏭ [${i + 1}/${plan.length}] 이미 완료 — 건너뜀: ${path.basename(it.scriptPath || '') || it.id}`); continue; }
    q.activeId = it.id; syncActiveToS();
    if (!S.parsed) { log(`(건너뜀) 대본 비어있음 [${i + 1}/${plan.length}]`); continue; }
    it.status = 'running'; pushDtoUpdate();
    const label = (S.parsed.fileTitle) || (it.scriptPath || '');
    log(`▶ [${i + 1}/${plan.length}] ${S.mode === 'longform' ? '롱폼' : '쇼츠'} · ${label}`);
    // 항목 설정은 **서버쪽 it.settings(진짜 최신)** 우선 — 렌더러 plan(entry.settings)은 디바운스 저장이
    //   DTO 로 안 돌아와 stale 일 수 있음(예: 이미지 도구를 comfy 로 바꿔도 plan 엔 옛 rotate 가 실려 순환 실행됨).
    const s = { ...(entry.settings || {}), ...(it.settings || {}) };
    try {
      // 비디오·이미지 엔진은 **항목별 값 우선**(이 작업엔 이 도구, 저 작업엔 저 도구). 항목에 없으면 헤더(공통) 폴백.
      //   제거된 영상엔진(flow/wan/grok10)은 grok 으로 보정. (comfy::path·grok-api 는 그대로)
      const rawVe = (s.videoEngine != null) ? s.videoEngine : (common.videoEngine != null ? common.videoEngine : 'grok');
      const ve = (['flow', 'wan', 'grok10'].includes(rawVe)) ? 'grok' : rawVe;
      const ie = (s.imgEngine != null) ? s.imgEngine : (common.imgEngine || 'genspark');
      await runMakeAllCore({
        engine: ie, presetName: s.presetName || null, speed: s.ttsSpeed || null,
        styleId: s.styleId || null,
        fromNum: (s.vidFrom != null && s.vidFrom !== '') ? parseInt(s.vidFrom, 10) : null,
        toNum: (s.vidTo != null && s.vidTo !== '') ? parseInt(s.vidTo, 10) : null,
        videoEngine: ve, flowVideoModel: common.flowVideoModel || s.flowVideoModel || 'Veo 3.1 - Lite', flowCount: common.flowCount || s.flowCount || 'x1',
        captionStyle: common.captionStyle || null, captionMaxChars: common.captionMaxChars || 7,
        clipMaxSec: clipMaxOf(ve), aiNotice: !!s.aiNotice, // 쇼츠 그룹 재구성 캡 + AI 고지(사용자 선택)
        dry: false, openVrew: openEach, openFolder: false, // openEach=순차 .vrew 열기(단건과 동일). 폴더는 끝에 1번만
      });
      it.status = 'done'; okN++;
    } catch (e) {
      it.status = 'failed'; failN++;
      log(`✗ 실패: ${label} — ${e.message} (다음 대본 계속)`);
    }
    pushDtoUpdate();
  }
  log(`⚡⚡ 큐 제작 종료 — 성공 ${okN} · 실패 ${failN}${skipN ? ` · 완료건너뜀 ${skipN}` : ''}`);
  try { if (S.outRoot) shell.openPath(S.outRoot); } catch {}
  return { dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO() };
}));

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

// ── 큐 전체 저장/불러오기 ── 다중 작업 세트를 파일(.pmqueue.json)로 저장 후 통째로 복구.
//   저장 = 대본목록·채널·설정·상태. 불러오기 = 그 목록을 다시 파싱(+.smproj 작업물 이어받기)해 큐 재구성.
ipcMain.handle('save-queue', async () => {
  const total = ['longform', 'shorts', 'playlist', 'book'].reduce((n, m) => n + ((S.modes[m] && S.modes[m].items.length) || 0), 0);
  if (!total) { log('저장할 큐가 비어있습니다.'); return { ok: false, reason: 'empty' }; }
  const file = path.join(savesDir(), `큐_${_saveStamp()}.pmqueue.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(serializeQueue(), null, 2), 'utf8');
    log(`💾 큐 저장: ${path.basename(file)} (${total}개 대본)`);
    return { ok: true, path: file, count: total };
  } catch (e) { log('큐 저장 실패: ' + e.message); return { ok: false, reason: 'write', error: e.message }; }
});
// 저장 폴더(saves) 전체삭제 — 작업·큐 파일만. 자동이어받기(projects/)·워크스페이스는 건드리지 않음.
ipcMain.handle('clear-saves', () => {
  const dir = savesDir(); let n = 0;
  try { for (const f of fs.readdirSync(dir)) { if (/\.(smproj|pmqueue)\.json$/i.test(f) || /\.json$/i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch {} } } } catch {}
  log(`🗑 저장 폴더 비움 — ${n}개 파일 삭제 (${dir})`);
  return { ok: true, count: n, dir };
});
ipcMain.handle('load-queue', async () => {
  const opt = { properties: ['openFile'], defaultPath: savesDir(), filters: [{ name: 'Priming 큐', extensions: ['pmqueue.json', 'json'] }] };
  const r = await dialog.showOpenDialog(win, opt);
  if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'cancel', queue: queueDTO(), dto: S.parsed ? P.toDTO(S.parsed) : null, mode: S.mode };
  let ws;
  try { ws = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); }
  catch (e) { log('큐 파일 읽기 실패: ' + e.message); return { ok: false, reason: 'parse', queue: queueDTO() }; }
  const n = applyWorkspace(ws, { clear: true }); // 현재 큐 비우고 파일 내용으로 교체
  writeWorkspace();
  log(`📂 큐 불러오기: ${path.basename(r.filePaths[0])} — ${n}개 대본 복구`);
  return { ok: true, count: n, dto: S.parsed ? P.toDTO(S.parsed) : null, queue: queueDTO(), mode: S.mode };
});
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
  if (it) {
    let ns = (args && args.settings) || null;
    // keepChannel: 채널(presetName)은 '대본 열 때' 확정된 값 유지 — 디바운스 자동저장이 헤더의
    //   (다음 대본용으로 바뀐) 채널을 이 항목에 덮어써서 목소리가 뒤섞이던 버그 방지. 배속·스타일 등만 갱신.
    if (args && args.keepChannel && ns && it.settings && it.settings.presetName) {
      ns = { ...ns, presetName: it.settings.presetName };
    }
    it.settings = ns; scheduleAutoSave(); writeWorkspace();
  }
  return true;
});

// 그룹 1개만 TTS 변환 (그 그룹의 문장들)
ipcMain.handle('tts-group', (_e, args = {}) => enqueueTtsJob('그룹 TTS 변환', async () => {
  { const _b = gpuBusyReason(); if (_b) { log(`⚠ ${_b} 중에는 음성변환을 할 수 없습니다. 끝난 뒤 다시 시도하세요.`); return currentDTO(); } }
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
  // 이 그룹만 재변환 = 사용자가 결과가 마음에 안 들어 '새로 뽑기'. 기존 음성·캐시를 무시(force=true)하고,
  //   seed 를 매 클릭 랜덤화해 같은 문장이라도 매번 다른 take 가 나오게 한다(같은 seed 면 결정적=동일 결과).
  const rollPreset = { ...preset, seed: Math.floor(Math.random() * 1e9) };
  log(`🎤 G${groupNum} TTS 새로 뽑기 (${sents.length}문장, 기존 삭제·seed 랜덤)…`);
  await P.fillTtsList(sents, rollPreset, mgr, ttsDir, log, () => S.abort, (speed && Number(speed) > 0) ? Number(speed) : 1.0, `G${groupNum}`, pushDtoUpdate, true);
  try { await mgr.stop(); } catch {}
  pushDtoUpdate();
  return P.toDTO(S.parsed);
}));

// 그룹 프롬프트 직접 수정 — 대본 이미지/비디오 프롬프트를 사용자가 모달에서 고쳐 저장.
//   저장 후 regen-group(이미지)·video-group(비디오)을 호출하면 이 프롬프트로 재생성됨.
ipcMain.handle('set-group-prompt', (_e, args = {}) => {
  if (!S.parsed) return null;
  const { shortsNum, groupNum, imagePrompt, videoPrompt } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  if (imagePrompt != null) g.imagePrompt = String(imagePrompt).trim();
  if (videoPrompt != null) { g.videoPrompt = String(videoPrompt).trim(); g.isI2V = !!g.videoPrompt; }
  scheduleAutoSave();
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 그룹 1개만 영상 변환 (이미지 → i2v)
ipcMain.handle('video-group', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum, engine = 'grok', flowVideoModel = 'Veo 3.1 - Lite', flowCount = 'x1', upscale = false, imgEngine = 'rotate', styleId = null } = args;
  if (engine === 'none') { log('비디오 엔진 "없음" — 이미지만 사용, 비디오 생성 안 함'); return P.toDTO(S.parsed); }
  // Grok(브라우저) 한도 쿨다운 중이면 브라우저 접속 없이 건너뜀 (grok-api/comfy 는 해당 없음)
  if (engine === 'grok' || engine === 'grok10') {
    const _gc = grokCoolUntil();
    if (_gc) { log(`⏭ Grok 한도 — ${fmtClock(_gc)}까지 영상 생성 건너뜀 (재설정 후 다시 시도)`); return P.toDTO(S.parsed); }
  }
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
      await runRotatingImages(pr, videoDir, log, styleId, imgEngine, [groupNum]);
      cacheGeneratedImages(pr, styleId, imgEngine);
    } catch (e) { log(`이미지 선행 생성 오류: ${e.message}`); }
    pushDtoUpdate();
    if (!g.imagePath || !fs.existsSync(g.imagePath)) { log(`G${groupNum}: 이미지 생성 실패 — 영상 생략`); return P.toDTO(S.parsed); }
  }
  log(`🎬 G${groupNum} 영상 생성 (${engine})…`);
  // 단일 그룹 재생성 = 강제 새로 만들기 → 기존 영상·캐시 비우기.
  try {
    const MC = require('./core/media-cache');
    MC.del(MC.videoKey(g.videoPrompt || g.motionNote || '', g.imagePath, pr.aspect || '9:16', 'grok'));
    g.videoPath = null; g.videoStatus = 'generating'; pushDtoUpdate();
  } catch {}
  try {
    await genGroupVideos(pr, videoDir, [groupNum], engine);
    await maybeUpscale(pr, log, true);
    if (g.videoPath) log(`✓ G${groupNum} 영상 완료`);
    else { g.videoStatus = 'fail'; log(`✗ G${groupNum} 영상 실패 — 생성되지 않았습니다 (Grok 한도·오류 확인)`); } // 실패 시 'generating' 고착 방지
  } catch (e) { g.videoStatus = 'fail'; log(`✗ G${groupNum} 영상 실패: ${e.message}`); }
  pushDtoUpdate();
  return P.toDTO(S.parsed);
});

// 빈(또는 특정) 그룹 1개만 이미지 재생성 (Genspark 단일)
// ── 이미지 작업 직렬 큐 ── 단건 재생성/전체 생성이 동시에 돌면 같은 브라우저(Flow/Genspark)를
//   두 작업이 잡아 먼저 것이 강제 종료됨("Target page ... has been closed") → 들어온 순서대로 하나씩 실행.
let imageJobChain = Promise.resolve();
let imageJobPending = 0;
function enqueueImageJob(label, fn) {
  imageJobPending++;
  if (imageJobPending > 1) log(`⏳ ${label} — 이미지 작업 큐 대기 (앞에 ${imageJobPending - 1}건)`);
  const run = () => fn();
  const p = imageJobChain.then(run, run); // 앞 작업이 실패해도 다음 작업은 실행
  imageJobChain = p.then(() => { imageJobPending--; }, () => { imageJobPending--; });
  return p;
}

// TTS 작업 직렬 큐 — tts-build·tts-group·make-all·run-batch 는 공용 TTS 매니저(getInstance 싱글톤)를 쓴다.
//   두 작업이 동시에 돌면 한쪽의 refreshProvider(provider 삭제 후 재연결)·mgr.stop()(provider 전부 비움)이
//   다른 쪽이 쓰던 provider 를 없애 'TTS provider not available' 로 죽는다(+ 전체빌드의 전체삭제가 다른
//   작업 결과물까지 지움). → 한 번에 하나만 실행되도록 줄 세운다. 뒤 작업은 앞 작업이 끝나면 자동 실행(손실 없음).
let ttsJobChain = Promise.resolve();
let ttsJobPending = 0;
function enqueueTtsJob(label, fn) {
  ttsJobPending++;
  if (ttsJobPending > 1) log(`⏳ ${label} — TTS 작업 큐 대기 (앞에 ${ttsJobPending - 1}건 진행 중)`);
  const run = () => fn();
  const p = ttsJobChain.then(run, run); // 앞 작업이 실패해도 다음 작업은 실행
  ttsJobChain = p.then(() => { ttsJobPending--; }, () => { ttsJobPending--; });
  return p;
}

ipcMain.handle('regen-group', (_e, args = {}) => {
  const { shortsNum, groupNum, styleId = null, engine = 'genspark' } = args;
  return enqueueImageJob(`G${groupNum} 이미지 재생성`, async () => {
    if (!S.parsed) throw new Error('대본을 먼저 여세요.');
    const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
    const g = pr && pr.groups.find((x) => x.num === groupNum);
    if (!g) return P.toDTO(S.parsed);
    if (!g.imagePrompt || !g.imagePrompt.trim()) { log(`G${groupNum}: 이미지 프롬프트 없음`); return P.toDTO(S.parsed); }
    S.abort = false;
    const mediaDir = shortsDirs(S.outRoot, shortsNum).media;
    log(`🔄 ${prLabel(pr)} G${groupNum} 이미지 재생성 (${engine})…`);
    try {
      g.imagePath = null; g.imageStatus = 'generating'; g.imageEngine = null; pushDtoUpdate(); // 강제 재생성(기존/캐시 우회)
      await runRotatingImages(pr, mediaDir, log, styleId, engine, [groupNum]); // Flow+Genspark 순환, 이 그룹만
      cacheGeneratedImages(pr, styleId, engine); // 새 결과 캐시 갱신(엔진 태그 맞춤)
      if (g.imagePath && g.imageStatus === 'done') log(`✓ G${groupNum} 재생성 완료`);
      else { g.imageStatus = 'fail'; log(`✗ G${groupNum} 재생성 실패 — 이미지가 생성되지 않았습니다 (엔진 한도·오류·결제 확인)`); } // 실패 시 'generating' 고착 방지
    } catch (e) { g.imageStatus = 'fail'; log(`✗ G${groupNum} 재생성 실패: ${e.message}`); }
    pushDtoUpdate(); // 성공/실패 최종 상태를 UI 에 반영(스피너 해제)
    return P.toDTO(S.parsed);
  });
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
  return { dto: currentDTO(), queue: queueDTO() };
});

// ── 플리(ACE-Step 음악) ──────────────────────────────────────────────
// 플리 스펙(.md) 열기 → 곡 목록 파싱 → 플리 큐에 적재.
ipcMain.handle('open-playlist-spec', async (_e, args = {}) => {
  const preset = args.presetName ? P.getPreset(args.presetName) : (S.preset || null);
  if (preset) S.preset = preset;
  const defPath = (preset && (preset.scriptFolder || preset.outputFolder)) || undefined;
  const r = await dialog.showOpenDialog(win, {
    title: '플리 스펙(.md) 열기', defaultPath: defPath,
    properties: ['openFile'], filters: [{ name: '플리 스펙', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const specPath = r.filePaths[0];
  try {
    const parsed = parsePlaylistFile(specPath);
    if (!parsed.tracks.length) { log('플리 스펙에 트랙이 없습니다 — 형식을 확인하세요.'); return null; }
    S.mode = 'playlist';
    const outRoot = playlistOutRoot(specPath, preset);
    addItem(parsed, specPath, outRoot, args.settings || null);
    log(`🎵 플리 열기: ${parsed.fileTitle} (${parsed.tracks.length}곡)`);
    return { dto: currentDTO(), scriptPath: specPath, outRoot, queue: queueDTO(), mode: S.mode };
  } catch (e) {
    log('플리 스펙 파싱 실패: ' + e.message);
    return null;
  }
});

// 플리 전체 생성 — 곡마다 ComfyUI ACE-Step API 호출 → 출력폴더에 저장.
// 음악 없는 곡만 ACE-Step 독립 서버로 생성 — 「🎬 만들기」(이미지+음악+vrew) 앞단계에서 사용.
//   반환 { done, fail, serverDown }. 이미 mp3 있는 곡은 건너뜀(재생성은 ⚡음악 버튼이 담당).
// 오디오 끝 페이드아웃 — ACE-Step 은 곡 끝이 갑자기 뚝 끊기는 경향 → ffmpeg afade 로 자연스럽게.
function fadeOutAudioFile(wavPath, durSec, fadeSec = 3) {
  try {
    const ff = require('./core/media-utils').getFfmpegPath();
    if (!ff || !fs.existsSync(wavPath)) return;
    const st = Math.max(0, (Number(durSec) || 0) - fadeSec);
    const tmp = wavPath + '.fade.wav';
    const r = require('child_process').spawnSync(ff, ['-y', '-i', wavPath, '-af', `afade=t=out:st=${st}:d=${fadeSec}`, tmp], { windowsHide: true });
    if (r.status === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, wavPath); }
    else { try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}

// GPU 뮤텍스: 보이스디자인·음악 중엔 서로/음성변환을 막는다(한 번에 하나만 GPU 무겁게).
function gpuBusyReason() {
  if (S.voiceDesignActive) return '보이스디자인';
  if (S.musicActive) return '음악 생성';
  return null;
}

// 주어진 곡들을 ACE-Step 독립 서버(로컬 GPU, ComfyUI 불필요)로 생성. 서버를 자동으로 켜고(모델 로딩) 끝나면 끔.
// 음악 생성 동안 S.musicActive=true → TTS(OmniVoice)·Qwen 차단(VRAM 동시 사용 방지).
async function runAceStepMusic(tracks) {
  const AS = require('./core/ace-step');
  if (!AS.isInstalled()) { log('⚠ ACE-Step 미설치 — ace-step/1_최초설치.bat 를 먼저 실행하세요.'); return { done: 0, fail: 0, notInstalled: true }; }
  if (S.voiceDesignActive) { log('⚠ 보이스디자인 중에는 음악을 만들 수 없습니다. 디자인 창을 닫은 뒤 다시 시도하세요.'); return { done: 0, fail: 0 }; }
  const outRoot = S.outRoot || playlistOutRoot(S.scriptPath || 'playlist.md', S.preset);
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  S.musicActive = true;
  let done = 0, fail = 0;
  try {
    log(`🎵 음악 생성 — ${tracks.length}곡 → ${outRoot}`);
    const st = await AS.start(log);
    if (!st.ok) { log('✗ ACE-Step 시작 실패: ' + st.error); return { done, fail, startFail: true }; }
    for (const t of tracks) {
      if (S.abort) { log('⛔ 중단됨'); break; }
      t.status = 'generating'; t.error = null; pushDtoUpdate();
      const base = `${String(t.num).padStart(2, '0')}_${_safeFolder(t.title).slice(0, 40)}`;
      log(`  ▶ ${t.num}. ${t.title} (${t.durationSec || 180}초)`);
      const r = await AS.generate({ tags: t.tags, lyrics: t.lyrics, durationSec: t.durationSec || 180 }, log);
      if (r.ok) {
        const wavPath = path.join(outRoot, base + '.wav');
        fs.writeFileSync(wavPath, r.buffer);
        t.status = 'done'; t.audioPath = wavPath; done++;
        // 곡 길이 실측 보정 — 배경 루프·자막 길이 정합
        try { const info = await require('./core/media-utils').getMediaInfo(wavPath); if (info.durationSec > 1) t.durationSec = Math.round(info.durationSec * 10) / 10; } catch {}
        fadeOutAudioFile(wavPath, t.durationSec, 3);   // 끝 3초 페이드아웃(ACE-Step 특유의 갑작 끊김 완화)
        log(`  ✓ ${base}.wav (${t.durationSec}초)`);
      } else { t.status = 'fail'; t.error = r.error; fail++; log(`  ✗ 실패: ${r.error}`); }
      pushDtoUpdate();
    }
  } finally {
    try { await AS.stop(log); } catch {}   // 서버 종료 → VRAM 반납
    S.musicActive = false;
  }
  return { done, fail };
}

// 음악 없는 곡만 생성 — 「🎬 만들기」(음악+배경+vrew) 앞단계.
async function ensurePlaylistMusic() {
  const todo = (S.parsed.tracks || []).filter((t) => !(t.audioPath && fs.existsSync(t.audioPath)));
  if (!todo.length) { log('🎵 모든 곡에 음악이 이미 있습니다 — 음악 생성 건너뜀'); return { done: 0, fail: 0 }; }
  return await runAceStepMusic(todo);
}

// ⚡ 음악 전체 생성(또는 특정 곡 재생성) — ACE-Step 서버.
ipcMain.handle('make-playlist', async (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'playlist') { log('열린 플리가 없습니다 — 스펙을 먼저 여세요.'); return currentDTO(); }
  S.abort = false;
  const only = (args && Number(args.num)) || null;   // 특정 곡만(재생성) — null=전체
  const tracks = only ? S.parsed.tracks.filter((t) => t.num === only) : S.parsed.tracks;
  const t0 = Date.now();
  const r = await runAceStepMusic(tracks);
  S.timings.make = Math.round((Date.now() - t0) / 1000);
  log(`🎵 플리 생성 완료 — 성공 ${r.done}곡 · 실패 ${r.fail}곡 (${S.timings.make}초)`);
  try { if (r.done > 0) shell.openPath(S.outRoot || playlistOutRoot(S.scriptPath || 'playlist.md', S.preset)); } catch {}
  return currentDTO();
});

// 플리 배경(전 곡 공통) 이미지/영상 첨부 — 파일 선택. 첨부하면 「🎬 배경+vrew」가 이걸 배경으로 사용(생성 생략).
ipcMain.handle('playlist-attach-bg', async () => {
  if (!S.parsed || S.parsed.kind !== 'playlist') return currentDTO();
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '이미지/비디오', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }],
  });
  if (r.canceled || !r.filePaths[0]) return currentDTO();
  const fp = r.filePaths[0];
  const ext = path.extname(fp).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) { S.parsed.bgVideoPath = fp; S.parsed.bgImagePath = null; log(`플리 배경(영상) 첨부: ${path.basename(fp)}`); }
  else { S.parsed.bgImagePath = fp; S.parsed.bgVideoPath = null; log(`플리 배경(이미지) 첨부: ${path.basename(fp)}`); }
  return currentDTO();
});
// 플리 배경 삭제 — 영상 있으면 영상만(이미지 유지), 없으면 이미지 비움. (롱폼 clear-asset 과 동일 단계)
ipcMain.handle('playlist-clear-bg', () => {
  if (!S.parsed || S.parsed.kind !== 'playlist') return currentDTO();
  if (S.parsed.bgVideoPath) { S.parsed.bgVideoPath = null; log('플리 배경 영상 삭제(이미지 유지)'); }
  else { S.parsed.bgImagePath = null; log('플리 배경 이미지 삭제'); }
  return currentDTO();
});

// 플리 「🎬 만들기」 — 음악(ACE-Step, 없는 곡만) ∥ 배경(순환 이미지 → Grok i2v 짧은 클립) 병렬 →
//   부메랑 seamless 루프를 곡 길이만큼 곡마다 반복 → 곡=클립[ 곡 오디오 + 배경 루프 + 곡 제목 자막 ] 로 .vrew.
ipcMain.handle('make-playlist-video', async (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'playlist') { log('열린 플리가 없습니다 — 스펙을 먼저 여세요.'); return currentDTO(); }
  const bgImgEngine = args.imgEngine === 'gemini' ? 'gemini' : null; // 배경 이미지: 순환(null) | 유료 나노바나나('gemini')
  const bgVideoOn = args.videoEngine !== 'none';                     // 배경 영상: Grok 심리스(기본) | 없음=이미지 고정
  S.abort = false;
  const PV = require('./core/playlist-video');
  const outRoot = S.outRoot || playlistOutRoot(S.scriptPath || 'playlist.md', S.preset);
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  const t0 = Date.now();

  // 배경 프롬프트 — 스펙의 '배경:' > 컨셉 > 제목 순.
  const bgRaw = (S.parsed.bgPrompt && S.parsed.bgPrompt.trim()) || S.parsed.concept || S.parsed.fileTitle
    || 'calm ambient scenery, slow gentle motion, cinematic, soft light';

  // 배경 소스 — 첨부(영상/이미지) 우선. 스타일은 스펙 `> 배경:` 프롬프트가 그대로 제어.
  let bgImg = (S.parsed.bgImagePath && fs.existsSync(S.parsed.bgImagePath)) ? S.parsed.bgImagePath : null;
  let bgClipPath = (S.parsed.bgVideoPath && fs.existsSync(S.parsed.bgVideoPath)) ? S.parsed.bgVideoPath : null;

  // 배경 이미지→영상 태스크 — Flow/Genspark(이미지) → Grok i2v(영상). 브라우저 엔진이라 GPU 안 씀 → 음악과 병렬.
  const bgTask = (async () => {
    if (bgClipPath) { log(`🎬 첨부된 배경 영상 사용: ${path.basename(bgClipPath)}`); return; }
    const bgProj = { aspect: '16:9', fileTitle: S.parsed.fileTitle || 'bg',
      groups: [{ id: 'bg', num: 1, phase: '훅', imagePrompt: `${bgRaw.trim().replace(/[,\s]+$/, '')}, no text, no watermark`, videoPrompt: bgRaw, motionNote: 'slow subtle motion, seamless loop', isI2V: true, sentences: [] }] };
    const bgWork = path.join(outRoot, '_bgwork');
    if (bgImg) { bgProj.groups[0].imagePath = bgImg; log(`🖼 첨부된 배경 이미지 사용: ${path.basename(bgImg)}`); }
    else {
      try {
        log(`🖼 배경 이미지 생성(${bgImgEngine === 'gemini' ? '유료 나노바나나2 Lite API' : '순환: Genspark/Flow'}) — 스타일은 배경 프롬프트가 제어 — "${bgRaw.slice(0, 60)}"`);
        await runRotatingImages(bgProj, bgWork, log, null, bgImgEngine, [1]);   // styleId=null → 스펙 배경 프롬프트가 스타일 제어
        bgImg = bgProj.groups[0].imagePath || null;
        if (bgImg) { S.parsed.bgImagePath = bgImg; pushDtoUpdate(); log(`  ✓ 배경 이미지: ${path.basename(bgImg)}`); }
        else log('  ✗ 배경 이미지 생성 실패');
      } catch (e) { log('  ✗ 배경 이미지 오류: ' + (e && e.message || e)); }
    }
    // 이미지 나오면 바로 영상(Grok i2v) — 심리스 무한루프용 짧은 클립. '없음' 선택 시 이미지 고정 배경.
    if (!bgVideoOn) { if (bgImg) log('ℹ 배경 영상 「없음」 선택 — 이미지 고정 배경으로 진행'); }
    else if (bgImg && !S.abort) {
      try {
        log('🎬 배경 영상(Grok i2v)…');
        await P.generateHookVideosGrok(bgProj, bgWork, log, () => S.abort, 0, pushDtoUpdate, [1], 6);
        const vp = bgProj.groups[0].videoPath;
        if (vp && fs.existsSync(vp)) { bgClipPath = vp; S.parsed.bgVideoPath = bgClipPath; pushDtoUpdate(); log(`  ✓ 배경 영상: ${path.basename(bgClipPath)}`); }
        else log('  ℹ 배경 영상 없음 — 이미지 배경으로 진행');
      } catch (e) { log('  ✗ 배경 영상 오류: ' + (e && e.message || e) + ' — 이미지 배경으로 진행'); }
    }
    if (!bgImg && !bgClipPath) log('ℹ 배경을 못 만들었습니다 — 배경 없이 음악+제목 자막으로 .vrew 를 만듭니다.');
    try { closeFlowEng(); } catch {}
  })();

  // ▶ 병렬: 음악(GPU, ACE-Step) ∥ 배경 이미지·영상(브라우저) — GPU 안 겹침
  log('⚡ 만들기 — 음악(GPU) ∥ 배경 이미지·영상(브라우저) 병렬 진행…');
  const [mSettled] = await Promise.allSettled([ensurePlaylistMusic(), bgTask]);
  const mres = mSettled && mSettled.status === 'fulfilled' ? mSettled.value : {};
  if (S.abort) { log('⏹ 중단됨'); return currentDTO(); }

  const tracks = (S.parsed.tracks || []).filter((t) => t.audioPath && fs.existsSync(t.audioPath));
  if (!tracks.length) { log('⚠ 음악이 없어 만들 수 없습니다' + (mres && mres.notInstalled ? ' — ace-step/1_최초설치.bat 를 먼저 실행하세요.' : ' (음악 생성 실패 — 로그 확인).')); return currentDTO(); }
  // 곡 길이 실측 보정 — 배경 루프 길이 정합
  for (const t of tracks) {
    try {
      const info = await require('./core/media-utils').getMediaInfo(t.audioPath);
      if (info.durationSec > 1 && Math.abs(info.durationSec - (t.durationSec || 0)) > 1) t.durationSec = Math.round(info.durationSec * 10) / 10;
    } catch {}
  }

  // 4) seamless 부메랑 → 곡 길이만큼 곡별 루프
  let boomerang = null;
  if (bgClipPath && fs.existsSync(bgClipPath)) {
    try {
      boomerang = path.join(outRoot, '_bg_boomerang.mp4');
      await PV.makeBoomerang(bgClipPath, boomerang, log);
      for (const t of tracks) {
        if (S.abort) break;
        const lp = path.join(outRoot, `_bgloop_${String(t.num).padStart(2, '0')}.mp4`);
        try { await PV.loopBoomerangTo(boomerang, lp, t.durationSec || 180); t._bgLoop = lp; log(`  ✓ G${t.num} 배경 루프 (${(t.durationSec || 180)}초)`); }
        catch (e) { log(`  ✗ G${t.num} 배경 루프 실패: ${e.message}`); }
      }
    } catch (e) { log('✗ 배경 루프 생성 실패: ' + e.message + ' — 이미지 배경으로 대체'); }
    finally { try { if (boomerang) fs.unlinkSync(boomerang); } catch {} }
  }

  // 5) Project 구성 + .vrew
  log('📦 플리 .vrew 생성…');
  const proj = PV.buildPlaylistProject({ ...S.parsed, tracks }, { bgImagePath: bgImg });
  const baseName = _safeFolder(S.parsed.fileTitle || '플레이리스트').slice(0, 60) || '플레이리스트';
  const vrewPath = path.join(outRoot, `${baseName}.vrew`);
  try {
    const res = await P.buildProjectVrew(proj, vrewPath, null, log, 14, 1); // 제목 자막 14자 분할, 배속 1
    log(`✓ ${path.basename(vrewPath)} (clip ${res.clipCount}) — Vrew 에서 열어 마무리하세요`);
    shell.openPath(vrewPath);
  } catch (e) { log('✗ .vrew 생성 실패: ' + e.message); }
  S.timings.make = Math.round((Date.now() - t0) / 1000);
  log(`🎬 플리 영상/​.vrew 완료 (${S.timings.make}초)`);
  try { shell.openPath(outRoot); } catch {}
  return currentDTO();
});

// ── 출판(POD) — MD 원고 → 내지·표지 PDF ─────────────────────────────
// 다중 파일 원고: S.parsed._files = [{path, kind, startLine, lineCount}] (결합 라인 오프셋).
//   필수파일(메타·부속물) + 회차 .md N개 → 한 권. 편집은 결합 라인 → 원본 파일 역매핑.
function isMultiBook() { return !!(S.parsed && Array.isArray(S.parsed._files) && S.parsed._files.length > 1); }
function bookFilePaths() {
  if (S.parsed && Array.isArray(S.parsed._files)) return S.parsed._files.map((f) => f.path);
  return S.scriptPath ? [S.scriptPath] : [];
}
// 메타·부속물 편집 대상 파일 — 필수(essential) 파일 우선, 없으면 첫 파일.
function bookEssentialPath() {
  if (S.parsed && Array.isArray(S.parsed._files)) {
    const e = S.parsed._files.find((f) => f.kind === 'essential');
    return (e || S.parsed._files[0]).path;
  }
  return S.scriptPath;
}
// 원고 파일들 재파싱(다중=재합침) — 편집·섹션 토글 후 항상 이걸로 갱신.
function rebuildBook() {
  const BK = require('./core/parsers/book-parser');
  const paths = bookFilePaths();
  if (!paths.length) return currentDTO();
  const prevCover = S.parsed && S.parsed.coverImagePath;
  const prevPages = S.parsed && S.parsed._lastPages;
  const files = paths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  S.parsed = BK.parseBookFiles(files, path.basename(paths[0]).replace(/\.md$/i, ''));
  if (prevCover) S.parsed.coverImagePath = prevCover;
  if (prevPages) S.parsed._lastPages = prevPages;
  storeActive();
  return currentDTO();
}
// (단일 파일 전용) 원고 텍스트 재파싱 + 파일 저장
function applyBookText(text) {
  if (isMultiBook()) { log('⚠ 다중 파일 원고 — 전체 텍스트 일괄 수정은 지원하지 않습니다. 미리보기에서 문단을 클릭해 수정하세요.'); return currentDTO(); }
  const fallback = S.scriptPath ? path.basename(S.scriptPath).replace(/\.md$/i, '') : '책';
  if (S.scriptPath) { try { fs.writeFileSync(S.scriptPath, text, 'utf8'); } catch (e) { log('원고 저장 실패: ' + e.message); } }
  return rebuildBook();
}
function bookScriptText() {
  // 다중 파일이면 원본들을 파일 배너와 함께 이어붙여 반환(읽기 전용 참고용)
  if (isMultiBook()) {
    return S.parsed._files.map((f) => {
      let t = ''; try { t = fs.readFileSync(f.path, 'utf8'); } catch (_) {}
      return `<!-- ═══ 파일: ${path.basename(f.path)} (읽기 전용 — 수정은 미리보기 문단 클릭) ═══ -->\n${t}`;
    }).join('\n\n');
  }
  try { return fs.readFileSync(S.scriptPath, 'utf8'); } catch { return ''; }
}
// 출판 조판 옵션 — 렌더러가 넘긴 layout 을 활성 항목 settings 에 보관(워크스페이스 영속).
function rememberBookLayout(layout) {
  const it = activeItem();
  if (it && layout) { it.settings = { ...(it.settings || {}), book: { ...((it.settings || {}).book || {}), ...layout } }; writeWorkspace(); }
}
function bookLayoutOpts(args = {}) {
  const it = activeItem();
  const saved = (it && it.settings && it.settings.book) || {};
  const l = { ...saved, ...(args.layout || {}) };
  return {
    // 본문 타이포
    fontKey: l.fontKey, fontSizePt: l.fontSizePt, lineHeight: l.lineHeight, fontWeight: l.fontWeight,
    letterSpacingPt: l.letterSpacingPt, indentPt: l.indentPt, paragraphSpacingPt: l.paragraphSpacingPt,
    // 여백·장
    marginsMm: l.marginsMm, chapterStart: l.chapterStart, footnoteMode: l.footnoteMode,
    // 머리글/쪽번호
    headerEven: l.headerEven, headerOdd: l.headerOdd,
    headerEvenAlign: l.headerEvenAlign, headerOddAlign: l.headerOddAlign,
    headerLine: l.headerLine, pageNum: l.pageNum,
    // 소제목
    h2SizePt: l.h2SizePt, h2Gothic: l.h2Gothic, h2Weight: l.h2Weight, h2Align: l.h2Align,
    h2Prefix: l.h2Prefix, h2MarginTopPt: l.h2MarginTopPt, h2MarginBottomPt: l.h2MarginBottomPt,
    // 판권·표지
    colophonFields: l.colophonFields, coverOverlay: l.coverOverlay, coverBarcode: l.coverBarcode,
    coverTextColor: l.coverTextColor,
    // 특별 섹션(반복 코너) 키워드 + 출력 제외 섹션(구조 패널 체크 해제 — 원고 보존)
    specialKeyword: l.specialKeyword, excluded: Array.isArray(l.excluded) ? l.excluded : [],
  };
}

// 원고(.md) 열기 — 다중 선택 가능(필수파일 + 회차 여러 개 = 한 권). book-parser 로 파싱해 출판 큐에 적재.
ipcMain.handle('open-book-script', async (_e, args = {}) => {
  const preset = args.presetName ? P.getPreset(args.presetName) : (S.preset || null);
  if (preset) S.preset = preset;
  const opt = {
    title: '출판 원고(.md) 열기 — 여러 파일 선택 가능 (필수파일 + 회차들)',
    properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  if (preset && preset.scriptFolder && fs.existsSync(preset.scriptFolder)) opt.defaultPath = preset.scriptFolder;
  const r = await dialog.showOpenDialog(win, opt);
  if (r.canceled || !r.filePaths.length) return null;
  return openBookPaths(r.filePaths, preset);
});
// 경로 지정 열기 — 롱폼 「📖 출판편집」 버튼(무인자=현재 대본) 또는 scriptPaths 배열(다중 파일).
ipcMain.handle('open-book-path', (_e, args = {}) => {
  const arr = (args && Array.isArray(args.scriptPaths) && args.scriptPaths.length) ? args.scriptPaths
    : [(args && args.scriptPath) || S.scriptPath];
  const paths = arr.filter((p) => p && fs.existsSync(p));
  if (!paths.length) { log('원고 파일이 없습니다 — 대본을 먼저 여세요.'); return null; }
  return openBookPaths(paths, S.preset);
});
function openBookPaths(paths, preset) {
  try {
    const BK = require('./core/parsers/book-parser');
    // 정렬: 필수파일(메타·부속물) 먼저 → 나머지 파일명 숫자 인식 정렬(제001회 < 제002회 …)
    const items = paths.map((p) => ({ p, kind: BK.detectBookFileKind(fs.readFileSync(p, 'utf8')) }));
    items.sort((a, b) => {
      if (a.kind === 'essential' && b.kind !== 'essential') return -1;
      if (b.kind === 'essential' && a.kind !== 'essential') return 1;
      return path.basename(a.p).localeCompare(path.basename(b.p), 'ko', { numeric: true });
    });
    const sorted = items.map((x) => x.p);
    const files = sorted.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
    const parsed = BK.parseBookFiles(files, path.basename(sorted[0]).replace(/\.md$/i, ''));
    S.mode = 'book';
    // 출력 폴더 — 책제목(메타) 우선, 없으면 첫 파일명
    const folderKey = parsed.meta.title || path.basename(sorted[0]).replace(/\.md$/i, '');
    const outRoot = bookOutRoot(folderKey + '.md', preset || S.preset);
    try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
    const it = addItem(parsed, sorted[0], outRoot);
    it.settings = { ...(it.settings || {}), book: { ...((it.settings || {}).book || {}), files: sorted } };
    if (it.settings.book.coverImage && fs.existsSync(it.settings.book.coverImage)) {
      parsed.coverImagePath = it.settings.book.coverImage;
    }
    writeWorkspace();
    const chapters = parsed.parts.reduce((n, p) => n + p.chapters.length, 0);
    log(`📖 출판 원고 열기: ${parsed.fileTitle} — 파일 ${sorted.length}개 · 장 ${chapters}개 · 앞부속 ${parsed.front.length} · 뒷부속 ${parsed.back.length}`);
    return { dto: currentDTO(), scriptPath: sorted[0], outRoot, queue: queueDTO(), mode: S.mode };
  } catch (e) { log('출판 원고 파싱 실패: ' + e.message); return null; }
}

// 원고 작성 가이드(.md) 저장 — 규약 설명이 주석으로 들어 있는 "살아있는 예시" 파일.
ipcMain.handle('book-save-guide', async () => {
  const src = path.join(__dirname, 'docs', '출판-원고-가이드.md');
  if (!fs.existsSync(src)) { log('가이드 파일이 없습니다: ' + src); return null; }
  const r = await dialog.showSaveDialog(win, {
    title: '원고 작성 가이드 저장 — 이 파일을 복사해 내용을 바꾸면 바로 책이 됩니다',
    defaultPath: '출판원고_가이드.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return null;
  try {
    fs.copyFileSync(src, r.filePath);
    log('📄 원고 작성 가이드 저장: ' + r.filePath);
    try { shell.showItemInFolder(r.filePath); } catch {}
    return { path: r.filePath };
  } catch (e) { log('가이드 저장 실패: ' + e.message); return null; }
});

// 실제 페이지 미리보기 — 조판 HTML 을 출력폴더에 쓰고 media:// URL 반환(렌더러 vivliostyle 이 로드).
ipcMain.handle('book-preview', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') return null;
  try {
    const { buildBookHtml } = require('./core/book/html-builder');
    const { bundledFontCss } = require('./core/book/pdf-builder');
    rememberBookLayout(args.layout);
    const mediaUrl = (abs) => 'media://' + encodeURIComponent(abs);
    // 표지 안내 페이지(미리보기 전용) — 스프레드 치수 + 첨부 표지 이미지 정합 확인
    const d0 = bookDTO(S.parsed);
    const PP = require('./core/book/platform-presets');
    const coverInfo = {
      spread: d0.spread,
      pages: d0.lastPages || 0,
      flaps: d0.flaps,
      paperLabel: (PP.getPaper(d0.paperId) || {}).label || d0.paperId,
      coverImageUrl: (S.parsed.coverImagePath && fs.existsSync(S.parsed.coverImagePath)) ? mediaUrl(S.parsed.coverImagePath) : null,
      coverName: S.parsed.coverImagePath ? path.basename(S.parsed.coverImagePath) : null,
    };
    const { html } = buildBookHtml(S.parsed, {
      ...bookLayoutOpts(args),
      baseDir: S.scriptPath ? path.dirname(S.scriptPath) : undefined,
      imageUrl: mediaUrl,
      fontCss: bundledFontCss(mediaUrl),
      sourceMap: true,
      coverInfo,
    });
    const dir = path.join(S.outRoot || bookOutRoot(S.scriptPath || 'book.md', S.preset), '_preview');
    fs.mkdirSync(dir, { recursive: true });
    // 조판마다 새 파일명 — URL 쿼리(?t=) 캐시버스터는 vivliostyle target-counter(목차 쪽번호)의
    //   같은문서 판정을 깨뜨림(로드 URL 은 ?t= 포함, anchor 절대화는 쿼리 없음 → 불일치 → '??').
    //   파일명 자체를 바꾸면 쿼리 없이도 항상 새 URL = 캐시 무효 + anchor 일치.
    for (const f of fs.readdirSync(dir)) {
      if (/^book.*\.html$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    }
    const htmlPath = path.join(dir, `book-${Date.now()}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    return { url: 'media://' + encodeURIComponent(htmlPath), htmlPath };
  } catch (e) { log('미리보기 조판 실패: ' + e.message); return null; }
});
// 미리보기 페이지 수 보고 — 렌더러 vivliostyle 이 조판 완료 후 알려줌(책등 계산용).
ipcMain.handle('book-report-pages', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') return null;
  const n = Number(args.pages);
  if (Number.isFinite(n) && n > 0) { S.parsed._lastPages = n; storeActive(); }
  return currentDTO();
});

// PDF 생성 — 내지.pdf (+표지 이미지 있으면 표지.pdf). 완료 후 출력폴더 열기.
ipcMain.handle('book-build-pdf', async (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') { log('열린 출판 원고가 없습니다.'); return { dto: currentDTO() }; }
  // 구버전 설치본 가드 — vivliostyle CLI(또는 중첩 archiver)가 없으면 크래시 덤프 대신 재설치 안내.
  //   (라이트 업데이트는 node_modules 를 못 바꾸므로, deps 포함 릴리스는 설치파일 재설치가 필요)
  try {
    const cliPkg = require.resolve('@vivliostyle/cli/package.json');
    const cliDir = path.dirname(cliPkg);
    const hasArchiver = fs.existsSync(path.join(cliDir, 'node_modules', 'archiver'))
      || (() => { try { require.resolve('archiver'); return true; } catch { return false; } })();
    if (!hasArchiver) throw new Error('archiver 미포함');
  } catch (e) {
    const msg = '이 설치본에는 PDF 조판 모듈이 없습니다(구버전 설치) — 새 설치파일 Priming-Setup-0.2.8.exe 로 재설치하세요.';
    log('✗ ' + msg);
    return { dto: currentDTO(), error: msg };
  }
  const t0 = Date.now();
  try {
    const { buildBookHtml, metaPlatformId } = require('./core/book/html-builder');
    const PB = require('./core/book/pdf-builder');
    const SC = require('./core/book/spine-calc');
    const PP = require('./core/book/platform-presets');
    rememberBookLayout(args.layout);
    const outRoot = S.outRoot || bookOutRoot(S.scriptPath || 'book.md', S.preset);
    const workDir = path.join(outRoot, '_work');
    const assets = PB.prepareWorkAssets(workDir);
    const { html } = buildBookHtml(S.parsed, {
      ...bookLayoutOpts(args),
      baseDir: S.scriptPath ? path.dirname(S.scriptPath) : undefined,
      imageUrl: assets.imageUrl, fontCss: assets.fontCss, sourceMap: false,
    });
    const base = _safeFolder(S.parsed.meta.title || S.parsed.fileTitle || '책');
    const interiorPdf = path.join(outRoot, `${base}_내지.pdf`);
    const r = await PB.buildInteriorPdf({ html, outPdf: interiorPdf, workDir, log, pressReady: !!args.pressReady, grayScale: !!args.grayScale });
    if (!r.success) { log('✗ 내지 PDF 실패: ' + r.error); return { dto: currentDTO(), error: r.error }; }
    S.parsed._lastPages = r.pages || S.parsed._lastPages || 0;

    // 규격 리포트 — 플랫폼 최소쪽수 경고 + 책등/표지 스프레드 안내
    const meta = S.parsed.meta || {};
    const platformId = metaPlatformId(meta);
    const pf = PP.getPlatform(platformId);
    const trimId = meta.trim && PP.TRIM_SIZES[meta.trim] ? meta.trim : pf.defaultTrim;
    const paperId = meta.paper && PP.PAPERS[meta.paper] ? meta.paper : pf.defaultPaper;
    const flaps = !!(meta.flaps && !/^(없음|no|off|false|x)$/i.test(String(meta.flaps).trim()));
    const spread = SC.coverSpread({ platformId, trimId, paperId, totalPages: S.parsed._lastPages, flaps });
    if (pf.minPages && S.parsed._lastPages < pf.minPages) {
      log(`⚠ ${pf.label} 최소 ${pf.minPages}쪽 — 현재 ${S.parsed._lastPages}쪽 (승인 거부될 수 있음)`);
    }
    log(`📐 책등 ${spread.spineMm}mm · 표지 스프레드 ${spread.widthMm}×${spread.heightMm}mm (${spread.widthPx}×${spread.heightPx}px @300dpi${flaps ? ' · 날개 포함' : ''})`);

    // 표지 — 배경 이미지(선택) + 표지 문구([뒷표지]/[앞날개]/[뒷날개]/[책등])·제목 오버레이·바코드 조판.
    let coverResult = null;
    const layoutOpts = bookLayoutOpts(args);
    const coverHasImg = S.parsed.coverImagePath && fs.existsSync(S.parsed.coverImagePath);
    const coverSecsAll = (S.parsed.covers || []).filter((s) => !(layoutOpts.excluded || []).includes(s.key));
    const coverHasText = coverSecsAll.some((s) => (s.blocks || []).length) || layoutOpts.coverOverlay;
    if (coverHasImg || coverHasText) {
      // 🔍 표지 이미지 재검증 — 첨부 시점이 아니라 "최종 쪽수로 계산된 스프레드" 기준으로 다시 확인.
      //   (원고 수정으로 쪽수·책등이 변하면 첨부 때 맞았던 이미지도 어긋남 — 무경고 스트레치 방지)
      if (coverHasImg) {
        try {
          const { readImageSize } = require('./vrew/vrew-builder');
          const dim = readImageSize(S.parsed.coverImagePath); // {w,h}
          if (dim && dim.w) {
            const chk = SC.validateCoverImage({ imgW: dim.w, imgH: dim.h, spread });
            S.parsed._coverCheck = { ...chk, imgW: dim.w, imgH: dim.h };
            if (!chk.ok) log(`⚠ 표지 치수 불일치(최종 쪽수 기준): ${dim.w}×${dim.h}px — 기대 ${chk.expected.widthPx}×${chk.expected.heightPx}px (${chk.expected.widthMm}×${chk.expected.heightMm}mm). 그대로 진행하면 이미지가 강제로 늘어나 책등이 어긋날 수 있습니다.`);
          }
        } catch (_) {}
      }
      let barcode = null;
      if (layoutOpts.coverBarcode !== false && meta.isbn) {
        // 바 높이 200px(≈17.6mm@80%배율) — 표준 스캔 높이 확보. quiet 11모듈 = GS1 좌측 최소.
        try { barcode = require('./core/book/isbn-barcode').isbnBarcodeSvg(meta.isbn, meta.isbnAddon || '', { height: 200, quiet: 11 }); } catch (_) {}
        if (!barcode) log(`⚠ ISBN 체크섬/형식 오류 — 표지에 바코드가 포함되지 않습니다: ${meta.isbn}`);
      }
      const coverPdf = path.join(outRoot, `${base}_표지.pdf`);
      coverResult = await PB.buildCoverPdf({
        imagePath: coverHasImg ? S.parsed.coverImagePath : null,
        spread, outPdf: coverPdf, workDir, log,
        compose: { meta, covers: coverSecsAll, overlay: !!layoutOpts.coverOverlay, textColor: layoutOpts.coverTextColor, barcode },
      });
      if (!coverResult.success) log('✗ 표지 PDF 실패: ' + coverResult.error);
    } else {
      log('ℹ 표지 이미지·문구 없음 — 내지만 생성. 우측 패널에서 이미지 첨부 또는 [뒷표지]·[책등] 섹션을 추가하세요.');
    }
    // 판권지 존재 확인 — [판권] 마커 섹션이 없으면(또는 구조 패널에서 제외되면) 내지에 판권지가
    // 아예 없음(출판문화산업진흥법 기재사항 누락 위험) → 무경고 입고 방지.
    try {
      const hasColophon = (S.parsed.back || []).some((s) => s.key === 'colophon') && !(layoutOpts.excluded || []).includes('colophon');
      if (!hasColophon) log('⚠ 판권지 없음 — 내지에 판권지가 포함되지 않습니다. 원고에 `## [판권]` 을 추가하세요(내용 비우면 메타로 자동 생성).');
    } catch (_) {}
    S.timings.make = Math.round((Date.now() - t0) / 1000);
    const coverFailed = coverResult && !coverResult.success;
    log(`📕 출판 PDF 완료 — 내지 ${S.parsed._lastPages}쪽${coverResult && coverResult.success ? ' + 표지' : (coverFailed ? ' (⚠ 표지 실패 — 로그 확인)' : '')} (${S.timings.make}초) → ${outRoot}`);
    try { shell.openPath(outRoot); } catch {}
    storeActive();
    return { dto: currentDTO(), pages: S.parsed._lastPages, interiorPdf, coverPdf: coverResult && coverResult.success ? coverResult.pdfPath : null, coverError: coverFailed ? coverResult.error : null };
  } catch (e) {
    log('✗ 출판 PDF 오류: ' + e.message);
    return { dto: currentDTO(), error: e.message };
  }
});

// 표지 이미지 첨부 — 스프레드 기대 치수와 검증(±1mm 또는 비율 1%).
ipcMain.handle('book-attach-cover', async () => {
  if (!S.parsed || S.parsed.kind !== 'book') return currentDTO();
  const r = await dialog.showOpenDialog(win, {
    // ⚠ TIFF 는 Chromium <img> 렌더 불가(표지가 빈 흰색으로 인쇄됨) → 필터에서 제외.
    title: '표지 이미지(앞표지+책등+뒷표지 통합 스프레드) 첨부',
    properties: ['openFile'], filters: [{ name: '이미지 (PNG/JPG/WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (r.canceled || !r.filePaths[0]) return currentDTO();
  const fp = r.filePaths[0];
  S.parsed.coverImagePath = fp;
  // 치수 검증 (이미지 헤더에서 px 읽기 — readImageSize 는 {w,h} 반환. width/height 아님 주의!)
  try {
    const { readImageSize } = require('./vrew/vrew-builder');
    const dim = readImageSize ? readImageSize(fp) : null;
    if (dim && dim.w) {
      const d = bookDTO(S.parsed);
      const SC = require('./core/book/spine-calc');
      S.parsed._coverCheck = { ...SC.validateCoverImage({ imgW: dim.w, imgH: dim.h, spread: d.spread }), imgW: dim.w, imgH: dim.h };
      const c = S.parsed._coverCheck;
      log(c.ok
        ? `🖼 표지 첨부: ${path.basename(fp)} (${dim.w}×${dim.h}px${c.lowDpi ? ' · ⚠ 실효 ' + c.effectiveDpi + 'dpi < 300' : ''})`
        : `⚠ 표지 치수 불일치: ${dim.w}×${dim.h}px — 기대 ${c.expected.widthPx}×${c.expected.heightPx}px (${c.expected.widthMm}×${c.expected.heightMm}mm)`);
      if ((S.parsed._lastPages || 0) <= 0) log('ℹ 아직 쪽수 미확정(미리보기/PDF 전) — 조판 후 쪽수가 정해지면 표지 치수를 다시 확인하세요.');
    } else { S.parsed._coverCheck = null; log(`🖼 표지 첨부: ${path.basename(fp)} (치수 확인 불가 형식 — PNG/JPG 권장)`); }
  } catch (_) { S.parsed._coverCheck = null; log(`🖼 표지 첨부: ${path.basename(fp)}`); }
  rememberBookLayout({ coverImage: fp });
  storeActive();
  return currentDTO();
});
ipcMain.handle('book-clear-cover', () => {
  if (!S.parsed || S.parsed.kind !== 'book') return currentDTO();
  S.parsed.coverImagePath = null; S.parsed._coverCheck = null;
  rememberBookLayout({ coverImage: null });
  log('표지 이미지 제거');
  return currentDTO();
});

// 결합 라인 → 원본 파일·로컬 라인 (단일 파일이면 그대로)
function bookResolveLine(combinedLine) {
  const BK = require('./core/parsers/book-parser');
  const src = BK.resolveSourceLine(S.parsed, combinedLine);
  return src || { path: S.scriptPath, line: combinedLine };
}
function readFileLines(p) { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n'); } catch { return []; } }
function writeFileLines(p, lines) { fs.writeFileSync(p, lines.join('\n'), 'utf8'); }

// 구조 패널 — 예약 섹션 넣기/빼기 = 원고(.md)에 템플릿 삽입/삭제.
ipcMain.handle('book-toggle-section', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book' || !S.scriptPath) return currentDTO();
  const BK = require('./core/parsers/book-parser');
  const key = args.key;
  const rs = BK.reservedSections().find((x) => x.key === key);
  if (!rs) return currentDTO();
  const exists = [...(S.parsed.front || []), ...(S.parsed.back || []), ...(S.parsed.covers || [])].find((s) => s.key === key);
  if (args.on && !exists) {
    // 추가 — 필수(essential) 파일 끝에 템플릿 append (표시 순서는 파서가 관행대로 재배열)
    const target = bookEssentialPath();
    const lines = readFileLines(target);
    const tpl = BK.sectionTemplate(key).trimEnd();
    if (!isMultiBook() && rs.zone === 'front') {
      // 단일 파일 앞부속 — 첫 본문 장(비대괄호 ## 헤딩) 앞에 삽입
      let at = lines.length;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^##\s+(.+)$/);
        if (m && !/^\[/.test(m[1].trim())) { at = i; break; }
      }
      lines.splice(at, 0, tpl, '');
    } else {
      lines.push(tpl);
    }
    writeFileLines(target, lines);
    log(`＋ [${rs.label}] 섹션 추가 → ${path.basename(target)}`);
  } else if (!args.on && exists) {
    // 제거 — 섹션 헤더가 있는 원본 파일에서 다음 헤딩 직전까지 삭제
    const src = bookResolveLine(exists.lineStart);
    const lines = readFileLines(src.path);
    let end = lines.length;
    for (let i = src.line + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+/.test(lines[i].trim()) || /^===.*===$/.test(lines[i].trim())) { end = i; break; }
    }
    lines.splice(src.line, end - src.line);
    writeFileLines(src.path, lines);
    log(`－ [${rs.label}] 섹션 제거 (${path.basename(src.path)})`);
  } else { return currentDTO(); }
  return rebuildBook();
});

// 책 정보(메타) 편집 — 원고 상단 `> 라벨: 값` 줄을 갱신(없으면 삽입). title 은 H1.
const BOOK_META_LABELS = {
  subtitle: '부제', author: '저자', translator: '옮긴이', publisher: '출판사', issuer: '발행인',
  issueDate: '발행일', isbn: 'ISBN', isbnAddon: '부가기호', price: '정가', ebookPrice: '전자책', regNo: '출판등록',
  address: '주소', phone: '전화', fax: '팩스', homepage: '홈페이지', email: '이메일',
  copyright: '저작권', trim: '판형', platform: '플랫폼', paper: '용지', flaps: '날개',
  colophonPos: '판권위치', halfTitle: '반표제지', footnoteMode: '각주방식', logo: '로고',
  qr: 'QR', qrLabel: 'QR라벨',
};
ipcMain.handle('book-set-meta', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book' || !S.scriptPath) return currentDTO();
  const key = args.key; const value = String(args.value == null ? '' : args.value).trim();
  const target = bookEssentialPath();
  const lines = readFileLines(target);
  // title — 단일(우리 형식) 파일은 H1, 필수파일(다중)은 `책제목:` 메타 줄로
  if (key === 'title' && !isMultiBook()) {
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^#\s+/.test(lines[i])) { lines[i] = '# ' + value; done = true; break; }
      if (/^##\s+/.test(lines[i])) break;
    }
    if (!done) lines.unshift('# ' + value);
    writeFileLines(target, lines);
    return rebuildBook();
  }
  const label = key === 'title' ? '책제목' : BOOK_META_LABELS[key];
  if (!label) return currentDTO();
  // 이 표준키에 매핑되는 기존 메타 줄 탐색 — `> 라벨:` 과 평문 `라벨:`(필수파일) 둘 다 인식
  // ⚠ H1(# 책제목)은 메타 영역보다 앞에 오는 '제목'이라 body 시작이 아님 — H2 이상(##)부터 body.
  //   (H1 을 body 로 치면 탐색 범위가 0줄 → 기존 메타 줄을 못 찾고 맨 앞에 중복 삽입 →
  //    파서는 아래(원래) 값을 쓰므로 규격 패널 변경이 전부 안 먹던 버그)
  const { parseBookText } = require('./core/parsers/book-parser');
  let bodyStart = lines.findIndex((l) => /^#{2,6}\s+/.test(l.trim()) || /^===.*===$/.test(l.trim()));
  if (bodyStart < 0) bodyStart = lines.length;
  // 같은 표준키의 메타 줄을 전부 수집 — 과거 버그(H1 오판)로 중복 삽입된 원고도 자가 정리
  const foundAll = []; // [{i, arrow}]
  for (let i = 0; i < bodyStart; i++) {
    const m = lines[i].trim().match(/^(>\s*)?([^:：#>\-*\s][^:：]{0,11})\s*[:：]/);
    if (!m) continue;
    const probe = parseBookText(`# t\n> ${m[2].trim()}: probe`, 't');
    if (probe.meta[key] === 'probe') foundAll.push({ i, arrow: !!m[1] });
  }
  // 파서는 '마지막 값 승리'이므로 마지막 줄을 갱신하고 나머지(중복)는 제거
  const last = foundAll.length ? foundAll[foundAll.length - 1] : null;
  const found = last ? last.i : -1;
  const hadArrow = last ? last.arrow : false;
  // 파일의 메타 줄 스타일(평문/>)을 따라 기록 — 필수파일은 평문 유지
  const style = (arrow) => (arrow ? `> ${label}: ${value}` : `${label}: ${value}`);
  if (value === '' && found >= 0) { for (const f of foundAll.slice().reverse()) lines.splice(f.i, 1); }
  else if (found >= 0) {
    lines[found] = style(hadArrow);
    for (const f of foundAll.slice(0, -1).reverse()) lines.splice(f.i, 1); // 중복 줄 정리
  }
  else if (value !== '') {
    // 마지막 메타 줄(또는 H1) 다음에 삽입 — 스타일은 기존 메타 줄과 통일
    let at = 0; let anyArrow = !isMultiBook();
    for (let i = 0; i < bodyStart; i++) {
      const t = lines[i].trim();
      if (/^#\s+/.test(t)) at = i + 1;
      else if (/^(>\s*)?[^:：#>\-*\s][^:：]{0,11}\s*[:：]/.test(t)) { at = i + 1; anyArrow = t.startsWith('>'); }
    }
    lines.splice(at, 0, style(anyArrow));
  } else return currentDTO();
  writeFileLines(target, lines);
  return rebuildBook();
});

// 미리보기 클릭-편집용 원본 조회 — 결합 라인 → 해당 원본 파일의 실제 줄 텍스트.
ipcMain.handle('book-get-lines', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') return null;
  const start = Number(args.lineStart), end = Number(args.lineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  const src = bookResolveLine(start);
  const lines = readFileLines(src.path);
  const endSrc = bookResolveLine(end);
  const localEnd = Math.min(endSrc.path === src.path ? endSrc.line : src.line + (end - start), lines.length - 1);
  if (src.line >= lines.length) return null;
  return { text: lines.slice(src.line, localEnd + 1).join('\n'), file: path.basename(src.path) };
});

// 미리보기 클릭-편집 — 결합 라인을 원본 파일·라인으로 역매핑해 그 파일만 수정.
ipcMain.handle('book-apply-edit', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book' || !S.scriptPath) return currentDTO();
  const start = Number(args.lineStart), end = Number(args.lineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return currentDTO();
  const src = bookResolveLine(start);
  const lines = readFileLines(src.path);
  if (src.line >= lines.length) return currentDTO();
  const endSrc = bookResolveLine(end);
  const localEnd = Math.min(endSrc.path === src.path ? endSrc.line : src.line + (end - start), lines.length - 1);
  const newLines = String(args.text == null ? '' : args.text).replace(/\r\n/g, '\n').split('\n');
  lines.splice(src.line, localEnd - src.line + 1, ...newLines);
  writeFileLines(src.path, lines);
  log(`✏ 본문 수정 — ${path.basename(src.path)} ${src.line + 1}~${localEnd + 1}행 → ${newLines.length}행`);
  return rebuildBook();
});

// ePub(전자책) 생성 — 같은 원고로 POD PDF 와 병행 산출.
ipcMain.handle('book-build-epub', async (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') { log('열린 출판 원고가 없습니다.'); return { dto: currentDTO() }; }
  try {
    const { buildEpub } = require('./core/book/epub-builder');
    const { metaPlatformId } = require('./core/book/html-builder');
    const SC = require('./core/book/spine-calc');
    const PP = require('./core/book/platform-presets');
    const meta = S.parsed.meta || {};
    const outRoot = S.outRoot || bookOutRoot('book.md', S.preset);
    const base = _safeFolder(meta.title || S.parsed.fileTitle || '책');
    // 전자책 표지 크롭용 스프레드 정보 (인쇄 표지가 첨부돼 있을 때)
    const platformId = metaPlatformId(meta);
    const pf = PP.getPlatform(platformId);
    const trimId = meta.trim && PP.TRIM_SIZES[meta.trim] ? meta.trim : pf.defaultTrim;
    const paperId = meta.paper && PP.PAPERS[meta.paper] ? meta.paper : pf.defaultPaper;
    const flaps = !!(meta.flaps && !/^(없음|no|off|false|x)$/i.test(String(meta.flaps).trim()));
    const spread = SC.coverSpread({ platformId, trimId, paperId, totalPages: S.parsed._lastPages || 0, flaps });
    // 쪽수 미확정(책등 0mm)이면 인쇄 표지 크롭 위치가 어긋남 → 표지 크롭 생략(전자책표지 메타가 있으면 그걸 사용).
    const pagesKnown = (S.parsed._lastPages || 0) > 0;
    if (!pagesKnown && S.parsed.coverImagePath) log('ℹ 쪽수 미확정 — 인쇄 표지에서 앞표지 자동 크롭을 건너뜁니다(미리보기/PDF 후 다시 만들면 포함). `> 전자책표지:` 메타가 있으면 그걸 사용합니다.');
    const r = await buildEpub(S.parsed, {
      outPath: path.join(outRoot, `${base}.epub`),
      baseDir: S.scriptPath ? path.dirname(S.scriptPath) : outRoot,
      coverImagePath: pagesKnown ? (S.parsed.coverImagePath || null) : null,
      spread, log,
    });
    if (r.success) { try { shell.openPath(outRoot); } catch {} }
    return { dto: currentDTO(), epubPath: r.epubPath };
  } catch (e) {
    log('✗ ePub 오류: ' + e.message);
    return { dto: currentDTO(), error: e.message };
  }
});

// ISBN 바코드(EAN-13 + 부가기호) 생성 — SVG 를 출력폴더에 저장 + 렌더러(PNG 변환용)에 반환.
ipcMain.handle('book-export-barcode', (_e) => {
  if (!S.parsed || S.parsed.kind !== 'book') return { error: '출판 원고가 없습니다' };
  const meta = S.parsed.meta || {};
  if (!meta.isbn) return { error: 'ISBN 이 없습니다 — 책 정보에서 ISBN 을 입력하세요.' };
  const { isbnBarcodeSvg } = require('./core/book/isbn-barcode');
  const r = isbnBarcodeSvg(meta.isbn, meta.isbnAddon || '', { height: 200, quiet: 11 }); // 표지 자동조판과 동일 규격(GS1)
  if (!r) return { error: 'ISBN 형식 오류(체크 자릿수 불일치): ' + meta.isbn };
  const outRoot = S.outRoot || bookOutRoot('book.md', S.preset);
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  const svgPath = path.join(outRoot, `ISBN바코드_${r.isbn13}.svg`);
  try { fs.writeFileSync(svgPath, r.svg, 'utf8'); } catch (e) { return { error: '저장 실패: ' + e.message }; }
  log(`🏷 ISBN 바코드 생성 — ${r.isbn13}${meta.isbnAddon ? ' + 부가기호 ' + meta.isbnAddon : ''} → ${path.basename(svgPath)} (표지 뒷면 오른쪽 하단에 배치)`);
  return { svg: r.svg, svgPath, isbn13: r.isbn13, widthPx: r.widthPx, heightPx: r.heightPx };
});

// 렌더러가 만든 이미지(dataURL — 표지 가이드 PNG·바코드 PNG)를 출력폴더에 저장.
ipcMain.handle('book-save-asset', (_e, args = {}) => {
  if (!S.parsed || S.parsed.kind !== 'book') return { error: '출판 원고가 없습니다' };
  const name = _safeFolder(String(args.name || 'asset.png'));
  const m = String(args.dataUrl || '').match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return { error: '잘못된 데이터' };
  const outRoot = S.outRoot || bookOutRoot('book.md', S.preset);
  try {
    fs.mkdirSync(outRoot, { recursive: true });
    const p = path.join(outRoot, name);
    fs.writeFileSync(p, Buffer.from(m[1], 'base64'));
    log(`💾 저장: ${name} → ${outRoot}`);
    return { path: p };
  } catch (e) { return { error: '저장 실패: ' + e.message }; }
});

// 대본 수정 — 편집한 텍스트로 재파싱(+원본 .md 갱신). 출판 다중 파일이면 결합본(읽기 전용 배너 포함).
ipcMain.handle('get-script-text', () => {
  if (S.parsed && S.parsed.kind === 'book') return bookScriptText();
  try { return fs.readFileSync(S.scriptPath, 'utf8'); } catch { return ''; }
});
ipcMain.handle('apply-script-text', (_e, args = {}) => {
  const text = String((args && args.text) || '');
  if (!text.trim()) { log('대본 내용이 비어 있습니다'); return S.parsed ? currentDTO() : null; }
  if (S.mode === 'book' || (S.parsed && S.parsed.kind === 'book')) return applyBookText(text); // 출판 — book-parser 로
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
  const splitMode = (args.splitMode === 'sentence' || args.splitMode === 'h2') ? args.splitMode : 'h3';
  const th = { introSentenceSize: args.intro, mainSentenceSize: args.main, shortLen: args.short, longLen: args.long, splitMode };
  S.parsed = P.parseScript(S.scriptPath, 'longform', th);
  storeActive();
  const g = S.parsed.projects[0] ? S.parsed.projects[0].groups.length : 0;
  const smLabel = splitMode === 'h3' ? 'H3 섹션' : splitMode === 'h2' ? 'H2 섹션' : '문장';
  log(`🔁 롱폼 재분할(${smLabel}): 도입부 ${args.intro} · 본론 ${args.main} · 짧은 ${args.short} · 긴 ${args.long} → 그룹 ${g}개`);
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

// Supertonic 음성 미리듣기 — 사전 정의 음성은 파일이 없으므로 백엔드로 짧은 샘플을 즉석 합성해 반환.
ipcMain.handle('preview-supertonic', async (_e, args = {}) => {
  try {
    const { getProvider } = require('./tts/tts-config');
    const cfg = getProvider('supertonic') || {};
    const baseUrl = (cfg.baseUrl || 'http://127.0.0.1:9882').replace(/\/$/, '');
    const { SupertonicProvider } = require('./tts/providers/supertonic-provider');
    const p = new SupertonicProvider({ baseUrl, timeout: 30000 });
    if (!(await p.init())) return { error: `Supertonic 백엔드 미기동 (${baseUrl})` };
    const lang = (args.language === 'en') ? 'en' : 'ko';
    const sample = lang === 'en'
      ? 'Hello. This is a preview of this voice.'
      : '안녕하세요. 이 목소리로 영상을 만들어 드립니다.';
    const r = await p.synthesize(sample, { voice: args.voice || 'M1', language: lang, speed: 1.0, silenceDuration: 0.2 });
    return { dataUrl: `data:audio/wav;base64,${Buffer.from(r.mp3Buffer).toString('base64')}` };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('open-folder', async () => {
  if (!S.outRoot) return;
  fs.mkdirSync(S.outRoot, { recursive: true });
  shell.openPath(S.outRoot);
});
