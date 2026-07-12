// BookView.jsx — 출판(POD) 모드 화면: 구조 패널 / 실제 페이지 미리보기(vivliostyle) / 설정 패널.
//   미리보기 = main 이 조판 HTML 을 media:// 로 서빙 → @vivliostyle/core 가 브라우저에서
//   PDF 와 동일한 CSS Paged Media 조판으로 펼침면 렌더. 문단 클릭 → 원고(.md) 해당 줄 수정.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import api from './lib/ipc.js';
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';

// 책 정보(메타) 폼 필드 정의 — key = main 의 BOOK_META_LABELS 표준키
const META_FIELDS = [
  ['title', '책 제목'], ['subtitle', '부제'], ['author', '저자'], ['translator', '옮긴이'],
  ['publisher', '출판사'], ['issuer', '발행인'], ['issueDate', '발행일'], ['isbn', 'ISBN'],
  ['price', '정가(POD)'], ['ebookPrice', '전자책 가격'], ['regNo', '출판등록'],
  ['address', '주소'], ['phone', '대표전화'], ['homepage', '홈페이지'], ['email', '이메일'],
  ['copyright', '저작권(ⓒ)'], ['isbnAddon', '부가기호(5자리)'], ['logo', '출판사 로고(이미지 경로)'], ['qr', 'QR(주소/이미지)'], ['qrLabel', 'QR 라벨'],
];
// 판권 법정 필수 7필드 — 미입력 경고
const REQUIRED_KEYS = [['title', '제목'], ['author', '저자'], ['issuer', '발행인'], ['issueDate', '발행일'], ['publisher', '출판사'], ['isbn', 'ISBN'], ['price', '정가']];

// SVG 문자열 → PNG dataURL (렌더러 캔버스 사용)
function svgToPngDataUrl(svg, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/png'));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('SVG 렌더 실패')); };
    img.src = url;
  });
}

// 조판 옵션 기본값 — 구 Book Publishing 앱에서 사용자가 쓰던 값 그대로
const LAYOUT_DEFAULTS = {
  fontKey: 'kopub', fontSizePt: 10, lineHeight: 1.8, fontWeight: 300,
  letterSpacingPt: -0.4, indentPt: 15, paragraphSpacingPt: 0, // 관행 = 들여쓰기만, 문단 간격 0
  marginsMm: { top: 20, bottom: 15, inner: 20, outer: 17 },
  chapterStart: 'recto',
  headerEven: 'title', headerOdd: 'chapter', headerEvenAlign: 'left', headerOddAlign: 'right',
  headerLine: true, pageNum: 'outer',
  h2SizePt: 10.5, h2Gothic: true, h2Weight: 700, h2Align: 'left', h2Prefix: '❖',
  h2MarginTopPt: 25, h2MarginBottomPt: 8,
  colophonFields: null, coverOverlay: false, coverBarcode: true, coverTextColor: '#111111',
  specialKeyword: '', // 반복 코너(예: '역사 노트') — 일치하는 소제목 구간을 노트 박스로
  excluded: [],       // 출력 제외 섹션 key 목록 (원고는 보존)
};

// 구조 패널 체크박스 한 줄 — 원고에 있으면 포함/제외 토글(비파괴), 없으면 체크 시 템플릿 삽입.
function SectionChk({ r, presentKeys, layout, toggleSection, cover }) {
  const present = presentKeys.has(r.key);
  const checked = present && !(layout.excluded || []).includes(r.key);
  return (
    <label className="chk" style={present ? undefined : { opacity: 0.55 }}
      title={present
        ? (cover ? '체크 해제 = 표지 PDF 에서 제외 (원고 보존)' : '체크 해제 = 책에서 제외 (원고 보존 — 다시 체크하면 복원)')
        : '체크 = 원고에 이 섹션 템플릿을 추가'}>
      <input type="checkbox" checked={checked} onChange={(e) => toggleSection(r.key, e.target.checked, present)} /> {r.label}
      {!present && <span className="meta"> (원고에 없음)</span>}
    </label>
  );
}

