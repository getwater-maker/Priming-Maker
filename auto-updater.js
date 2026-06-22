'use strict';

/**
 * 자동 업데이트 — electron-updater + GitHub Releases (PrimingFlow 방식 동일)
 *
 * 흐름:
 *   1. 앱 실행 후 5초 뒤 GitHub Releases 의 latest.yml 체크
 *   2. 새 버전 있으면 사용자에게 [지금 업데이트 / 나중에] 다이얼로그
 *   3. 다운로드 진행 중엔 mainWindow 에 진행률 IPC 전송
 *   4. 다운로드 완료 후 [지금 재시작 / 나중에] 다이얼로그
 *   5. 나중에 선택해도 종료 시 자동 적용 (autoInstallOnAppQuit=true)
 *
 * dev 환경(`electron .`) 에선 skip — 빌드된 패키지에서만 동작.
 *
 * 빌드 + 배포는 package.json 의 build.publish 설정에 따라
 *   `npx electron-builder --win nsis --x64 --publish always`
 * 명령으로 GitHub Releases 에 자동 업로드됨 (GH_TOKEN 필요).
 */

const { app, dialog, BrowserWindow } = require('electron');

function _log(msg) {
  try { process.stdout.write(`[auto-updater] ${msg}\n`); } catch (_) {}
}
function _err(msg) {
  try { process.stderr.write(`[auto-updater] ${msg}\n`); } catch (_) {}
}

function setupAutoUpdater() {
  // dev 환경(npm start) 에선 자동 업데이트 동작 안 함 — packaged 빌드 전용
  if (!app.isPackaged) {
    _log('dev mode — auto-update skipped');
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    _err(`electron-updater require 실패: ${e.message}`);
    return;
  }

  // public repo — 토큰 인증 불필요

  // 사용자에게 묻고 다운로드 — 자동 다운로드 끔
  autoUpdater.autoDownload = false;
  // 사용자가 "나중에" 선택해도 앱 종료 시점에 적용
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    _err(`error: ${err && err.message}`);
  });

  autoUpdater.on('checking-for-update', () => {
    _log('업데이트 확인 중...');
  });

  autoUpdater.on('update-not-available', () => {
    _log(`최신 버전입니다 (현재 ${app.getVersion()})`);
  });

  autoUpdater.on('update-available', async (info) => {
    _log(`업데이트 발견: ${info.version} (현재 ${app.getVersion()})`);
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '새 버전 사용 가능',
      message: `Priming ${info.version} 출시`,
      detail:
        `현재 버전: ${app.getVersion()}\n새 버전: ${info.version}\n\n` +
        `[지금 업데이트] 다운로드 후 자동 재시작합니다.\n` +
        `[나중에] 다음 실행 시 다시 묻습니다.`,
    });
    if (result.response === 0) {
      _log('사용자 승인 → 다운로드 시작');
      autoUpdater.downloadUpdate().catch((err) => {
        _err(`download 실패: ${err && err.message}`);
        dialog.showMessageBox(win, {
          type: 'error',
          title: '업데이트 다운로드 실패',
          message: '업데이트 다운로드 중 오류',
          detail: err && err.message,
        });
      });
    } else {
      _log('사용자 보류');
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = (progress.percent || 0).toFixed(1);
    const mbps = ((progress.bytesPerSecond || 0) / 1024 / 1024).toFixed(2);
    _log(`다운로드 ${pct}%  (${mbps} MB/s)`);
    // renderer 에 진행률 전송 (UI 가 받아서 표시 가능 — 선택)
    const win = BrowserWindow.getAllWindows()[0];
    if (win && win.webContents) {
      try { win.webContents.send('updater:progress', progress); } catch (_) {}
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    _log(`다운로드 완료: ${info.version}`);
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['지금 재시작', '나중에 (앱 종료 시 자동 적용)'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 다운로드 완료',
      message: `${info.version} 설치 준비 완료`,
      detail: '재시작하면 새 버전으로 실행됩니다.',
    });
    if (result.response === 0) {
      _log('사용자 승인 → 즉시 재시작');
      autoUpdater.quitAndInstall();
    } else {
      _log('보류 — 종료 시 자동 적용 예정');
    }
  });

  // 앱 ready 후 5초 뒤 첫 체크 (앱 실행 부담 회피 + mainWindow 생성 대기)
  app.whenReady().then(() => {
    setTimeout(() => {
      _log(`체크 시작 (현재 버전 ${app.getVersion()})`);
      autoUpdater.checkForUpdates().catch((err) => {
        _err(`check 실패 (네트워크/서버 문제일 수 있음 — 무시): ${err && err.message}`);
      });
    }, 5000);
  });
}

module.exports = { setupAutoUpdater };
