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
const { getTrim, getPlatform, TRIM_SIZES } = require('./platform-presets');

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

// 장 본문 렌더 — 특별 섹션 키워드(예: '역사 노트')와 일치하는 소제목 구간을
// 노트 박스(<div class="special-sec">)로 감싸 본문과 다르게 조판. 구간 = 그 소제목부터 다음 소제목(또는 장 끝).
function chapterBlocksHtml(blocks, book, ctx, srcAttr, specials) {
  if (!specials || !specials.length) return blocksHtml(blocks, book, ctx, srcAttr);
  const out = [];
  let buf = [];
  let sbuf = null;
  const flushBuf = () => { if (buf.length) { out.push(blocksHtml(buf, book, ctx, srcAttr)); buf = []; } };
  const flushSpecial = () => { if (sbuf) { out.push(`<div class="special-sec">\n${blocksHtml(sbuf, book, ctx, srcAttr)}\n</div>`); sbuf = null; } };
  for (const b of blocks || []) {
    if (b.type === 'h3' || b.type === 'h4') {
      const hit = specials.some((k) => (b.text || '').trim().includes(k));
      if (hit) { flushBuf(); flushSpecial(); sbuf = [b]; continue; }
      flushSpecial(); buf.push(b); continue;
    }
    if (sbuf) sbuf.push(b); else buf.push(b);
  }
  flushBuf(); flushSpecial();
  return out.join('\n');
}

