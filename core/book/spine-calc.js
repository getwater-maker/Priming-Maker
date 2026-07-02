'use strict';

/**
 * spine-calc.js — 책등폭·표지 스프레드 치수 계산.
 *
 * 책등폭(무선제본·양면 인쇄) = (총페이지 ÷ 2) × 낱장두께(mm)
 *   예: 백색모조 100g(0.115mm/장) 300쪽 → 150장 × 0.115 = 17.3mm
 *
 * 표지 스프레드(부크크 규격체크 도구 실측 공식):
 *   전체폭 = bleed + [날개] + 뒤표지(판형폭) + 책등 + 앞표지(판형폭) + [날개] + bleed
 *   전체높이 = 판형높이 + bleed×2
 */

const { getPlatform, getTrim, getPaper } = require('./platform-presets');

// mm → px (dpi 기준, 300dpi: 1mm = 11.811px)
function mmToPx(mm, dpi = 300) { return Math.round((mm / 25.4) * dpi); }

// 책등폭(mm) — 소수 1자리 반올림.
function spineWidthMm(totalPages, paperId) {
  const paper = getPaper(paperId);
  const sheets = Math.ceil((Number(totalPages) || 0) / 2);
  return Math.round(sheets * paper.sheetMm * 10) / 10;
}

/**
 * 표지 스프레드 치수 계산.
 * @returns {{ spineMm, widthMm, heightMm, widthPx, heightPx, dpi, parts }}
 *   parts = 왼쪽부터 각 구간 폭(mm) — 가이드 렌더링용.
 */
function coverSpread({ platformId = 'bookk', trimId = 'A5', paperId, totalPages = 0, flaps = false }) {
  const pf = getPlatform(platformId);
  const trim = getTrim(trimId);
  const bleed = pf.coverBleedMm;
  const flap = flaps ? pf.coverFlapMm : 0;
  const spine = spineWidthMm(totalPages, paperId || pf.defaultPaper);

  const widthMm = Math.round((bleed + flap + trim.width + spine + trim.width + flap + bleed) * 10) / 10;
  const heightMm = trim.height + bleed * 2;
  const parts = [];
  parts.push({ name: 'bleed', mm: bleed });
  if (flaps) parts.push({ name: '뒷날개', mm: flap });
  parts.push({ name: '뒤표지', mm: trim.width });
  parts.push({ name: '책등', mm: spine });
  parts.push({ name: '앞표지', mm: trim.width });
  if (flaps) parts.push({ name: '앞날개', mm: flap });
  parts.push({ name: 'bleed', mm: bleed });

  return {
    spineMm: spine,
    widthMm, heightMm,
    widthPx: mmToPx(widthMm, pf.dpi), heightPx: mmToPx(heightMm, pf.dpi),
    dpi: pf.dpi, safeMm: pf.coverSafeMm, toleranceMm: pf.toleranceMm,
    parts,
  };
}

// 첨부한 표지 이미지 치수 검증 — px 를 mm 로 환산해 스프레드 기대치와 비교(±tolerance).
//   dpi 를 모르는 이미지가 많으므로 "가로/세로 비율" + "300dpi 가정 mm" 둘 다 검사해 관대하게 판단.
function validateCoverImage({ imgW, imgH, spread }) {
  const expW = spread.widthMm, expH = spread.heightMm;
  const mmW = (imgW / spread.dpi) * 25.4;
  const mmH = (imgH / spread.dpi) * 25.4;
  const dW = Math.abs(mmW - expW), dH = Math.abs(mmH - expH);
  const tol = Math.max(spread.toleranceMm, 1);
  const exact = dW <= tol && dH <= tol;
  // 비율 검사(±1%) — dpi 가 달라도 비율이 맞으면 스케일 인쇄 가능.
  const ratioOk = Math.abs((imgW / imgH) - (expW / expH)) / (expW / expH) <= 0.01;
  const dpiEff = (imgW / expW) * 25.4; // 폭 기준 실효 dpi
  return {
    ok: exact || ratioOk,
    exact, ratioOk,
    mmW: Math.round(mmW * 10) / 10, mmH: Math.round(mmH * 10) / 10,
    effectiveDpi: Math.round(dpiEff),
    lowDpi: dpiEff < 280, // 300dpi 에 크게 못 미치면 경고
    expected: { widthMm: expW, heightMm: expH, widthPx: spread.widthPx, heightPx: spread.heightPx },
  };
}

module.exports = { mmToPx, spineWidthMm, coverSpread, validateCoverImage };
