'use strict';

/**
 * epub-builder.js — BookModel → ePub 3.0 (전자책). adm-zip 재사용(신규 의존성 없음).
 *
 * 구성: mimetype(무압축·첫 엔트리) + META-INF/container.xml + OEBPS/(content.opf ·
 *   nav.xhtml · style.css · titlepage · 부속물 · 장별 xhtml · 판권).
 * 각주는 epub:type="noteref/footnote" (지원 리더에서 팝업, 그 외 장 끝 미주).
 * 전자책 표지: meta.ebookCover(전자책표지) 지정 시 그 이미지, 없으면 인쇄 표지
 *   스프레드에서 앞표지 영역을 ffmpeg 로 자동 크롭.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { esc, inlineMd } = require('./html-builder');

// ── 미니 ZIP 라이터 ──
// adm-zip 은 writeZip 때 엔트리를 이름순 정렬해 ePub 규격(mimetype=첫 엔트리·무압축)을
// 못 지킨다 → 로컬헤더+센트럴디렉터리를 직접 조립(추가 순서 보존, mimetype 만 STORED).
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
class MiniZip {
  constructor() { this.items = []; }
  // store=true → 무압축(STORED). 그 외 DEFLATE.
  add(name, data, store = false) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const comp = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    this.items.push({ name: Buffer.from(name, 'utf8'), raw, comp, method: store ? 0 : 8, crc: crc32(raw) });
  }
  toBuffer() {
    const parts = []; const central = [];
    let offset = 0;
    for (const it of this.items) {
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 플래그
      lh.writeUInt16LE(it.method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // 시간/날짜 고정
      lh.writeUInt32LE(it.crc, 14); lh.writeUInt32LE(it.comp.length, 18); lh.writeUInt32LE(it.raw.length, 22);
      lh.writeUInt16LE(it.name.length, 26); lh.writeUInt16LE(0, 28);
      parts.push(lh, it.name, it.comp);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(it.method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
      cd.writeUInt32LE(it.crc, 16); cd.writeUInt32LE(it.comp.length, 20); cd.writeUInt32LE(it.raw.length, 24);
      cd.writeUInt16LE(it.name.length, 28);
      cd.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cd, it.name]));
      offset += 30 + it.name.length + it.comp.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.items.length, 8); eocd.writeUInt16LE(this.items.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cdBuf, eocd]);
  }
}

function wrapXhtml(title, body, cssHref = 'style.css') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="${cssHref}"/></head>
<body>
${body}
</body>
</html>`;
}

const EPUB_CSS = `
body { font-family: serif; line-height: 1.7; word-break: keep-all; margin: 0 4%; }
p { margin: 0; text-indent: 1em; }
p.noindent, p.chapter-lead { text-indent: 0; }
p.chapter-lead { font-style: italic; color: #444; margin: 0 0 2em; }
h1.chapter-title { font-size: 1.4em; line-height: 1.5; margin: 2.5em 0 2em; }
h2.sec { font-size: 1.1em; margin: 2em 0 0.8em; }
h3.sec { font-size: 1em; margin: 1.6em 0 0.6em; }
blockquote { margin: 1.2em 1.4em; white-space: pre-line; font-size: 0.95em; }
div.verse { margin: 1.4em auto; text-align: center; white-space: pre-wrap; line-height: 2; }
figure { margin: 1.5em 0; text-align: center; }
figure img { max-width: 100%; }
figcaption { font-size: 0.85em; color: #555; margin-top: 0.5em; }
hr.scene { border: none; text-align: center; margin: 1.6em 0; }
hr.scene:after { content: "✻"; color: #777; }
section.front h1, section.back h1 { font-size: 1.25em; text-align: center; margin: 3em 0 2.5em; }
section.dedication, section.epigraph { text-align: center; }
section.dedication p, section.epigraph p { text-indent: 0; margin-top: 30%; }
.titlepage { text-align: center; }
.titlepage .t { font-size: 1.7em; font-weight: bold; margin-top: 30%; }
.titlepage .s { color: #555; margin-top: 1em; }
.titlepage .a { margin-top: 3em; }
.titlepage .pub { margin-top: 4em; color: #666; }
aside.fn { font-size: 0.88em; color: #333; margin: 1.5em 0 0; padding-top: 0.6em; border-top: 1px solid #ccc; }
.colophon p { text-indent: 0; margin: 0.25em 0; font-size: 0.9em; }
`;

// 블록 → xhtml (ePub 전용 — 각주는 noteref + 장 끝 aside)
function blocksXhtml(blocks, book, ctx) {
  const out = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case 'p': out.push(`<p>${inline(b.text, book, ctx)}</p>`); break;
      case 'lead': out.push(`<p class="chapter-lead">${inline(b.text, book, ctx)}</p>`); break;
      case 'h3': out.push(`<h2 class="sec">${inline(b.text, book, ctx)}</h2>`); break;
      case 'h4': out.push(`<h3 class="sec">${inline(b.text, book, ctx)}</h3>`); break;
      case 'quote': out.push(`<blockquote>${inline(b.text, book, ctx)}</blockquote>`); break;
      case 'verse': out.push(`<div class="verse">${(b.lines || []).map(esc).join('\n')}</div>`); break;
      case 'image': {
        const img = ctx.addImage(b.src);
        if (img) out.push(`<figure><img src="${img}" alt="${esc(b.caption || '')}"/>${b.caption ? `<figcaption>${inlineMd(b.caption)}</figcaption>` : ''}</figure>`);
        break;
      }
      case 'hr': out.push('<hr class="scene"/>'); break;
      default: break;
    }
  }
  // 이 문서에서 나온 각주들 — 장/섹션 끝에 aside(epub:type footnote)
  if (ctx.notes.length) {
    out.push(ctx.notes.map((n) => `<aside epub:type="footnote" class="fn" id="${n.id}"><p>${n.num}) ${inlineMd(n.text)}</p></aside>`).join('\n'));
    ctx.notes = [];
  }
  return out.join('\n');
}
function inline(text, book, ctx) {
  const parts = String(text || '').split(/(\[\^[^\]]+\])/);
  let out = '';
  for (const p of parts) {
    const m = p.match(/^\[\^([^\]]+)\]$/);
    if (!m) { out += inlineMd(p); continue; }
    const def = book.footnotes[m[1]];
    if (!def) { out += inlineMd(p); continue; }
    ctx.fnSeq++;
    const id = `fn-${ctx.fnSeq}`;
    ctx.notes.push({ id, num: ctx.fnSeq, text: def.text });
    out += `<sup><a epub:type="noteref" href="#${id}">${ctx.fnSeq}</a></sup>`;
  }
  return out;
}

// 인쇄 표지 스프레드에서 앞표지 영역 크롭 (ffmpeg) → jpg. 실패 시 null.
async function cropFrontCover(spreadImage, spread, outJpg) {
  try {
    const { readImageSize } = require('../../vrew/vrew-builder');
    const dim = readImageSize(spreadImage);   // {w,h} 반환 (width/height 아님)
    if (!dim || !dim.w) return null;
    const pxPerMm = dim.w / spread.widthMm;
    // 앞표지 x = bleed + [날개] + 뒤표지 + 책등, 폭 = 판형폭 (parts 에서 계산)
    let x = 0, w = 0;
    let acc = 0;
    for (const part of spread.parts) {
      if (part.name === '앞표지') { x = acc; w = part.mm; break; }
      acc += part.mm;
    }
    if (!w) return null;
    const cx = Math.round(x * pxPerMm), cw = Math.round(w * pxPerMm);
    const cy = Math.round(3 * pxPerMm), ch = Math.round((spread.heightMm - 6) * pxPerMm);
    const { getFfmpegPath } = require('../media-utils');
    const ff = getFfmpegPath();
    if (!ff) return null;
    const { execFileSync } = require('child_process');
    execFileSync(ff, ['-y', '-i', spreadImage, '-vf', `crop=${cw}:${ch}:${cx}:${cy}`, '-q:v', '3', outJpg], { windowsHide: true, stdio: 'ignore' });
    return fs.existsSync(outJpg) ? outJpg : null;
  } catch (_) { return null; }
}

/**
 * BookModel → .epub 파일.
 * @param {object} book  parseBookText/parseBookFiles 결과
 * @param {{ outPath, baseDir, spread?, coverImagePath?, log? }} a
 */
