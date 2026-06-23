'use strict';

/**
 * light-updater.js — 설치판 재설치 없이 "변경된 파일만" 받아 교체하는 가벼운 자동 업데이트.
 *
 * 동작:
 *   1. GitHub(main 브랜치)의 update-manifest.json 을 받음 (파일별 sha1 목록 + 버전 + deps 해시)
 *   2. 설치폴더(app.getAppPath())의 각 파일 해시와 비교 → 다른 파일만 raw URL 로 내려받아 교체
 *   3. bootstrap.js 가 main.js 를 require 하기 "전에" 호출하므로, 이번 실행이 곧바로 최신 코드로 동작
 *      (팝업·NSIS 인스톨·재시작 단계 없음)
 *
 * 한계: node_modules(의존성)는 파일 교체로 못 바꾼다. deps 해시가 다르면(=새 패키지 필요)
 *   파일 적용을 멈추고 "설치파일 재설치 필요" 안내만 띄운다. (그 외 JS/렌더러 변경은 전부 이 방식으로 처리)
 *
 * 발행: 코드 변경 후 `npm run update:publish` (vite build + 매니페스트 생성) → git commit + push.
 *   (raw.githubusercontent.com 은 public repo 라 토큰 불필요. CDN 캐시 ~5분.)
 *
 * dev(`npm start`, app.isPackaged=false)에선 동작 안 함.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog } = require('electron');

const REPO = 'getwater-maker/Priming-Maker';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

function log(m) { try { process.stdout.write(`[updater] ${m}\n`); } catch (_) {} }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

// 텍스트는 CRLF→LF 정규화 후 해시 (gen-manifest 와 동일 규칙) — 설치파일이 CRLF 로 패키징돼도
//   매니페스트(LF) 와 일치해 불필요한 재다운로드 방지. 바이너리는 원본 바이트.
const BINARY_EXT = new Set(['.vbin', '.bin', '.mp3', '.wav', '.ttf', '.otf', '.ico', '.png', '.jpg', '.jpeg']);
function normalizeLF(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) { if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; out[j++] = buf[i]; }
  return out.subarray(0, j);
}
function hashLocal(absPath, rel) {
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(rel).toLowerCase();
  return sha1(BINARY_EXT.has(ext) ? buf : normalizeLF(buf));
}

async function fetchWithTimeout(url, ms, asText) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return asText ? await r.text() : Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

/**
 * 변경 파일을 받아 설치폴더에 교체. main.js require 전에 await 로 호출.
 * 네트워크 실패/오프라인이면 조용히 현재 버전으로 진행.
 */
async function applyUpdates({ manifestTimeoutMs = 4000, fileTimeoutMs = 8000 } = {}) {
  if (!app.isPackaged) { log('dev 모드 — 업데이트 건너뜀'); return; }
  const appDir = app.getAppPath(); // asar:false → resources/app

  let manifest;
  try {
    const txt = await fetchWithTimeout(RAW_BASE + 'update-manifest.json?t=' + Date.now(), manifestTimeoutMs, true);
    manifest = JSON.parse(txt);
  } catch (e) { log(`매니페스트 조회 실패(오프라인일 수 있음) — 현재 버전으로 실행: ${e.message}`); return; }
  if (!manifest || !manifest.files || typeof manifest.files !== 'object') { log('매니페스트 형식 오류 — 건너뜀'); return; }

  // 로컬 package.json (버전·deps 비교용) — 루프에서 덮어쓰기 전에 미리 읽음
  let localPkg = {};
  try { localPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')); } catch (_) {}

  // 의존성(node_modules) 변경은 파일 교체로 불가 → 재설치 안내 후 현재 버전 유지
  const localDeps = sha1(Buffer.from(JSON.stringify(localPkg.dependencies || {})));
  if (manifest.deps && manifest.deps !== localDeps) {
    log(`의존성 변경 감지 — 전체 재설치 필요 (현재 ${localPkg.version} → ${manifest.version})`);
    app.whenReady().then(() => {
      try {
        dialog.showMessageBox({
          type: 'info', buttons: ['확인'], defaultId: 0,
          title: '업데이트 — 재설치 필요',
          message: `새 버전(${manifest.version})은 구성요소가 변경되어 설치파일 재설치가 필요합니다.`,
          detail: 'GitHub Releases 에서 최신 설치파일을 받아 설치해 주세요.\n(이번 실행은 현재 버전으로 계속됩니다.)',
        });
      } catch (_) {}
    });
    return;
  }

  // 변경된 파일만 다운로드 → 임시파일 기록 후 원자적 교체
  let updated = 0, failed = 0;
  for (const rel of Object.keys(manifest.files)) {
    const want = manifest.files[rel];
    const dest = path.join(appDir, rel.split('/').join(path.sep));
    let have = null;
    try { have = hashLocal(dest, rel); } catch (_) {}
    if (have === want) continue; // 동일 → 건너뜀
    try {
      const buf = await fetchWithTimeout(RAW_BASE + rel, fileTimeoutMs, false);
      if (sha1(buf) !== want) { log(`해시 불일치(다운로드 손상?) ${rel} — 건너뜀`); failed++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.tmp-update';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest); // 같은 볼륨 → 원자적 교체
      updated++;
    } catch (e) { log(`다운로드 실패 ${rel}: ${e.message}`); failed++; }
  }

  // 오래된 렌더러 에셋(이전 빌드 해시 파일) 정리 — manifest 에 없는 dist/assets 파일 삭제
  try {
    const assetsDir = path.join(appDir, 'renderer', 'dist', 'assets');
    if (fs.existsSync(assetsDir)) {
      const keep = new Set(
        Object.keys(manifest.files)
          .filter((f) => f.startsWith('renderer/dist/assets/'))
          .map((f) => f.split('/').pop())
      );
      for (const f of fs.readdirSync(assetsDir)) {
        if (!keep.has(f)) { try { fs.unlinkSync(path.join(assetsDir, f)); } catch (_) {} }
      }
    }
  } catch (_) {}

  if (updated === 0 && failed === 0) { log(`최신 상태 (${localPkg.version || '?'})`); return; }
  if (updated === 0 && failed > 0) { log(`업데이트 실패 ${failed}건 — 현재 버전 유지`); return; }
  log(`✅ 업데이트 적용: ${updated}개 파일 (v${localPkg.version} → v${manifest.version}${failed ? `, 실패 ${failed}` : ''})`);
}

module.exports = { applyUpdates };
