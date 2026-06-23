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

// 라이트 자동 업데이트 — main.js 를 로드하기 "전에" 변경된 파일만 받아 교체.
//   → 이번 실행이 곧바로 최신 코드로 동작 (팝업·NSIS 인스톨·재시작 단계 없음).
//   오프라인/실패면 조용히 현재 버전으로 진행. dev(npm start)에선 자동 건너뜀.
(async () => {
  try {
    await require('./light-updater').applyUpdates();
  } catch (err) {
    process.stderr.write(`[updater] setup failed: ${err && err.stack ? err.stack : err}\n`);
  }
  require('./main.js');
})();
