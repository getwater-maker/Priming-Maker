'use strict';

/**
 * book-parser.js — 출판(POD) 원고(.md) 파서. MD → BookModel.
 *
 * 롱폼 대본과 한 파일을 공유한다:
 *   - `## [예약섹션]`(대괄호) = 책 전용 front/back matter — 롱폼 파서는 스킵, 책만 사용.
 *   - 일반 `## 장 제목` = 본문 장 — 영상(롱폼)과 책(본문) 공용.
 *
 * 형식:
 *   # 책 제목
 *   > 부제: … / 저자: … / 옮긴이: … / 출판사: … / ISBN: … / 정가: … / 발행일: … 등 (메타)
 *   ## [헌사] / ## [추천사] / ## [서문] / ## [일러두기] / ## [목차] / ## [프롤로그]
 *   ## 1부. 부 제목            ← 부(部) — "N부." 패턴
 *   ## 1장. 장 제목            ← 본문 장
 *   ### 절 제목                ← 절(h3) / #### 소절(h4)
 *   본문 문단…  **굵게** *기울임* [^1] 각주
 *   > 인용문                   ← 블록 인용 (`> 🖼️`/`> 🎬` 프롬프트 줄은 영상용 — 책에선 무시)
 *   ```시 … ```                ← 시(행 보존·가운데)
 *   ![삽화 설명](경로)          ← 삽화 + 캡션
 *   [^1]: 각주 내용
 *   ## [에필로그] / ## [후기] / ## [감사의글] / ## [저자소개] / ## [판권]
 *
 * 반환: { kind:'book', fileTitle, meta, front[], parts[], back[], footnotes{}, srcLines[] }
 *   모든 블록에 lineStart/lineEnd(0-based, 원본 줄 인덱스) — 미리보기 클릭-편집 소스매핑용.
 */

// 예약 섹션 이름 → { key, zone(front|back), label } (별칭 포함)
const RESERVED = [
  { key: 'dedication', zone: 'front', label: '헌사', names: ['헌사', '헌정'] },
  { key: 'epigraph', zone: 'front', label: '제사', names: ['제사', '인용구'] },
  { key: 'recommendation', zone: 'front', label: '추천사', names: ['추천사', '추천의 글', '추천의글'] },
  { key: 'transPreface', zone: 'front', label: '역자 서문', names: ['역자서문', '역자 서문', '옮긴이의 말', '옮긴이의말', '역자의 말'] },
  { key: 'preface', zone: 'front', label: '서문', names: ['서문', '머리말', '들어가며', '저자서문', '프리페이스'] },
  { key: 'notes', zone: 'front', label: '일러두기', names: ['일러두기'] },
  { key: 'toc', zone: 'front', label: '목차', names: ['목차', '차례'] },
  { key: 'prologue', zone: 'front', label: '프롤로그', names: ['프롤로그'] },
  { key: 'epilogue', zone: 'back', label: '에필로그', names: ['에필로그'] },
  { key: 'afterword', zone: 'back', label: '후기', names: ['후기', '맺음말', '나가며', '작가의 말', '작가의말'] },
  { key: 'thanks', zone: 'back', label: '감사의 글', names: ['감사의글', '감사의 글'] },
  { key: 'appendix', zone: 'back', label: '부록', names: ['부록'] },
  { key: 'references', zone: 'back', label: '참고문헌', names: ['참고문헌', '참고 문헌'] },
  { key: 'authorBio', zone: 'back', label: '저자소개', names: ['저자소개', '저자 소개', '작가소개', '작가 소개'] },
  { key: 'colophon', zone: 'back', label: '판권', names: ['판권', '판권지', '간기'] },
  // 자동 생성 페이지 지시 섹션(필수파일 형식의 # 속표지/# 표제지) — 내용은 버림(앱이 메타로 자동 조판)
  { key: 'ignore', zone: 'ignore', label: '(자동)', names: ['속표지', '표제지', '반표제지', '표지', '목차페이지'] },
];
// 표시 순서(관행) — 파일 내 순서와 무관하게 이 순서로 재배열.
const FRONT_ORDER = ['dedication', 'epigraph', 'recommendation', 'transPreface', 'preface', 'notes', 'toc', 'prologue'];
const BACK_ORDER = ['epilogue', 'afterword', 'thanks', 'appendix', 'endnotes', 'references', 'authorBio', 'colophon'];

