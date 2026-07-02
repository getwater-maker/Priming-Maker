'use strict';
// node test/book-ui.smoke.js — Electron 앱을 Playwright 로 구동해 출판 모드 E2E 스모크.
//   흐름: 부팅 → 원고 로드(open-book-path) → 📖 출판 탭 → BookView → vivliostyle 미리보기 페이지 수.
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'output', '_book-smoke', 'sample-book.md');

const para = '조선의 밤은 길고 깊었다. 등불 하나에 의지해 역사를 기록하던 사람들이 있었다. '.repeat(5);
fs.mkdirSync(path.dirname(SAMPLE), { recursive: true });
fs.writeFileSync(SAMPLE, `# UI스모크 책
> 저자: 홍길동
> 출판사: 프라이밍북스
> 발행인: 김대표
> 발행일: 2026-08-01
> ISBN: 979-11-0000-000-0
> 정가: 10,000원
> 판형: 46판

## [서문]
서문이다.

## [목차]

## 1장. 하나
${para}

## 2장. 둘
${para}

## [판권]
`, 'utf8');

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, PM_UI_SMOKE: '1' } });
  try {
    const win = await app.firstWindow();
    win.on('console', (m) => { if (m.type() === 'error') console.log('[renderer:error]', m.text()); });
    await win.waitForSelector('h1', { timeout: 20000 });
    console.log('· 부팅 OK:', await win.locator('h1').first().innerText());

    // 원고를 main 에 직접 로드(파일 대화상자 우회) 후 출판 탭 클릭
    const r = await win.evaluate((p) => window.api.openBookPath({ scriptPath: p }), SAMPLE);
    if (!r || !r.dto || r.dto.kind !== 'book') throw new Error('openBookPath 실패: ' + JSON.stringify(r && r.mode));
    console.log('· 원고 로드 OK — 장', r.dto.parts.reduce((n, p) => n + p.chapters.length, 0), '개');

    await win.click('.modetoggle button:has-text("📖 출판")');
    await win.waitForSelector('.bkwrap', { timeout: 10000 });
    console.log('· BookView 렌더 OK');

    // vivliostyle 조판 완료 대기 — .bkpage 에 "N / M쪽"
    await win.waitForFunction(() => {
      const el = document.querySelector('.bkpage');
      return el && /\/\s*\d+쪽/.test(el.textContent);
    }, null, { timeout: 60000 });
    const pageTxt = await win.locator('.bkpage').innerText();
    console.log('· 미리보기 조판 OK —', pageTxt.trim());

    // 안정성 — 조판 완료 후 재조판 루프(깜빡임)가 없어야 한다.
    //   busy 표시("조판 중…")가 3초 동안 다시 켜지지 않는지 샘플링.
    let relayouts = 0;
    for (let i = 0; i < 12; i++) {
      const busy = await win.evaluate(() => {
        const el = document.querySelector('.bkbar .meta');
        return el ? /조판 중/.test(el.textContent) : false;
      });
      if (busy) relayouts++;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (relayouts > 0) throw new Error(`재조판 루프 감지 — 3초간 "조판 중" ${relayouts}회 (깜빡임 버그)`);
    console.log('· 안정성 OK — 3초간 재조판 없음(루프 해소)');

    // 미리보기(iframe 격리) 안에 실제 페이지 DOM + 소스매핑 존재?
    const nSrc = await win.evaluate(() => {
      const f = document.querySelector('iframe.bkviewport');
      return f && f.contentDocument ? f.contentDocument.querySelectorAll('[data-src-line]').length : -1;
    });
    console.log('· 소스매핑 블록(iframe):', nSrc, '개');
    if (nSrc < 1) throw new Error('data-src-line 블록 없음 — 클릭-편집 불가');

    // 클릭-편집 왕복 — 본문 문단 클릭(iframe 내부) → 편집창 → 저장 → 원본 .md 반영 확인
    await win.evaluate(() => {
      const f = document.querySelector('iframe.bkviewport');
      const els = f.contentDocument.querySelectorAll('p[data-src-line]');
      for (const el of els) { if (el.textContent.includes('조선의 밤')) { el.click(); return; } }
      throw new Error('본문 문단을 못 찾음');
    });
    await win.waitForSelector('.bkedit textarea', { timeout: 5000 });
    await win.fill('.bkedit textarea', '오타를 고친 새 문장이다.');
    await win.click('.bkedit button:has-text("저장")');
    await win.waitForFunction(() => !document.querySelector('.bkedit'), null, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800)); // 파일 쓰기 여유
    const saved = fs.readFileSync(SAMPLE, 'utf8');
    if (!saved.includes('오타를 고친 새 문장이다.')) throw new Error('편집이 원본 .md 에 저장되지 않음');
    console.log('· 클릭-편집 → 원본 .md 저장 OK');

    // 재조판 완료 대기(편집 반영)
    await win.waitForFunction(() => {
      const el = document.querySelector('.bkpage');
      return el && /\/\s*\d+쪽/.test(el.textContent);
    }, null, { timeout: 60000 });

    // ── 다중 파일 원고 (삼국지 필수파일+회차) — 원고가 있을 때만 ──
    const DATA = 'D:/PrimingBook/book-publishing/data';
    if (fs.existsSync(path.join(DATA, '삼국지연의_1권_필수파일.md'))) {
      const multi = [path.join(DATA, '삼국지연의_1권_필수파일.md')];
      for (let i = 1; i <= 15; i++) multi.push(path.join(DATA, `출판_삼국지_제${String(i).padStart(3, '0')}회.md`));
      const rm = await win.evaluate((ps) => window.api.openBookPath({ scriptPaths: ps }), multi);
      if (!rm || !rm.dto || rm.dto.kind !== 'book') throw new Error('다중 파일 열기 실패');
      const chN = rm.dto.parts.reduce((n, p) => n + p.chapters.length, 0);
      if (chN !== 15) throw new Error(`다중 파일 장 수 ${chN} ≠ 15`);
      console.log('· 다중 파일(삼국지 16개) 로드 OK — 장', chN, '개, 제목:', rm.dto.fileTitle);
      // IPC 직접 호출은 React dto 를 안 바꾸므로 실사용처럼 모드 토글로 재로드
      await win.click('.modetoggle button:has-text("롱폼")');
      await win.waitForTimeout(800);
      try {
        await win.click('.modetoggle button:has-text("📖 출판")', { timeout: 15000 });
      } catch (e) {
        await win.screenshot({ path: path.join(ROOT, 'output', '_book-multi', 'ui-fail.png') });
        console.log('[debug] 출판 탭 클릭 실패 — 화면:', await win.evaluate(() => ({
          buttons: [...document.querySelectorAll('.modetoggle button')].map((b) => b.textContent),
          hasBody: !!document.querySelector('#body'),
        })).catch(() => 'evaluate 실패'));
        throw e;
      }
      // 조판 완료 대기 — 대작(200쪽+)이 실제 조판됐는지 (이전 14쪽 잔상 배제)
      await win.waitForFunction(() => {
        const el = document.querySelector('.bkpage');
        const m = el && el.textContent.match(/\/\s*(\d+)쪽/);
        return m && parseInt(m[1], 10) > 100;
      }, null, { timeout: 180000 });
      console.log('· 삼국지 미리보기 조판 OK —', (await win.locator('.bkpage').innerText()).trim());
      await win.screenshot({ path: path.join(ROOT, 'output', '_book-multi', 'ui-samgukji.png') });
    } else console.log('⏭ 삼국지 원고 없음 — 다중 파일 케이스 스킵');

    // 스크린샷
    await win.screenshot({ path: path.join(ROOT, 'output', '_book-smoke', 'ui-bookview.png') });
    console.log('✅ book-ui.smoke — 전체 통과 (스크린샷: output/_book-smoke/ui-bookview.png)');
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
