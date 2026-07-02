'use strict';

/**
 * pdf-builder.js — 조판 HTML → 내지.pdf / 표지 이미지 → 표지.pdf.
 *
 * Vivliostyle CLI(@vivliostyle/cli, ESM)를 자식 프로세스로 호출한다:
 *   - Electron 안에서는 ELECTRON_RUN_AS_NODE=1 + process.execPath 로 node 없이 실행.
 *   - 브라우저는 앱이 이미 가진 playwright chromium 을 --executable-browser 로 재사용.
 *   - --press-ready(PDF/X-1a)는 Ghostscript 필요 → 옵션(기본 off; 일반 PDF 로도 부크크·교보 입고 가능).
 *
 * 동봉 폰트(assets/fonts/book/*.ttf)가 있으면 @font-face 로 주입 — Chromium 이 PDF 에 서브셋 임베딩.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CLI_JS = path.join(__dirname, '..', '..', 'node_modules', '@vivliostyle', 'cli', 'dist', 'cli.js');
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts', 'book');

function chromiumPath() {
  try { return require('playwright').chromium.executablePath(); } catch (_) { return null; }
}

// 동봉 폰트 @font-face CSS. urlFor(absPath)→URL (기본 file:///).
//   ⚠ 정적(static) 웨이트만 사용 — 가변폰트(variable TTF)는 Chromium 이 PDF 에 Type3(패스)로
//   구워 인쇄 RIP 호환성이 떨어짐. 나눔명조/나눔고딕(OFL)은 CIDFontType2 로 정상 임베딩.
function bundledFontCss(urlFor) {
  const toUrl = urlFor || ((p) => 'file:///' + p.replace(/\\/g, '/'));
  const css = [];
  const face = (family, file, weight) => {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) css.push(`@font-face { font-family: '${family}'; src: url('${toUrl(p)}'); font-weight: ${weight}; }`);
  };
  try {
    face('NanumMyeongjo', 'NanumMyeongjo-Regular.ttf', 400);
    face('NanumMyeongjo', 'NanumMyeongjo-Bold.ttf', 700);
    face('NanumGothic', 'NanumGothic-Regular.ttf', 400);
    face('NanumGothic', 'NanumGothic-Bold.ttf', 700);
  } catch (_) {}
  return css.join('\n');
}

/**
 * 빌드 작업폴더 준비 — CLI 가 HTML 을 내부 HTTP 서버로 서빙하므로 file:/// 서브리소스는
 * 차단된다. 폰트·이미지를 workDir 로 복사하고 상대경로 URL 을 쓰게 한다.
 * @returns {{ fontCss:string, imageUrl:(abs:string)=>string }}
 */
