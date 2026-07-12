'use strict';

/**
 * isbn-barcode.js — 의존성 없는 ISBN 바코드 SVG 생성 (EAN-13 + 부가기호 EAN-5).
 *
 * 표지 뒷면(오른쪽 하단) 부착용. 국립중앙도서관 한국문헌번호편람 관행:
 *   ISBN 13자리(EAN-13) + 부가기호 5자리(EAN-5 add-on), OCR-B 계열 숫자 병기.
 * 300dpi 인쇄 기준 실치수: 기본 모듈폭 0.33mm — scale 인자로 확대.
 */

// EAN-13 인코딩 테이블 (7모듈/자리)
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// 첫 자리 → 왼쪽 6자리의 L/G 패턴
const FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
// EAN-5 부가기호: 체크값(=(3×(d1+d3+d5)+9×(d2+d4))%10) → L/G 패턴
const EAN5 = ['GGLLL', 'GLGLL', 'GLLGL', 'GLLLG', 'LGGLL', 'LLGGL', 'LLLGG', 'LGLGL', 'LGLLG', 'LLGLG'];

function cleanDigits(s) { return String(s || '').replace(/[^0-9]/g, ''); }

// ISBN-13 체크디짓 검증(10자리는 13자리로 변환)
function normalizeIsbn13(isbn) {
  let d = cleanDigits(isbn);
  if (d.length === 10) {
    const p = '978' + d.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(p[i], 10) * (i % 2 === 0 ? 1 : 3);
    d = p + ((10 - (sum % 10)) % 10);
  }
  if (d.length !== 13) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(d[i], 10) * (i % 2 === 0 ? 1 : 3);
  if (((10 - (sum % 10)) % 10) !== parseInt(d[12], 10)) return null;
  return d;
}

// EAN-13 모듈열('1'=검정) 생성
function ean13Modules(d13) {
  const first = parseInt(d13[0], 10);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (FIRST[first][i - 1] === 'L' ? L : G)[parseInt(d13[i], 10)];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[parseInt(d13[i], 10)];
  bits += '101';
  return bits; // 95모듈
}

// EAN-5 부가기호 모듈열
function ean5Modules(d5) {
  const check = (3 * (+d5[0] + +d5[2] + +d5[4]) + 9 * (+d5[1] + +d5[3])) % 10;
  const pat = EAN5[check];
  let bits = '01011'; // start guard
  for (let i = 0; i < 5; i++) {
    if (i > 0) bits += '01'; // delineator
    bits += (pat[i] === 'L' ? L : G)[parseInt(d5[i], 10)];
  }
  return bits; // 47모듈
}

/**
 * ISBN(+부가기호) 바코드 SVG.
 * @param {string} isbn  '979-11-1234-567-8' 등 (10/13자리)
 * @param {string} [addon]  부가기호 5자리 (예 '03910') — 없으면 EAN-13만
 * @param {object} [o]  { scale(모듈폭 px, 기본 3), height(바 높이 px, 기본 90), quiet(여백 모듈수, 기본 9) }
 * @returns {{ svg, isbn13, widthPx, heightPx } | null}
 */
function isbnBarcodeSvg(isbn, addon, o = {}) {
  const d13 = normalizeIsbn13(isbn);
  if (!d13) return null;
  const d5 = cleanDigits(addon).length === 5 ? cleanDigits(addon) : null;
  const scale = o.scale || 3;
  const barH = o.height || 90;
  const quiet = (o.quiet == null ? 9 : o.quiet);
  const fontH = Math.round(scale * 7);
  const guardExtra = Math.round(fontH * 0.5); // 가드바는 숫자 영역까지 연장

  const main = ean13Modules(d13);
  const add = d5 ? ean5Modules(d5) : '';
  const addGap = d5 ? 10 : 0; // EAN-13 ↔ 부가기호 간격(모듈)
  const totalModules = quiet + main.length + addGap + add.length + quiet;
  const W = totalModules * scale;
  const H = barH + guardExtra + fontH + Math.round(fontH * 0.6) + (d5 ? fontH : 0);

  const rects = [];
  const bar = (mx, mw, h) => rects.push(`<rect x="${mx * scale}" y="${d5 ? fontH : 0}" width="${mw * scale}" height="${h}"/>`);
  // 가드바 위치(EAN-13): 0-2, 45-49, 92-94 는 연장
  const isGuard = (i) => (i < 3) || (i >= 45 && i < 50) || (i >= 92);
  let x = quiet;
  for (let i = 0; i < main.length;) {
    if (main[i] === '1') {
      let w = 1; while (i + w < main.length && main[i + w] === '1' && isGuard(i + w) === isGuard(i)) w++;
      bar(x + i, w, barH + (isGuard(i) ? guardExtra : 0));
      i += w;
    } else i++;
  }
  const addStart = quiet + main.length + addGap;
  for (let i = 0; i < add.length;) {
    if (add[i] === '1') {
      let w = 1; while (i + w < add.length && add[i + w] === '1') w++;
      bar(addStart + i, w, barH);
      i += w;
    } else i++;
  }

  const mono = `font-family="OCRB, 'OCR-B', Consolas, monospace" font-size="${fontH}px"`;
  const textY = (d5 ? fontH : 0) + barH + guardExtra + fontH - Math.round(fontH * 0.15);
  const texts = [
    `<text x="${(quiet - 1) * scale}" y="${textY}" ${mono} text-anchor="end">${d13[0]}</text>`,
    `<text x="${(quiet + 3 + 21) * scale}" y="${textY}" ${mono} text-anchor="middle">${d13.slice(1, 7)}</text>`,
    `<text x="${(quiet + 50 + 21) * scale}" y="${textY}" ${mono} text-anchor="middle">${d13.slice(7)}</text>`,
    // 하이픈 병기: 한국 ISBN 발행자번호는 2~6자리 가변 — 사용자가 입력한 하이픈 표기가 있으면 그대로,
    // 없을 때만 3-2-4-3-1 고정 분할 폴백(발행자 4자리 가정).
    `<text x="${(quiet + 47) * scale}" y="${textY + fontH + Math.round(fontH * 0.2)}" ${mono} text-anchor="middle">ISBN ${/-/.test(String(isbn)) ? String(isbn).trim().replace(/^ISBN\s*/i, '') : `${d13.slice(0, 3)}-${d13.slice(3, 5)}-${d13.slice(5, 9)}-${d13.slice(9, 12)}-${d13[12]}`}</text>`,
  ];
  if (d5) texts.push(`<text x="${(addStart + add.length / 2) * scale}" y="${fontH - Math.round(fontH * 0.2)}" ${mono} text-anchor="middle">${d5}</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fff"/>
<g fill="#000">${rects.join('')}</g>
${texts.join('\n')}
</svg>`;
  return { svg, isbn13: d13, widthPx: W, heightPx: H };
}

module.exports = { isbnBarcodeSvg, normalizeIsbn13 };