export default function BookView({ dto, setDto, setStatus, logline }) {
  const [layout, setLayout] = useState(LAYOUT_DEFAULTS);
  // 원고 전환 시 저장된 조판 설정 복원(없으면 기본값)
  const layoutLoadedFor = useRef('');
  useEffect(() => {
    if (!dto || dto.kind !== 'book' || layoutLoadedFor.current === dto.scriptPath) return;
    layoutLoadedFor.current = dto.scriptPath;
    lastPagesRef.current = 0; // 원고 전환 — 이전 원고와 새 조판 쪽수가 우연히 같아도 쪽수 보고가 스킵되지 않게 리셋
    const saved = dto.layoutSaved || {};
    setLayout({ ...LAYOUT_DEFAULTS, ...saved, marginsMm: { ...LAYOUT_DEFAULTS.marginsMm, ...(saved.marginsMm || {}) } });
  }, [dto && dto.scriptPath]);
  const L = (k, v) => setLayout((s) => ({ ...s, [k]: v }));
  const Lm = (k, v) => setLayout((s) => ({ ...s, marginsMm: { ...s.marginsMm, [k]: Number(v) || 0 } }));
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [pageInfo, setPageInfo] = useState({ cur: 0, total: 0 });
  const [edit, setEdit] = useState(null); // { lineStart, lineEnd, text, file }
  const viewerRef = useRef(null);   // CoreViewer 인스턴스
  const viewportRef = useRef(null); // 뷰포트 DOM
  const loadedForRef = useRef('');  // 마지막으로 로드한 url (중복 로드 방지)
  const lastPagesRef = useRef(0);   // 마지막 보고 쪽수 (동일 값 재보고 방지)

  const meta = (dto && dto.meta) || {};
  const loaded = !!(dto && dto.kind === 'book');

  // ── 미리보기 조판 ──
  const refreshPreview = useCallback(async () => {
    if (!loaded) return;
    setPreviewBusy(true); setStatus('조판 중…');
    try {
      const r = await api.bookPreview({ layout });
      if (r && r.url) setPreviewUrl(r.url + '#t=' + Date.now()); // 캐시 무효화용 fragment
      else { setPreviewBusy(false); setStatus('⚠ 미리보기 조판 실패 — 로그를 확인하세요'); } // 실패 시 '조판 중…' 고착 방지
    } catch (e) { logline('미리보기 오류: ' + e.message); setPreviewBusy(false); setStatus('⚠ 미리보기 오류 — 로그 확인'); }
  }, [loaded, layout]);

  // 조판에 영향을 주는 "내용"만 뽑은 문자열 시그니처.
  //   ⚠ dto.meta/front/back/parts 를 직접 의존성에 넣으면, 조판 완료 후 bookReportPages 가
  //   돌려주는 새 dto(내용 동일·참조만 다름) 때문에 effect 가 재실행 → 무한 재조판(깜빡임)이 된다.
  //   값 기반 문자열이면 쪽수 보고로 dto 가 새로 와도 시그니처가 같아 재조판을 트리거하지 않는다.
  //   (dto.spread·lastPages 는 조판 결과라 여기서 제외)
  const contentSig = loaded ? JSON.stringify({
    path: dto.scriptPath, meta: dto.meta, front: dto.front, back: dto.back, parts: dto.parts,
    covers: dto.covers, cover: dto.coverImagePath, layout,
  }) : '';

  // 내용이 바뀌면 자동 재조판 — 디바운스 600ms
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(refreshPreview, 600);
    return () => clearTimeout(t);
  }, [contentSig]);

  // ── vivliostyle 로드 ──
  //   ⚠ 반드시 iframe 안에 렌더 — 같은 document 에 렌더하면 앱 전역 CSS(p 마진·폰트 14px 등)가
  //   조판 DOM 에 캐스케이드돼 실측 기반 페이지 분할이 왜곡됨(삼국지 255쪽 → 660쪽으로 부풀던 원인).
  useEffect(() => {
    if (!previewUrl || !viewportRef.current) return;
    if (loadedForRef.current === previewUrl) return;
    loadedForRef.current = previewUrl;
    const iframe = viewportRef.current;
    const fdoc = iframe.contentDocument;
    fdoc.open();
    fdoc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#8a8177}
[data-src-line]:hover{outline:2px solid rgba(212,165,116,.9);outline-offset:1px;cursor:pointer}
</style></head><body><div id="vp"></div></body></html>`);
    fdoc.close();
    fdoc.addEventListener('click', (e) => onPreviewClickRef.current(e));
    // 마우스 휠 = 펼침면 넘기기 (스로틀 250ms — 트랙패드 관성 스크롤 과속 방지)
    let lastWheel = 0;
    fdoc.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 250 || Math.abs(e.deltaY) < 4) return;
      lastWheel = now;
      try { viewerRef.current && viewerRef.current.navigateToPage(e.deltaY > 0 ? Navigation.NEXT : Navigation.PREVIOUS); } catch (_) {}
    }, { passive: false });
    const vp = fdoc.getElementById('vp');
    const viewer = new CoreViewer({ viewportElement: vp, window: iframe.contentWindow }, {
      renderAllPages: true, pageViewMode: PageViewMode.SPREAD, fitToScreen: true, autoResize: true,
    });
    viewerRef.current = viewer;
    viewer.addListener('nav', (p) => {
      if (p && typeof p.epage === 'number') setPageInfo((pi) => ({ ...pi, cur: Math.round(p.epage) + 1 }));
    });
    viewer.addListener('readystatechange', () => {
      if (viewer.readyState === 'complete') {
        // 첫 페이지 = 표지 안내(미리보기 전용, 내지 아님) → 내지 쪽수는 -1
        const total = Math.max(0, (viewer.getPageSizes() || []).length - 1);
        setPageInfo((pi) => ({ ...pi, total }));
        setPreviewBusy(false); setStatus(`조판 완료 — 내지 ${total}쪽`);
        // 쪽수가 실제로 바뀔 때만 dto 갱신(책등·규격 재계산). 같은 값이면 불필요한 재렌더 회피.
        if (total > 0 && total !== lastPagesRef.current) {
          lastPagesRef.current = total;
          api.bookReportPages({ pages: total }).then((d) => { if (d) setDto(d); }).catch(() => {});
        }
      }
    });
    viewer.loadDocument(previewUrl, {}, {});
  }, [previewUrl]);

  // ── 문단 클릭 → 편집 ── (iframe 내부 click 리스너가 ref 를 통해 항상 최신 핸들러 호출)
  const onPreviewClick = useCallback(async (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-src-line]');
    if (!el) return;
    const lineStart = parseInt(el.getAttribute('data-src-line'), 10);
    const lineEnd = parseInt(el.getAttribute('data-src-end') || el.getAttribute('data-src-line'), 10);
    if (isNaN(lineStart)) return;
    try {
      // 원본 파일 기준 줄 텍스트 — 다중 파일 원고(필수파일+회차)에서도 정확한 파일·줄로 역매핑
      const r = await api.bookGetLines({ lineStart, lineEnd });
      if (!r) return;
      setEdit({ lineStart, lineEnd, text: r.text, file: r.file });
    } catch (err) { logline('원고 읽기 오류: ' + err.message); }
  }, []);
  const onPreviewClickRef = useRef(onPreviewClick);
  onPreviewClickRef.current = onPreviewClick;

  async function saveEdit() {
    if (!edit) return;
    try {
      const d = await api.bookApplyEdit(edit);
      if (d) setDto(d);
      setEdit(null); setStatus('수정 저장됨 — 재조판 중…');
    } catch (e) { logline('수정 저장 오류: ' + e.message); }
  }

  // ── 액션 ──
  async function buildPdf() {
    setBuilding(true); setStatus('PDF 생성 중… (내지 조판 + 표지)');
    try {
      const r = await api.bookBuildPdf({ layout });
      if (r && r.dto) setDto(r.dto);
      setStatus(r && !r.error
        ? (r.coverError ? `⚠ 내지 ${r.pages}쪽 완료 · 표지 실패 — 로그 확인` : `PDF 완료 — 내지 ${r.pages}쪽${r.coverPdf ? ' + 표지' : ''}`)
        : 'PDF 실패 — 로그 확인');
    } catch (e) { logline('PDF 오류: ' + e.message); }
    setBuilding(false);
  }
  async function buildEpubFile() {
    setBuilding(true); setStatus('ePub 생성 중…');
    try {
      const r = await api.bookBuildEpub({});
      if (r && r.dto) setDto(r.dto);
      setStatus(r && !r.error ? 'ePub 완료 — 출력폴더 확인' : 'ePub 실패 — 로그 확인');
    } catch (e) { logline('ePub 오류: ' + e.message); }
    setBuilding(false);
  }
  // 구조 패널 체크박스 — 원고에 있는 섹션은 "포함/제외"만 토글(원고 보존),
  //   원고에 없는 섹션을 체크하면 템플릿을 원고에 삽입.
  async function toggleSection(key, on, present) {
    if (present) {
      const ex = new Set(layout.excluded || []);
      if (on) ex.delete(key); else ex.add(key);
      L('excluded', [...ex]); // layout 변경 → contentSig 로 자동 재조판
      setStatus(on ? '섹션 포함' : '섹션 제외 (원고에는 남아 있음 — 다시 체크하면 복원)');
      return;
    }
    if (on) {
      const d = await api.bookToggleSection({ key, on: true });
      if (d) setDto(d);
    }
  }
  async function setMeta(key, value) {
    if ((meta[key] || '') === value) return;
    const d = await api.bookSetMeta({ key, value });
    if (d) setDto(d);
  }
  async function attachCover() { const d = await api.bookAttachCover(); if (d) setDto(d); }
  async function clearCover() { const d = await api.bookClearCover(); if (d) setDto(d); }

  // ISBN 바코드 — main 이 SVG 저장, 렌더러가 PNG(300dpi 상당)로도 변환 저장.
  async function exportBarcode() {
    try {
      const r = await api.bookExportBarcode();
      if (!r || r.error) { setStatus(r ? r.error : '바코드 생성 실패'); return; }
      const png = await svgToPngDataUrl(r.svg, r.widthPx * 2, r.heightPx * 2); // 2배(≈600px 폭) 고해상
      const sv = await api.bookSaveAsset({ name: `ISBN바코드_${r.isbn13}.png`, dataUrl: png });
      if (sv && sv.error) { setStatus('⚠ 바코드 PNG 저장 실패: ' + sv.error); return; }
      setStatus('ISBN 바코드 저장 (SVG+PNG) — 표지 뒷면 오른쪽 하단에 배치하세요');
    } catch (e) { logline('바코드 오류: ' + e.message); }
  }
  // 표지 가이드 PNG — 300dpi 실치수 캔버스에 재단선/책등/날개 구분선 + 치수 라벨.
  async function exportCoverGuide() {
    try {
      const sp = dto.spread;
      if (!sp || !sp.parts) { setStatus('⚠ 스프레드 정보 없음 — 미리보기 조판을 먼저 해주세요'); return; }
      if (!(dto.lastPages > 0)) { setStatus('⚠ 쪽수 미확정(책등 0mm) — 미리보기/PDF 로 쪽수를 확정한 뒤 가이드를 만드세요'); return; }
      const mmToPx = (mm) => Math.round((mm / 25.4) * 300);
      const W = mmToPx(sp.widthMm), H = mmToPx(sp.heightMm);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H); // 투명 배경 — 캔바 등에서 레이어로 얹기
      const font = (px) => { ctx.font = `${px}px sans-serif`; };
      // 구분선(파란 점선) + 라벨
      ctx.strokeStyle = '#1976d2'; ctx.fillStyle = '#1976d2'; ctx.lineWidth = 3;
      ctx.setLineDash([18, 14]);
      let xMm = 0;
      for (let i = 0; i < sp.parts.length; i++) {
        const part = sp.parts[i];
        const x0 = mmToPx(xMm);
        if (i > 0) { ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke(); }
        font(54); ctx.textAlign = 'center';
        const cx = mmToPx(xMm + part.mm / 2);
        if (part.name !== 'bleed') {
          ctx.fillText(part.name, cx, Math.round(H * 0.5));
          font(40); ctx.fillText(`${part.mm}mm`, cx, Math.round(H * 0.5) + 56);
        }
        xMm += part.mm;
      }
      // 재단선(빨강 실선) — 사방 bleed 안쪽
      const bl = mmToPx(3);
      ctx.setLineDash([]); ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 3;
      ctx.strokeRect(bl, bl, W - bl * 2, H - bl * 2);
      // 안전선(초록 점선) — 재단선 안쪽 5mm
      const sf = mmToPx(3 + (sp.safeMm || 5));
      ctx.setLineDash([12, 10]); ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 2;
      ctx.strokeRect(sf, sf, W - sf * 2, H - sf * 2);
      // 상단 안내
      ctx.setLineDash([]); ctx.fillStyle = '#d32f2f'; ctx.textAlign = 'left'; font(44);
      ctx.fillText(`표지 스프레드 ${sp.widthMm}×${sp.heightMm}mm = ${W}×${H}px @300dpi · 빨강=재단선 · 초록=안전선(글자 금지 바깥)`, sf + 10, sf + 60);
      const sv = await api.bookSaveAsset({ name: '표지가이드.png', dataUrl: cv.toDataURL('image/png') });
      if (sv && sv.error) { setStatus('⚠ 표지 가이드 저장 실패: ' + sv.error); return; }
      setStatus(`표지 가이드 저장 — ${W}×${H}px. 이 위에 디자인하고 가이드 레이어는 지우세요`);
    } catch (e) { logline('표지 가이드 오류: ' + e.message); }
  }
  const nav = (dir) => { try { viewerRef.current && viewerRef.current.navigateToPage(dir); } catch {} };

  if (!loaded) {
    return (
      <div className="plempty">
        <h2>📖 출판 — MD 원고 → POD 출판용 PDF</h2>
        <p>상단 <b>「📖 원고 열기」</b>로 원고(.md)를 불러오세요 (여러 파일 선택 가능).</p>
        <p>처음이라면 <b>「📄 작성 가이드」</b>로 샘플 원고를 저장하세요 — 규약 설명이 주석으로 들어 있는 살아있는 예시라, 복사해서 내용만 바꾸면 바로 책이 됩니다.</p>
        <p className="meta">
          핵심 규칙: <code># 책제목</code>(맨 위 한 번) + <code>&gt; 저자: …</code> 책 정보 + <code>## [서문]</code> 같은 대괄호 = 부속물(헌사·목차·판권·뒷표지 글…) +
          대괄호 없는 <code>## 1장. 제목</code> = 본문 장. 부크크·교보POD·작가와 규격의 내지/표지 PDF 와 ePub 을 만듭니다.
        </p>
      </div>
    );
  }

  const presentKeys = new Set([...(dto.front || []), ...(dto.back || []), ...(dto.covers || [])].map((s) => s.key));
  const missing = REQUIRED_KEYS.filter(([k]) => !(k === 'title' ? (meta.title || dto.fileTitle) : meta[k]));
  const spread = dto.spread || {};
  const chapters = (dto.parts || []).flatMap((p) => p.chapters);

  return (
    <div className="bkwrap">
      {/* ── 좌: 책 구조 ── */}
      <div className="bkpanel bkleft">
        <div className="bktitle">📚 책 구조</div>
        <div className="bkzone">앞부속</div>
        <label className="chk"><input type="checkbox" checked={!/^(off|no|없음|아니오|false|0|x)$/i.test(String(meta.halfTitle || 'on'))}
          onChange={(e) => setMeta('halfTitle', e.target.checked ? '' : '없음')} /> 반표제지 <span className="meta">(자동)</span></label>
        <label className="chk"><input type="checkbox" checked disabled /> 속표지 <span className="meta">(자동)</span></label>
        {(dto.reserved || []).filter((r) => r.zone === 'front').map((r) => <SectionChk key={r.key} r={r} presentKeys={presentKeys} layout={layout} toggleSection={toggleSection} />)}
        <div className="bkzone">본문 — 장 {chapters.length}개</div>
        <div className="bkchapters">
          {(dto.parts || []).map((p, pi) => (
            <React.Fragment key={pi}>
              {p.title ? <div className="bkpart">{p.num ? `제${p.num}부 ` : ''}{p.title}</div> : null}
              {p.chapters.map((c) => (
                <div key={c.num} className="bkch" title={`문단 ${c.blocks}개 — 미리보기에서 클릭해 수정`}>{c.title || `(제목 없음)`}</div>
              ))}
            </React.Fragment>
          ))}
          {!chapters.length && <div className="meta">본문 장이 없습니다 — 원고에 <code>## 1장. 제목</code>을 추가하세요.</div>}
        </div>
        <div className="bkzone">뒷부속</div>
        {(dto.reserved || []).filter((r) => r.zone === 'back').map((r) => <SectionChk key={r.key} r={r} presentKeys={presentKeys} layout={layout} toggleSection={toggleSection} />)}
        <div className="bkzone">표지 구성 (표지 PDF)</div>
        {(dto.reserved || []).filter((r) => r.zone === 'cover').map((r) => <SectionChk key={r.key} r={r} presentKeys={presentKeys} layout={layout} toggleSection={toggleSection} cover />)}
        <div className="meta" style={{ marginTop: 8 }}>원고에 쓴 섹션은 자동으로 체크됩니다. 체크를 해제하면 <b>원고는 그대로 두고 책에서만 제외</b>합니다.</div>
        {dto.footnoteCount > 0 && <div className="meta" style={{ marginTop: 8 }}>각주 {dto.footnoteCount}개 — {meta.footnoteMode === '미주' ? '미주(책 끝 모음)' : '각주(페이지 하단)'}</div>}
      </div>

      {/* ── 중앙: 실제 페이지 미리보기 ── */}
      <div className="bkcenter">
        <div className="bkbar">
          <button className="ghost" onClick={() => nav(Navigation.FIRST)} title="첫 페이지">⏮</button>
          <button className="ghost" onClick={() => nav(Navigation.PREVIOUS)} title="이전 펼침면">◀</button>
          <span className="bkpage" title="1번째 화면은 표지 안내(내지 아님)">{pageInfo.cur === 1 ? '표지' : (pageInfo.cur > 1 ? pageInfo.cur - 1 : '–')} / {pageInfo.total || '–'}쪽</span>
          <button className="ghost" onClick={() => nav(Navigation.NEXT)} title="다음 펼침면">▶</button>
          <button className="ghost" onClick={() => nav(Navigation.LAST)} title="마지막 페이지">⏭</button>
          <span className="grow" />
          <span className="meta">{previewBusy ? '⏳ 조판 중…' : '문단을 클릭하면 수정할 수 있습니다'}</span>
          <button className="ghost" onClick={refreshPreview} title="원고를 다시 조판">🔄 미리보기 갱신</button>
        </div>
        <iframe className="bkviewport" ref={viewportRef} title="페이지 미리보기" />
        {edit && (
          <div className="bkedit">
            <div className="meta">{edit.file ? `${edit.file} — ` : '원고 '}수정 후 저장하면 원본 .md 에 반영되고 재조판됩니다</div>
            <textarea value={edit.text} rows={Math.min(8, edit.text.split('\n').length + 1)}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })} autoFocus />
            <div className="mbtns">
              <button onClick={saveEdit}>저장</button>
              <button className="ghost" onClick={() => setEdit(null)}>취소</button>
            </div>
          </div>
        )}
      </div>

      {/* ── 우: 설정 ── */}
      <div className="bkpanel bkright">
        <div className="bktitle">⚙ 출판 설정</div>
        {missing.length > 0 && (
          <div className="bkwarn" title="출판문화산업진흥법상 간행물 필수 기재사항">
            ⚠ 판권 필수 미입력: {missing.map(([, l]) => l).join(' · ')}
            <div style={{ fontWeight: 400, marginTop: 3 }}>※ [판권] 섹션에 자유문을 쓴 경우 이 검사는 책 정보 폼만 봅니다 — 자유문에 ISBN·발행일·발행처 등이 실제로 들어갔는지 직접 확인하세요.</div>
          </div>
        )}
        <details open>
          <summary>규격 (플랫폼·판형·용지)</summary>
          <div className="bkform">
            <label>플랫폼
              <select value={dto.platformId} onChange={(e) => setMeta('platform', e.target.value === 'kyobo' ? '교보' : e.target.value === 'jakkawa' ? '작가와' : '부크크')}>
                {(dto.platforms || []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label>판형
              <select value={dto.trimId} onChange={(e) => setMeta('trim', e.target.value)}>
                {(dto.trims || []).filter((t) => {
                  const pf = (dto.platforms || []).find((p) => p.id === dto.platformId);
                  return !pf || pf.trims.includes(t.id);
                }).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label>내지 용지
              <select value={dto.paperId} onChange={(e) => setMeta('paper', e.target.value)}>
                {(dto.papers || []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="chk"><input type="checkbox" checked={dto.flaps} onChange={(e) => setMeta('flaps', e.target.checked ? '있음' : '없음')} /> 표지 날개 (100mm)</label>
            <label title="판권 내용은 원고의 [판권] 섹션에 쓴 문구가 그대로 조판됩니다 (내용 없이 마커만 있으면 책 정보 메타로 자동 생성)">판권 위치
              <select value={/앞/.test(String(meta.colophonPos || '')) ? '앞' : '뒤'} onChange={(e) => setMeta('colophonPos', e.target.value === '앞' ? '앞(속표지 뒷면)' : '')}>
                <option value="뒤">맨 뒤 (한국 관행)</option><option value="앞">앞 (속표지 뒷면)</option>
              </select>
            </label>
          </div>
        </details>
        <details open>
          <summary>본문 조판</summary>
          <div className="bkform">
            <label>본문 폰트
              <select value={layout.fontKey} onChange={(e) => L('fontKey', e.target.value)}>
                {(dto.fontOptions || []).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <div className="bkrow">
              <label>크기(pt) <input type="number" step="0.5" min="7" max="14" value={layout.fontSizePt} onChange={(e) => L('fontSizePt', Number(e.target.value) || 10)} /></label>
              <label title="한국 단행본 관행 = 글자 크기의 1.7~2.0배 (대표 1.8)">행간 <input type="number" step="0.05" min="1.2" max="2.5" value={layout.lineHeight} onChange={(e) => L('lineHeight', Number(e.target.value) || 1.8)} /></label>
            </div>
            <div className="bkrow">
              <label>굵기
                <select value={layout.fontWeight} onChange={(e) => L('fontWeight', Number(e.target.value))}>
                  <option value={300}>가늘게(300) — 단행본 관행</option><option value={400}>보통(400)</option><option value={700}>굵게(700)</option>
                </select>
              </label>
              <label>자간(pt) <input type="number" step="0.1" min="-2" max="2" value={layout.letterSpacingPt} onChange={(e) => L('letterSpacingPt', Number(e.target.value) || 0)} /></label>
            </div>
            <div className="bkrow">
              <label title="문단 첫 줄 들여쓰기">들여쓰기(pt) <input type="number" step="1" min="0" max="40" value={layout.indentPt} onChange={(e) => L('indentPt', Math.max(0, Number(e.target.value) || 0))} /></label>
              <label title="문단과 문단 사이 간격 — 한국 단행본 관행은 0 (들여쓰기로만 문단 구분)">문단 간격(pt) <input type="number" step="1" min="0" max="40" value={layout.paragraphSpacingPt} onChange={(e) => L('paragraphSpacingPt', Math.max(0, Number(e.target.value) || 0))} /></label>
            </div>
            <label>장 시작
              <select value={layout.chapterStart} onChange={(e) => L('chapterStart', e.target.value)}>
                <option value="recto">홀수쪽(오른쪽) — 관행</option><option value="page">다음 쪽 (분량 절약)</option>
              </select>
            </label>
            <label>각주 방식
              <select value={meta.footnoteMode === '미주' ? '미주' : '각주'} onChange={(e) => setMeta('footnoteMode', e.target.value === '미주' ? '미주' : '')}>
                <option value="각주">각주 (페이지 하단)</option><option value="미주">미주 (책 끝 모음)</option>
              </select>
            </label>
            <label title="장마다 반복되는 코너의 소제목을 쉼표로 구분해 입력하면 그 구간을 옅은 배경 노트 박스로 본문과 다르게 조판합니다">
              특별 섹션 (예: 역사 노트)
              <input type="text" value={layout.specialKeyword || ''} placeholder="반복 코너 소제목 (쉼표로 여러 개)"
                onChange={(e) => L('specialKeyword', e.target.value)} />
            </label>
          </div>
        </details>
        <details>
          <summary>여백 (mm)</summary>
          <div className="bkform">
            <div className="bkrow">
              <label>위 <input type="number" step="1" min="5" max="40" value={layout.marginsMm.top} onChange={(e) => Lm('top', e.target.value)} /></label>
              <label>아래 <input type="number" step="1" min="5" max="40" value={layout.marginsMm.bottom} onChange={(e) => Lm('bottom', e.target.value)} /></label>
            </div>
            <div className="bkrow">
              <label title="제본되는 안쪽(책등 쪽) — 무선제본은 파묻히므로 바깥보다 넓게">안쪽 <input type="number" step="1" min="5" max="40" value={layout.marginsMm.inner} onChange={(e) => Lm('inner', e.target.value)} /></label>
              <label>바깥 <input type="number" step="1" min="5" max="40" value={layout.marginsMm.outer} onChange={(e) => Lm('outer', e.target.value)} /></label>
            </div>
            <div className="meta">기본 20/15/20/17 — 안쪽≥바깥이 무선제본 관행입니다.</div>
          </div>
        </details>
        <details>
          <summary>머리글 · 쪽번호</summary>
          <div className="bkform">
            <div className="bkrow">
              <label>짝수쪽 머리글
                <select value={layout.headerEven} onChange={(e) => L('headerEven', e.target.value)}>
                  <option value="title">책 제목 (관행)</option><option value="subtitle">책 부제</option>
                  <option value="chapter">장 제목</option><option value="section">소제목(절)</option>
                  <option value="none">표시 안 함</option>
                </select>
              </label>
              <label>정렬
                <select value={layout.headerEvenAlign} onChange={(e) => L('headerEvenAlign', e.target.value)}>
                  <option value="left">왼쪽(바깥) — 관행</option><option value="center">가운데</option><option value="right">오른쪽</option>
                </select>
              </label>
            </div>
            <div className="bkrow">
              <label>홀수쪽 머리글
                <select value={layout.headerOdd} onChange={(e) => L('headerOdd', e.target.value)}>
                  <option value="chapter">장 제목 (관행)</option><option value="section">소제목(절)</option>
                  <option value="title">책 제목</option><option value="subtitle">책 부제</option>
                  <option value="none">표시 안 함</option>
                </select>
              </label>
              <label>정렬
                <select value={layout.headerOddAlign} onChange={(e) => L('headerOddAlign', e.target.value)}>
                  <option value="right">오른쪽(바깥) — 관행</option><option value="center">가운데</option><option value="left">왼쪽</option>
                </select>
              </label>
            </div>
            <label className="chk"><input type="checkbox" checked={layout.headerLine} onChange={(e) => L('headerLine', e.target.checked)} /> 머리글 아래 구분선</label>
            <label>쪽번호
              <select value={layout.pageNum} onChange={(e) => L('pageNum', e.target.value)}>
                <option value="outer">바깥 하단 (관행)</option><option value="center">하단 가운데</option><option value="none">표시 안 함</option>
              </select>
            </label>
            <div className="meta">표제지·판권·백면·장 시작 페이지에는 자동으로 표시되지 않습니다.</div>
          </div>
        </details>
        <details>
          <summary>소제목(##) 스타일</summary>
          <div className="bkform">
            <div className="bkrow">
              <label>크기(pt) <input type="number" step="0.5" min="8" max="18" value={layout.h2SizePt} onChange={(e) => L('h2SizePt', Number(e.target.value) || 10.5)} /></label>
              <label>굵기
                <select value={layout.h2Weight} onChange={(e) => L('h2Weight', Number(e.target.value))}>
                  <option value={500}>중간(500)</option><option value={700}>굵게(700)</option>
                </select>
              </label>
            </div>
            <div className="bkrow">
              <label>정렬
                <select value={layout.h2Align} onChange={(e) => L('h2Align', e.target.value)}>
                  <option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option>
                </select>
              </label>
              <label title="소제목 앞에 붙는 장식 문자 — 비우면 없음">장식 <input type="text" value={layout.h2Prefix} style={{ width: 50 }} onChange={(e) => L('h2Prefix', e.target.value)} /></label>
            </div>
            <div className="bkrow">
              <label>위 여백(pt) <input type="number" step="1" min="0" max="60" value={layout.h2MarginTopPt} onChange={(e) => L('h2MarginTopPt', Math.max(0, Number(e.target.value) || 0))} /></label>
              <label>아래 여백(pt) <input type="number" step="1" min="0" max="40" value={layout.h2MarginBottomPt} onChange={(e) => L('h2MarginBottomPt', Math.max(0, Number(e.target.value) || 0))} /></label>
            </div>
            <label className="chk"><input type="checkbox" checked={layout.h2Gothic} onChange={(e) => L('h2Gothic', e.target.checked)} /> 고딕체 사용 (해제 시 본문 폰트)</label>
          </div>
        </details>
        <details open>
          <summary>표지 (완성 이미지 첨부)</summary>
          <div className="bkform">
            <div className="meta bkcoverspec">
              책등 <b>{spread.spineMm}mm</b> (총 {dto.lastPages || '?'}쪽 기준)<br />
              스프레드 <b>{spread.widthMm}×{spread.heightMm}mm</b><br />
              = <b>{spread.widthPx}×{spread.heightPx}px</b> @300dpi{dto.flaps ? ' · 날개 포함' : ''}<br />
              <span title="재단 시 잘리는 영역 — 배경을 끝까지 채우세요">재단여백 3mm · 안전여백 5mm</span>
            </div>
            {dto.coverImagePath
              ? (<>
                  <div className="meta" style={{ wordBreak: 'break-all' }}>🖼 {dto.coverImagePath.split(/[\\/]/).pop()}</div>
                  {dto.coverCheck && !dto.coverCheck.ok && <div className="bkwarn">⚠ 치수 불일치 — 기대 {dto.coverCheck.expected.widthPx}×{dto.coverCheck.expected.heightPx}px</div>}
                  {dto.coverCheck && dto.coverCheck.ok && dto.coverCheck.lowDpi && <div className="bkwarn">⚠ 해상도 낮음 (실효 {dto.coverCheck.effectiveDpi}dpi &lt; 300)</div>}
                  <div className="mbtns"><button className="ghost" onClick={attachCover}>교체</button><button className="ghost" onClick={clearCover}>제거</button></div>
                </>)
              : <button onClick={attachCover}>🖼 표지 이미지 첨부 (배경)</button>}
            <label className="chk" title="배경 이미지 위에 제목·부제·저자·출판사 글자를 얹어 조판 — 완성 이미지에 글자가 이미 있으면 끄세요">
              <input type="checkbox" checked={!!layout.coverOverlay} onChange={(e) => L('coverOverlay', e.target.checked)} /> 앞표지에 제목·저자 얹기
            </label>
            <label className="chk" title="뒷표지 오른쪽 하단에 ISBN 바코드+정가 자동 배치">
              <input type="checkbox" checked={layout.coverBarcode !== false} onChange={(e) => L('coverBarcode', e.target.checked)} disabled={!meta.isbn} /> 뒷표지 바코드·정가 {!meta.isbn && <span className="meta">(ISBN 필요)</span>}
            </label>
            {(layout.coverOverlay || (dto.covers || []).length > 0) && (
              <label>표지 글자색 <input type="color" value={layout.coverTextColor || '#111111'} onChange={(e) => L('coverTextColor', e.target.value)} style={{ width: 60, padding: 0, height: 26 }} /></label>
            )}
            <div className="meta">뒷표지 소개글·날개 글·책등 문구는 좌측 「표지 구성」 섹션에 쓰면 표지 PDF 에 조판됩니다.</div>
            <div className="mbtns">
              <button className="ghost" title="재단선·책등·날개 구분선이 그려진 투명 PNG(300dpi) — 캔바 등에서 밑그림 레이어로" onClick={exportCoverGuide}>📐 표지 가이드</button>
              <button className="ghost" title="ISBN(EAN-13)+부가기호 바코드를 SVG·PNG 로 생성 — 표지 뒷면 오른쪽 하단에 배치" onClick={exportBarcode} disabled={!meta.isbn}>🏷 바코드</button>
            </div>
            <div className="meta">표지 = 뒷표지+책등+앞표지(+날개) 통합 한 장. 위 픽셀 치수로 만들어 첨부하면 표지 PDF 로 변환됩니다.</div>
          </div>
        </details>
        <details>
          <summary>책 정보 (판권지 자동 생성)</summary>
          <div className="bkform">
            {META_FIELDS.map(([k, label]) => (
              <label key={k}>{label}
                <input type="text" defaultValue={k === 'title' ? (meta.title || dto.fileTitle || '') : (meta[k] || '')}
                  key={dto.scriptPath + ':' + k + ':' + (meta[k] || '')}
                  onBlur={(e) => setMeta(k, e.target.value.trim())} />
              </label>
            ))}
            <div className="meta">값은 원고 상단 <code>&gt; 라벨: 값</code> 메타 줄로 저장됩니다.</div>
          </div>
        </details>
        <div className="bkactions">
          <button disabled={building} onClick={buildPdf}>{building ? '⏳ 생성 중…' : '📕 PDF 생성 (내지+표지)'}</button>
          <button className="ghost" disabled={building} title="같은 원고로 전자책(ePub 3.0) 생성 — 표지는 전자책표지 메타 또는 인쇄 표지에서 앞표지 자동 크롭" onClick={buildEpubFile}>📱 ePub</button>
          <button className="ghost" onClick={() => api.openFolder()}>📁 출력폴더</button>
        </div>
        <div className="bkstatus">
          총 <b>{dto.lastPages || '?'}쪽</b> · 책등 <b>{spread.spineMm}mm</b>
          {(() => { const pf = (dto.platforms || []).find((p) => p.id === dto.platformId); return pf && dto.lastPages > 0 && dto.lastPages < pf.minPages ? <span className="bkwarn"> · ⚠ {pf.label} 최소 {pf.minPages}쪽</span> : null; })()}
        </div>
      </div>
    </div>
  );
}