// ── 자동 생성 페이지 ──
function halfTitleHtml(meta, fallbackTitle) {
  // 제목 폴백 — 메타에 책제목이 없으면 파일 제목으로(반표제지가 빈 페이지로 나오던 문제)
  return `<section class="halftitle"><div class="ht-title">${esc(meta.title || fallbackTitle || '')}</div></section>`;
}
function titlePageHtml(meta, ctx, fallbackTitle) {
  const logo = meta.logo ? `<img class="tp-logo" src="${esc(ctx.resolveImage(meta.logo))}" alt="logo" />` : '';
  return `<section class="titlepage">
  <div class="tp-main">
    <h1 class="tp-title">${esc(meta.title || fallbackTitle || '')}</h1>
    ${meta.subtitle ? `<div class="tp-subtitle">${esc(meta.subtitle)}</div>` : ''}
    <div class="tp-author">${esc(meta.author || '')}${meta.author ? ' 지음' : ''}</div>
    ${meta.translator ? `<div class="tp-translator">${esc(meta.translator)} ${meta.translatorLabel === '편역이' ? '편역' : '옮김'}</div>` : ''}
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

// [판권] 자유문 라벨 → 표(메타) 키 매핑 — 이 라벨로 시작하는 줄은 표에 이미 있으면 '되풀이'로 간주.
const COLOPHON_LABEL_KEYS = [
  [/^(원작|지은이|저자|글)\s+\S/, 'author'],
  [/^(편역|편역자|편역이|옮긴이|역자|엮은이|번역)\s+\S/, 'translator'],
  [/^(펴낸이|발행인)\s+\S/, 'issuer'],
  [/^(펴낸곳|발행처|출판사)\s+\S/, 'publisher'],
  [/^(발행일|초판|발행)\s+.*\d/, 'issueDate'], // \b 는 한글 경계 미인식 → \s+ 사용
  [/^ISBN\b/i, 'isbn'],
  [/^(정가|가격)\s+\S/, 'price'],
  [/^부가기호\s+\S/, 'isbnAddon'],
  [/^판형\s+\S/, 'trim'],
  [/^(주소|주 소)\s+\S/, 'address'],
  [/^(대표전화|전화)\s+\S/, 'phone'],
  [/^팩스\s+\S/, 'fax'],
  [/^홈페이지\s+\S/, 'homepage'],
  [/^(이메일|email)\s+\S/i, 'email'],
  [/^출판등록\s+\S/, 'regNo'],
];
// [판권] 자유문의 한 줄이 '표·제목·ⓒ에 이미 나온 정보를 되풀이한 것'인가?
//   되풀이면 버리고(표가 대신 보여줌), 표에 없는 고유 정보(고지문 등)는 보존 → 무손실.
function colophonLineRedundant(line, meta) {
  const s = String(line || '').trim();
  if (!s) return false;
  const title = (meta.title || '').trim();
  // 제목/부제 재기술 — cp-title 에 이미 있음
  if (title && (s.replace(/\s/g, '') === title.replace(/\s/g, '')
    || (s.includes(title) && s.length <= title.length + 30))) return true;
  // ⓒ/© 저작권 줄 — 하단 cp-legal 이 자동 생성
  if (/^(ⓒ|©|copyright)/i.test(s) && (meta.author || meta.translator || meta.copyright)) return true;
  // 라벨+값 — 해당 메타가 표에 이미 있으면 중복(없으면 고유 정보라 보존)
  for (const [re, key] of COLOPHON_LABEL_KEYS) {
    if (re.test(s) && meta[key] != null && String(meta[key]).trim() !== '') return true;
  }
  return false;
}
// [판권] 섹션에서 되풀이 줄을 걸러 고지문만 남긴 사본을 반환(원본 모델 불변).
function filterColophonSection(section, meta) {
  if (!section || !Array.isArray(section.blocks)) return section;
  const blocks = [];
  for (const b of section.blocks) {
    if (b && b.type === 'p' && typeof b.text === 'string') {
      const kept = b.text.split('\n').filter((ln) => !colophonLineRedundant(ln, meta));
      const txt = kept.join('\n').trim();
      if (txt) blocks.push({ ...b, text: txt });
    } else if (b) {
      blocks.push(b); // 인용·시 등 비문단 블록은 그대로 보존
    }
  }
  return { ...section, blocks };
}
// 판권지 — 사용자 확정 레이아웃(구 Book Publishing 앱 실물과 동일):
//   하단 배치 · 책제목(볼드) · 「라벨 ｜ 값」 행(발행/발행처/ISBN·가격) · 가는 구분선 ·
//   고지문([판권] 자유문 중 표에 없는 줄만 — AI 활용·편집 저작권 등) · QR(중앙)+라벨 · ⓒ + 재사용 안내.
//   Option 1(2026-07-13): 자유문이 표·제목·ⓒ를 되풀이하면 그 줄만 빼고 고지문만 남김(중복 제거·무손실).
function colophonHtml(meta, ctx, isFront, section, book, srcAttr, fields) {
  const row = (label, v) => (v ? `<div class="cp-row"><span class="k">${esc(label)}</span><span class="sep">｜</span><span class="v">${esc(v)}</span></div>` : '');
  const g1 = [row('발행일', meta.issueDate), row('지은이', meta.author),
    row(meta.translatorLabel || '옮긴이', meta.translator),
    row('발행인', meta.issuer), row('발행처', meta.publisher), row('출판등록', meta.regNo),
    row('주  소', meta.address), row('대표전화', meta.phone), row('팩스', meta.fax),
    row('홈페이지', meta.homepage), row('이메일', meta.email)].join('');
  const g2 = '';
  const isbnStr = meta.isbn ? (meta.isbn + (meta.isbnAddon ? ` (부가기호 ${meta.isbnAddon})` : '')) : '';
  const g3 = [row('ISBN', isbnStr), row('가격', meta.price), row('전자책', meta.ebookPrice)].join('')
    + Object.entries(meta.extra || {}).map(([k, v]) => row(k, v)).join('');
  const groups = [g1, g2, g3].filter(Boolean).join('<div class="cp-gap"></div>');

  const fsec = filterColophonSection(section, meta);
  const notes = (fsec && fsec.blocks && fsec.blocks.length)
    ? `<hr class="cp-rule" /><div class="cp-notes">${blocksHtml(fsec.blocks, book, ctx, srcAttr)}</div>`
    : '';

  const qrIsImg = meta.qr && /\.(png|jpe?g|svg|webp)$/i.test(meta.qr);
  const qrBlock = (qrIsImg || meta.qrLabel || meta.qr)
    ? `<div class="cp-qrbox">
    ${qrIsImg ? `<img class="cp-qr" src="${esc(ctx.resolveImage(meta.qr))}" alt="QR" />` : ''}
    ${meta.qrLabel ? `<div class="cp-qrlabel">${esc(meta.qrLabel)}${!qrIsImg && meta.qr ? ' — ' + esc(meta.qr) : ''}</div>`
      : (!qrIsImg && meta.qr ? `<div class="cp-qrlabel">${esc(meta.qr)}</div>` : '')}
  </div>` : '';

  const year = (String(meta.issueDate || '').match(/\d{4}/) || [new Date().getFullYear()])[0];
  // 편역서는 편집 저작권자 = 편역자(목표 최종본: ⓒ 로이(한득수)) — translator 우선
  const cpName = meta.translator || meta.author;
  const owner = meta.copyright || (cpName ? `ⓒ ${cpName} ${year}. All rights reserved.` : '');
  const legal = owner
    ? `<div class="cp-legal"><p>${esc(owner)}</p><p>이 책의 내용 중 전부 또는 일부를 재사용하려면 반드시 저작권자의 서면 동의를 얻어야 합니다.</p></div>`
    : '';

  return `<section class="colophon${isFront ? ' cp-front' : ''}">
  <div class="cp-wrap">
    <div class="cp-title">${esc(meta.title || '')}${meta.subtitle ? ` <span class="cp-subtitle">${esc(meta.subtitle)}</span>` : ''}</div>
    <div class="cp-rows">${groups}</div>
    ${notes}
    ${qrBlock}
    ${legal}
  </div>
</section>`;
}
// 목차 — 사용자 최종본([POD] 원고_고전의뜰 삼국지_01.pdf p.11)과 동일: **본문 장(제N회)만** 나열
//   (서문·프롤로그 등 부속물 제외), 각 행 = 제목 + 점선 리더 + 우측 쪽번호.
//   점선은 leader() 대신 flex 빈칸의 border-bottom(dotted) — 미리보기(코어)·CLI 양쪽 동일 렌더.
function tocHtml(book, tocTitle, excluded = []) {
  const items = [];
  for (const p of book.parts) {
    if (p.title) items.push(`<li class="toc-part"><span class="tt">${esc(p.title)}</span></li>`);
    for (const c of p.chapters) {
      if (!c.title) continue;
      items.push(`<li class="toc-chapter"><a href="#ch-${c.num}"><span class="tt">${esc(c.title)}</span><span class="dots"></span></a></li>`);
    }
  }
  return `<nav class="toc"><h2>${esc(tocTitle || '목차')}</h2><ol>${items.join('\n')}</ol></nav>`;
}
// 표지 안내 페이지 — 미리보기 전용 1쪽(내지 PDF 에는 넣지 않음).
//   스프레드 치수 전부 + 축소 다이어그램(재단선·안전선·책등·날개 구획). 표지 이미지가 첨부돼 있으면
//   다이어그램 배경에 깔아 "치수가 맞게 만들어졌는지"를 눈으로 확인.
function coverInfoHtml(ci, meta, o) {
  const sp = ci.spread;
  if (!sp) return '';
  // 판면 폭에 맞춰 스케일(mm 기준) — 다이어그램이 페이지를 넘지 않게
  const bodyWmm = o.trimW - o.marginsMm.inner - o.marginsMm.outer;
  const scale = Math.min(1, bodyWmm / sp.widthMm);
  const W = sp.widthMm * scale, H = sp.heightMm * scale;
  const bleed = 3 * scale, safe = (3 + (sp.safeMm || 5)) * scale;
  // 구획 상자들
  let x = 0;
  const partDivs = sp.parts.map((p) => {
    const left = x * scale; x += p.mm;
    if (p.name === 'bleed') return '';
    return `<div style="position:absolute; left:${left.toFixed(2)}mm; top:0; width:${(p.mm * scale).toFixed(2)}mm; height:${H.toFixed(2)}mm; border-left:0.3pt dashed #2a6fb0; box-sizing:border-box;">
      <div style="position:absolute; left:0; right:0; top:42%; text-align:center; font-size:6.5pt; color:#2a6fb0; background:rgba(255,255,255,.55);">${esc(p.name)}<br/>${p.mm}mm</div>
    </div>`;
  }).join('');
  const bg = ci.coverImageUrl
    ? `<img src="${esc(ci.coverImageUrl)}" style="position:absolute; left:0; top:0; width:${W.toFixed(2)}mm; height:${H.toFixed(2)}mm; object-fit:fill;" />`
    : '';
  const row = (k, v) => `<tr><td style="padding:1pt 8pt 1pt 0; color:#555; white-space:nowrap;">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  return `<section class="cover-info">
  <h2 style="font-size:12pt; margin:0 0 6pt;">📐 표지 스프레드 안내</h2>
  <p class="noindent" style="font-size:8pt; color:#777; margin:0 0 8pt;">이 페이지는 미리보기 전용입니다 — 내지 PDF 에는 포함되지 않습니다. 표지 이미지를 첨부하면 아래 다이어그램에 겹쳐 표시되어 치수 정합을 확인할 수 있습니다.</p>
  <table style="font-size:8.5pt; border-collapse:collapse; margin-bottom:8pt;">
    ${row('판형(내지)', `${o.trimW} × ${o.trimH} mm`)}
    ${row('스프레드 전체', `${sp.widthMm} × ${sp.heightMm} mm  =  ${sp.widthPx} × ${sp.heightPx} px @${sp.dpi}dpi`)}
    ${row('책등', `${sp.spineMm} mm (총 ${ci.pages || '?'}쪽 · ${esc(ci.paperLabel || '')} 기준)`)}
    ${row('날개', ci.flaps ? '있음 — 앞뒤 각 100 mm' : '없음')}
    ${row('재단여백', '사방 3 mm — 배경을 끝까지 채우세요 (재단 시 잘림)')}
    ${row('안전여백', `재단선 안쪽 ${sp.safeMm || 5} mm — 글자·로고는 이 안에`)}
    ${ci.coverImageUrl ? row('첨부 표지', ci.coverName || '') : row('첨부 표지', '없음 — 우측 패널에서 이미지를 첨부하세요')}
  </table>
  <div style="position:relative; width:${W.toFixed(2)}mm; height:${H.toFixed(2)}mm; background:#eee; outline:0.5pt solid #999; overflow:hidden;">
    ${bg}
    ${partDivs}
    <div style="position:absolute; left:${bleed.toFixed(2)}mm; top:${bleed.toFixed(2)}mm; right:${bleed.toFixed(2)}mm; bottom:${bleed.toFixed(2)}mm; border:0.5pt solid #d32f2f;"></div>
    <div style="position:absolute; left:${safe.toFixed(2)}mm; top:${safe.toFixed(2)}mm; right:${safe.toFixed(2)}mm; bottom:${safe.toFixed(2)}mm; border:0.4pt dotted #2e7d32;"></div>
  </div>
  <p class="noindent" style="font-size:7.5pt; color:#777; margin-top:5pt;">🔴 빨간 실선=재단선 · 🟢 초록 점선=안전선 · 파란 점선=책등/날개 구획 (축척 ${(scale * 100).toFixed(0)}%)</p>
</section>`;
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
  // 머리글 — 구 앱 스타일: 고딕 9pt 회색(#595959)
  const rh = `font-family: ${GOTHIC_STACK}; font-size: 9pt; color: #595959;`;
  const fo = `font-family: ${GOTHIC_STACK}; font-size: 9pt; font-weight: 700; color: #000;`;
  // 머리글 내용 — 책제목/부제/장제목(first-except: 장 시작 페이지 생략)/소제목(절)
  // 최종본 스타일: 책제목 헤더는 부제가 있으면 '제목 / 부제' 병기.
  const rhContent = (kind) => kind === 'title' ? (o.hasSubtitle ? 'string(book-title) " / " string(book-subtitle)' : 'string(book-title)')
    : kind === 'subtitle' ? 'string(book-subtitle)'
    : kind === 'chapter' ? 'string(chapter-title, first-except)'
    : kind === 'section' ? 'string(sec-title)' : 'none';
  // 정렬 — vivliostyle 마진 박스는 폭이 내용 기준(@top-left/right 는 세로 쌓임, @top-center 는
  //   width:100% 무시하고 가운데 배치 — 실측). 판면 폭을 mm 로 명시해 text-align 이 작동하게 한다.
  const bodyW = o.trimW - m.inner - m.outer; // 판면(글상자) 폭
  const headerBoxes = (kind, align) => {
    // 밑줄 간격: 글자는 밑줄에 붙고(vertical-align:bottom + padding 2pt), 밑줄과 본문 사이는
    //   margin-bottom 7pt 로 띄운다(관행 — 이전엔 반대로 글자가 위·밑줄이 본문에 붙어 있었음).
    const line = o.headerLine ? ' border-bottom: 0.4pt solid #cccccc; padding-bottom: 2pt; margin-bottom: 7pt;' : '';
    if (kind === 'none' && !o.headerLine) return '';
    const content = kind === 'none' ? '""' : rhContent(kind);
    // 단일 @top-center 박스(판면 폭 명시) + text-align — 모든 정렬 공통.
    //   ⚠ @top-left 와 @top-center 를 함께 쓰면 두 박스가 공간을 나눠 가져 왼쪽 글이
    //   중앙으로 밀리는 충돌(실측) → 박스는 하나만 쓴다.
    return `@top-center { content: ${content}; width: ${bodyW}mm; text-align: ${align}; vertical-align: bottom; ${rh}${line} }`;
  };
  const headerEvenBox = headerBoxes(o.headerEven, o.headerEvenAlign);
  const headerOddBox = headerBoxes(o.headerOdd, o.headerOddAlign);
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
@page display { @top-left { content: none; } @top-center { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
@page front { @top-left { content: none; } @top-center { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
/* recto 강제로 생긴 백면 */
@page :blank { @top-left { content: none; } @top-center { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
h2.chapter-title { string-set: chapter-title content(); }
section.chapter h3 { string-set: sec-title content(); }
.book-title-anchor { string-set: book-title content(); display: none; }
.book-subtitle-anchor { string-set: book-subtitle content(); display: none; }

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
/* 특별 섹션(반복 코너 — 예: 역사 노트) — 옅은 배경 노트 박스, 본문보다 한 단계 작게 */
div.special-sec {
  background: #f4f1ea;
  padding: 10pt 12pt;
  margin: 16pt 0 10pt;
  font-size: 0.93em;
  line-height: ${Math.max(1.5, o.lineHeight - 0.15)};
}
div.special-sec h3 { margin: 0 0 8pt !important; }
div.special-sec p { text-indent: 0; margin-bottom: 5pt; }
/* 목차 행 — 제목 + 점선 리더(flex 빈칸의 dotted 밑줄) + 우측 쪽번호(target-counter).
   leader()는 미리보기(코어)와 CLI 렌더가 달라 폐기 — 이 방식은 양쪽 동일(실측). */
nav.toc a { display: flex; align-items: baseline; text-decoration: none; color: inherit; }
nav.toc a .tt { flex: 0 1 auto; }
nav.toc a .dots { flex: 1 1 auto; min-width: 1.5em; margin: 0 0.55em; border-bottom: 1.3px dotted #aaaaaa; transform: translateY(-0.28em); }
nav.toc a::after {
  content: target-counter(attr(href url), page);
  font-weight: 400; font-family: ${GOTHIC_STACK}; font-size: 0.95em;
}
`;
}

/**
 * BookModel → { html, css } (css 는 html 에 인라인 포함돼 있음 — html 만 쓰면 됨)
 */
function buildBookHtml(book, opts = {}) {
  const meta = book.meta || {};
  const platform = getPlatform(opts.platformId || metaPlatformId(meta));
  // 판형 결정 — main.js(표지·책등 계산)와 동일한 검증식으로 통일. 미등록 판형(오타 등)이면
  // 플랫폼 기본 판형으로 폴백(예전엔 getTrim 이 A5 로 떨어져 내지=A5·표지=신국판 불일치 위험).
  const trimId = (meta.trim && TRIM_SIZES[meta.trim]) ? meta.trim
    : ((opts.trimId && TRIM_SIZES[opts.trimId]) ? opts.trimId : platform.defaultTrim);
  const trim = getTrim(trimId);

  const o = {
    trimW: trim.width, trimH: trim.height,
    // ── 본문 타이포 — 기본값은 구 Book Publishing 앱에서 사용자가 쓰던 값 그대로 ──
    fontKey: FONT_STACKS[opts.fontKey] ? opts.fontKey : 'kopub',
    fontSizePt: num(opts.fontSizePt, 10),
    // 행간 — 한국 단행본 관행 = 글자 크기의 1.7~2.0배(10pt 본문 → 17~20pt 행간, 대표 1.8).
    //   구 앱 값(1.65)은 관행 하한보다 좁아 기본을 1.8 로.
    lineHeight: num(opts.lineHeight, 1.8),
    fontWeight: num(opts.fontWeight, 300),
    letterSpacingPt: numAllowNeg(opts.letterSpacingPt, -0.4),
    indentPt: numAllowZero(opts.indentPt, 15),
    // 문단 간격 — 한국 단행본 관행 = 들여쓰기만 하고 문단 간격 0 (간격은 장면 전환 등 의도적 구분에만).
    paragraphSpacingPt: numAllowZero(opts.paragraphSpacingPt, 5), // 최종본 실측 — 문단 사이 뚜렷한 간격
    // ── 여백(mm) — 구 앱: 위20 / 아래15 / 안쪽20 / 바깥17 ──
    marginsMm: Object.assign({ top: 20, bottom: 15, inner: 20, outer: 17 }, opts.marginsMm || {}),
    chapterStart: opts.chapterStart === 'page' ? 'page' : 'recto',
    footnoteMode: (meta.footnoteMode === '미주' || opts.footnoteMode === 'endnote') ? 'endnote' : 'footnote',
    // ── 머리글/쪽번호 노출 선택 ──
    //   내용: 책제목/부제/장제목/소제목(절)/없음 · 정렬: 왼쪽/가운데/오른쪽 (기본=바깥쪽 정렬 관행)
    headerEven: pick(opts.headerEven, ['title', 'subtitle', 'chapter', 'section', 'none'], 'title'),   // 짝수쪽(왼쪽)
    headerOdd: pick(opts.headerOdd, ['title', 'subtitle', 'chapter', 'section', 'none'], 'chapter'),   // 홀수쪽(오른쪽)
    headerEvenAlign: pick(opts.headerEvenAlign, ['left', 'center', 'right'], 'left'),   // 짝수쪽 바깥=왼쪽
    headerOddAlign: pick(opts.headerOddAlign, ['left', 'center', 'right'], 'right'),    // 홀수쪽 바깥=오른쪽
    headerLine: opts.headerLine !== false,                                       // 머리글 아래 구분선
    pageNum: pick(opts.pageNum, ['outer', 'center', 'none'], 'outer'),
    // ── 소제목(원고의 ## = 절) 스타일 — 구 앱: 고딕 800, ❖ 접두, 위25pt/아래10pt ──
    h2SizePt: num(opts.h2SizePt, 10.5),
    h2Gothic: opts.h2Gothic !== false,
    h2Weight: num(opts.h2Weight, 700),
    h2Align: pick(opts.h2Align, ['left', 'center', 'right'], 'left'),
    h2Prefix: opts.h2Prefix != null ? String(opts.h2Prefix) : '❖',
    // 소제목 여백 관행 — 위(넉넉히) : 아래(본문과 가깝게) ≈ 3:1. 아래를 크게 주지 않는다.
    h2MarginTopPt: numAllowZero(opts.h2MarginTopPt, 25),
    h2MarginBottomPt: numAllowZero(opts.h2MarginBottomPt, 8),
    // ── 판권 자동 항목 선택 (null = 전부) ──
    colophonFields: Array.isArray(opts.colophonFields) ? opts.colophonFields : null,
    // ── 특별 섹션 키워드(쉼표 구분) — 일치하는 소제목 구간을 노트 박스로 (예: '역사 노트') ──
    specialKeywords: String(opts.specialKeyword || '').split(',').map((s) => s.trim()).filter(Boolean),
    // ── 출력 제외 섹션(구조 패널 체크 해제 — 원고는 보존) ──
    excluded: Array.isArray(opts.excluded) ? opts.excluded : [],
    sourceMap: opts.sourceMap !== false,
  };
  o.fontStack = FONT_STACKS[o.fontKey];
  o.hasSubtitle = !!(meta.subtitle && String(meta.subtitle).trim()); // 헤더 '제목 / 부제' 병기용

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
  bodyParts.push(`<span class="book-subtitle-anchor">${esc(meta.subtitle || meta.title || book.fileTitle || '')}</span>`);

  // 표지 안내 페이지 — 미리보기 전용(opts.coverInfo 전달 시에만). 내지 PDF 빌드에서는 전달 안 함.
  if (opts.coverInfo) bodyParts.push(coverInfoHtml(opts.coverInfo, meta, o));

  // 앞부속 — 반표제지(기본 on) → 속표지 → (앞판권) → 예약섹션들(목차는 자동 생성)
  if (truthyDefault(meta.halfTitle, true)) bodyParts.push(halfTitleHtml(meta, book.fileTitle));
  bodyParts.push(titlePageHtml(meta, ctx, book.fileTitle));
  const colFront = /앞/.test(String(meta.colophonPos || ''));
  const colSection = book.back.find((s) => s.key === 'colophon');
  const colIncluded = colSection && !o.excluded.includes('colophon');
  if (colFront && colIncluded) bodyParts.push(colophonHtml(meta, ctx, true, colSection, book, srcAttr, o.colophonFields));
  for (const s of book.front) {
    if (o.excluded.includes(s.key)) continue; // 구조 패널에서 체크 해제(원고는 보존)
    if (s.key === 'toc') { bodyParts.push(tocHtml(book, s.title, o.excluded)); continue; }
    bodyParts.push(`<section class="front-section sec-${s.key}" id="sec-${s.key}">
<h2${o.sourceMap ? ` data-src-line="${s.lineStart}" data-src-end="${s.lineStart}"` : ''}>${esc(s.title)}</h2>
${blocksHtml(s.blocks, book, ctx, srcAttr)}
</section>`);
  }

  // 목차 자동 생성 — 원고에 [목차] 섹션이 없으면 프로그램이 만들어 제공(원고에 있으면 그 위치가 우선).
  //   구조 패널에서 '목차' 체크 해제(excluded)하면 자동 생성도 생략.
  if (!book.front.some((s) => s.key === 'toc') && !o.excluded.includes('toc')) {
    bodyParts.push(tocHtml(book, '목차', o.excluded));
  }

  // 본문 — 부 표제지 + 장
  for (const p of book.parts) {
    if (p.title) {
      bodyParts.push(`<section class="part-title" id="part-${p.num || p.lineStart}">
<div class="pt-num">${p.num ? `제${p.num}부` : ''}</div><h2>${esc(p.title)}</h2></section>`);
    }
    for (const c of p.chapters) {
      bodyParts.push(`<section class="chapter" id="ch-${c.num}">
${c.title ? (() => {
        // 최종본 스타일: '제N회'와 제목을 2줄로 분리(중앙 정렬). 헤더 러닝타이틀은 content() 로 전체 텍스트 사용.
        const mCh = /^(제\s*\d+\s*회)[.,]?\s*(.+)$/.exec(c.title);
        const inner = mCh ? `<span class="ch-no">${esc(mCh[1])}</span>${esc(mCh[2])}` : esc(c.title);
        return `<h2 class="chapter-title"${o.sourceMap ? ` data-src-line="${c.lineStart}" data-src-end="${c.lineStart}"` : ''}>${inner}</h2>`;
      })() : ''}
${chapterBlocksHtml(c.blocks, book, ctx, srcAttr, o.specialKeywords)}
</section>`);
    }
  }

  // 뒷부속 — 예약섹션들 → (미주) → 판권(뒤 기본)
  for (const s of book.back) {
    if (s.key === 'colophon') continue;
    if (o.excluded.includes(s.key)) continue; // 구조 패널에서 체크 해제(원고는 보존)
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
  if (colIncluded && !colFront) bodyParts.push(colophonHtml(meta, ctx, false, colSection, book, srcAttr, o.colophonFields));

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
