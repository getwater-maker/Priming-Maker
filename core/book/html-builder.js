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
// 판권 자동 생성 항목 정의 — UI 체크박스와 1:1 (key, 라벨, 값 추출)
const COLOPHON_FIELDS = [
  ['issueDate', '초판 1쇄 발행'], ['author', '지은이'], ['translator', '옮긴이'], ['issuer', '펴낸이'],
  ['publisher', '펴낸곳'], ['regNo', '출판등록'], ['address', '주소'], ['phone', '전화'], ['fax', '팩스'],
  ['homepage', '홈페이지'], ['email', '이메일'], ['isbn', 'ISBN'], ['price', '정가'], ['ebookPrice', '전자책'],
  ['copyright', 'ⓒ 저작권 문구'], ['legal', '무단복제 금지 문구'], ['exchange', '파본 교환 안내'],
];

function colophonHtml(meta, ctx, isFront, section, book, srcAttr, fields) {
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
  // 항목 선택 — fields 배열(체크박스)이 오면 그 항목만, null 이면 전부
  const on = (key) => !Array.isArray(fields) || fields.includes(key);
  const rows = [];
  const add = (fieldKey, label, v) => { if (v && on(fieldKey)) rows.push(`<tr><td class="k">${esc(label)}</td><td>${esc(v)}</td></tr>`); };
  add('issueDate', '초판 1쇄 발행', meta.issueDate);
  add('author', '지은이', meta.author);
  add('translator', '옮긴이', meta.translator);
  add('issuer', '펴낸이', meta.issuer);
  add('publisher', '펴낸곳', meta.publisher);
  add('regNo', '출판등록', meta.regNo);
  add('address', '주소', meta.address);
  add('phone', '전화', meta.phone);
  add('fax', '팩스', meta.fax);
  add('homepage', '홈페이지', meta.homepage);
  add('email', '이메일', meta.email);
  add('isbn', 'ISBN', meta.isbn);
  add('price', '정가', meta.price);
  add('ebookPrice', '전자책', meta.ebookPrice);
  for (const [k, v] of Object.entries(meta.extra || {})) { if (v) rows.push(`<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`); }

  const year = (String(meta.issueDate || '').match(/\d{4}/) || [new Date().getFullYear()])[0];
  const cline = meta.copyright || (meta.author ? `ⓒ ${meta.author}, ${year}` : '');
  const qrIsImg = meta.qr && /\.(png|jpe?g|svg|webp)$/i.test(meta.qr);
  return `<section class="colophon${isFront ? ' cp-front' : ''}">
  <div class="cp-wrap">
    <div class="cp-title">${esc(meta.title || '')}</div>
    ${meta.subtitle ? `<div class="cp-subtitle">${esc(meta.subtitle)}</div>` : ''}
    <table>${rows.join('')}</table>
    <div class="cp-legal">
      ${cline && on('copyright') ? `<p>${esc(cline)}</p>` : ''}
      ${on('legal') ? '<p>이 책은 저작권법에 따라 보호받는 저작물이므로 무단 전재와 복제를 금합니다.</p>' : ''}
      ${on('exchange') ? '<p>잘못된 책은 구입하신 곳에서 바꾸어 드립니다.</p>' : ''}
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

// 폰트 키 → 스택 (전부 동봉 정적 웨이트 — 가변폰트는 PDF 에 Type3 로 구워져 배제)
const FONT_STACKS = {
  kopub: `'KoPubWorld Batang', 'NanumMyeongjo', 'Batang', serif`,
  'kopub-dotum': `'KoPubWorld Dotum', 'NanumGothic', 'Dotum', sans-serif`,
  'nanum-myeongjo': `'NanumMyeongjo', 'KoPubWorld Batang', 'Batang', serif`,
  'nanum-gothic': `'NanumGothic', 'KoPubWorld Dotum', 'Dotum', sans-serif`,
};
const FONT_OPTIONS = [
  { id: 'kopub', label: 'KoPub월드 바탕 (권장)' },
  { id: 'kopub-dotum', label: 'KoPub월드 돋움' },
  { id: 'nanum-myeongjo', label: '나눔명조' },
  { id: 'nanum-gothic', label: '나눔고딕' },
];
const GOTHIC_STACK = FONT_STACKS['kopub-dotum'];

// ── 동적 CSS(@page) ──
function pageCss(o) {
  const m = o.marginsMm;
  // 머리글 — 구 앱 스타일: 고딕 9pt 회색(#595959) (+선택 시 아래 구분선)
  const rh = `font-family: ${GOTHIC_STACK}; font-size: 9pt; color: #595959;`
    + (o.headerLine ? ' border-bottom: 0.4pt solid #dddddd; margin-bottom: 3pt;' : '');
  const fo = `font-family: ${GOTHIC_STACK}; font-size: 9pt; font-weight: 700; color: #000;`;
  // 머리글 내용 선택 — 없음/책제목/장제목(first-except: 장 시작 페이지에선 생략)
  const rhContent = (kind) => kind === 'title' ? 'string(book-title)'
    : kind === 'chapter' ? 'string(chapter-title, first-except)' : 'none';
  const headerEvenBox = o.headerEven !== 'none' ? `@top-center { content: ${rhContent(o.headerEven)}; ${rh} }` : '';
  const headerOddBox = o.headerOdd !== 'none' ? `@top-center { content: ${rhContent(o.headerOdd)}; ${rh} }` : '';
  // 쪽번호 위치 — 바깥 하단 / 하단 가운데 / 숨김
  const numEven = o.pageNum === 'outer' ? `@bottom-left { content: counter(page); ${fo} }`
    : o.pageNum === 'center' ? `@bottom-center { content: counter(page); ${fo} }` : '';
  const numOdd = o.pageNum === 'outer' ? `@bottom-right { content: counter(page); ${fo} }`
    : o.pageNum === 'center' ? `@bottom-center { content: counter(page); ${fo} }` : '';
  return `
@page {
  size: ${o.trimW}mm ${o.trimH}mm;
  margin-top: ${m.top}mm; margin-bottom: ${m.bottom}mm;
}
/* 짝수쪽(왼쪽): 바깥여백=왼쪽 */
@page :left {
  margin-left: ${m.outer}mm; margin-right: ${m.inner}mm;
  ${headerEvenBox}
  ${numEven}
}
/* 홀수쪽(오른쪽): 바깥여백=오른쪽 */
@page :right {
  margin-left: ${m.inner}mm; margin-right: ${m.outer}mm;
  ${headerOddBox}
  ${numOdd}
}
/* 디스플레이 페이지(표제지·부표제지·판권) + 앞부속: 러닝헤드·폴리오 없음 */
@page display { @top-center { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
@page front { @top-center { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
/* recto 강제로 생긴 백면 */
@page :blank { @top-center { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
h2.chapter-title { string-set: chapter-title content(); }
.book-title-anchor { string-set: book-title content(); display: none; }

/* ── 본문 타이포(옵션) — 테마 기본을 덮어씀 ── */
body {
  font-weight: ${o.fontWeight};
  letter-spacing: ${o.letterSpacingPt}pt;
}
p { text-indent: ${o.indentPt}pt; margin-bottom: ${o.paragraphSpacingPt}pt; }
p.noindent, p.chapter-lead { text-indent: 0; }
strong { font-weight: ${Math.min(900, o.fontWeight + 400)}; }
/* 소제목(원고 ## = 절) */
section.chapter h3 {
  font-family: ${o.h2Gothic ? GOTHIC_STACK : o.fontStack};
  font-size: ${o.h2SizePt}pt;
  font-weight: ${o.h2Weight};
  text-align: ${o.h2Align};
  margin: ${o.h2MarginTopPt}pt 0 ${o.h2MarginBottomPt}pt;
  letter-spacing: 0;
}
${o.h2Prefix ? `section.chapter h3::before { content: "${o.h2Prefix.replace(/"/g, '\\"')} "; }` : ''}
/* 목차 쪽번호 — 우측 고정(absolute). leader()는 미리보기(코어)와 CLI 지원이 달라
   양쪽 동일하게 나오는 방식으로 통일. */