function reservedByName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  for (const r of RESERVED) if (r.names.some((x) => x === n || x.replace(/\s+/g, '') === n.replace(/\s+/g, ''))) return r;
  return null;
}

// 메타 키 별칭 → 표준 키
const META_KEYS = {
  '책제목': 'title', '제목': 'title',
  '부제': 'subtitle', '부제목': 'subtitle',
  '저자': 'author', '지은이': 'author', '글': 'author',
  '옮긴이': 'translator', '역자': 'translator',
  '출판사': 'publisher', '발행처': 'publisher', '펴낸곳': 'publisher',
  '발행인': 'issuer', '펴낸이': 'issuer',
  '발행일': 'issueDate', '초판발행': 'issueDate', '초판 1쇄': 'issueDate', '초판1쇄': 'issueDate',
  'isbn': 'isbn',
  '부가기호': 'isbnAddon',
  '정가': 'price', '가격': 'price', 'pod가격': 'price', 'pod 가격': 'price',
  '전자책': 'ebookPrice', '전자책가격': 'ebookPrice', '전자책 가격': 'ebookPrice',
  '전자책표지': 'ebookCover', '전자책 표지': 'ebookCover',
  '출판등록': 'regNo', '등록': 'regNo',
  '주소': 'address', '전화': 'phone', '대표전화': 'phone', '팩스': 'fax',
  '홈페이지': 'homepage', '이메일': 'email', 'email': 'email',
  '저작권': 'copyright', 'copyright': 'copyright', 'ⓒ': 'copyright',
  '판형': 'trim', '플랫폼': 'platform', '용지': 'paper', '날개': 'flaps',
  '판권위치': 'colophonPos',
  '반표제지': 'halfTitle', '면지': 'endpaper',
  '각주방식': 'footnoteMode', // 각주 | 미주
  '로고': 'logo', '출판사로고': 'logo',
  'qr': 'qr', 'qr코드': 'qr', 'qr주소': 'qr',
  'qr라벨': 'qrLabel', 'qr코드라벨': 'qrLabel',
};

const IMG_PROMPT_RE = /^>\s*🖼/;
const VID_PROMPT_RE = /^>\s*🎬/;

