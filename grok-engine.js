/**
 * Grok Imagine 비디오 변환 엔진 (이미지 → 진짜 움직이는 영상)
 *
 * 흐름:
 *   1. Playwright 로 grok.com Imagine 페이지 진입
 *   2. 로그인 상태 확인 — 안 되어 있으면 사용자에게 수동 로그인 요청
 *   3. 입력 이미지 업로드
 *   4. 모션 프롬프트 입력
 *   5. Generate 클릭 → 폴링으로 완료 대기
 *   6. 완성된 mp4 다운로드 → outputPath 에 저장
 *
 * 인프라:
 *   - flow-engine.js 와 같은 패턴 (chromium.launchPersistentContext)
 *   - anti-detect.js 의 humanDelay / 일일 한도 (별도 store: tts/grok-store.js)
 *   - 로그인 자동화는 미구현 — 첫 실행 시 사용자가 직접 로그인 (이후 세션 유지)
 *
 * ⚠️ Selector TODO — 우토그록 v2.4.0 의 content.js 가 난독화되어 있어
 *    grok.com Imagine 의 정확한 selector 추출 불가. 첫 실행 시 사용자와 함께
 *    DevTools 로 selector 확인 후 GROK_SELECTORS 상수에 채워야 동작.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GrokStore = require('./tts/grok-store');

// 사용자 데이터 디렉토리 (Flow 프로필과 분리)
const PROFILE_BASE = path.join(os.homedir(), '.flow-app', 'grok-profiles');
const GROK_URL = 'https://grok.com/imagine';

// grok.com/imagine 의 비디오 생성 흐름 selector (사용자 DevTools 캡처 2026-05-06 기반).
// 핵심 컨테이너: form 안의 div.flex.flex-wrap.items-center.gap-1.5.px-2.py-2
//   - div:nth-child(1) = Agent (Beta)
//   - div:nth-child(2) = 이미지/비디오 토글 (그 안에 button 두 개)
//   - div:nth-child(3) = 해상도 (480p/720p — 비디오 모드 활성 후 등장)
//   - div:nth-child(4) = 길이 (6s/10s — 비디오 모드 활성 후 등장)
//   - div:nth-child(5) = 비율 dropdown trigger (16:9 등)
const CHIPS_CONTAINER = 'form div.flex.flex-wrap.items-center';

const GROK_SELECTORS = {
  // 텍스트(모션) 입력란 — placeholder "텍스트를 입력하여 상상해 보세요"
  promptInput:       'textarea[placeholder*="입력하여 상상"], textarea[placeholder*="imagine" i], textarea, form [contenteditable="true"]',
  // 이미지 업로드 — 페이지의 hidden input[type=file] 직접 접근
  fileInput:         'input[type="file"]',
  // "비디오" 모드 칩 — chips 컨테이너 안에서 '텍스트'로 탐색 (위치 nth-child 의존 제거).
  //   Grok UI 가 칩 그룹 순서를 자주 바꿔(2026-06: 토글이 child(1)로 이동) nth-child 가 깨짐.
  //   컨테이너 스코프라 바깥의 "Video Game" 추천칩과 안 겹침.
  videoModeChip:     `${CHIPS_CONTAINER} button:has-text("비디오"), ${CHIPS_CONTAINER} button:has-text("Video")`,
  imageModeChip:     `${CHIPS_CONTAINER} button:has-text("이미지"), ${CHIPS_CONTAINER} button:has-text("Image")`,
  // 비디오 전용 옵션 칩 — 비디오 모드 활성 시에만 등장. 위치 무관 텍스트 탐색.
  res480Chip:        `${CHIPS_CONTAINER} button:has-text("480p")`,
  res720Chip:        `${CHIPS_CONTAINER} button:has-text("720p")`,
  dur6sChip:         `${CHIPS_CONTAINER} button:has-text("6s")`,
  dur10sChip:        `${CHIPS_CONTAINER} button:has-text("10s")`,
  // 비율 dropdown 트리거 — chips 컨테이너의 '마지막' 칩 그룹 button (항상 마지막 = 비율).
  //   현재 값(16:9/9:16 등)이 텍스트라 has-text 로는 못 고정 → last-child 로 위치 무관 타게팅.
  aspectChipTrigger: `${CHIPS_CONTAINER} > div:last-child button`,
  // 비율 메뉴 항목 — radix dropdown 펼친 후 그 안의 5번째 항목 = "16:9 Widescreen"
  // (순서: 2:3 Tall, 3:2 Wide, 1:1 Square, 9:16 Vertical, 16:9 Widescreen)
  aspectMenu16x9:    '[role="menu"] > div:nth-child(5), [role="menu"] [role="menuitem"]:nth-child(5), [data-radix-popper-content-wrapper] [role="menuitem"]:nth-child(5)',
  aspectMenuFallback:'[role="menuitem"]:has-text("Widescreen"), [role="option"]:has-text("Widescreen"), [role="menuitem"]:has-text("16:9")',
  // 쇼츠(9:16 Vertical) — 메뉴 4번째 항목
  aspectMenu9x16:    '[role="menu"] > div:nth-child(4), [role="menu"] [role="menuitem"]:nth-child(4), [data-radix-popper-content-wrapper] [role="menuitem"]:nth-child(4)',
  aspectMenu9x16Fallback:'[role="menuitem"]:has-text("Vertical"), [role="option"]:has-text("Vertical"), [role="menuitem"]:has-text("9:16")',
  // Submit — form 안에서만 (form 밖의 다른 button 안 잡힘)
  submitButton:      'form button[type="submit"]',
  // 완성된 video element
  videoElement:      'main article video, main article source[src*=".mp4"]',
  // 다운로드 버튼 (사용자 캡처: 우측 사이드 버튼 그룹의 4번째)
  downloadButton:    'main article div.absolute.\\-right-14 button:nth-child(4), main article button[aria-label*="Download" i], main article button[aria-label*="다운" i]',
  // 로그인 안 됨 감지
  loginIndicator:    'a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("로그인")',
};

/**
 * 사용자의 기본 크롬 프로필을 grok-profiles/userchrome/ 으로 한 번 복사.
 * 이미 복사된 흔적(Cookies 파일)이 있으면 건너뜀 — 매번 작동하지 않고 첫 실행 시만.
 * 복사가 부분 실패하거나 사용자 크롬 폴더가 없으면 null 반환 → 호출부가 격리 프로필로 폴백.
 *
 * 의도: 사용자가 평소 크롬에서 X 계정 (또는 grok.com) 에 이미 로그인돼 있으면
 *       그 쿠키·세션이 따라옴 → PrimingFlow 안에서 별도 X 로그인 불필요.
 *       사용자의 진짜 크롬 폴더는 건드리지 않음 (읽기만).
 */
