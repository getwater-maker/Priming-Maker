'use strict';
// node test/book-parser.test.js — book-parser 단언 테스트
const assert = require('assert');
const { parseBookText, reservedSections, sectionTemplate } = require('../core/parsers/book-parser');
const { spineWidthMm, coverSpread, validateCoverImage } = require('../core/book/spine-calc');

let n = 0;
const ok = (cond, msg) => { n++; assert(cond, `#${n} ${msg}`); };

const MD = `# 조선의 밤
> 부제: 잊혀진 역사 이야기
> 저자: 홍길동
> 옮긴이: 김역자
> 출판사: 프라이밍북스
> 발행인: 김대표
> 발행일: 2026-08-01
> ISBN: 979-11-1234-567-8
> 정가: 15,000원
> 전자책: 9,000원
> 출판등록: 제2026-000012호 (2026.1.2.)
> 주소: 서울시 어딘가 123
> 대표전화: 02-1234-5678
> 홈페이지: https://example.com
> 판형: 46판
> 플랫폼: bookk
> 용지: 백색모조 100g
> 날개: 있음

## [헌사]
어머니께 바칩니다.

## [서문]
이 책을 쓰게 된 이유는 간단하다.
역사는 반복되기 때문이다.

## [목차]

## [프롤로그]
그날 밤, 궁궐의 등불이 모두 꺼졌다.

## 1부. 왕조의 그림자

## 1장. 첫 번째 밤
> 🖼️ 이미지: a dark palace at night
본문 첫 문단이다. **중요한** 이야기가 [^1] 시작된다.
같은 문단의 둘째 줄.

새 문단이다.

> 밤이 깊을수록 별은 밝아진다.
> — 옛 속담

\`\`\`시
달빛 아래
그림자 하나
\`\`\`

![궁궐의 밤 풍경](images/night.png)

### 등불이 꺼진 이유
절 본문.

[^1]: 첫 각주 내용이다.

## 2장. 두 번째 밤
둘째 장 본문.

## [에필로그]
모든 밤은 아침으로 이어진다.

## [판권]

## [저자소개]
홍길동 — 역사 이야기꾼.
`;

const b = parseBookText(MD, '폴백');

// ── 메타 ──
ok(b.kind === 'book', 'kind=book');
ok(b.fileTitle === '조선의 밤', 'H1 제목');
ok(b.meta.subtitle === '잊혀진 역사 이야기', '부제');
ok(b.meta.author === '홍길동', '저자');
ok(b.meta.translator === '김역자', '옮긴이');
ok(b.meta.publisher === '프라이밍북스', '출판사');
ok(b.meta.issuer === '김대표', '발행인');
ok(b.meta.isbn === '979-11-1234-567-8', 'ISBN');
ok(b.meta.price === '15,000원', '정가');
ok(b.meta.ebookPrice === '9,000원', '전자책 가격');
ok(b.meta.regNo && b.meta.regNo.includes('제2026-000012호'), '출판등록');
ok(b.meta.phone === '02-1234-5678', '대표전화(별칭)');
ok(b.meta.trim === '46판', '판형');
ok(b.meta.flaps === '있음', '날개');

// ── front matter — 관행 순서(헌사→서문→목차→프롤로그) ──
ok(b.front.length === 4, 'front 4개');
ok(b.front.map((s) => s.key).join(',') === 'dedication,preface,toc,prologue', 'front 순서');
ok(b.front[0].blocks[0].text === '어머니께 바칩니다.', '헌사 본문');
ok(b.front[1].blocks[0].text.includes('이유는 간단하다. 역사는 반복되기'), '서문 문단 합침');