async function buildEpub(book, a) {
  const log = a.log || (() => {});
  const meta = book.meta || {};
  const zip = new MiniZip();
  zip.addFile = (name, data) => zip.add(name, data); // 기존 호출부 호환
  const manifest = [];
  const spine = [];
  const navItems = [];
  let imgSeq = 0;

  const ctx = {
    fnSeq: 0, notes: [],
    addImage(src) {
      try {
        const abs = path.isAbsolute(src) ? src : path.join(a.baseDir || '.', src);
        if (!fs.existsSync(abs)) return null;
        const ext = path.extname(abs).toLowerCase().replace('.', '') || 'png';
        const name = `img/${String(++imgSeq).padStart(2, '0')}.${ext}`;
        zip.addFile(`OEBPS/${name}`, fs.readFileSync(abs));
        manifest.push(`<item id="img${imgSeq}" href="${name}" media-type="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`);
        return name;
      } catch (_) { return null; }
    },
  };

  // 1) mimetype — 반드시 첫 엔트리 + 무압축(STORED)
  zip.add('mimetype', 'application/epub+zip', true);
  // 2) container
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`));
  zip.addFile('OEBPS/style.css', Buffer.from(EPUB_CSS));
  manifest.push('<item id="css" href="style.css" media-type="text/css"/>');

  const addDoc = (id, name, title, bodyHtml, opts = {}) => {
    zip.addFile(`OEBPS/${name}`, Buffer.from(wrapXhtml(title, bodyHtml)));
    manifest.push(`<item id="${id}" href="${name}" media-type="application/xhtml+xml"${opts.nav ? ' properties="nav"' : ''}/>`);
    if (!opts.skipSpine) spine.push(`<itemref idref="${id}"${opts.linear === false ? ' linear="no"' : ''}/>`);
    if (opts.toc) navItems.push({ href: name, title: opts.toc });
  };

  // 3) 표지 — 전자책표지(meta.ebookCover) > 인쇄 스프레드 앞표지 크롭
  let coverAdded = false;
  let coverSrc = meta.ebookCover && fs.existsSync(path.isAbsolute(meta.ebookCover) ? meta.ebookCover : path.join(a.baseDir || '.', meta.ebookCover))
    ? (path.isAbsolute(meta.ebookCover) ? meta.ebookCover : path.join(a.baseDir || '.', meta.ebookCover)) : null;
  if (!coverSrc && a.coverImagePath && a.spread && fs.existsSync(a.coverImagePath)) {
    const tmp = path.join(path.dirname(a.outPath), '_ebook-cover.jpg');
    coverSrc = await cropFrontCover(a.coverImagePath, a.spread, tmp);
    if (coverSrc) log('🖼 인쇄 표지에서 앞표지 자동 크롭 → 전자책 표지');
  }
  if (coverSrc) {
    const ext = path.extname(coverSrc).toLowerCase().replace('.', '') || 'jpg';
    zip.addFile(`OEBPS/cover.${ext}`, fs.readFileSync(coverSrc));
    manifest.push(`<item id="cover-img" href="cover.${ext}" media-type="image/${ext === 'jpg' ? 'jpeg' : ext}" properties="cover-image"/>`);
    addDoc('cover', 'cover.xhtml', '표지', `<div style="text-align:center"><img src="cover.${ext}" alt="표지" style="max-width:100%"/></div>`);
    coverAdded = true;
  }

  // 4) 표제지
  addDoc('titlepage', 'titlepage.xhtml', '표제지', `<div class="titlepage">
<p class="t">${esc(meta.title || book.fileTitle || '')}</p>
${meta.subtitle ? `<p class="s">${esc(meta.subtitle)}</p>` : ''}
<p class="a">${esc(meta.author || '')}</p>
${meta.translator ? `<p class="s">${esc(meta.translator)}</p>` : ''}
<p class="pub">${esc(meta.publisher || '')}</p>
</div>`);

  // 5) 앞부속 (목차 마커는 스킵 — ePub 은 nav 가 목차)
  for (const s of book.front) {
    if (s.key === 'toc') continue;
    addDoc(`front-${s.key}`, `front-${s.key}.xhtml`, s.title,
      `<section class="front ${s.key === 'dedication' ? 'dedication' : ''}" epub:type="frontmatter"><h1>${esc(s.title)}</h1>\n${blocksXhtml(s.blocks, book, ctx)}</section>`,
      { toc: s.title });
  }

  // 6) 본문 — 부/장
  for (const p of book.parts) {
    if (p.title) {
      addDoc(`part-${p.num || 'x'}`, `part-${p.num || 'x'}.xhtml`, p.title,
        `<section epub:type="part" style="text-align:center"><h1 style="margin-top:35%">${p.num ? `제${p.num}부 ` : ''}${esc(p.title)}</h1></section>`,
        { toc: `${p.num ? `제${p.num}부 ` : ''}${p.title}` });
    }
    for (const c of p.chapters) {
      addDoc(`ch-${c.num}`, `ch-${String(c.num).padStart(3, '0')}.xhtml`, c.title,
        `<section epub:type="chapter"><h1 class="chapter-title">${esc(c.title)}</h1>\n${blocksXhtml(c.blocks, book, ctx)}</section>`,
        { toc: c.title });
    }
  }

  // 7) 뒷부속 + 판권
  for (const s of book.back) {
    if (s.key === 'colophon') continue;
    addDoc(`back-${s.key}`, `back-${s.key}.xhtml`, s.title,
      `<section class="back" epub:type="backmatter"><h1>${esc(s.title)}</h1>\n${blocksXhtml(s.blocks, book, ctx)}</section>`, { toc: s.title });
  }
  const col = book.back.find((s) => s.key === 'colophon');
  const colBody = col && col.blocks && col.blocks.length
    ? blocksXhtml(col.blocks, book, ctx)
    : `<p>${esc(meta.title || '')}</p><p>지은이 ${esc(meta.author || '')}</p>${meta.translator ? `<p>옮긴이 ${esc(meta.translator)}</p>` : ''}<p>펴낸곳 ${esc(meta.publisher || '')}</p>${meta.isbn ? `<p>ISBN ${esc(meta.isbn)}</p>` : ''}${meta.ebookPrice ? `<p>정가(전자책) ${esc(meta.ebookPrice)}</p>` : ''}`;
  addDoc('colophon', 'colophon.xhtml', '판권', `<section class="colophon" epub:type="colophon"><h1 style="font-size:1.1em">판권</h1>\n${colBody}</section>`, { toc: '판권' });

  // 8) nav
  const navLis = navItems.map((n) => `<li><a href="${n.href}">${esc(n.title)}</a></li>`).join('\n');
  addDoc('nav', 'nav.xhtml', '목차', `<nav epub:type="toc" id="toc"><h1>목차</h1><ol>
${navLis}
</ol></nav>`, { nav: true, skipSpine: true });

  // 9) opf
  const uid = 'urn:isbn:' + (String(meta.isbn || '').replace(/[^0-9Xx]/g, '') || 'priming-' + Buffer.from(meta.title || 'book').toString('hex').slice(0, 12));
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.addFile('OEBPS/content.opf', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="ko">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${esc(uid)}</dc:identifier>
    <dc:title>${esc(meta.title || book.fileTitle || '책')}</dc:title>
    ${meta.subtitle ? `<dc:description>${esc(meta.subtitle)}</dc:description>` : ''}
    <dc:creator>${esc(meta.author || '')}</dc:creator>
    ${meta.translator ? `<dc:contributor>${esc(meta.translator)}</dc:contributor>` : ''}
    ${meta.publisher ? `<dc:publisher>${esc(meta.publisher)}</dc:publisher>` : ''}
    <dc:language>ko</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverAdded ? '<meta name="cover" content="cover-img"/>' : ''}
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine>
${spine.join('\n')}
  </spine>
</package>`));

  fs.mkdirSync(path.dirname(a.outPath), { recursive: true });
  fs.writeFileSync(a.outPath, zip.toBuffer());
  const chapters = book.parts.reduce((n, p) => n + p.chapters.length, 0);
  log(`📱 ePub 완료 — 장 ${chapters}개${coverAdded ? ' + 표지' : ''} · ${(fs.statSync(a.outPath).size / 1024 / 1024).toFixed(1)}MB → ${path.basename(a.outPath)}`);
  return { success: true, epubPath: a.outPath };
}

module.exports = { buildEpub };