async function _ensureUserChromeProfileCopy(log) {
  const targetDir = path.join(PROFILE_BASE, 'userchrome');
  const targetCookies = path.join(targetDir, 'Default', 'Cookies');
  if (fs.existsSync(targetCookies)) return targetDir;   // 이미 복사 완료 — 건너뜀

  // Windows 사용자 기본 크롬 프로필 위치
  const sourceUserData = path.join(os.homedir(),
    'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  if (!fs.existsSync(sourceUserData)) {
    log('[Grok] 사용자 크롬 프로필 폴더 없음 — 격리 프로필 사용');
    return null;
  }

  log('[Grok] 첫 실행: 사용자 크롬 프로필을 복사합니다 (10~30초). 크롬을 닫아두면 더 안전합니다...');
  const targetDefault = path.join(targetDir, 'Default');
  fs.mkdirSync(targetDefault, { recursive: true });

  // 핵심 파일/폴더만 복사 (캐시·인덱스 등 큰 폴더 제외 — 빠르고 가벼움)
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
      // Cookies 잠금 등 — 부분 실패는 로그 후 계속 (다른 파일이라도 가져오면 도움)
      log(`[Grok]   ${item} 복사 스킵: ${e.message}`);
    }
  }
  // Local State (필수 — Chrome 부팅에 필요)
  try {
    const ls = path.join(sourceUserData, 'Local State');
    if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(targetDir, 'Local State'));
  } catch {}

  if (fs.existsSync(targetCookies)) {
    log('[Grok] 프로필 복사 완료 — 평소 크롬 로그인 세션이 따라옵니다.');
    return targetDir;
  }
  log('[Grok] Cookies 복사 실패 (크롬 실행 중일 수 있음) — 격리 프로필 사용. 첫 실행 시 X 계정 로그인 필요.');
  return null;
}

class GrokEngine {
  constructor(opts = {}) {
    this.profileId = opts.profileId || 'default';
    // profileDir 는 start() 에서 결정 — profileId='default' 면 사용자 크롬 프로필 복사 시도,
    // 명시적 profileId 면 그 격리 프로필 사용.
    this.profileDir = null;
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.context = null;
    this.page = null;
    this._aspectRatio = null;   // '9:16'(쇼츠) 이면 6s + 9:16 Vertical 강제 (UI 가 생성 전 설정)
  }

  log(msg) { this.logger(msg); }

