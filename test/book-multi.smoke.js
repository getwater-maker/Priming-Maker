'use strict';
// node test/book-multi.smoke.js — 다중 파일 원고(삼국지 필수파일+15회차) → 내지 PDF + ePub 스모크.
//   원고가 D:/PrimingBook 에 없으면 스킵(다른 PC 대응).
const fs = require('fs');
const path = require('path');
const { parseBookFiles } = require('../core/parsers/book-parser');
const { buildBookHtml } = require('../core/book/html-builder');
const { buildInteriorPdf, prepareWorkAssets } = require('../core/book/pdf-builder');
const { buildEpub } = require('../core/book/epub-builder');
const { coverSpread } = require('../core/book/spine-calc');

const DATA = 'D:/PrimingBook/book-publishing/data';
const OUT = path.join(__dirname, '..', 'output', '_book-multi');

(async () => {
  if (!fs.existsSync(path.join(DATA, '삼국지연의_1권_필수파일.md'))) {
    console.log('⏭ 삼국지 원고 없음 — 스킵'); return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  const paths = [path.join(DATA, '삼국지연의_1권_필수파일.md')];
  for (let i = 1; i <= 15; i++) paths.push(path.join(DATA, `출판_삼국지_제${String(i).padStart(3, '0')}회.md`));
  const files = paths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const book = parseBookFiles(files, '삼국지');
  const chs = book.parts.flatMap((p) => p.chapters);
  console.log(`· 파싱: "${book.fileTitle}" — 장 ${chs.length}개 · front ${book.front.length} · back ${book.back.length}`);
  if (chs.length !== 15) { console.error('❌ 장 수 불일치'); process.exit(1); }

  // 내지 PDF (판형 메타 없음 → 기본 A5)
  const work = prepareWorkAssets(path.join(OUT, 'work'));
  const { html } = buildBookHtml(book, { fontCss: work.fontCss, imageUrl: work.imageUrl, baseDir: DATA, sourceMap: true });
  fs.writeFileSync(path.join(OUT, 'book.html'), html, 'utf8');
  // 판권 자유문·리드문 마크업 확인
  if (!html.includes('cp-free')) { console.error('❌ 판권 자유문 미적용'); process.exit(1); }
  if (!html.includes('chapter-lead')) { console.error('❌ 장 리드문 미적용'); process.exit(1); }
  console.log('· HTML: 판권 자유문 + 장 리드문 마크업 OK');

  const r = await buildInteriorPdf({ html, outPdf: path.join(OUT, '내지.pdf'), workDir: path.join(OUT, 'work'), log: (m) => console.log(m) });
  if (!r.success) { console.error('❌ 내지 실패:', r.error); process.exit(1); }
  console.log(`· 내지 PDF: ${r.pages}쪽`);

  // ePub
  const spread = coverSpread({ platformId: 'bookk', trimId: 'A5', totalPages: r.pages || 300, flaps: false });
  const re = await buildEpub(book, { outPath: path.join(OUT, `${book.fileTitle}.epub`), baseDir: DATA, spread, log: (m) => console.log(m) });
  if (!re.success) { console.error('❌ ePub 실패'); process.exit(1); }
  // ePub 구조 검증 — mimetype 첫 엔트리·무압축, opf·nav 존재
  const AdmZip = require('adm-zip');
  const z = new AdmZip(re.epubPath);
  const entries = z.getEntries();
  const first = entries[0];
  if (first.entryName !== 'mimetype' || first.header.method !== 0) { console.error('❌ mimetype 규격 위반:', first.entryName, first.header.method); process.exit(1); }
  const names = entries.map((e) => e.entryName);
  for (const need of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/ch-001.xhtml', 'OEBPS/ch-015.xhtml', 'OEBPS/colophon.xhtml']) {
    if (!names.includes(need)) { console.error('❌ ePub 엔트리 누락:', need); process.exit(1); }
  }
  console.log(`· ePub 구조 OK — ${entries.length}개 엔트리, mimetype STORED`);
  console.log(`✅ book-multi.smoke — 삼국지 1권(15회) PDF ${r.pages}쪽 + ePub (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${OUT}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