// ── 본문 — 부/장/절 ──
ok(b.parts.length === 1, '부 1개');
ok(b.parts[0].title === '왕조의 그림자', '부 제목');
ok(b.parts[0].chapters.length === 2, '장 2개');
const c1 = b.parts[0].chapters[0];
ok(c1.title === '1장. 첫 번째 밤', '1장 제목');
ok(c1.num === 1 && b.parts[0].chapters[1].num === 2, '장 번호 통산');
const types = c1.blocks.map((x) => x.type).join(',');
ok(types === 'p,p,quote,verse,image,h3,p', `1장 블록 순서 (실제: ${types})`);
ok(c1.blocks[0].text.includes('**중요한**') && c1.blocks[0].text.includes('[^1]'), '본문 인라인 보존');
ok(c1.blocks[0].text.includes('둘째 줄'), '여러 줄 문단 합침');
ok(!c1.blocks.some((x) => (x.text || '').includes('🖼')), '이미지 프롬프트 줄 제외');
ok(c1.blocks[2].text.includes('옛 속담'), '여러 줄 인용 합침');
ok(c1.blocks[3].lines.length === 2 && c1.blocks[3].lines[0].includes('달빛'), '시 행 보존');
ok(c1.blocks[4].caption === '궁궐의 밤 풍경' && c1.blocks[4].src === 'images/night.png', '삽화');
ok(c1.blocks[5].text === '등불이 꺼진 이유', '절(h3)');

// ── 각주 ──
ok(b.footnotes['1'] && b.footnotes['1'].text === '첫 각주 내용이다.', '각주 정의');

// ── back matter — 관행 순서(에필로그→저자소개→판권) ──
ok(b.back.map((s) => s.key).join(',') === 'epilogue,authorBio,colophon', 'back 순서(파일 순서 무관 재배열)');

// ── 소스매핑 ──
ok(typeof c1.blocks[0].lineStart === 'number' && c1.blocks[0].lineEnd >= c1.blocks[0].lineStart, '블록 lineStart/lineEnd');
const srcLine = MD.split('\n')[c1.blocks[0].lineStart];
ok(srcLine.includes('본문 첫 문단'), 'lineStart 가 원본 줄과 일치');

// ── 책등/표지 계산 ──
ok(spineWidthMm(300, '백색모조 80g') === 15, '책등: 300p 모조80g = 15mm');
ok(Math.abs(spineWidthMm(200, '백색모조 100g') - 11.5) < 0.01, '책등: 200p 모조100g = 11.5mm');
const sp = coverSpread({ platformId: 'bookk', trimId: '46판', paperId: '백색모조 80g', totalPages: 0, flaps: false });
ok(sp.widthMm === 260 && sp.heightMm === 194, `46판 0p 표지 = 260×194 (실제 ${sp.widthMm}×${sp.heightMm})`);
const sp2 = coverSpread({ platformId: 'bookk', trimId: '46판', paperId: '백색모조 80g', totalPages: 300, flaps: true });
ok(sp2.widthMm === 475 && sp2.spineMm === 15, `46판 300p 날개 표지 = 475mm (실제 ${sp2.widthMm}, 책등 ${sp2.spineMm})`);
const v = validateCoverImage({ imgW: sp2.widthPx, imgH: sp2.heightPx, spread: sp2 });
ok(v.ok && v.exact, '표지 이미지 검증(정확 일치)');
const v2 = validateCoverImage({ imgW: Math.round(sp2.widthPx / 2), imgH: Math.round(sp2.heightPx / 2), spread: sp2 });
ok(v2.ok && v2.ratioOk && v2.lowDpi, '표지 이미지 검증(비율 일치 + 저해상도 경고)');

// ── 예약 섹션 도우미 ──
ok(reservedSections().some((r) => r.key === 'dedication' && r.zone === 'front'), 'reservedSections');
ok(sectionTemplate('preface').includes('## [서문]'), 'sectionTemplate');

// ── 메타 없는 최소 원고 ──
const b2 = parseBookText('## 1장. 시작\n본문.', 'fallback');
ok(b2.fileTitle === 'fallback' && b2.parts[0].chapters[0].blocks[0].text === '본문.', '최소 원고');

console.log(`✅ book-parser.test.js — ${n} 단언 전부 통과`);