  /** dialog-portal 의 open backdrop 이 있으면 ESC 로 닫아 클릭 가로챔 방지 */
  async _dismissAnyDialog() {
    try {
      let dialog = await this.page.$('#dialog-portal [data-state="open"]');
      let attempts = 0;
      while (dialog && attempts < 3) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(400);
        dialog = await this.page.$('#dialog-portal [data-state="open"]');
        attempts++;
      }
      if (attempts > 0) this.log(`[Grok] dialog backdrop 닫음 (ESC ${attempts}회)`);
    } catch {}
  }

  // 해상도 칩 선택 — 720p 요청이어도 한도(빨간 계기판 아이콘)로 막혀 비활성이면 480p 로 자동 전환.
  //   영상 생성을 멈추지 않고 480p 로 계속 진행. 반환값 = 실제 선택된 해상도.
  async _selectResolutionChip(want) {
    try {
      if (want !== '720p') {
        const c = await this.page.$(GROK_SELECTORS.res480Chip);
        if (c) { await c.click(); await this.page.waitForTimeout(300); }
        return '480p';
      }
      const chip720 = await this.page.$(GROK_SELECTORS.res720Chip);
      let blocked = false;
      let limitLabel = '';

      // 1순위: 빨간 계기판 aria-label = 가장 신뢰할 수 있는 720p 한도 신호.
      //   (검증됨: 한도여도 720p 칩 자체는 활성 상태라서 칩 검사만으론 못 잡음)
      const lim = await this._check720pLimit();
      if (lim.limited) { blocked = true; limitLabel = lim.label; }

      // 2순위(보조): 칩 자체가 disabled / pointer-events:none / 반투명 / 비활성 래퍼 → 막힘
      if (!blocked && chip720) {
        blocked = await chip720.evaluate(el => {
          const dis = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
          const cs = getComputedStyle(el);
          const noClick = cs.pointerEvents === 'none' || parseFloat(cs.opacity || '1') < 0.5;
          const wrapDis = !!el.closest('[aria-disabled="true"],[disabled]');
          return !!(dis || noClick || wrapDis);
        }).catch(() => false);
      }
      // 3순위(보조): 720p 칩이 아예 안 보이는데 480p 칩은 있으면 = 720p 만 막힌 것 (칩 미로딩과 구분)
      if (!blocked && !chip720) {
        const c480exists = await this.page.$(GROK_SELECTORS.res480Chip);
        blocked = !!c480exists;
      }

      if (blocked) {
        this.log(`[Grok] ⚠️ 720p 한도 감지 — 480p 로 선제 전환 (영상은 계속 생성)${limitLabel ? ` | ${limitLabel}` : ''}`);
        if (!limitLabel) await this._dumpResChips();   // aria-label 못 잡은 경우만 마크업 덤프 (셀렉터 정밀화용)
        const c480 = await this.page.$(GROK_SELECTORS.res480Chip);
        if (c480) { await c480.click(); await this.page.waitForTimeout(300); }
        return '480p';
      }
      await chip720.click();
      await this.page.waitForTimeout(300);
      return '720p';
    } catch (e) {
      this.log(`[Grok] 해상도 칩 선택 예외(무시): ${e.message}`);
      return want;
    }
  }

  // 720p 한도 감지 (검증됨 2026-06-07, openclaude 실측).
  //   grok.com 은 720p 한도 도달 시 칩을 비활성화하지 않는다(720p 칩은 계속 활성/클릭 가능).
  //   대신 입력창 우하단에 빨간 계기판 아이콘을 띄운다:
  //     <button class="... text-fg-danger" aria-label="동영상 (720p, 10초) 생성 한도에 도달했습니다: 오후 6:01에 다시 사용 가능">
  //       <svg class="lucide lucide-gauge"> ... </svg>
  //   → 이 aria-label("한도에 도달") + 빨간 계기판(text-fg-danger)이 유일하게 신뢰할 수 있는 한도 신호.
  //   반환: { limited: boolean, label: string }  (label = aria-label, 재사용 시각 포함)
  async _check720pLimit() {
    try {
      return await this.page.evaluate(() => {
        const gauges = [...document.querySelectorAll('svg.lucide-gauge')];
        for (const g of gauges) {
          const btn = g.closest('button') || g.parentElement;
          const cls = (btn && btn.className) || '';
          const aria = (btn && btn.getAttribute('aria-label')) || '';
          const danger = /text-fg-danger|danger/i.test(cls);
          const limitTxt = /한도에\s*도달|limit\s*reached|generation\s*limit/i.test(aria);
          const is720 = /720p|720/i.test(aria);
          if ((danger || limitTxt) && is720) return { limited: true, label: aria.trim() };
          if (danger && limitTxt) return { limited: true, label: aria.trim() };
        }
        return { limited: false, label: '' };
      });
    } catch (_) {
      return { limited: false, label: '' };
    }
  }

  // 720p 막힘이 의심될 때 해상도 칩 영역 DOM 을 로그로 덤프 — 빨간 계기판 아이콘/disabled 마크업 확인용.
  async _dumpResChips() {
    try {
      const html = await this.page.$eval(
        `${CHIPS_CONTAINER} > div:nth-child(3)`,
        el => (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 400)
      ).catch(() => null);
      if (html) this.log(`[Grok] [DUMP 해상도칩] ${html}`);
    } catch (_) {}
  }

  async start() {
    // 페이지가 닫혔으면 컨텍스트도 폐기 후 재시작
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      try { await this.context?.close(); } catch {}
      this.context = null;
      this.page = null;
    }
    if (this.context) return;

    // 첫 호출 시 profileDir 결정.
    // - profileId='default' (기본): 사용자 크롬 프로필 복사 시도 → 평소 크롬 로그인 세션 활용.
    // - 명시적 profileId: 격리 프로필 (기존 동작 유지).
    if (!this.profileDir) {
      if (this.profileId === 'default') {
        const userCopy = await _ensureUserChromeProfileCopy(this.log.bind(this)).catch(() => null);
        this.profileDir = userCopy || path.join(PROFILE_BASE, 'default');
      } else {
        this.profileDir = path.join(PROFILE_BASE, this.profileId);
      }
    }

    fs.mkdirSync(this.profileDir, { recursive: true });
    // 잠금 파일 제거 (이전 비정상 종료 흔적)
    try {
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(this.profileDir, lock);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    this.log('[Grok] 브라우저 시작 (Grok Imagine)...');
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: null,                                // 시스템 화면 크기 그대로 (축소 방지)
      args: [
        '--start-maximized',                         // 전체 화면으로 시작
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

    await this.page.goto(GROK_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(3000);

    // 페이지 로드 직후 dialog 가 떠있으면 닫기 (광고/안내/Premium 확인 등)
    await this._dismissAnyDialog();

    // 로그인 상태 확인
    const loginIndicator = await this.page.$(GROK_SELECTORS.loginIndicator);
    if (loginIndicator) {
      this.log('[Grok] 로그인이 필요합니다. 브라우저에서 X 계정으로 로그인하세요. (한 번 로그인하면 이후엔 자동)');
      // grok.com 안의 다른 페이지로 이동하면 로그인 완료로 간주 (최대 5분 대기)
      await this.page.waitForFunction(
        () => !document.querySelector('a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in")'),
        { timeout: 300000 }
      ).catch(() => {});
      this.log('[Grok] 로그인 감지 — 진행합니다.');
    } else {
      this.log('[Grok] 이미 로그인되어 있습니다.');
    }
  }

  async stop() {
    if (this.context) {
      try { await this.context.close(); } catch {}
      this.context = null;
      this.page = null;
    }
  }

  /**
   * 그록 로그인 페이지로 이동 — 사용자가 X 계정 로그인 미리 해두는 용도.
   * 자동화 크롬 시작 후 grok.com/login 페이지로 직행.
   * 이미 로그인돼 있으면 grok 이 자동으로 메인 페이지로 redirect.
   */
  async openLoginPage() {
    await this.start();   // 브라우저 시작 (start 가 grok.com/imagine 까지 이동)
    try {
      this.log('[Grok] 로그인 페이지로 이동');
      await this.page.goto('https://grok.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (e) {
      this.log(`[Grok] /login 이동 실패: ${e.message} — 메인 페이지에 머무름`);
    }
  }

  /**
   * 이미지 1장 → 비디오 1개 생성.
   * @param {object} args
   *   imagePath   : 입력 이미지 절대경로
   *   prompt      : 모션 프롬프트 (없으면 grok-store 의 defaultMotionPrompt 사용)
   *   outputPath  : 결과 mp4 저장 경로 (절대)
   *   abortSignal : () => boolean 형태. true 반환 시 중단
   * @returns { success, videoPath?, error? }
   */
  async generateVideoFromImage({ imagePath, prompt, outputPath, abortSignal }) {
    // 1. 일일 한도 체크
    const limit = GrokStore.checkDailyLimit();
    if (!limit.allowed) {
      return { success: false, error: limit.reason };
    }

    // 2. 입력 검증
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { success: false, error: `입력 이미지 없음: ${imagePath}` };
    }
    if (!outputPath) return { success: false, error: 'outputPath 필수' };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const motion = (prompt && prompt.trim()) || limit.cfg.defaultMotionPrompt;

    // 3. 브라우저 시작 보장 (page 가 closed 면 start() 가 자동 재기동)
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      this.log('[Grok] 이전 세션이 닫혀있음 — 재시작');
      try { await this.context?.close(); } catch {}
      this.context = null;
      this.page = null;
    }
    await this.start();
    if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

    try {
      this.log(`[Grok] 비디오 생성 시작 — ${path.basename(imagePath)} · "${motion.substring(0, 40)}"`);

      // 4. /imagine 진입 (이전 결과 페이지 /imagine/post/... 에 있으면 메인으로 이동)
      if (!this.page.url().endsWith('/imagine') && !this.page.url().endsWith('/imagine/')) {
        // waitUntil 'networkidle' → 'load' — Grok SPA 의 background API 호출이 끊이지 않아
      // networkidle 가 timeout 되는 케이스 회피. load 면 DOM 준비됐을 때 즉시 진행.
      await this.page.goto(GROK_URL, { waitUntil: 'load', timeout: 30000 });
        await this.page.waitForTimeout(2000);
      }
      // 진입 후 떠있는 모든 dialog 닫기
      await this._dismissAnyDialog();
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 5. "비디오" 모드 칩 클릭 — 이미지 → 비디오 변환의 핵심
      // 검증: 클릭 후 480p / 6s 같은 비디오 전용 칩이 등장하면 active 성공
      const videoChip = await this.page.$(GROK_SELECTORS.videoModeChip);
      if (!videoChip) {
        return { success: false, error: '"비디오" 칩 못 찾음 (selector: ' + GROK_SELECTORS.videoModeChip + ')' };
      }
      // 첫 시도 — 일반 click. dialog 가 가로채면 force 옵션 사용
      try {
        await videoChip.click({ timeout: 5000 });
      } catch (e) {
        this.log(`[Grok] 비디오 칩 일반 클릭 실패 — force 옵션 재시도: ${e.message}`);
        await this._dismissAnyDialog();
        await videoChip.click({ force: true, timeout: 5000 }).catch(() => {});
      }
      await this.page.waitForTimeout(1500);  // 비디오 모드 옵션 등장 충분히 대기

      const verify = await this.page.$(GROK_SELECTORS.res480Chip)
                  || await this.page.$(GROK_SELECTORS.res720Chip);
      if (verify) {
        this.log('[Grok] "비디오" 모드 활성화 확인 (해상도 칩 등장)');
      } else {
        // 한 번 더
        await this._dismissAnyDialog();
        await videoChip.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(1500);
        const verify2 = await this.page.$(GROK_SELECTORS.res480Chip)
                     || await this.page.$(GROK_SELECTORS.res720Chip);
        if (verify2) {
          this.log('[Grok] "비디오" 모드 활성화 확인 (재시도 후)');
        } else {
          this.log('[Grok] ⚠️ "비디오" 모드 활성 검증 실패 — 그래도 진행');
        }
      }

      // 5-2. 비디오 해상도 / 길이 / 비율 옵션 적용
      // 쇼츠(9:16) 프로젝트면: 길이 6s + 비율 9:16 Vertical 강제. 그 외(롱폼)는 grok-store 설정값.
      const grokCfg = GrokStore.load();
      const _shorts = this._aspectRatio === '9:16';
      // 길이: UI 지정(this._videoDuration) 우선 → 없으면 쇼츠 6s / 롱폼 cfg(기본 10s)
      const _wantDur = (this._videoDuration === '10s' || this._videoDuration === '6s')
        ? this._videoDuration
        : (!_shorts && grokCfg.videoDuration === '10s' ? '10s' : '6s');
      const durChipSel = (_wantDur === '10s') ? GROK_SELECTORS.dur10sChip : GROK_SELECTORS.dur6sChip;
      const aspMenuSel  = _shorts ? GROK_SELECTORS.aspectMenu9x16 : GROK_SELECTORS.aspectMenu16x9;
      const aspFallback = _shorts ? GROK_SELECTORS.aspectMenu9x16Fallback : GROK_SELECTORS.aspectMenuFallback;
      const aspLabel    = _shorts ? '9:16 Vertical' : '16:9 Widescreen';
      const durLabel    = _wantDur;
      try {
        const _actualRes = await this._selectResolutionChip(grokCfg.videoResolution);
        const durChip = await this.page.$(durChipSel);
        if (durChip) { await durChip.click(); await this.page.waitForTimeout(300); }

        // 비율 dropdown 트리거 클릭 → 쇼츠면 9:16 Vertical(4번째), 롱폼이면 16:9 Widescreen(5번째)
        const aspectTrigger = await this.page.$(GROK_SELECTORS.aspectChipTrigger);
        if (aspectTrigger) {
          await aspectTrigger.click();
          await this.page.waitForTimeout(500);
          let menuItem = await this.page.$(aspMenuSel);
          if (!menuItem) menuItem = await this.page.$(aspFallback);   // 텍스트 매칭 폴백
          if (menuItem) {
            await menuItem.click();
            await this.page.waitForTimeout(300);
            this.log(`[Grok] 비율 선택: ${aspLabel}`);
          } else {
            this.log(`[Grok] ⚠️ 비율 메뉴 항목 못 찾음 — 현재 비율 유지 (ESC)`);
            await this.page.keyboard.press('Escape').catch(() => {});
          }
        }
        this.log(`[Grok] 옵션: ${_actualRes} · ${durLabel} · ${aspLabel}${_shorts ? ' (쇼츠)' : ''}`);
      } catch (e) {
        this.log(`[Grok] 비디오 옵션 적용 중 예외 (무시): ${e.message}`);
      }

      // 6. 이미지 업로드 — hidden input[type=file]
      await this._dismissAnyDialog();
      const fileInput = await this.page.$(GROK_SELECTORS.fileInput);
      if (!fileInput) {
        return { success: false, error: `이미지 업로드 input 못 찾음 (selector: ${GROK_SELECTORS.fileInput})` };
      }
      await fileInput.setInputFiles(imagePath);
      await this.page.waitForTimeout(1500);
      this.log(`[Grok] 이미지 업로드: ${path.basename(imagePath)}`);
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 6-b. ⚠️ 720p 한도 재확인 — 이 위치가 핵심.
      //   해상도 선택(5-2, _selectResolutionChip)은 이미지 첨부 *전*이라 빨간 계기판이 아직 안 떠서
      //   한도를 못 본다. 계기판은 이미지 첨부 후에만 등장(openclaude 실측 2026-06-07).
      //   따라서 첨부 직후 다시 확인해서 720p 한도면 480p 로 선제 전환한다.
      if (grokCfg.videoResolution === '720p') {
        const lim2 = await this._check720pLimit();
        if (lim2.limited) {
          this.log(`[Grok] ⚠️ (이미지 첨부 후) 720p 한도 감지 — 480p 로 선제 전환 (영상은 계속 생성) | ${lim2.label}`);
          const c480 = await this.page.$(GROK_SELECTORS.res480Chip);
          if (c480) {
            await c480.click();
            await this.page.waitForTimeout(400);
            this.log('[Grok] 480p 칩 클릭 완료 — 480p 로 진행');
          } else {
            this.log('[Grok] ⚠️ 480p 칩을 못 찾음 — 720p 그대로 진행 (생성 중 자동 강등 안전망에 의존)');
          }
        }
      }

      // 7. 모션 프롬프트 입력 — 일관된 타이핑 페이스.
      //    배경: Playwright keyboard.type 의 { delay } 옵션은 OS 스케줄링 의존이라
      //    자동제작 중(이미지/TTS 동시 진행으로 main thread 부하 ↑) vs 단독 호출 시
      //    실제 페이스가 흐트러져 사용자가 다른 속도로 느낌. 명시적 waitForTimeout 으로
      //    분리해서 부하와 무관한 일정 페이스 보장 (자동제작·선택그룹·범위 모두 동일).
      // 사용자 선택 고정 타이핑 속도 — 길이와 무관하게 글자당 동일 ms (일관성). grok-store.typingSpeed.
      //   'instant'=0(가장 빠름·setter 일괄) / 'fast'=4 / 'normal'=12 / 'slow'=28 ms/char
      const _SPEED_MS = { instant: 0, fast: 4, normal: 12, slow: 28 };
      const TYPING_INTERVAL_MS = _SPEED_MS[grokCfg.typingSpeed] != null ? _SPEED_MS[grokCfg.typingSpeed] : 12;
      const _len = motion.length;
      const promptEl = await this.page.$(GROK_SELECTORS.promptInput);
      if (promptEl) {
        await promptEl.click();
        if (TYPING_INTERVAL_MS === 0) {
          // instant — 한 번에 입력 (글자단위 sleep 없음). 가장 빠름.
          await this.page.keyboard.insertText(motion);
        } else {
          // 글자 단위 타이핑 + 고정 sleep (길이 무관 동일 페이스)
          for (const ch of motion) {
            await this.page.keyboard.type(ch);
            await this.page.waitForTimeout(TYPING_INTERVAL_MS);
          }
        }
        await this.page.waitForTimeout(500);
        this.log(`[Grok] 모션 프롬프트 입력: "${motion.substring(0, 60)}..." (${_len}자, 속도 ${grokCfg.typingSpeed}/${TYPING_INTERVAL_MS}ms)`);
      } else {
        this.log('[Grok] ⚠️ 프롬프트 입력 영역 못 찾음 — 빈 프롬프트로 진행');
      }
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 8. Submit — submit 버튼 우선 + Enter 키 백업 (둘 다 시도해서 robust ↑)
      // 9. URL 이 /imagine/post/<UUID> 로 변경되는 것 감지 (timeout 30→90 초)
      //
      // 이전 30초 timeout 으로 인한 실패가 잦았음:
      //   - Grok 서버 부하 시 submit 응답이 30초 넘김
      //   - submit 버튼 클릭만으로 form 트리거 안 되는 케이스 발견
      //
      // 강화: 첫 시도 실패 시 한 번 더 (페이지 새로고침 + 재시도) — Grok UI 잔여 상태 해소.
      const _trySubmitAndWait = async () => {
        await this._dismissAnyDialog();
        const submitBtn = await this.page.$(GROK_SELECTORS.submitButton);
        if (submitBtn) {
          try { await submitBtn.click(); } catch (_) {}
        }
        // 버튼 클릭 후에도 안 됐을 케이스 대비해서 Enter 도 발사 (이미 페이지 전환된 경우엔 무시됨)
        try { await this.page.keyboard.press('Enter'); } catch (_) {}
        this.log('[Grok] 생성 요청 전송 — 결과 페이지로 이동 대기 (최대 90초)');
        await this.page.waitForURL(/\/imagine\/post\//, { timeout: 90000 });
      };

      try {
        await _trySubmitAndWait();
        this.log(`[Grok] 결과 페이지 진입: ${this.page.url()}`);
      } catch (e) {
        // 1차 실패 — 페이지 새로고침 + 1회 재시도
        this.log(`[Grok] 1차 submit 실패 (${e.message}) — 페이지 새로고침 후 1회 재시도`);
        try {
          await this.page.reload({ waitUntil: 'load', timeout: 30000 });
          await this.page.waitForTimeout(2000);
          // 이 시점 URL 이 결과 페이지(/imagine/post/...) 면 사실은 submit 이 됐는데
          // waitForURL 만 못 잡은 케이스 — 그대로 진행
          if (/\/imagine\/post\//.test(this.page.url())) {
            this.log(`[Grok] reload 후 이미 결과 페이지에 있음: ${this.page.url()}`);
          } else {
            await _trySubmitAndWait();
            this.log(`[Grok] 결과 페이지 진입(재시도): ${this.page.url()}`);
          }
        } catch (e2) {
          return { success: false, error: `결과 페이지로 이동 안 됨 (재시도 후 실패: ${e2.message})` };
        }
      }

      // 10. 비디오 생성 완료 대기 (폴링)
      // 완료 신호: <video> 등장 + downloadButton 클릭 가능
      const POLL_INTERVAL = 5000;
      const TIMEOUT_MS = 5 * 60 * 1000;  // 최대 5분
      const startedAt = Date.now();
      let videoUrl = null;
      // 720p → 480p 강등 감지 — grok.com 의 [role=alert] 토스트("720p rate limit reached. Switched to 480p.")
      // 가 뜨면 grok.com 이 자체적으로 강등해서 영상 만들기 시작함. 우리는 사실 감지만 하면 됨.
      // 한 영상당 한 번만 로그 + 결과에 downgradedTo:'480p' 플래그.
      let _downgradeDetected = false;
      // 동일 https video URL 이 ready 상태로 연속 감지된 횟수 — 프리뷰가 아닌 완성본 확인용
      let stableReady = 0;
      let lastReadyUrl = null;
      while (Date.now() - startedAt < TIMEOUT_MS) {
        if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };
        await this.page.waitForTimeout(POLL_INTERVAL);

        // 토스트 텍스트 감지 — 매 폴링마다 (5초 간격)
        if (!_downgradeDetected) {
          try {
            const toastTexts = await this.page.$$eval('[role="alert"], [role="status"], [data-sonner-toast]',
              els => els.map(e => (e.textContent || '').trim()).filter(t => t.length > 0));
            const hit = toastTexts.find(t => /720p.*rate.*limit.*480p|switched\s+to\s+480p/i.test(t));
            if (hit) {
              _downgradeDetected = true;
              this.log(`[Grok] ⚠️ 720p 한도 도달 — grok.com 이 480p 로 자동 강등 ("${hit.slice(0, 80)}")`);
            }
          } catch (_) { /* 토스트 selector 미존재는 무시 */ }
        }

        // <video> 요소에서 src 추출 시도
        const v = await this.page.$(GROK_SELECTORS.videoElement);
        if (v) {
          const src = await v.getAttribute('src');
          if (src && src.startsWith('http') && !src.includes('blob:')) {
            // blob: 가 아닌 실제 URL 이면 직접 fetch 가능 (동일 URL 반복 로그는 생략)
            if (videoUrl !== src) this.log(`[Grok] video src 감지: ${src.substring(0, 60)}...`);
            videoUrl = src;
          } else if (src) {
            this.log(`[Grok] blob video 감지 — 다운로드 버튼 사용`);
          }
        }

        // 비디오 ready 판정 — 다운로드 버튼과 무관하게 직접 측정.
        // (이전 버그: 생성 중 placeholder 다운로드 → 정적 mp4) 방지: duration>1 + readyState>=2.
        let videoReady = false;
        try {
          videoReady = await this.page.evaluate((sel) => {
            const v = document.querySelector(sel) || document.querySelector('main article video') || document.querySelector('video');
            if (!v || v.tagName !== 'VIDEO') return false;
            const dur = isFinite(v.duration) ? v.duration : 0;
            return v.readyState >= 2 && dur > 1;
          }, GROK_SELECTORS.videoElement);
        } catch { videoReady = false; }

        // ★ 1순위 (화면 구성 변경에 강함): 실제 https video URL + 비디오 ready → 다운로드 버튼 없이 즉시 URL 다운로드.
        //   Grok UI 가 자주 바뀌어 다운로드 버튼 셀렉터가 깨지므로 버튼에 의존하지 않음.
        //   동일 URL 이 2회 연속 ready 로 잡히면(≈10초 안정) 프리뷰가 아닌 완성본으로 보고 다운로드.
        if (videoUrl && videoUrl.startsWith('http') && videoReady) {
          if (videoUrl === lastReadyUrl) stableReady++; else { stableReady = 1; lastReadyUrl = videoUrl; }
          if (stableReady >= 2) {
            try {
              const res = await this.page.context().request.get(videoUrl);
              const buf = await res.body();
              fs.writeFileSync(outputPath, buf);
              GrokStore.markUsed();
              this.log(`[Grok] ✅ video URL 직접 다운로드 (완료 감지): ${outputPath}`);
              return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
            } catch (eDirect) {
              this.log(`[Grok] URL 직접 다운로드 실패 (${eDirect.message}) — 다운로드 버튼으로 폴백`);
            }
          } else {
            this.log(`[Grok] 비디오 ready — 안정성 확인 중 (${stableReady}/2)`);
          }
        } else {
          stableReady = 0;
        }

        // 2순위 (폴백): blob 비디오이거나 URL 직접 다운로드가 안 될 때만 다운로드 버튼 사용.
        const dlBtn = await this.page.$(GROK_SELECTORS.downloadButton);
        let dlEnabled = false;
        if (dlBtn) {
          try { dlEnabled = await dlBtn.isEnabled(); } catch { dlEnabled = false; }
        }
        if (dlBtn && dlEnabled && videoReady) {
          // video src 가 실제 https URL 이면 직접 다운로드 — 버튼 클릭 생략.
          if (videoUrl && videoUrl.startsWith('http')) {
            try {
              const res = await this.page.context().request.get(videoUrl);
              const buf = await res.body();
              fs.writeFileSync(outputPath, buf);
              GrokStore.markUsed();
              this.log(`[Grok] ✅ video URL 직접 다운로드 (버튼 생략): ${outputPath}`);
              return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
            } catch (eDirect) {
              this.log(`[Grok] URL 직접 다운로드 실패 (${eDirect.message}) — 다운로드 버튼으로 폴백`);
            }
          }
          this.log('[Grok] 다운로드 버튼 클릭 (대기 90초)');
          try {
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 90000 }),  // 30초 → 90초
              // click 자체는 5초 안에 안 되면 다음 폴링 사이클로 빠르게 복귀
              // (Playwright 기본 actionTimeout 30초가 disabled 상태에서 까먹는 시간 줄임)
              dlBtn.click({ timeout: 5000 }),
            ]);
            await download.saveAs(outputPath);
            GrokStore.markUsed();
            this.log(`[Grok] ✅ 비디오 저장 완료: ${outputPath}`);
            return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
          } catch (e) {
            this.log(`[Grok] 다운로드 이벤트 timeout — video src fallback 시도: ${e.message}`);
            // fallback A: video element 의 src 가 https URL 이면 직접 fetch
            if (videoUrl && videoUrl.startsWith('http')) {
              try {
                const res = await this.page.context().request.get(videoUrl);
                const buf = await res.body();
                fs.writeFileSync(outputPath, buf);
                GrokStore.markUsed();
                this.log(`[Grok] ✅ video URL 직접 다운로드: ${outputPath}`);
                return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
              } catch {}
            }
            // fallback B: video element 가 blob: 면 페이지 안에서 fetch → base64 → 디스크 저장
            try {
              const base64 = await this.page.evaluate(async () => {
                const v = document.querySelector('main article video, main article source[src*=".mp4"]');
                if (!v) return null;
                const src = v.src || (v.querySelector ? '' : '');
                if (!src) return null;
                const r = await fetch(src);
                const blob = await r.blob();
                return await new Promise((resolve, reject) => {
                  const fr = new FileReader();
                  fr.onload = () => resolve(fr.result);
                  fr.onerror = reject;
                  fr.readAsDataURL(blob);
                });
              });
              if (base64 && base64.includes('base64,')) {
                const pure = base64.split('base64,')[1];
                fs.writeFileSync(outputPath, Buffer.from(pure, 'base64'));
                GrokStore.markUsed();
                this.log(`[Grok] ✅ blob video → base64 저장: ${outputPath}`);
                return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
              }
            } catch (e2) {
              this.log(`[Grok] base64 fallback 실패: ${e2.message}`);
            }
          }
        }

        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        this.log(`[Grok] 생성 대기 중... (${elapsed}초)`);
      }

      // <video> URL fallback
      if (videoUrl) {
        try {
          const res = await this.page.context().request.get(videoUrl);
          const buf = await res.body();
          fs.writeFileSync(outputPath, buf);
          GrokStore.markUsed();
          this.log(`[Grok] ✅ 비디오 URL 다운로드 완료: ${outputPath}`);
          return { success: true, videoPath: outputPath, downgradedTo: _downgradeDetected ? '480p' : null };
        } catch (e) {
          return { success: false, error: `video URL 다운로드 실패: ${e.message}` };
        }
      }

      return { success: false, error: '5분 대기 후에도 비디오 미완성 (timeout)' };
    } catch (e) {
      return { success: false, error: `Grok 자동화 예외: ${e.message}` };
    }
  }
}

module.exports = { GrokEngine, GROK_SELECTORS, PROFILE_BASE, _ensureUserChromeProfileCopy };
