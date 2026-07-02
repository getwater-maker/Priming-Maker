'use strict';

/**
 * html-builder.js — BookModel → 조판용 단일 HTML(+CSS).
 *
 * Vivliostyle 이 이 HTML 을 CSS Paged Media 로 조판한다:
 *   - @page :left/:right 미러 여백 + 러닝헤드(짝수쪽=책제목 / 홀수쪽=장제목 string-set)
 *   - 목차 쪽번호 target-counter · 각주 float:footnote(또는 미주 모음) · break-before:recto
 *   - 표제지·판권·백면(:blank)·장 시작 = 폴리오/러닝헤드 없음
 *
 * opts:
 *   trimId/platformId  판형·플랫폼 (meta 값이 우선)
 *   fontSizePt(10) lineHeight(1.8) marginsMm{top,bottom,inner,outer}
 *   chapterStart('recto'|'page')  footnoteMode('footnote'|'endnote')
 *   imageUrl(absPath)→URL  (PDF=file:// / 미리보기=media://)
 *   baseDir  상대 이미지 경로 기준(.md 위치)
 *   fontCss  @font-face 블록(선택 — 동봉 폰트)
 *   sourceMap(true)  data-src-line 속성 부여(클릭-편집용)
 */

const fs = require('fs');
const path = require('path');
const { getTrim, getPlatform } = require('./platform-presets');

const THEME_CSS_PATH = path.join(__dirname, 'book-theme.css');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 최소 인라인 마크다운: **굵게** *기울임* `코드` — HTML 이스케이프 후 적용.
function inlineMd(s) {
  let t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<span class="code">$1</span>');
  return t;
}

// 각주 참조 [^id] → 각주(float) 또는 미주(sup) 마크업.
function renderInline(text, book, ctx) {
  const parts = String(text || '').split(/(\[\^[^\]]+\])/);
  let out = '';
  for (const p of parts) {
    const m = p.match(/^\[\^([^\]]+)\]$/);
    if (!m) { out += inlineMd(p); continue; }
    const def = book.footnotes[m[1]];
    if (!def) { out += inlineMd(p); continue; }
    if (ctx.footnoteMode === 'endnote') {
      ctx.endnotes.push({ id: m[1], text: def.text });
      const n = ctx.endnotes.length;
      out += `<sup class="enref"><a id="enref-${n}" href="#en-${n}">${n}</a></sup>`;
    } else {
      out += `<span class="footnote">${inlineMd(def.text)}</span>`;
    }
  }
  return out;
}

function blockHtml(b, book, ctx, srcAttr) {
  const src = srcAttr(b);
  switch (b.type) {
    case 'p': return `<p${src}>${renderInline(b.text, book, ctx)}</p>`;
    case 'lead': return `<p class="chapter-lead noindent"${src}>${renderInline(b.text, book, ctx)}</p>`;
    case 'h3': return `<h3${src}>${renderInline(b.text, book, ctx)}</h3>`;
    case 'h4': return `<h4${src}>${renderInline(b.text, book, ctx)}</h4>`;
    case 'quote': return `<blockquote${src}>${renderInline(b.text, book, ctx)}</blockquote>`;
    case 'verse': return `<div class="verse"${src}>${b.lines.map((l) => esc(l)).join('\n')}</div>`;
    case 'image': {
      const url = ctx.resolveImage(b.src);
      const cap = b.caption ? `<figcaption>${inlineMd(b.caption)}</figcaption>` : '';
      return `<figure${src}><img src="${esc(url)}" alt="${esc(b.caption)}" />${cap}</figure>`;
    }
    case 'hr': return `<hr class="scene"${src} />`;
    default: return '';
  }
}

function blocksHtml(blocks, book, ctx, srcAttr) {
  return (blocks || []).map((b) => blockHtml(b, book, ctx, srcAttr)).join('\n');
}