function parseBookText(text, fallbackTitle) {
  const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');

  const meta = { extra: {} };
  let fileTitle = fallbackTitle || '책';
  const front = [];   // { key, label, title, blocks }
  const back = [];
  const parts = [];   // { title:null|string, lineStart, chapters: [{num,title,lineStart,blocks}] }
  const footnotes = {}; // id → { text, line }

  let seenHeading = false;   // 첫 ##/[섹션] 이전 = 메타 영역
  let cur = null;            // 현재 컨테이너 { blocks: [] } (예약섹션 or 장)
  let curPart = null;
  let para = null;           // 누적 중 문단 { lines: [], lineStart }

  const ensurePart = (lineNo) => {
    if (!curPart) { curPart = { title: null, num: 0, lineStart: lineNo, chapters: [] }; parts.push(curPart); }
    return curPart;
  };
  const flushPara = (endLine) => {
    if (!para || !cur) { para = null; return; }
    const t = para.lines.join(' ').trim();
    if (t) cur.blocks.push({ type: 'p', text: t, lineStart: para.lineStart, lineEnd: endLine });
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // H1 = 책 제목 (첫 것만)
    const h1 = t.match(/^#\s+(.+)$/);
    if (h1 && !seenHeading && !meta.title) {
      fileTitle = h1[1].trim(); meta.title = fileTitle; continue;
    }

    // 메타( > key: value ) — 첫 헤딩 전에서만
    if (!seenHeading && /^>\s*/.test(t)) {
      const body = t.replace(/^>\s*/, '');
      const m = body.match(/^([^:：]{1,12})\s*[:：]\s*(.*)$/);
      if (m) {
        const stdKey = META_KEYS[m[1].trim().toLowerCase()] || META_KEYS[m[1].trim()] || null;
        const val = m[2].trim();
        if (stdKey) meta[stdKey] = val;
        else meta.extra[m[1].trim()] = val;
      }
      continue;
    }

    // H2 — 예약 섹션 / 부 / 장
    const h2 = t.match(/^##\s+(.+)$/);
    if (h2 && !/^#{3,}/.test(t)) {
      flushPara(i - 1);
      const title = h2[1].trim();
      const br = title.match(/^\[(.+?)\]\s*(.*)$/);
      if (br) {
        const r = reservedByName(br[1]);
        if (r) {
          seenHeading = true;
          cur = { key: r.key, label: r.label, title: br[2].trim() || r.label, lineStart: i, blocks: [] };
          // ignore 존(속표지·표제지 지시문) = 내용 버림 — 컨테이너를 어디에도 안 붙임
          if (r.zone === 'front') front.push(cur);
          else if (r.zone === 'back') back.push(cur);
          continue;
        }
        // 모르는 대괄호 섹션 → 본문 장으로 취급 (제목에 대괄호 유지)
      }
      seenHeading = true;
      const pm = title.match(/^(?:제\s*)?(\d+)\s*부[.·]?\s*(.*)$/);
      if (pm) { // 부(部) 표제
        curPart = { title: pm[2].trim() || `${pm[1]}부`, num: Number(pm[1]), lineStart: i, chapters: [] };
        parts.push(curPart);
        cur = null;
        continue;
      }
      const ch = { title, lineStart: i, blocks: [] };
      ensurePart(i).chapters.push(ch);
      cur = ch;
      continue;
    }

    // H3/H4 — 절/소절
    const h34 = t.match(/^(#{3,4})\s+(.+)$/);
    if (h34) {
      flushPara(i - 1);
      seenHeading = true;
      if (cur) cur.blocks.push({ type: h34[1].length === 3 ? 'h3' : 'h4', text: h34[2].trim(), lineStart: i, lineEnd: i });
      continue;
    }

    if (!seenHeading) continue; // 메타 영역의 잡줄 무시
    if (!cur) { // 부 표제지 직후 등 컨테이너 없음 — 장 없는 본문은 무시하지 않고 임시 장 생성
      if (!t) continue;
      const p = ensurePart(i);
      cur = { title: '', lineStart: i, blocks: [] };
      p.chapters.push(cur);
    }

    // 각주 정의 [^id]: …
    const fn = t.match(/^\[\^([^\]]+)\]:\s*(.+)$/);
    if (fn) { flushPara(i - 1); footnotes[fn[1]] = { text: fn[2].trim(), line: i }; continue; }

    // 코드펜스 = 시/보존 블록 (```시 / ```verse / ``` 무엇이든)
    if (/^```/.test(t)) {
      flushPara(i - 1);
      const verse = [];
      const start = i;
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { verse.push(lines[i]); i++; }
      cur.blocks.push({ type: 'verse', lines: verse, lineStart: start, lineEnd: Math.min(i, lines.length - 1) });
      continue;
    }

    // 인용 (영상용 프롬프트 줄은 무시)
    if (/^>\s?/.test(t)) {
      if (IMG_PROMPT_RE.test(t) || VID_PROMPT_RE.test(t)) { continue; }
      flushPara(i - 1);
      const qlines = [t.replace(/^>\s?/, '')];
      const start = i;
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim()) &&
             !IMG_PROMPT_RE.test(lines[i + 1].trim()) && !VID_PROMPT_RE.test(lines[i + 1].trim())) {
        i++; qlines.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      cur.blocks.push({ type: 'quote', text: qlines.join('\n').trim(), lineStart: start, lineEnd: i });
      continue;
    }

    // 삽화 ![캡션](경로)
    const img = t.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) { flushPara(i - 1); cur.blocks.push({ type: 'image', caption: img[1].trim(), src: img[2].trim(), lineStart: i, lineEnd: i }); continue; }

    // 구분선 --- = 장면 전환
    if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(i - 1); cur.blocks.push({ type: 'hr', lineStart: i, lineEnd: i }); continue; }

    // 빈 줄 = 문단 경계
    if (!t) { flushPara(i - 1); continue; }

    // 본문 줄 누적
    if (!para) para = { lines: [], lineStart: i };
    para.lines.push(t);
  }
  flushPara(lines.length - 1);

  // front/back 관행 순서로 재배열 (같은 key 여러 개면 파일 순서 유지)
  const orderOf = (order, key) => { const k = order.indexOf(key); return k < 0 ? order.length : k; };
  front.sort((a, b) => orderOf(FRONT_ORDER, a.key) - orderOf(FRONT_ORDER, b.key));
  back.sort((a, b) => orderOf(BACK_ORDER, a.key) - orderOf(BACK_ORDER, b.key));

  // 장 번호 부여 (부 무관 통산) + 리드문 — 장 첫 블록이 전체 이탤릭 한 문장(*...*)이면 lead(장 부제)로
  let chNum = 0;
  for (const p of parts) for (const c of p.chapters) {
    chNum++; c.num = chNum;
    const b0 = c.blocks[0];
    if (b0 && b0.type === 'p' && /^\*[^*].*\*$/.test(b0.text.trim())) {
      b0.type = 'lead';
      b0.text = b0.text.trim().replace(/^\*|\*$/g, '').trim();
    }
  }

  // 메타의 책제목(예: 필수파일 `책제목:` 줄)이 있으면 파일 제목으로
  if (meta.title) fileTitle = meta.title;

  return { kind: 'book', fileTitle, meta, front, parts, back, footnotes, totalLines: lines.length };
}

// 예약 섹션 목록(구조 패널·템플릿 삽입용) — ignore(속표지·표제지 지시)는 UI 비노출
function reservedSections() {
  return RESERVED.filter((r) => r.zone !== 'ignore')
    .map((r) => ({ key: r.key, zone: r.zone, label: r.label, name: r.names[0] }));
}

// 섹션 템플릿(.md 삽입용) — key → 기본 마크다운 조각
function sectionTemplate(key) {
  const r = RESERVED.find((x) => x.key === key);
  if (!r) return '';
  if (key === 'toc') return `\n## [${r.names[0]}]\n`;
  if (key === 'colophon') return `\n## [${r.names[0]}]\n`;
  return `\n## [${r.names[0]}]\n(내용을 입력하세요)\n`;
}

// ── 다중 파일 원고 (필수파일 + 회차 파일 N개 → 한 권) ──────────────────────
// Book Publishing(구 앱) 원고 형식 호환. 각 파일을 "라인수 보존" 변환으로 우리 단일 형식에
// 맞춘 뒤 이어붙여 parseBookText 에 태운다 — 결합 라인 ↔ 원본 파일·라인 역매핑이 오프셋만으로 성립.
//
//   필수파일: `책제목: X` 평문 메타 + `===앞부속물===` 구분자 + `# 헌사`/`# 판권` H1 부속물
//   회차 파일: `# 제N회 제목`(장) + `*이탤릭 리드문*` + `## 절` + 본문

// 파일 종류 감지 — 'essential'(필수/부속물) | 'chapter'(회차=본문 장) | 'native'(우리 단일 형식)
function detectBookFileKind(text) {
  const head = String(text || '').slice(0, 4000);
  if (/^===.*(앞부속물|뒷부속물|본문).*===$/m.test(head) || /^(책제목|제목)\s*[:：]/m.test(head)) return 'essential';
  if (/^##\s+\[/m.test(head) || /^>\s*(저자|책제목|부제|출판사)\s*[:：]/m.test(head)) return 'native';
  return 'chapter';
}

// 필수파일 → 우리 형식 (라인수 보존: 같은 줄 안에서만 치환)
function normalizeEssentialFile(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let seenHeading = false;
  return lines.map((line) => {
    const t = line.trim();
    if (/^===.*===$/.test(t)) return '';               // 존 구분자 → 빈 줄 (존은 헤딩 이름으로 판정)
    const h1 = t.match(/^#\s+(.+)$/);
    if (h1 && !/^##/.test(t)) {
      seenHeading = true;
      const name = h1[1].trim();
      const r = reservedByName(name);
      return r ? `## [${name}]` : `## ${name}`;        // 예약명 → [섹션] / 그 외 → 본문 장
    }
    if (/^#{2,}\s+/.test(t)) { seenHeading = true; return line; }
    // 평문 메타 (첫 헤딩 전, `라벨: 값`) → `> 라벨: 값`
    if (!seenHeading) {
      const m = t.match(/^([^:：#>\-*\s][^:：]{0,11})\s*[:：]\s*(.*)$/);
      if (m && (META_KEYS[m[1].trim().toLowerCase()] || META_KEYS[m[1].trim()])) return `> ${m[1].trim()}: ${m[2]}`;
    }
    return line;
  }).join('\n');
}

// 회차 파일 → 우리 형식 — 모든 헤딩 레벨 +1 (H1=장 → H2, H2=절 → H3, H3 → H4).
//   첫 비공백 줄이 헤딩 없는 평문 제목(예: `제9회 여포의 칼…`)이면 장 헤딩으로 승격.
function normalizeChapterFile(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let first = true;
  return lines.map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (first) {
      first = false;
      if (!/^#/.test(t) && !/^[*>!\[`-]/.test(t) && t.length <= 60) return '## ' + t;
    }
    return /^#{1,3}\s+/.test(t) ? '#' + line.trimStart() : line;
  }).join('\n');
}

/**
 * 여러 원고 파일 → 한 권. files = [{ path, text }] (호출자가 순서 정렬: 필수파일 먼저 + 회차 번호순).
 * @returns BookModel + _files: [{ path, startLine, lineCount }] (결합 기준 오프셋 — 소스매핑 역변환용)
 */
function parseBookFiles(files, fallbackTitle) {
  const chunks = [];
  const map = [];
  let offset = 0;
  for (const f of files) {
    const kind = detectBookFileKind(f.text);
    const norm = kind === 'essential' ? normalizeEssentialFile(f.text)
      : kind === 'chapter' ? normalizeChapterFile(f.text)
      : String(f.text || '').replace(/\r\n/g, '\n');
    const lineCount = norm.split('\n').length;
    map.push({ path: f.path, kind, startLine: offset, lineCount });
    chunks.push(norm);
    offset += lineCount;
  }
  const book = parseBookText(chunks.join('\n'), fallbackTitle);
  book._files = map;
  return book;
}

// 결합 라인 번호 → { path, kind, line(원본 파일 내 0-based) }. 단일 파일(_files 없음)이면 null.
function resolveSourceLine(book, combinedLine) {
  if (!book || !Array.isArray(book._files)) return null;
  for (const f of book._files) {
    if (combinedLine >= f.startLine && combinedLine < f.startLine + f.lineCount) {
      return { path: f.path, kind: f.kind, line: combinedLine - f.startLine };
    }
  }
  return null;
}

// `## [이름]` 헤더가 출판 예약 섹션인지 — 롱폼 파서가 영상 대본에서 스킵할 때 사용.
function isReservedHeading(h2Title) {
  const m = String(h2Title || '').trim().match(/^\[(.+?)\]/);
  return !!(m && reservedByName(m[1]));
}
// 원고에서 출판 예약 섹션(## [헌사] 등)을 통째로 제거 — 롱폼(영상) 파싱 전처리.
function stripBookSections(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const h2 = line.trim().match(/^##\s+(.+)$/);
    if (h2 && !/^#{3,}/.test(line.trim())) skipping = isReservedHeading(h2[1]);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

module.exports = {
  parseBookText, parseBookFiles, resolveSourceLine, detectBookFileKind,
  reservedSections, sectionTemplate, isReservedHeading, stripBookSections,
  RESERVED, FRONT_ORDER, BACK_ORDER,
};