function prepareWorkAssets(workDir) {
  fs.mkdirSync(path.join(workDir, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
  // 폰트 복사 + 상대 URL @font-face
  try {
    for (const f of fs.readdirSync(FONT_DIR)) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      const dst = path.join(workDir, 'fonts', f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(FONT_DIR, f), dst);
    }
  } catch (_) {}
  const fontCss = bundledFontCss((abs) => 'fonts/' + path.basename(abs));
  // 이미지 복사(중복 이름 회피) + 상대 URL
  let seq = 0;
  const seen = new Map();
  const imageUrl = (abs) => {
    if (seen.has(abs)) return seen.get(abs);
    let rel = 'assets/' + path.basename(abs);
    if (fs.existsSync(path.join(workDir, rel))) rel = `assets/${String(++seq).padStart(2, '0')}-${path.basename(abs)}`;
    try { fs.copyFileSync(abs, path.join(workDir, rel)); } catch (_) { return 'file:///' + abs.replace(/\\/g, '/'); }
    seen.set(abs, rel);
    return rel;
  };
  return { fontCss, imageUrl };
}

function runCli(args, log, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    const isElectron = !!process.versions.electron;
    const cmd = process.execPath;
    const fullArgs = [CLI_JS, ...args];
    const env = { ...process.env };
    if (isElectron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(cmd, fullArgs, { env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (log) for (const l of s.split('\n')) if (l.trim()) log(`  [vivliostyle] ${l.trim()}`); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// PDF 총 페이지수 — 비압축 오브젝트에서 못 찾으면 FlateDecode 스트림(ObjStm)을 해제해 탐색.
//   Chromium/Vivliostyle PDF 는 페이지 트리를 오브젝트 스트림에 압축해 넣는다.
function pdfPageCount(pdfPath) {
  try {
    const zlib = require('zlib');
    const buf = fs.readFileSync(pdfPath);
    const s = buf.toString('latin1');
    const countIn = (txt) => {
      const pages = (txt.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
      if (pages > 0) return pages;
      let max = 0; const re = /\/Count\s+(\d+)/g; let m;
      while ((m = re.exec(txt))) max = Math.max(max, parseInt(m[1], 10));
      return max || 0;
    };
    let n = countIn(s);
    if (n > 0) return n;
    // 압축 스트림 해제 — stream…endstream 청크를 inflate 시도(실패는 무시)
    let inflated = '';
    const re = /stream\r?\n/g; let m;
    while ((m = re.exec(s))) {
      const start = m.index + m[0].length;
      const end = s.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        inflated += zlib.inflateSync(buf.subarray(start, end)).toString('latin1');
      } catch (_) {}
    }
    n = countIn(inflated);
    return n || null;
  } catch (_) { return null; }
}

/**
 * 조판 HTML → 내지 PDF.
 * @param {{ html:string, outPdf:string, workDir:string, log?:fn, pressReady?:boolean, grayScale?:boolean, timeoutSec?:number }} a
 * @returns {Promise<{success:boolean, pdfPath?:string, pages?:number|null, error?:string}>}
 */
async function buildInteriorPdf(a) {
  const log = a.log || (() => {});
  try {
    if (!fs.existsSync(CLI_JS)) return { success: false, error: 'vivliostyle CLI 미설치 (node_modules/@vivliostyle/cli)' };
    fs.mkdirSync(a.workDir, { recursive: true });
    fs.mkdirSync(path.dirname(a.outPdf), { recursive: true });
    const htmlPath = path.join(a.workDir, 'book.html');
    fs.writeFileSync(htmlPath, a.html, 'utf8');

    const args = ['build', htmlPath, '-d', '-o', a.outPdf, '--log-level', 'info', '-t', String(a.timeoutSec || 600), '--no-vite-config-file'];
    const chrome = chromiumPath();
    if (chrome && fs.existsSync(chrome)) args.push('--executable-browser', chrome);
    if (a.pressReady) {
      args.push('--preflight', 'press-ready-local');
      if (a.grayScale) args.push('--preflight-option', 'gray-scale');
    }
    log(`📕 내지 PDF 조판 중… (Vivliostyle)`);
    const r = await runCli(args, log, (a.timeoutSec || 600) * 1000 + 60000);
    if (r.code !== 0 || !fs.existsSync(a.outPdf)) {
      return { success: false, error: `vivliostyle 실패 (code ${r.code}) ${lastLines(r.err || r.out)}` };
    }
    const pages = pdfPageCount(a.outPdf);
    log(`📕 내지 PDF 완료 — ${pages || '?'}쪽 · ${path.basename(a.outPdf)}`);
    return { success: true, pdfPath: a.outPdf, pages };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

/**
 * 표지 이미지 → 스프레드 치수 그대로의 표지 PDF (1쪽).
 * spread = spine-calc.coverSpread() 결과.
 */
async function buildCoverPdf({ imagePath, spread, outPdf, workDir, log, timeoutSec }) {
  const L = log || (() => {});
  try {
    if (!fs.existsSync(imagePath)) return { success: false, error: '표지 이미지가 없습니다: ' + imagePath };
    fs.mkdirSync(workDir, { recursive: true });
    // HTTP 서빙에서 file:/// 차단 → 이미지를 workDir 로 복사해 상대경로 참조
    const coverName = 'cover-image' + path.extname(imagePath);
    fs.copyFileSync(imagePath, path.join(workDir, coverName));
    const url = coverName;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${spread.widthMm}mm ${spread.heightMm}mm; margin: 0; }
html,body { margin:0; padding:0; }
img { display:block; width: ${spread.widthMm}mm; height: ${spread.heightMm}mm; object-fit: fill; }
</style></head><body><img src="${url.replace(/"/g, '&quot;')}" /></body></html>`;
    const htmlPath = path.join(workDir, 'cover.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const args = ['build', htmlPath, '-d', '-o', outPdf, '--log-level', 'info', '-t', String(timeoutSec || 180), '--no-vite-config-file'];
    const chrome = chromiumPath();
    if (chrome && fs.existsSync(chrome)) args.push('--executable-browser', chrome);
    L('🖼 표지 PDF 생성 중…');
    const r = await runCli(args, L, (timeoutSec || 180) * 1000 + 30000);
    if (r.code !== 0 || !fs.existsSync(outPdf)) return { success: false, error: `표지 PDF 실패 (code ${r.code}) ${lastLines(r.err || r.out)}` };
    L(`🖼 표지 PDF 완료 — ${spread.widthMm}×${spread.heightMm}mm (책등 ${spread.spineMm}mm)`);
    return { success: true, pdfPath: outPdf };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

function lastLines(s, n = 4) {
  const lines = String(s || '').trim().split('\n').filter((l) => l.trim());
  return lines.slice(-n).join(' | ').slice(0, 400);
}

module.exports = { buildInteriorPdf, buildCoverPdf, bundledFontCss, prepareWorkAssets, pdfPageCount };