// ── 자동 생성 페이지 ──
function halfTitleHtml(meta) {
  return `<section class="halftitle"><div class="ht-title">${esc(meta.title || '')}</div></section>`;
}
function titlePageHtml(meta, ctx) {
  const logo = meta.logo ? `<img class="tp-logo" src="${esc(ctx.resolveImage(meta.logo))}" alt="logo" />` : '';
  return `<section class="titlepage">
  <div class="tp-main">
    <h1 class="tp-title">${esc(meta.title || '')}</h1>
    ${meta.subtitle ? `<div class="tp-subtitle">${esc(meta.subtitle)}</div>` : ''}
    <div class="tp-author">${esc(meta.author || '')}${meta.author ? ' 지음' : ''}</div>
    ${meta.translator ? `<div class="tp-translator">${esc(meta.translator)} 옮김</div>` : ''}
  </div>
  <div class="tp-publisher">${logo}${esc(meta.publisher || '')}</div>
</section>`;
}
function colophonHtml(meta, ctx, isFront, section, book, srcAttr) {
  // [판권] 섹션에 자유 문구가 있으면(예: AI 활용 고지·편역 저작권 안내) 그걸 그대로 조판 —
  //   자동 테이블·고정 법정 문구는 생략(중복 방지). 없으면 메타로 자동 생성.
  if (section && section.blocks && section.blocks.length) {
    const qrIsImg2 = meta.qr && /\.(png|jpe?g|svg|webp)$/i.test(meta.qr);
    return `<section class="colophon cp-free${isFront ? ' cp-front' : ''}">
  <div class="cp-wrap">
${blocksHtml(section.blocks, book, ctx, srcAttr)}
    ${qrIsImg2 ? `<img class="cp-qr" src="${esc(ctx.resolveImage(meta.qr))}" alt="QR" />` : ''}
    ${meta.qrLabel ? `<div class="cp-qrlabel">${esc(meta.qrLabel)}${!qrIsImg2 && meta.qr ? ' — ' + esc(meta.qr) : ''}</div>` : ''}
  </div>
</section>`;
  }
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`); };
  add('초판 1쇄 발행', meta.issueDate);
  add('지은이', meta.author);
  add('옮긴이', meta.translator);
  add('펴낸이', meta.issuer);
  add('펴낸곳', meta.publisher);
  add('출판등록', meta.regNo);
  add('주소', meta.address);
  add('전화', meta.phone);
  add('팩스', meta.fax);
  add('홈페이지', meta.homepage);
  add('이메일', meta.email);
  add('ISBN', meta.isbn);
  add('정가', meta.price);
  if (meta.ebookPrice) add('전자책', meta.ebookPrice);
  for (const [k, v] of Object.entries(meta.extra || {})) add(k, v);

  const year = (String(meta.issueDate || '').match(/\d{4}/) || [new Date().getFullYear()])[0];
  const cline = meta.copyright || (meta.author ? `ⓒ ${meta.author}, ${year}` : '');
  const qrIsImg = meta.qr && /\.(png|jpe?g|svg|webp)$/i.test(meta.qr);
  return `<section class="colophon${isFront ? ' cp-front' : ''}">
  <div class="cp-wrap">
    <div class="cp-title">${esc(meta.title || '')}</div>
    ${meta.subtitle ? `<div class="cp-subtitle">${esc(meta.subtitle)}</div>` : ''}
    <table>${rows.join('')}</table>
    <div class="cp-legal">
      ${cline ? `<p>${esc(cline)}</p>` : ''}
      <p>이 책은 저작권법에 따라 보호받는 저작물이므로 무단 전재와 복제를 금합니다.</p>
      <p>잘못된 책은 구입하신 곳에서 바꾸어 드립니다.</p>
    </div>
    ${qrIsImg ? `<img class="cp-qr" src="${esc(ctx.resolveImage(meta.qr))}" alt="QR" />` : ''}
    ${meta.qrLabel ? `<div class="cp-qrlabel">${esc(meta.qrLabel)}${!qrIsImg && meta.qr ? ' — ' + esc(meta.qr) : ''}</div>`
      : (!qrIsImg && meta.qr ? `<div class="cp-qrlabel">${esc(meta.qr)}</div>` : '')}
  </div>
</section>`;
}
function tocHtml(book, tocTitle) {
  const items = [];
  for (const s of book.front) {
    if (s.key === 'toc' || s.key === 'dedication' || s.key === 'epigraph') continue;
    items.push(`<li class="toc-front"><a href="#sec-${s.key}">${esc(s.title)}</a></li>`);
  }
  for (const p of book.parts) {
    if (p.title) items.push(`<li class="toc-part"><a href="#part-${p.num || p.lineStart}">${esc(p.title)}</a></li>`);
    for (const c of p.chapters) items.push(`<li class="toc-chapter"><a href="#ch-${c.num}">${esc(c.title)}</a></li>`);
  }
  for (const s of book.back) {
    if (s.key === 'colophon') continue;
    items.push(`<li class="toc-back"><a href="#sec-${s.key}">${esc(s.title)}</a></li>`);
  }
  return `<nav class="toc"><h2>${esc(tocTitle || '차례')}</h2><ol>${items.join('\n')}</ol></nav>`;
}
function endnotesHtml(ctx) {
  if (!ctx.endnotes.length) return '';
  const lis = ctx.endnotes.map((e, i) =>
    `<li id="en-${i + 1}"><a href="#enref-${i + 1}">${i + 1}</a>. ${inlineMd(e.text)}</li>`).join('\n');
  return `<section class="back-section endnotes" id="sec-endnotes"><h2>미주</h2><ol style="list-style:none">${lis}</ol></section>`;
}

// ── 동적 CSS(@page) ──
function pageCss(opts) {
  const m = opts.marginsMm;
  const rh = 'font-size: 7.5pt; letter-spacing: 0.06em; color: #333;';
  const fo = 'font-size: 8.5pt; color: #222;';
  return `
@page {
  size: ${opts.trimW}mm ${opts.trimH}mm;
  margin-top: ${m.top}mm; margin-bottom: ${m.bottom}mm;
}
/* 짝수쪽(왼쪽): 바깥=왼쪽. 러닝헤드=책제목, 폴리오=왼쪽 하단 */
@page :left {
  margin-left: ${m.outer}mm; margin-right: ${m.inner}mm;
  @top-center { content: string(book-title); ${rh} }
  @bottom-left { content: counter(page); ${fo} }
}
/* 홀수쪽(오른쪽): 러닝헤드=장제목, 폴리오=오른쪽 하단.
   first-except = 값이 설정되는 페이지(장 시작)에서는 빈 문자열 — 장 시작 러닝헤드 생략 관행. */
@page :right {
  margin-left: ${m.inner}mm; margin-right: ${m.outer}mm;
  @top-center { content: string(chapter-title, first-except); ${rh} }
  @bottom-right { content: counter(page); ${fo} }
}
/* 디스플레이 페이지(표제지·부표제지·판권) + 앞부속: 러닝헤드·폴리오 없음 */
@page display { @top-center { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
@page front { @top-center { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
/* recto 강제로 생긴 백면 */
@page :blank { @top-center { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
h2.chapter-title { string-set: chapter-title content(); }
.book-title-anchor { string-set: book-title content(); display: none; }
`;
}

/**
 * BookModel → { html, css } (css 는 html 에 인라인 포함돼 있음 — html 만 쓰면 됨)
 */
function buildBookHtml(book, opts = {}) {
  const meta = book.meta || {};
  const platform = getPlatform(opts.platformId || metaPlatformId(meta));
  const trimId = meta.trim || opts.trimId || platform.defaultTrim;
  const trim = getTrim(trimId);

  const o = {
    trimW: trim.width, trimH: trim.height,
    fontSizePt: num(opts.fontSizePt, 10),
    lineHeight: num(opts.lineHeight, 1.8),
    marginsMm: Object.assign({ top: 18, bottom: 22, inner: 25, outer: 16 }, opts.marginsMm || {}),
    chapterStart: opts.chapterStart === 'page' ? 'page' : 'recto',
    footnoteMode: (meta.footnoteMode === '미주' || opts.footnoteMode === 'endnote') ? 'endnote' : 'footnote',
    fontStack: opts.fontStack || `'KoPub World Batang', 'KoPubWorld Batang', 'RIDIBatang', 'NanumMyeongjo', 'Batang', serif`,
    sourceMap: opts.sourceMap !== false,
  };

  const baseDir = opts.baseDir || process.cwd();
  const imageUrl = typeof opts.imageUrl === 'function' ? opts.imageUrl : (abs) => 'file:///' + abs.replace(/\\/g, '/');
  const ctx = {
    footnoteMode: o.footnoteMode,
    endnotes: [],
    resolveImage(src) {
      if (/^(https?|data|media|file):/i.test(src)) return src;
      const abs = path.isAbsolute(src) ? src : path.join(baseDir, src);
      return imageUrl(abs);
    },
  };
  const srcAttr = (b) => (o.sourceMap && typeof b.lineStart === 'number')
    ? ` data-src-line="${b.lineStart}" data-src-end="${b.lineEnd}"` : '';

  const bodyParts = [];
  bodyParts.push(`<span class="book-title-anchor">${esc(meta.title || book.fileTitle || '')}</span>`);

  // 앞부속 — 반표제지(기본 on) → 속표지 → (앞판권) → 예약섹션들(목차는 자동 생성)
  if (truthyDefault(meta.halfTitle, true)) bodyParts.push(halfTitleHtml(meta));
  bodyParts.push(titlePageHtml(meta, ctx));
  const colFront = /앞/.test(String(meta.colophonPos || ''));
  const colSection = book.back.find((s) => s.key === 'colophon');
  if (colFront && colSection) bodyParts.push(colophonHtml(meta, ctx, true, colSection, book, srcAttr));
  for (const s of book.front) {
    if (s.key === 'toc') { bodyParts.push(tocHtml(book, s.title)); continue; }
    bodyParts.push(`<section class="front-section sec-${s.key}" id="sec-${s.key}">
<h2${o.sourceMap ? ` data-src-line="${s.lineStart}" data-src-end="${s.lineStart}"` : ''}>${esc(s.title)}</h2>
${blocksHtml(s.blocks, book, ctx, srcAttr)}
</section>`);
  }

  // 본문 — 부 표제지 + 장
  for (const p of book.parts) {
    if (p.title) {
      bodyParts.push(`<section class="part-title" id="part-${p.num || p.lineStart}">
<div class="pt-num">${p.num ? `제${p.num}부` : ''}</div><h2>${esc(p.title)}</h2></section>`);
    }
    for (const c of p.chapters) {
      bodyParts.push(`<section class="chapter" id="ch-${c.num}">
${c.title ? `<h2 class="chapter-title"${o.sourceMap ? ` data-src-line="${c.lineStart}" data-src-end="${c.lineStart}"` : ''}>${esc(c.title)}</h2>` : ''}
${blocksHtml(c.blocks, book, ctx, srcAttr)}
</section>`);
    }
  }

  // 뒷부속 — 예약섹션들 → (미주) → 판권(뒤 기본)
  for (const s of book.back) {
    if (s.key === 'colophon') continue;
    bodyParts.push(`<section class="back-section sec-${s.key}" id="sec-${s.key}">
<h2${o.sourceMap ? ` data-src-line="${s.lineStart}" data-src-end="${s.lineStart}"` : ''}>${esc(s.title)}</h2>
${blocksHtml(s.blocks, book, ctx, srcAttr)}
</section>`);
    // 미주는 참고문헌·저자소개보다 앞(후기 뒤)에 두는 게 관행 — afterword/thanks 뒤 첫 위치에 삽입
    if (o.footnoteMode === 'endnote' && (s.key === 'thanks' || s.key === 'afterword') && ctx.endnotes.length && !ctx._endnotesDone) {
      bodyParts.push(endnotesHtml(ctx)); ctx._endnotesDone = true;
    }
  }
  if (o.footnoteMode === 'endnote' && ctx.endnotes.length && !ctx._endnotesDone) bodyParts.push(endnotesHtml(ctx));
  if (colSection && !colFront) bodyParts.push(colophonHtml(meta, ctx, false, colSection, book, srcAttr));

  // ⚠ CSS 변수(:root + var()) 를 쓰지 않고 값을 직접 치환 — vivliostyle core(브라우저 미리보기)가
  //   var() 를 CLI 와 다르게 해석해 본문 크기가 16px 로 폴백 → 쪽수가 ~2.5배로 뻥튀기되던 문제.
  const theme = fs.readFileSync(THEME_CSS_PATH, 'utf8')
    .replace(/var\(--font-body\)/g, o.fontStack)
    .replace(/calc\(var\(--font-size\) - 2pt\)/g, `${Math.max(6, o.fontSizePt - 2)}pt`)
    .replace(/var\(--font-size\)/g, `${o.fontSizePt}pt`)
    .replace(/var\(--line-height\)/g, String(o.lineHeight))
    .replace(/var\(--chapter-break\)/g, o.chapterStart === 'page' ? 'page' : 'recto');
  const css = (opts.fontCss || '') + '\n' + pageCss(o) + '\n' + theme;
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${esc(meta.title || book.fileTitle || '책')}</title>
<style>
${css}
</style>
</head>
<body>
${bodyParts.join('\n\n')}
</body>
</html>`;
  return { html, css, trimId, trim, platform, options: o };
}

function num(v, d) { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; }
function truthyDefault(v, d) {
  if (v == null || v === '') return d;
  return !/^(off|no|없음|아니오|false|0|x)$/i.test(String(v).trim());
}
function metaPlatformId(meta) {
  const p = String(meta.platform || '').toLowerCase();
  if (/교보|kyobo/.test(p)) return 'kyobo';
  if (/작가와|jakkawa/.test(p)) return 'jakkawa';
  return 'bookk';
}

module.exports = { buildBookHtml, metaPlatformId, esc, inlineMd };
