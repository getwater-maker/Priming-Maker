/**
 * Genspark AI 이미지 생성 엔진 (genspark.ai/ai_image · Nano Banana 2)
 *
 * 흐름:
 *   1. Playwright 로 genspark.ai/ai_image 진입 (사용자 크롬 프로필 복사 → 로그인 상속)
 *   2. 로그인 상태 확인 — 안 되어 있으면 사용자에게 수동 로그인 요청
 *   3. 세션 1회 셋업: Nano Banana 2 확인 → 설정에서 2K + 16:9 → 자동 프롬프트 OFF
 *   4. 그룹별: 프롬프트 입력 → 전송 → 새 이미지 등장 폴링 → src fetch → 저장
 *
 * 설계:
 *   - grok-engine.js 와 같은 인프라 (chromium.launchPersistentContext, 프로필 복사, 로그인 폴링)
 *   - Genspark 은 채팅 스레드형 — 같은 스레드에서 프롬프트만 순차 제출 (셋업 1회)
 *   - 결과 이미지는 인증된 직접 URL (https://www.genspark.ai/api/files/s/{id}) →
 *     page.context().request.get(src) 로 바이트 fetch (Grok 의 video src fallback 과 동일 패턴)
 *
 * ⚠️ Genspark 은 React SPA 라 칩/옵션이 모두 div (표준 button 아님). 셀렉터는 클래스+텍스트
 *    매칭 기반이며 사이트 UI 변경 시 GENSPARK_SELECTORS 한 곳만 수정하면 됨. (라이브 캡처 2026-06-01)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GensparkStore = require('./tts/genspark-store');

// 사용자 데이터 디렉토리 (Flow/Grok 프로필과 분리)
const PROFILE_BASE = path.join(os.homedir(), '.flow-app', 'genspark-profiles');
const GENSPARK_URL = 'https://www.genspark.ai/ai_image';

// genspark.ai/ai_image 의 이미지 생성 흐름 selector (라이브 DOM 캡처 2026-06-01 기반).
const GENSPARK_SELECTORS = {
  // 모델 칩 — 텍스트 "Nano Banana 2" (기본 선택). model-button 은 설정/스타일 칩도 공유하므로 텍스트로 식별.
  modelButton:      'div.model-button',
  // 설정 칩 — 클릭하면 이미지 크기 / 종횡비 팝오버 열림
  settingButton:    'div.setting-button',
  // 이미지 크기 옵션 — 자식 span 텍스트 "자동"/"0.5K"/"1K"/"2K"/"4K", 선택됨 = .size-option.selected
  sizeOption:       'div.size-options div.size-option',
  sizeSelected:     'div.size-option.selected',
  // 종횡비 옵션 — 자식 div.ratio-label 텍스트 "16:9" 등, 선택됨 = .ratio-option.selected
  ratioOption:      'div.ratio-grid div.ratio-option',
  ratioSelected:    'div.ratio-option.selected',
  // 자동 프롬프트 토글 — class 에 'active' 있으면 ON. 클릭해서 OFF.
  autoPromptToggle: 'div.reflection-toggle.tooltip-wrapper',
  // 프롬프트 입력란 (React 제어 textarea)
  promptInput:      'textarea.search-input.j-search-input, textarea.search-input',
  // ★ 전송 버튼 — 텍스트가 있으면 .input-icon 안에 .enter-icon(검은 ↵ 원형)이 나타남.
  //   ⚠️ right-icon-group 의 다른 cursor-pointer 는 '마이크'(음성입력 → speakly.ai 로 이동) 라 절대 누르면 안 됨.
  //   반드시 .enter-icon / .input-icon 만 타겟. (라이브 검증 2026-06-01)
  sendButton:       'div.right-icon-group div.enter-icon, div.right-icon-group div.input-icon',
  // 생성 결과 이미지 — 인증된 직접 URL (context.request.get 으로 fetch 가능)
  resultImg:        'img[src*="/api/files/s/"]',
  // 로그인 안 됨 감지
  loginIndicator:   'a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("로그인")',
};

/**
 * 사용자의 기본 크롬 프로필을 genspark-profiles/userchrome/ 으로 한 번 복사.
 * grok-engine 과 동일 패턴 (별도 디렉토리 — 동시 실행 시 프로필 잠금 충돌 방지).
 * 이미 복사된 흔적(Cookies)이 있으면 건너뜀. 부분 실패/폴더 없음이면 null → 격리 프로필 폴백.
 */
