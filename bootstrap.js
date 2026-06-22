/**
 * bootstrap.js — Electron 엔트리 (package.json main).
 * 캐시 디렉토리 분리 후 main.js 로딩.
 */
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 기존 앱(~/.flow-app, ~/.shots-maker)과 캐시/세션 충돌 방지 — 통합 앱 전용 디렉토리
try {
  const dataDir = path.join(os.homedir(), '.priming-maker');
  app.setPath('userData', path.join(dataDir, 'electron'));
  // 디스크/GPU 캐시 경로 고정 — "Unable to move the cache" 권한 경고 회피.
  app.commandLine.appendSwitch('disk-cache-dir', path.join(dataDir, 'electron', 'cache'));
} catch (_) {}

require('./main.js');

// 자동 업데이트 체크 등록 (패키징된 앱에서만 동작 — main.js 의 app.whenReady 처리 후 5초 뒤)
try {
  require('./auto-updater').setupAutoUpdater();
} catch (err) {
  process.stderr.write(`[auto-updater] setup failed: ${err && err.stack ? err.stack : err}\n`);
}