nav.toc li { position: relative; padding-right: 2.2em; }
nav.toc a::after {
  content: target-counter(attr(href url), page);
  position: absolute; right: 0; font-weight: 400;
  font-family: ${GOTHIC_STACK}; font-size: 0.9em;
}
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
    // ── 본문 타이포 — 기본값은 구 Book Publishing 앱에서 사용자가 쓰던 값 그대로 ──
    fontKey: FONT_STACKS[opts.fontKey] ? opts.fontKey : 'kopub',
    fontSizePt: num(opts.fontSizePt, 10),
    lineHeight: num(opts.lineHeight, 1.65),
    fontWeight: num(opts.fontWeight, 300),
    letterSpacingPt: numAllowNeg(opts.letterSpacingPt, -0.4),
    indentPt: numAllowZero(opts.indentPt, 15),
    paragraphSpacingPt: numAllowZero(opts.paragraphSpacingPt, 10),
    // ── 여백(mm) — 구 앱: 위20 / 아래15 / 안쪽20 / 바깥17 ──
    marginsMm: Object.assign({ top: 20, bottom: 15, inner: 20, outer: 17 }, opts.marginsMm || {}),
    chapterStart: opts.chapterStart === 'page' ? 'page' : 'recto',
    footnoteMode: (meta.footnoteMode === '미주' || opts.footnoteMode === 'endnote') ? 'endnote' : 'footnote',
    // ── 머리글/쪽번호 노출 선택 ──
    headerEven: pick(opts.headerEven, ['title', 'chapter', 'none'], 'title'),   // 짝수쪽(왼쪽)
    headerOdd: pick(opts.headerOdd, ['chapter', 'title', 'none'], 'chapter'),   // 홀수쪽(오른쪽)
    headerLine: opts.headerLine !== false,                                       // 머리글 아래 구분선
    pageNum: pick(opts.pageNum, ['outer', 'center', 'none'], 'outer'),
    // ── 소제목(원고의 ## = 절) 스타일 — 구 앱: 고딕 800, ❖ 접두, 위25pt/아래10pt ──
    h2SizePt: num(opts.h2SizePt, 10.5),
    h2Gothic: opts.h2Gothic !== false,
    h2Weight: num(opts.h2Weight, 700),
    h2Align: pick(opts.h2Align, ['left', 'center', 'right'], 'left'),
    h2Prefix: opts.h2Prefix != null ? String(opts.h2Prefix) : '❖',
    h2MarginTopPt: numAllowZero(opts.h2MarginTopPt, 25),
    h2MarginBottomPt: numAllowZero(opts.h2MarginBottomPt, 10),
    // ── 판권 자동 항목 선택 (null = 전부) ──
    colophonFields: Array.isArray(opts.colophonFields) ? opts.colophonFields : null,
    sourceMap: opts.sourceMap !== false,
  };
  o.fontStack = FONT_STACKS[o.fontKey];

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
  if (colFront && colSection) bodyParts.push(colophonHtml(meta, ctx, true, colSection, book, srcAttr, o.colophonFields));
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
  if (colSection && !colFront) bodyParts.push(colophonHtml(meta, ctx, false, colSection, book, srcAttr, o.colophonFields));

  // ⚠ CSS 변수(:root + var()) 를 쓰지 않고 값을 직접 치환 — vivliostyle core(브라우저 미리보기)가
  //   var() 를 CLI 와 다르게 해석해 본문 크기가 16px 로 폴백 → 쪽수가 ~2.5배로 뻥튀기되던 문제.
  const theme = fs.readFileSync(THEME_CSS_PATH, 'utf8')
    .replace(/var\(--font-body\)/g, o.fontStack)
    .replace(/calc\(var\(--font-size\) - 2pt\)/g, `${Math.max(6, o.fontSizePt - 2)}pt`)
    .replace(/var\(--font-size\)/g, `${o.fontSizePt}pt`)
    .replace(/var\(--line-height\)/g, String(o.lineHeight))
    .replace(/var\(--chapter-break\)/g, o.chapterStart === 'page' ? 'page' : 'recto');
  // 순서: 폰트 → 테마(기본) → pageCss(옵션 오버라이드가 마지막에 이기도록)
  const css = (opts.fontCss || '') + '\n' + theme + '\n' + pageCss(o);
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
function numAllowZero(v, d) { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; }
function numAllowNeg(v, d) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function pick(v, allowed, d) { return allowed.includes(v) ? v : d; }
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

module.exports = { buildBookHtml, metaPlatformId, esc, inlineMd, FONT_OPTIONS, COLOPHON_FIELDS, FONT_STACKS, GOTHIC_STACK };