async function _ensureUserChromeProfileCopy(log) {
  const targetDir = path.join(PROFILE_BASE, 'userchrome');
  const targetCookies = path.join(targetDir, 'Default', 'Cookies');
  if (fs.existsSync(targetCookies)) return targetDir;   // 이미 복사 완료 — 건너뜀

  const sourceUserData = path.join(os.homedir(),
    'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  if (!fs.existsSync(sourceUserData)) {
    log('[Genspark] 사용자 크롬 프로필 폴더 없음 — 격리 프로필 사용');
    return null;
  }

  log('[Genspark] 첫 실행: 사용자 크롬 프로필을 복사합니다 (10~30초). 크롬을 닫아두면 더 안전합니다...');
  const targetDefault = path.join(targetDir, 'Default');
  fs.mkdirSync(targetDefault, { recursive: true });

  const ESSENTIAL = [
    'Cookies', 'Cookies-journal',
    'Login Data', 'Login Data-journal',
    'Preferences', 'Bookmarks',
    'Local Storage', 'Session Storage',
    'History', 'Network',
  ];
  for (const item of ESSENTIAL) {
    const src = path.join(sourceUserData, 'Default', item);
    const dst = path.join(targetDefault, item);
    try {
      if (!fs.existsSync(src)) continue;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
      else fs.copyFileSync(src, dst);
    } catch (e) {
      log(`[Genspark]   ${item} 복사 스킵: ${e.message}`);
    }
  }
  try {
    const ls = path.join(sourceUserData, 'Local State');
    if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(targetDir, 'Local State'));
  } catch {}

  if (fs.existsSync(targetCookies)) {
    log('[Genspark] 프로필 복사 완료 — 평소 크롬 로그인 세션이 따라옵니다.');
    return targetDir;
  }
  log('[Genspark] Cookies 복사 실패 (크롬 실행 중일 수 있음) — 격리 프로필 사용. 첫 실행 시 Genspark 로그인 필요.');
  return null;
}

/** 이미지 버퍼에서 width/height 추출 (PNG IHDR / JPEG SOF). 실패 시 null. */
function _readImageSize(b) {
  try {
    // PNG: 89 50 4E 47 ... IHDR width@16 height@20 (BE)
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // JPEG: FF D8 ... SOFn(FFC0..FFCF except C4/C8/CC) → [len2][prec1][h2][w2]
    if (b[0] === 0xFF && b[1] === 0xD8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1];
        const isSOF = (m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
        if (isSOF) {
          return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
        }
        const len = (b[i + 2] << 8) | b[i + 3];
        if (len <= 0) break;
        i += 2 + len;
      }
    }
  } catch (_) {}
  return null;
}

class GensparkEngine {
  constructor(opts = {}) {
    this.profileId = opts.profileId || 'default';
    this.profileDir = null;
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.context = null;
    this.page = null;
    this._setupDone = false;   // 세션 1회 셋업 (2K/16:9/자동프롬프트OFF) 완료 플래그
  }

  log(msg) { this.logger(msg); }

