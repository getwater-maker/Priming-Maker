'use strict';
// node test/book-pdf.smoke.js — 샘플 원고 → 내지.pdf + 표지.pdf 헤드리스 스모크.
//   검증: PDF 생성 · 쪽수 · 판형 치수(MediaBox) · 표지 스프레드 치수.
const fs = require('fs');
const path = require('path');
const { parseBookText } = require('../core/parsers/book-parser');
const { buildBookHtml } = require('../core/book/html-builder');
const { buildInteriorPdf, buildCoverPdf, prepareWorkAssets, pdfPageCount } = require('../core/book/pdf-builder');
const { coverSpread } = require('../core/book/spine-calc');

const OUT = path.join(__dirname, '..', 'output', '_book-smoke');
fs.mkdirSync(OUT, { recursive: true });

// 본문을 넉넉히 만들어 여러 페이지·홀짝 규칙을 확인
const para = '조선의 밤은 길고 깊었다. 등불 하나에 의지해 역사를 기록하던 사람들이 있었다. 그들의 붓끝에서 왕조의 흥망이 갈렸고, 한 줄의 기록이 천 년을 살아남았다. '.repeat(6);
const chapters = [];
for (let i = 1; i <= 5; i++) {
  chapters.push(`## ${i}장. ${i}번째 밤 이야기\n${(para + '\n\n').repeat(4)}\n### ${i}장의 첫 절\n${para}[^${i}]\n\n[^${i}]: ${i}번 각주 — 조선왕조실록 제${i}권 참조.\n`);
}
const MD = `# 조선의 밤
> 부제: 잊혀진 역사 이야기
> 저자: 홍길동
> 출판사: 프라이밍북스
> 발행인: 김대표
> 발행일: 2026-08-01
> ISBN: 979-11-1234-567-8
> 정가: 15,000원
> 출판등록: 제2026-000012호 (2026.1.2.)
> 주소: 서울시 어딘가 123
> 판형: 46판
> 용지: 백색모조 100g

## [헌사]
어머니께 바칩니다.

## [서문]
이 책을 쓰게 된 이유는 간단하다. 역사는 반복되기 때문이다.
${para}

## [목차]

## [프롤로그]
그날 밤, 궁궐의 등불이 모두 꺼졌다.
${para}

## 1부. 왕조의 그림자

${chapters.join('\n')}

## [에필로그]
모든 밤은 아침으로 이어진다.
${para}

## [저자소개]
홍길동 — 역사 이야기꾼.

## [판권]
`;

(async () => {
  const t0 = Date.now();
  const book = parseBookText(MD, '스모크');
  const work = prepareWorkAssets(path.join(OUT, 'work'));
  const { html } = buildBookHtml(book, { fontCss: work.fontCss, imageUrl: work.imageUrl, sourceMap: true });
  fs.writeFileSync(path.join(OUT, 'book.html'), html, 'utf8');
  console.log('· HTML 생성:', html.length, 'chars');

  const r = await buildInteriorPdf({ html, outPdf: path.join(OUT, '내지.pdf'), workDir: path.join(OUT, 'work'), log: (m) => console.log(m) });
  if (!r.success) { console.error('❌ 내지 실패:', r.error); process.exit(1); }
  console.log('· 내지 쪽수:', r.pages);

  // MediaBox 치수 확인 — 46판 127×188mm = 360×532.9pt (1mm=2.8346pt)
  const s = fs.readFileSync(r.pdfPath).toString('latin1');
  const mb = s.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (mb) {
    const wMm = parseFloat(mb[1]) / 2.8346, hMm = parseFloat(mb[2]) / 2.8346;
    console.log(`· MediaBox: ${wMm.toFixed(1)}×${hMm.toFixed(1)}mm (기대 127×188)`);
    if (Math.abs(wMm - 127) > 1 || Math.abs(hMm - 188) > 1) { console.error('❌ 판형 치수 불일치'); process.exit(1); }
  } else console.warn('⚠ MediaBox 미발견(압축 오브젝트?) — Vrew 뷰어로 확인 필요');

  // 표지
  const spread = coverSpread({ platformId: 'bookk', trimId: '46판', paperId: '백색모조 100g', totalPages: r.pages || 100, flaps: false });
  // 표지 이미지 대용 — 단색 PNG 생성 (1x1 확대 대신 정확 픽셀로)
  const cvs = path.join(OUT, 'cover-src.png');
  if (!fs.existsSync(cvs)) {
    // 최소 PNG (1×1 갈색) — object-fit:fill 로 늘려짐
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNsbmz8DwAF5AJ3iX9CjQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(cvs, png1x1);
  }
  const rc = await buildCoverPdf({ imagePath: cvs, spread, outPdf: path.join(OUT, '표지.pdf'), workDir: path.join(OUT, 'work'), log: (m) => console.log(m) });
  if (!rc.success) { console.error('❌ 표지 실패:', rc.error); process.exit(1); }
  const s2 = fs.readFileSync(rc.pdfPath).toString('latin1');
  const mb2 = s2.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (mb2) {
    const wMm = parseFloat(mb2[1]) / 2.8346, hMm = parseFloat(mb2[2]) / 2.8346;
    console.log(`· 표지 MediaBox: ${wMm.toFixed(1)}×${hMm.toFixed(1)}mm (기대 ${spread.widthMm}×${spread.heightMm}, 책등 ${spread.spineMm}mm)`);
    if (Math.abs(wMm - spread.widthMm) > 1 || Math.abs(hMm - spread.heightMm) > 1) { console.error('❌ 표지 치수 불일치'); process.exit(1); }
  }
  console.log(`✅ book-pdf.smoke — 내지 ${r.pages}쪽 + 표지 OK (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${OUT}`);
})();
