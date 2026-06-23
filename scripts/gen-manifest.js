'use strict';

/**
 * gen-manifest.js — light-updater 용 update-manifest.json 생성.
 *   앱 런타임 파일(JS/JSON/HTML/CSS/dist/아이콘 등)의 sha1 목록 + 버전 + deps 해시.
 *   node_modules·소스·산출물·대용량 정적자산은 제외 (light-updater.js 의 제외 정책과 일치).
 *
 * 사용: vite build 후 `node scripts/gen-manifest.js` (= npm run update:publish).
 *   생성된 update-manifest.json + 변경 파일들을 git commit + push 하면 클라이언트가 변경분만 받음.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'update-manifest.json');

// 폴더 단위 제외 (이름 일치) — 주의: 'dist' 는 여기 넣지 않는다(renderer/dist 는 포함해야 함).
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'output', 'test', 'lora-dataset', 'scripts']);
// 상대경로(슬래시) 정규식 제외 — 대용량/정적/소스 + 루트 설치산출물 dist/
const EXCLUDE_REL = [
  /^dist\//,            // electron-builder 설치파일 산출물 (renderer/dist 는 제외 안 됨)
  /^renderer\/src\//,
  /^tts\/omnivoice-backend\//,
  /^assets\/fonts\//,
];
// 파일명/경로 제외 (_ 로 시작하는 스크래치/노트 파일 전부 제외)
const EXCLUDE_FILE = [/\.map$/, /^_/, /\.vrew$/, /\.debug\.json$/, /^\./, /^update-manifest\.json$/];

// 바이너리 확장자 (.gitattributes 의 binary 선언과 일치) — EOL 정규화 안 함, 원본 바이트로 해시.
const BINARY_EXT = new Set(['.vbin', '.bin', '.mp3', '.wav', '.ttf', '.otf', '.ico', '.png', '.jpg', '.jpeg']);

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

// 텍스트 파일은 CRLF→LF 정규화 후 해시 — git(eol=lf)·raw.githubusercontent 가 LF 로 서빙하므로 일치 보장.
function normalizeLF(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; // CRLF 의 CR 제거
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}
function hashFile(abs, name) {
  const buf = fs.readFileSync(abs);
  const ext = path.extname(name).toLowerCase();
  return sha1(BINARY_EXT.has(ext) ? buf : normalizeLF(buf));
}

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(name)) continue;
      if (EXCLUDE_REL.some((re) => re.test(r + '/'))) continue;
      walk(abs, r, out);
    } else {
      if (EXCLUDE_REL.some((re) => re.test(r))) continue;
      if (EXCLUDE_FILE.some((re) => re.test(name) || re.test(r))) continue;
      out[r] = hashFile(abs, name);
    }
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = {};
walk(ROOT, '', files);
const depsHash = sha1(Buffer.from(JSON.stringify(pkg.dependencies || {})));
const manifest = { version: pkg.version, deps: depsHash, files };
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
console.log(`update-manifest.json 생성: v${pkg.version} · ${Object.keys(files).length}개 파일 · deps ${depsHash.slice(0, 8)}`);