  /** 떠있는 모달/다이얼로그가 클릭을 가로채면 ESC 로 닫기 (제네릭) */
  async _dismissAnyDialog() {
    try {
      const sel = '[role="dialog"][data-state="open"], [data-state="open"][role="dialog"], .modal.show, [aria-modal="true"]';
      let dialog = await this.page.$(sel);
      let attempts = 0;
      while (dialog && attempts < 3) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(400);
        dialog = await this.page.$(sel);
        attempts++;
      }
      if (attempts > 0) this.log(`[Genspark] dialog 닫음 (ESC ${attempts}회)`);
    } catch {}
  }

  async start() {
    // 페이지가 닫혔으면 컨텍스트도 폐기 후 재시작
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      try { await this.context?.close(); } catch {}
      this.context = null;
      this.page = null;
      this._setupDone = false;
    }
    if (this.context) return;

    if (!this.profileDir) {
      if (this.profileId === 'default') {
        const userCopy = await _ensureUserChromeProfileCopy(this.log.bind(this)).catch(() => null);
        this.profileDir = userCopy || path.join(PROFILE_BASE, 'default');
      } else {
        this.profileDir = path.join(PROFILE_BASE, this.profileId);
      }
    }

    fs.mkdirSync(this.profileDir, { recursive: true });
    try {
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(this.profileDir, lock);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    this.log('[Genspark] 브라우저 시작 (Genspark AI 이미지)...');
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: null,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await this.page.goto(GENSPARK_URL, { waitUntil: 'load', timeout: 30000 });
    await this.page.waitForTimeout(3000);
    await this._dismissAnyDialog();

    // 로그인 상태 확인
    const loginIndicator = await this.page.$(GENSPARK_SELECTORS.loginIndicator);
    if (loginIndicator) {
      this.log('[Genspark] 로그인이 필요합니다. 브라우저에서 Genspark 계정으로 로그인하세요. (한 번 로그인하면 이후엔 자동)');
      await this.page.waitForFunction(
        () => !document.querySelector('a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in")'),
        { timeout: 300000 }
      ).catch(() => {});
      this.log('[Genspark] 로그인 감지 — 진행합니다.');
    } else {
      this.log('[Genspark] 이미 로그인되어 있습니다.');
    }
  }

  async stop() {
    if (this.context) {
      try { await this.context.close(); } catch {}
      this.context = null;
      this.page = null;
      this._setupDone = false;
    }
  }

  /**
   * Genspark 로그인 페이지로 이동 — 사용자가 미리 로그인해두는 용도.
   * 자동화 크롬 시작 후 genspark.ai 로그인 페이지로 직행.
   * 이미 로그인돼 있으면 genspark 이 자동으로 메인 페이지로 redirect.
   */
  async openLoginPage() {
    await this.start();   // 브라우저 시작 (start 가 ai_image 까지 이동 + 로그인 체크)
    // start() 가 이미 로그인 상태 확인을 함. 로그인 안 됐으면 사용자가 그 창에서 로그인하면 됨.
  }

  /**
   * 설정 적용: Nano Banana 2 확인 → 설정에서 2K + 16:9 → 자동 프롬프트 OFF.
   * ⚠️ 매 생성마다 호출해야 함 — Genspark 은 첫 제출 후 채팅 스레드로 넘어가면서
   *    크기/종횡비가 기본값(자동/정사각형)으로 리셋되기 때문. (그룹1만 16:9, 그룹2+ 정사각형 버그 해소)
   * 각 단계는 실패해도 throw 하지 않고 로그 후 진행 (셀렉터 취약성 대비).
   * @param {boolean} verbose 첫 호출만 상세 로그 (반복 호출은 간결하게)
   */
  async _applySettings(verbose = true) {
    const cfg = GensparkStore.load();
    // 적용 결과(팝오버 안에서 바로 확인) — 끝에 반환해서 호출부가 재오픈 없이 검증에 사용.
    let _sizeOk = false, _sizeSel = '', _ratioOk = false, _ratioSel = '';
    await this._dismissAnyDialog();

    // 1. 모델 확인 (Nano Banana 2 가 기본 선택 — 검증만, 아니면 경고)
    try {
      const modelTexts = await this.page.$$eval(GENSPARK_SELECTORS.modelButton,
        els => els.map(e => (e.textContent || '').trim()));
      const hasNB2 = modelTexts.some(t => /Nano Banana 2/i.test(t));
      if (!hasNB2) this.log(`[Genspark] ⚠️ Nano Banana 2 모델 칩 못 찾음 (현재: ${modelTexts.join(' / ').slice(0, 60)}) — 그대로 진행`);
      else if (verbose) this.log('[Genspark] 모델: Nano Banana 2 확인');
    } catch (e) {
      this.log(`[Genspark] 모델 확인 예외(무시): ${e.message}`);
    }

    // 2. 설정 팝오버 열기 — 옵션이 실제로 보일 때까지 대기 (애니메이션/리렌더 대비). 안 열리면 1회 재시도.
    try {
      const settingBtn = this.page.locator(GENSPARK_SELECTORS.settingButton).first();
      let opened = false;
      for (let attempt = 0; attempt < 2 && !opened; attempt++) {
        await settingBtn.click({ timeout: 5000 }).catch(() => {});
        opened = await this.page.waitForSelector(GENSPARK_SELECTORS.sizeOption, { timeout: 3500, state: 'visible' })
          .then(() => true).catch(() => false);
      }
      await this.page.waitForTimeout(400);  // 옵션 위치 안정화
      if (!opened) this.log('[Genspark] ⚠️ 설정 팝오버 옵션이 안 보임 — 그래도 시도');
    } catch (e) {
      this.log(`[Genspark] ⚠️ 설정 버튼 클릭 실패: ${e.message}`);
    }

    // 3. 이미지 크기 선택 (cfg.imageSize = '2K') — 검증 후 안 맞으면 1회 재클릭
    try {
      const sizeLoc = this.page.locator(GENSPARK_SELECTORS.sizeOption, { hasText: cfg.imageSize });
      if (await sizeLoc.count()) {
        let sel = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await sizeLoc.first().scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
          try { await sizeLoc.first().click({ timeout: 4000 }); }
          catch (_) { await sizeLoc.first().click({ timeout: 4000, force: true }).catch(() => {}); }
          await this.page.waitForTimeout(300);
          sel = await this.page.$eval(GENSPARK_SELECTORS.sizeSelected, el => (el.textContent || '').trim()).catch(() => '');
          if (sel.includes(cfg.imageSize)) break;
        }
        _sizeSel = sel; _sizeOk = sel.includes(cfg.imageSize);
        if (verbose || !sel.includes(cfg.imageSize)) {
          this.log(`[Genspark] 이미지 크기: ${cfg.imageSize} 선택 (현재 선택=${sel || '?'})`);
        }
      } else {
        this.log(`[Genspark] ⚠️ 크기 옵션 '${cfg.imageSize}' 못 찾음 — 기본값 유지`);
      }
    } catch (e) {
      this.log(`[Genspark] ⚠️ 크기 선택 실패: ${e.message}`);
    }

    // 4. 종횡비 선택 — 프로젝트 비율(쇼츠=9:16) override 우선, 없으면 cfg.ratio(기본 16:9).
    const _ratio = this._aspectRatio || cfg.ratio || '16:9';
    try {
      const ratioLoc = this.page.locator(GENSPARK_SELECTORS.ratioOption, { hasText: _ratio });
      if (await ratioLoc.count()) {
        let sel = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await ratioLoc.first().scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
          try { await ratioLoc.first().click({ timeout: 4000 }); }
          catch (_) { await ratioLoc.first().click({ timeout: 4000, force: true }).catch(() => {}); }
          await this.page.waitForTimeout(300);
          sel = await this.page.$eval(GENSPARK_SELECTORS.ratioSelected, el => (el.textContent || '').trim()).catch(() => '');
          if (sel.includes(_ratio)) break;
        }
        _ratioSel = sel; _ratioOk = sel.includes(_ratio);
        if (verbose || !sel.includes(_ratio)) {
          this.log(`[Genspark] 종횡비: ${_ratio} 선택 (현재 선택=${sel || '?'})`);
        }
      } else {
        this.log(`[Genspark] ⚠️ 종횡비 '${_ratio}' 못 찾음 — 기본값 유지`);
      }
    } catch (e) {
      this.log(`[Genspark] ⚠️ 종횡비 선택 실패: ${e.message}`);
    }

    // 5. 설정 팝오버 닫기
    try {
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(400);
    } catch {}

    // 6. 자동 프롬프트 OFF — class 에 'active' 있으면 클릭해서 제거
    try {
      const toggle = await this.page.$(GENSPARK_SELECTORS.autoPromptToggle);
      if (toggle) {
        let cls = (await toggle.getAttribute('class')) || '';
        if (/\bactive\b/.test(cls)) {
          await toggle.click();
          await this.page.waitForTimeout(400);
          cls = (await toggle.getAttribute('class')) || '';
          if (/\bactive\b/.test(cls)) {
            await toggle.click({ force: true });
            await this.page.waitForTimeout(400);
            cls = (await toggle.getAttribute('class')) || '';
          }
          this.log(/\bactive\b/.test(cls)
            ? '[Genspark] ⚠️ 자동 프롬프트 OFF 적용 실패 (여전히 active) — 그대로 진행'
            : '[Genspark] 자동 프롬프트 OFF 적용');
        } else if (verbose) {
          this.log('[Genspark] 자동 프롬프트 이미 OFF');
        }
      } else {
        this.log('[Genspark] ⚠️ 자동 프롬프트 토글 못 찾음 — 그대로 진행');
      }
    } catch (e) {
      this.log(`[Genspark] ⚠️ 자동 프롬프트 토글 실패: ${e.message}`);
    }

    // 적용 결과 반환 — 팝오버 안에서 이미 확인했으므로 호출부는 재오픈 없이 이 값으로 검증.
    return {
      sizeOk: _sizeOk, ratioOk: _ratioOk,
      sizeSel: _sizeSel, ratioSel: _ratioSel,
      wantSize: cfg.imageSize, wantRatio: (this._aspectRatio || cfg.ratio || '16:9'),
    };
  }

  /** textarea 에 텍스트 채우고 전송. 여러 줄(\n) 도 지원 — React setter 로 값 주입(타이핑 X)
   *  이라 \n 이 Enter 제출로 새지 않음. 단일/배치 공용. (라이브 검증 2026-06-01) */
  async _fillAndSubmit(text) {
    const inputSel = GENSPARK_SELECTORS.promptInput;
    const promptEl = await this.page.$(inputSel);
    if (!promptEl) throw new Error(`프롬프트 입력란 못 찾음 (selector: ${inputSel})`);
    await promptEl.click();
    // React 제어 textarea: native setter 로 값 주입 + input 이벤트 (멀티라인 안전)
    await this.page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel.split(',')[0].trim()) || document.querySelector('textarea.search-input');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { sel: inputSel, val: text });
    await this.page.waitForTimeout(500);
    // 전송 — 텍스트가 들어가면 나타나는 .enter-icon(검은 ↵) 을 기다렸다가 클릭.
    //   ⚠️ 마이크 버튼(speakly.ai 로 이동) 은 절대 누르지 않음 — sendButton 셀렉터가 .enter-icon/.input-icon 만 잡음.
    let submitted = false;
    try {
      const enterBtn = await this.page.waitForSelector(GENSPARK_SELECTORS.sendButton, { timeout: 4000, state: 'visible' });
      if (enterBtn) { await enterBtn.click({ timeout: 5000 }); submitted = true; }
    } catch (e) {
      this.log(`[Genspark] 전송 버튼(enter-icon) 대기/클릭 실패 — Enter 키 백업: ${e.message}`);
    }
    if (!submitted) {
      // 백업: textarea 포커스 후 Enter (Genspark 의 enter-icon = Enter 제출)
      try { await (await this.page.$(inputSel))?.click(); } catch (_) {}
      await this.page.keyboard.press('Enter').catch(() => {});
    }
  }

  /** 결과 이미지 src 를 fetch → 올바른 확장자로 저장 → {path,width,height} 반환. 실패 시 throw. */
  async _fetchAndSave(src, outputPath) {
    const res = await this.page.context().request.get(src);
    if (!res.ok()) throw new Error(`이미지 fetch 실패: HTTP ${res.status()}`);
    const buf = await res.body();
    // Genspark 은 JPEG 를 주는데 outputPath 는 .png — 실제 포맷에 맞춰 확장자 교정
    let finalPath = outputPath;
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      let ext = '';
      if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
      else if (ct.includes('png')) ext = '.png';
      else if (ct.includes('webp')) ext = '.webp';
      else if (buf[0] === 0xFF && buf[1] === 0xD8) ext = '.jpg';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
      else if (buf[0] === 0x52 && buf[8] === 0x57) ext = '.webp';
      if (ext && path.extname(outputPath).toLowerCase() !== ext) {
        finalPath = outputPath.replace(/\.[^.\\/]+$/, '') + ext;
      }
    } catch (_) {}
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, buf);
    const dim = _readImageSize(buf) || { width: 0, height: 0 };
    return { path: finalPath, width: dim.width, height: dim.height };
  }

  /** 현재 결과 이미지 src 를 DOM 순서대로(중복 제거) 반환 — DOM 순서 = 채팅 입력 순서 */
  async _resultSrcsInOrder() {
    const srcs = await this.page.$$eval(GENSPARK_SELECTORS.resultImg, els => els.map(e => e.src)).catch(() => []);
    const seen = new Set(); const out = [];
    for (const s of srcs) { if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
    return out;
  }

  /** 배치 미완료(Failure 타일 등) 시 결과 카드 DOM 구조를 로그로 덤프 — 진단용.
   *  목적: "부분 저장(성공분만 올바른 그룹에)" 개선을 위해 Failure 타일의 정확한 마크업 수집.
   *  실패 상황을 일부러 재현하기 어려우므로, 자연 발생 시 자동으로 로그에 남긴다. */
  async _dumpResultCards() {
    try {
      const info = await this.page.evaluate(() => {
        const out = { failures: [], cards: [] };
        // 1) "Failure" 텍스트 요소와 그 부모 체인 (3단계)
        const fe = [...document.querySelectorAll('*')].filter(el =>
          el.children.length === 0 && /^failure$/i.test((el.textContent || '').trim()));
        for (const el of fe.slice(0, 4)) {
          const chain = [];
          let p = el;
          for (let i = 0; i < 4 && p; i++) {
            chain.push(`${p.tagName}.${String(p.className || '').split(/\s+/).slice(0, 2).join('.')}`);
            p = p.parentElement;
          }
          out.failures.push(chain.join(' < '));
        }
        // 2) 결과 이미지의 그리드 컨테이너 추정 → 카드들을 순서대로 (img 유무 + 텍스트)
        const imgs = [...document.querySelectorAll('img[src*="/api/files/s/"]')];
        if (imgs.length) {
          let grid = imgs[imgs.length - 1].parentElement;
          for (let i = 0; i < 6 && grid; i++) {
            const kids = [...grid.children];
            if (kids.length >= 2 && kids.filter(k => k.querySelector && (k.querySelector('img[src*="/api/files/s/"]') || /failure/i.test(k.textContent || ''))).length >= 2) break;
            grid = grid.parentElement;
          }
          if (grid) {
            out.gridClass = String(grid.className || '').slice(0, 60);
            out.cards = [...grid.children].slice(-12).map((k, idx) => ({
              i: idx,
              cls: String(k.className || '').split(/\s+/).slice(0, 2).join('.'),
              img: !!(k.querySelector && k.querySelector('img[src*="/api/files/s/"]')),
              txt: (k.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
            }));
          }
        }
        return out;
      });
      if (info.failures.length) this.log(`[Genspark] [DUMP Failure타일] ${info.failures.join(' || ')}`);
      if (info.cards.length) this.log(`[Genspark] [DUMP 결과카드] grid=${info.gridClass || '?'} cards=${JSON.stringify(info.cards)}`);
      if (!info.failures.length && !info.cards.length) this.log('[Genspark] [DUMP] Failure 타일/결과 그리드 미검출');
    } catch (e) {
      this.log(`[Genspark] [DUMP] 결과카드 덤프 실패(무시): ${e.message}`);
    }
  }

  /** 사용 한도/차단/플랜 관련 안내 메시지 감지 — 발견 시 텍스트 반환, 없으면 null.
   *  (예: "5시간 제한에 근접했습니다.", "limit reached", "더 이상 ..." 등) */
  async _detectLimitMessage() {
    try {
      return await this.page.evaluate(() => {
        const RE = /(한도|제한|사용량|초과|남은|limit|quota|credit|too many|rate.?limit|upgrade|플랜|업그레이드|내일|reset)/i;
        const sels = '[role="alert"],[role="status"],[class*="toast" i],[class*="error" i],[class*="limit" i],[class*="banner" i],[class*="notice" i],[class*="warn" i]';
        for (const el of Array.from(document.querySelectorAll(sels))) {
          const t = (el.textContent || '').trim();
          if (t && t.length < 140 && RE.test(t)) return t;
        }
        return null;
      });
    } catch (_) { return null; }
  }

  /**
   * 프롬프트 N개 → 이미지 N장 한 번에 생성 (줄바꿈으로 나열 → Genspark 이 줄당 1장).
   * 결과는 입력 순서대로 매핑 (DOM 순서 = 입력 순서, 라이브 검증 2026-06-01).
   * @param {object} args
   *   prompts     : string[] 각 줄 = 한 이미지 프롬프트
   *   outputPaths : string[] prompts 와 1:1 (절대경로)
   *   abortSignal : () => boolean
   * @returns Array< { path?, width?, height?, error? } >  (prompts 와 같은 길이/순서)
   */
  async generateImagesBatch({ prompts, outputPaths, abortSignal, onSaved }) {
    const N = prompts.length;
    const fail = (msg) => prompts.map(() => ({ error: msg }));

    const limit = GensparkStore.checkDailyLimit();
    if (!limit.allowed) return fail(limit.reason);
    if (!N) return [];

    // 브라우저 + 설정 보장
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      try { await this.context?.close(); } catch {}
      this.context = null; this.page = null;
    }
    await this.start();
    if (abortSignal && abortSignal()) return fail('사용자 중단');

    // 설정(크기/비율) 확정 — _applySettings 가 팝오버 안에서 바로 확인한 결과를 그대로 사용.
    //   (별도 재오픈 검증은 불필요한 추가 클릭이라 제거 — 적용 단계에서 이미 .selected 확인함)
    //   1K/16:9 가 맞을 때까지 최대 3회 재적용. 끝내 안 되면 이 배치를 생성하지 않고 실패 반환
    //   → 잘못된 크기 이미지가 폴더에 섞이는 미스매치 원천 차단.
    let _verified = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      _verified = await this._applySettings(!this._appliedOnce);
      this._appliedOnce = true;
      if (abortSignal && abortSignal()) return fail('사용자 중단');
      if (_verified && _verified.sizeOk && _verified.ratioOk) {
        if (attempt > 1) this.log(`[Genspark] ✅ 설정 확인: 크기=${_verified.sizeSel} · 비율=${_verified.ratioSel}`);
        break;
      }
      this.log(`[Genspark] ⚠️ 설정 미일치 (시도 ${attempt}/3) — 크기=${(_verified && _verified.sizeSel) || '?'}(원함 ${_verified && _verified.wantSize}) · 비율=${(_verified && _verified.ratioSel) || '?'}(원함 ${_verified && _verified.wantRatio}) — 재적용`);
      if (abortSignal && abortSignal()) return fail('사용자 중단');
    }
    if (!_verified || !_verified.sizeOk || !_verified.ratioOk) {
      const msg = `Genspark 설정 적용 실패 (원함 ${_verified ? _verified.wantSize : '1K'}/${_verified ? _verified.wantRatio : '16:9'} · 실제 크기=${_verified ? (_verified.sizeSel || '?') : '?'}/비율=${_verified ? (_verified.ratioSel || '?') : '?'}) — 잘못된 크기 방지 위해 이 배치를 생성하지 않음`;
      this.log(`[Genspark] ❌ ${msg}`);
      return fail(msg);
    }
    if (abortSignal && abortSignal()) return fail('사용자 중단');

    const t0 = Date.now();
    try {
      // 제출 전 기존 이미지 스냅샷
      const beforeSrcs = new Set(await this._resultSrcsInOrder());

      // 줄바꿈으로 나열해 한 번에 제출
      await this._fillAndSubmit(prompts.join('\n'));
      this.log(`[Genspark] ${N}개 프롬프트 한 번에 제출 — ${N}장 대기`);

      // N 장 새 이미지 등장 폴링
      const POLL = 3000;
      const TIMEOUT_MS = Math.max(4 * 60 * 1000, N * 45 * 1000);
      const GRACE_MS = 180 * 1000;   // 막판 1~2장만 남았을 때 추가로 더 기다리는 유예 (안정 우선 — 미스매치 방지)
      const startedAt = Date.now();
      let newSrcs = [];
      let limitMsg = null;
      let _gracedLogged = false;
      while (true) {
        if (abortSignal && abortSignal()) return fail('사용자 중단');
        await this.page.waitForTimeout(POLL);
        newSrcs = (await this._resultSrcsInOrder()).filter(s => !beforeSrcs.has(s));
        const elapsedMs = Date.now() - startedAt;
        const elapsed = Math.round(elapsedMs / 1000);
        if (newSrcs.length >= N) {
          // 안정화: 한 번 더 확인 (로딩 중 transient 회피)
          await this.page.waitForTimeout(1500);
          newSrcs = (await this._resultSrcsInOrder()).filter(s => !beforeSrcs.has(s));
          if (newSrcs.length >= N) { this.log(`[Genspark] ${newSrcs.length}장 감지 (${elapsed}초)`); break; }
        }
        // 진전이 없으면(이미지 0장) 사용 한도/제한 메시지 감지 → 조기 중단(4분 낭비 방지)
        if (newSrcs.length === 0 && elapsed >= 30) {
          const msg = await this._detectLimitMessage();
          if (msg) {
            limitMsg = msg;
            this.log(`[Genspark] ⚠️ 사용 한도/제한 메시지 감지: "${msg}"`);
            break;
          }
        }
        // ⏱ 막판 유예 — 5장(N-1) 이상 완료됐는데 마지막 1~2장이 안 끝나면, 기본 타임아웃에서
        //   멈추지 말고 GRACE_MS 까지 더 기다린다. (이전: 6장 중 5장 떠도 타임아웃에 6장 통째로 버림)
        const almostDone = N >= 2 && newSrcs.length >= N - 1;
        const effTimeout = almostDone ? TIMEOUT_MS + GRACE_MS : TIMEOUT_MS;
        if (almostDone && elapsedMs >= TIMEOUT_MS && !_gracedLogged) {
          _gracedLogged = true;
          this.log(`[Genspark] 막판 ${N - newSrcs.length}장 대기 — 최대 ${Math.round(GRACE_MS / 1000)}초 추가 유예 (배치 통째 버림 방지)`);
        }
        if (elapsedMs >= effTimeout) break;
        this.log(`[Genspark] 배치 생성 대기... ${newSrcs.length}/${N} (${elapsed}초)`);
      }

      if (newSrcs.length < N) {
        // 개수 불일치 → 순서 매핑 신뢰 불가. 안전하게 전체 실패 처리(오매칭 방지 — 재시도 권장).
        // 진단: Failure 타일/결과 카드 구조를 로그에 남김 → "성공분만 부분 저장" 개선의 근거 수집.
        await this._dumpResultCards();
        if (limitMsg) {
          return fail(`Genspark 사용 한도/제한으로 보임: "${limitMsg}" — 잠시 후(보통 몇 시간) 다시 시도하세요.`);
        }
        return fail(`배치 미완료 — ${N}장 중 ${newSrcs.length}장만 확인 (재시도 필요)`);
      }

      // 입력 순서대로 매핑해 저장 (newSrcs 는 DOM 순서 = 입력 순서)
      const results = [];
      for (let i = 0; i < N; i++) {
        try {
          const r = await this._fetchAndSave(newSrcs[i], outputPaths[i]);
          GensparkStore.markUsed();
          results.push(r);
          if (r && r.path && onSaved) { try { onSaved(i, r.path); } catch {} } // 저장 즉시 매핑 통지
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      const okCount = results.filter(r => r.path).length;
      const dim0 = results.find(r => r.width);
      this.log(`[Genspark] ✅ 배치 저장 ${okCount}/${N}${dim0 ? ` · 크기 ${dim0.width}x${dim0.height} (비율 ${(dim0.width / dim0.height).toFixed(2)})` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return results;
    } catch (e) {
      return fail(`Genspark 배치 예외: ${e.message}`);
    }
  }

  /** 프롬프트 1개 → 이미지 1장 (배치의 단일 케이스 래퍼). */
  async generateImage({ prompt, outputPath, abortSignal }) {
    if (!prompt || !prompt.trim()) return { error: '빈 프롬프트' };
    if (!outputPath) return { error: 'outputPath 필수' };
    const [r] = await this.generateImagesBatch({ prompts: [prompt], outputPaths: [outputPath], abortSignal });
    return r || { error: '알 수 없는 오류' };
  }
}

module.exports = { GensparkEngine, GENSPARK_SELECTORS, PROFILE_BASE };
