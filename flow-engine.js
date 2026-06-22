// asar 패키징 시 unpacked 파일 경로 변환
const _resolveUnpacked = (filePath) => filePath.replace('app.asar', 'app.asar.unpacked');

/**
 * Flow Engine v2.0 - Google Flow 브라우저 자동화 엔진
 * Playwright로 Flow에 접속하여 이미지 자동 생성
 *
 * v2.0 신규 기능:
 * - 배치 전송/다운로드 분리 (속도 향상)
 * - 403 감지 + 쿨다운 + 세션 복구
 * - 2K/4K 고해상도 다운로드
 * - 캐릭터 참조 이미지 업로드
 * - 휴먼화 타이핑 (봇 감지 회피)
 * - 기존 파일 건너뛰기 (이어하기)
 * - 생성 진행률 감지
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AntiDetect } = require('./anti-detect');

// 계정(profile)당 하루 '성공 이미지' 상한 — 구글 Flow 봇 감지/차단 예방. 0 = 무제한.
// run() 시작 시 + 생성 루프 중간(매 그룹)에 모두 검사해 작업 중 초과도 방지.
const PER_PROFILE_DAILY_CAP = 45;

const FLOW_URL = 'https://labs.google/fx/ko/tools/flow';
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.flow-app', 'profiles', 'default');

// ════════════════════════════════════════════════════════════════════
// 🔧 SYSTEM CHROME SWITCH — v1.13.39
//
//   true  = 시스템에 설치된 정식 Google Chrome 사용 (권장 — Google 자동화 차단 회피)
//   false = Playwright 번들 Chromium 사용 (옛 방식, fingerprint 차이로 차단 가능성)
//
// ❗ 문제가 생기면 이 한 줄을 false 로 바꾸고 앱을 재시작하세요 (npm start 또는 Ctrl+R 후 재기동).
//    Chrome 본체 사용이 안 되는 환경(Chrome 미설치 등)에서는 자동으로 Chromium 폴백됩니다.
//
// 📌 v1.13.41: true 로 재복구 — Chromium(145) ↔ Chrome 본체(148) 버전 mismatch 로
//    profileDir 의 prefs 가 호환 안 되어 Chromium launch 즉시 crash 발생.
//    Chrome 본체 사용 시 호환성 유지 + 동작 안정. ToS 위반 강도는 false 일 때와 동일(둘 다 RPA).
//    합법 provider (Stable Diffusion / Imagen / Pollinations) 도입 후 이 플래그 자체가
//    legacy Flow provider 의 옵션으로 의미 축소될 예정.
// ════════════════════════════════════════════════════════════════════
const USE_SYSTEM_CHROME = true;

class FlowAutomator {
  constructor(mainWindow, profileDir) {
    this.win = mainWindow;
    this.profileDir = profileDir || DEFAULT_PROFILE_DIR;
    this.context = null;
    this.page = null;

    // v2.0: 상태
    this._stopped = false;
    this._rateLimited = false;
    this._403Count = 0;
    this._cooldownMs = 60000;
    this._maxRetries = 3;
    // v1.13.21: Flow toast 형태의 rate-limit 감지 (HTTP 403 외에 "너무 빨리..." UI 메시지)
    this._rateLimitDetected = false;          // _waitForImage 폴에서 매칭되면 true
    this._rateLimitDetectedText = '';         // 마지막 매칭 텍스트 (로그용)
    this._rateLimitDetectedType = '';         // 'rate-limit' | 'suspicious-activity' (v1.13.26)
    this._groupRateLimitCount = 0;            // 현재 그룹 내 rate-limit 발생 횟수 (점진 대기 계산)
    this._sessionRateLimitCount = 0;          // 세션 전체 누적 (통계/로그용)
    this._lastRateLimitAt = 0;                // 마지막 발생 timestamp (단순화 가드용)
    this._consecutiveSuccessForRateReset = 0; // 연속 성공 시 _sessionRateLimitCount 리셋
    // v1.13.22: 다중 프로필 폴백을 위한 추적 변수
    this._currentProfileId = '';              // run() 시작 시 셋, 로그/IPC 페이로드에 사용
    this._completedNums = [];                 // 이번 run 에서 성공한 num 들 (renderer 가 남은 그룹 계산용)
    this._rateExhaustedFlag = false;          // run() 종료 시 renderer 가 폴백 트리거할지 판단
  }

  // v1.13.21~v1.13.26: Flow toast 메시지에서 차단 키워드 감지 (HTTP 403 와 별개의 UI 신호)
  // 작은 toast/alert 박스(폭 < 600, 텍스트 < 200자)에서만 매칭하여 오판 방지.
  // 반환값에 type 포함:
  //   - 'suspicious-activity': "비정상적인 활동 감지" / "abnormal activity" — 60초 대기 의미 없음 → 즉시 폴백
  //   - 'rate-limit': "너무 빨리 요청" / "rate limit" — 60초 대기 후 1회 재시도
  async _detectRateLimitText() {
    try {
      if (!this.page || this.page.isClosed()) return null;
      return await this.page.evaluate(() => {
        // 비정상 활동(봇 의심 차단) — 일반 rate-limit 보다 심각, 60초 기다려도 회복 X
        const KO_SUS = /비정상적?\s*(?:인|활동)|이상\s*활동|차단|의심.*감지|봇.*감지/;
        const EN_SUS = /abnormal\s*activity|unusual\s*activity|suspicious\s*activity|automated\s*behavior/i;
        // 일반 rate-limit (일시적 — 1회 재시도 안전망 가치 있음)
        const KO_RATE = /너무\s*빨리|잠시\s*후에?\s*다시|요청이\s*너무|속도\s*제한|일일\s*한도/;
        const EN_RATE = /too\s*quickly|rate[\s-]?limit|try\s*again\s*later|too\s*many\s*request|quota\s*exceeded/i;
        const sels = '[role="alert"],[role="status"],div[class*="toast"],div[class*="error"],div[class*="alert"],div[class*="snackbar"]';
        const candidates = Array.from(document.querySelectorAll(sels));
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          // v1.13.33: size 필터 완화 — 사용자가 본 큰 차단 토스트 (캔버스 전체 덮음) 도 잡히도록
          if (rect.width === 0 || rect.width > 1200) continue;
          if (rect.height === 0 || rect.height > 800) continue;
          const text = (el.innerText || el.textContent || '').trim();
          if (!text || text.length > 400) continue;
          // 비정상 활동 우선 검사 (더 심각한 카테고리)
          if (KO_SUS.test(text) || EN_SUS.test(text)) {
            return { text: text.slice(0, 150), type: 'suspicious-activity' };
          }
          if (KO_RATE.test(text) || EN_RATE.test(text)) {
            return { text: text.slice(0, 150), type: 'rate-limit' };
          }
        }
        return null;
      });
    } catch (e) {
      return null;
    }
  }

  // v1.13.21: 그룹 내 rate-limit 발생 횟수에 따른 점진 대기 시간 (ms)
  // 1회=60s, 2회=120s, 3회=180s, 4회+=240s (단, 3회 cap 후 skip 이라 4회 도달 X)
  _getProgressiveWaitMs() {
    const n = Math.max(1, this._groupRateLimitCount | 0);
    const sec = Math.min(300, 60 * n);
    return sec * 1000;
  }

  // v1.13.21: rate-limit 카운터 리셋 (그룹 성공/skip 시 호출)
  _resetGroupRateLimitCounter() {
    this._groupRateLimitCount = 0;
    this._rateLimitDetected = false;
    this._rateLimitDetectedText = '';
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }

  log(msg) {
    console.log(msg);
    this.send('log', msg);
    if (this._logFilePath) {
      try {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        fs.appendFileSync(this._logFilePath, `[${ts}] ${msg}\n`, 'utf-8');
      } catch {}
    }
  }

  // 내부 디버그 로그 (콘솔만, UI에 안 보임)
  debug(msg) {
    console.log(msg);
  }

  progress(current, total, status) {
    this.send('progress', { current, total, status });
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this.log('중지 요청됨...');
  }

  // v1.13.46: 프로필 전환 폴백 / 사용자 중지 시 즉시 창을 닫기 위한 통합 헬퍼.
  // 페이지 명시 close → context.close → OS lock 해제 대기 → 상태 리셋.
  // v1.13.47: profileDir 리셋 제거 — login() 이 this.profileDir 을 직접 참조하므로
  //           null 로 두면 path.join(null, 'SingletonLock') 에서 폭발. context/page 만
  //           null 리셋으로 충분 (다음 run() 분기에서 needNewContext=true 자동 진입).
  async _closeContextAndCleanup(reason) {
    if (!this.context) return;
    this.log(`[Flow] 컨텍스트 종료 (${reason})`);
    try {
      const pages = this.context.pages ? this.context.pages() : [];
      for (const p of pages) {
        try { if (!p.isClosed()) await p.close({ runBeforeUnload: false }); } catch {}
      }
    } catch {}
    try { await this.context.close(); } catch (e) {
      this.debug(`[Flow] context.close 오류 무시: ${e.message}`);
    }
    // Chrome persistent context 의 OS-level 종료 lag — 500ms → 2000ms
    await new Promise(r => setTimeout(r, 2000));
    this.context = null;
    this.page = null;
    // profileDir 은 의도적으로 유지 — login() / 다른 메서드에서 직접 참조.
  }

  pause() {
    if (this._paused) { this.log('이미 일시정지 상태'); return; }
    this._paused = true;
    this._pauseStart = Date.now();
    this.log('일시정지 요청 수신 — 다음 안전 지점에서 멈춥니다');
    // 세션 유지 + 경과 시간 표시
    if (this._sessionKeeper) { clearInterval(this._sessionKeeper); this._sessionKeeper = null; }
    this._sessionKeeper = setInterval(async () => {
      // 세션 유지 (백그라운드 페이지 활성화)
      try {
        if (this.page && !this.page.isClosed()) {
          await this.page.evaluate(() => {
            document.dispatchEvent(new Event('mousemove'));
            return window.scrollY;
          }).catch(() => {});
        }
      } catch {}
      // 경과 시간 로그 (1분마다)
      const elapsed = Math.floor((Date.now() - this._pauseStart) / 1000);
      if (elapsed > 0 && elapsed % 60 === 0) {
        const mins = Math.floor(elapsed / 60);
        this.log(`일시정지 ${mins}분 경과`);
      }
    }, 1000);
  }

  resume() {
    if (!this._paused) { this.log('일시정지 상태가 아님 (재개 무시)'); return; }
    this._paused = false;
    if (this._sessionKeeper) {
      clearInterval(this._sessionKeeper);
      this._sessionKeeper = null;
    }
    const elapsed = Math.floor((Date.now() - (this._pauseStart || Date.now())) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    this.log(`재개됨 (${mins}분 ${secs}초 일시정지)`);
  }

  async _waitIfPaused() {
    while (this._paused && !this._stopped) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  async login() {
    // 기존 브라우저 세션 정리 (잠금 방지)
    if (this.context) {
      try { await this.context.close(); } catch {}
      this.context = null;
      this.page = null;
    }
    // 프로필 잠금 파일 제거
    try {
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(this.profileDir, lock);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    fs.mkdirSync(this.profileDir, { recursive: true });

    // v1.13.39: 로그인 흐름도 같은 채널 정책 적용 (run() 의 브라우저 준비 블록과 동일).
    // 로그인은 Chromium, 작업은 Chrome 으로 갈리면 쿠키 일관성 깨짐.
    const _loginLaunchOpts = {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--test-type'],
      ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
      permissions: ['clipboard-read', 'clipboard-write'],
    };
    if (USE_SYSTEM_CHROME) {
      try {
        this.log('[Flow] 브라우저 시작 (로그인, 정식 Chrome 사용)...');
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          ..._loginLaunchOpts,
          channel: 'chrome',
        });
      } catch (e) {
        this.log(`[Flow] ⚠ 정식 Chrome 실행 실패 (${e.message.split('\n')[0].slice(0, 100)}) — Chromium 으로 폴백`);
        this.log('[Flow]   → Chrome 미설치 또는 경로 못 찾음. https://www.google.com/chrome 에서 설치 권장');
        this.context = await chromium.launchPersistentContext(this.profileDir, _loginLaunchOpts);
      }
    } else {
      this.log('[Flow] 브라우저 시작 (로그인, Chromium — USE_SYSTEM_CHROME=false)');
      this.context = await chromium.launchPersistentContext(this.profileDir, _loginLaunchOpts);
    }

    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await this.page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(3000);
    await this._dismissBanners();

    if (this.page.url().includes('accounts.google')) {
      this.log('[Flow] Google 로그인이 필요합니다. 브라우저에서 로그인하세요.');
      await this.page.waitForURL('**/labs.google/**', { timeout: 300000 });
      this.log('[Flow] 로그인 완료!');
    } else {
      this.log('[Flow] 이미 로그인되어 있습니다.');
    }

    await this.page.waitForTimeout(2000);
    this.log('[Flow] 로그인 완료! 브라우저를 유지합니다.');
    this.log('[Flow] 이 브라우저로 이미지 생성이 진행됩니다.');
  }

  async run(config) {
    const {
      paragraphs,
      // 하이브리드 분할 — 대괄호 그룹은 한국어+스타일 그대로 입력 (번역 스킵).
      // null 인 idx 는 기존 영문 변환 흐름. 길이는 paragraphs 와 1:1.
      customPrompts = null,
      mediaType = 'image',
      style = 'cinematic',
      ratio = '16:9',
      model = 'Nano Banana 2',
      count = 'x1',
      withSubtitle = false,
      outputDir,
      // v2.0 신규 옵션
      batchMode = false,
      humanizedTyping = false,
      typingSpeed = 1.0,
      downloadResolution = '1K',
      cooldownSeconds = 60,
      characterImages = [],
      frameImages = [],          // i2v: 영상 모드에서 각 단락의 소스 이미지를 프레임/애셋으로 첨부(길이 1:1)
      characterMap = [],
      kenburnsMode = 'uniform',
      kenburnsSpeed = 'normal',
      maxChars = 30,
      presetPrompt = '',
      antiDetect: antiDetectOpts = {},
    } = config;

    this._stopped = false;
    this._paused = false;
    if (this._sessionKeeper) { clearInterval(this._sessionKeeper); this._sessionKeeper = null; }
    this._cooldownMs = cooldownSeconds * 1000;
    this._characterMap = characterMap;
    fs.mkdirSync(this.profileDir, { recursive: true });

    // ─── vrewOnly 분기 — 이미지 생성 스킵, .vrew 만 만든다 (8단계) ───
    // UI 의 "💾 .vrew 저장" 버튼이 호출. paragraphs + imgDir 만 있으면 됨.
    if (config.vrewOnly) {
      const imgDir = config.imgDir || path.join(config.outputDir, 'images');
      const subDir = path.join(config.outputDir, 'subtitles');
      fs.mkdirSync(subDir, { recursive: true });
      this.log(`[Vrew Only] 이미지 폴더: ${imgDir}, ${paragraphs.length}개 클립`);
      try {
        const vrewPath = path.join(config.outputDir, `${path.basename(config.outputDir)}.vrew`);
        await this._generateVrew(paragraphs, imgDir, vrewPath, kenburnsMode, maxChars, kenburnsSpeed);
        this._generateSRT(paragraphs, path.join(subDir, 'subtitles.srt'));
        this.log(`[저장] Vrew → ${path.basename(vrewPath)}`);
        this.send('vrew:generated', { path: vrewPath, file: path.basename(vrewPath) });
        this.send('done', { success: paragraphs.length, total: paragraphs.length, outputDir: config.outputDir });
      } catch (e) {
        this.log(`[!] Vrew 생성 실패: ${e.message}`);
        this.send('done', { success: 0, total: paragraphs.length, outputDir: config.outputDir, error: e.message });
      }
      return;
    }

    // ─── 안티 디텍션 인스턴스 (단락·세션 레이어 휴먼화) ───
    this.antiDetect = new AntiDetect({
      enabled:        antiDetectOpts.enabled,
      preset:         antiDetectOpts.preset,
      dailyLimit:     antiDetectOpts.dailyLimit,
      onLimitReached: antiDetectOpts.onLimitReached,
      profileId:      (config && config.profileId) || 'default',   // 계정별 하루 한도 카운팅
      logger:         (m) => this.log(m),
    });
    const limitCheck = this.antiDetect.checkDailyLimit();
    if (limitCheck.shouldStop) {
      this.log(`[!] 일일 한도 ${limitCheck.todayCount}/${limitCheck.limit}회 도달 — 자동 중지 모드로 진행 차단`);
      this.send('done', { success: 0, total: paragraphs.length, outputDir, blocked: true });
      return;
    }
    if (limitCheck.reached) {
      this.log(`⚠️ 일일 한도 ${limitCheck.todayCount}/${limitCheck.limit}회 도달 — 경고만 (계속 진행)`);
    } else if (this.antiDetect.enabled) {
      const remain = limitCheck.limit > 0 ? `· 남은 한도 ${limitCheck.remaining}회` : '· 무제한';
      this.log(`[안티디텍션] 강도 "${this.antiDetect.preset}" · 오늘 ${limitCheck.todayCount}회 ${remain}`);
    } else {
      this.log(`[안티디텍션] 비활성화 (기존 동작 유지)`);
    }

    // ─── 계정당 하루 한도 (계정 차단 예방) ───
    //   구글 Flow 는 한 계정을 하루에 과하게 쓰면 "비정상 활동" 으로 차단한다.
    //   계정(profile)별 오늘 생성 횟수가 상한에 도달하면, 이 계정은 더 쓰지 않고
    //   rate-exhausted 신호를 보내 renderer 가 다음 프로필로 폴백하게 한다(=계정 휴식).
    //   0 이면 무제한. 값 변경: 모듈 상단 PER_PROFILE_DAILY_CAP.
    {
      const _pid = (config && config.profileId) || 'default';
      const _pc = (limitCheck && Number.isFinite(limitCheck.profileCount)) ? limitCheck.profileCount : 0;
      if (PER_PROFILE_DAILY_CAP > 0 && _pc >= PER_PROFILE_DAILY_CAP) {
        this.log(`🛑 계정 ${_pid} 오늘 ${_pc}회 — 계정당 하루 한도(${PER_PROFILE_DAILY_CAP}회) 도달. 이 계정은 휴식하고 다음 프로필로 넘어갑니다 (구글 차단 예방).`);
        try {
          this.send('flow-rate-exhausted', {
            profileId: _pid,
            completedNums: [],
            remainingNums: paragraphs.map((_, j) => j + 1),
            reason: 'daily-limit',
          });
        } catch (_) {}
        this._rateExhaustedFlag = true;
        this.send('done', { success: 0, total: paragraphs.length, outputDir, rateExhausted: true });
        return;
      }
    }

    const imgDir = path.join(outputDir, 'images');
    const subDir = path.join(outputDir, 'subtitles');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    // 로그 파일 초기화 (이 시점부터 log() 호출은 파일에도 기록됨)
    this._logFilePath = path.join(outputDir, 'log.txt');
    this._failedNums = [];
    // v1.13.22: 다중 프로필 폴백을 위한 run 별 추적 초기화
    this._currentProfileId = (config && config.profileId) || 'default';
    this._completedNums = [];
    this._rateExhaustedFlag = false;
    // v1.13.23: 적극적 순차 전환 — N개 그룹 성공 시 rate-limit 전에 자동 break + 폴백 트리거
    this._proactiveSwitchEveryN = (config && config.proactiveSwitchEveryN) | 0;
    this._proactiveSwitchTriggered = false;
    try {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fs.writeFileSync(this._logFilePath, `=== 생성 시작 ${ts} ===\n출력: ${outputDir}\n단락 수: ${paragraphs.length}\n\n`, 'utf-8');
    } catch {}

    // v1.13.30: profileId 변경 감지 — 폴백으로 다른 프로필 들어오면 기존 context 종료 후 새 profileDir 로 재시작
    // v1.13.31: 공백(\s) 변환 제거 — 로그인 검증(flow-login IPC)이 공백 그대로 폴더 만들기 때문에
    // 변환하면 빈 새 폴더로 들어가서 로그인 정보 손실 → textbox 못 찾고 timeout. 공백 그대로 유지.
    // v1.13.39: 프로필 전환 시 명시적으로 "닫고 새로 열기" 보장 — 사용자 요청.
    //           기존엔 profileDir != desiredProfileDir 일 때만 close 했는데, 이전 인스턴스
    //           재사용 케이스가 섞여 동작이 일관되지 않아 보였음. 이제 다른 프로필이면 무조건 close.
    // v1.13.46: close 로직을 _closeContextAndCleanup 헬퍼로 통합 (페이지 명시 close + 2초 대기).
    {
      const desiredProfileId = (config && config.profileId) || 'default';
      const desiredProfileDir = path.join(os.homedir(), '.flow-app', 'profiles', desiredProfileId.replace(/[\\\/:*?"<>|]/g, '_'));
      const profileChanged = this.profileDir !== desiredProfileDir;
      if (profileChanged) {
        if (this.context) {
          this.log(`[Flow] 프로필 변경: ${path.basename(this.profileDir)} → ${path.basename(desiredProfileDir)}`);
          await this._closeContextAndCleanup('프로필 변경');
        }
        this.profileDir = desiredProfileDir;  // cleanup 이 null 로 리셋했으니 재설정
      }
    }

    // v1.13.30: context/page health check — closed 면 자동 재시작
    let needNewContext = !this.context || !this.page;
    if (!needNewContext) {
      try {
        if (this.page.isClosed && this.page.isClosed()) {
          needNewContext = true;
        } else {
          // 가벼운 health probe — closed context 면 throw
          await this.page.evaluate(() => 1);
        }
      } catch (e) {
        this.log(`[Flow] 기존 브라우저 health check 실패 — 재시작 (${e.message.split('\n')[0].slice(0, 80)})`);
        needNewContext = true;
        try { if (this.context) await this.context.close(); } catch {}
        this.context = null;
        this.page = null;
      }
    }

    // 브라우저 준비
    if (needNewContext) {
      // v1.13.39: USE_SYSTEM_CHROME=true 이면 시스템 정식 Chrome 사용 (Google 자동화 차단 회피).
      // channel:'chrome' 지정 시 Playwright 가 시스템 Chrome 자동 탐지. 못 찾으면 명확한 안내 후 Chromium 폴백.
      const launchOpts = {
        headless: false,
        viewport: { width: 1400, height: 900 },
        args: ['--disable-blink-features=AutomationControlled', '--test-type'],
        ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
      };
      let usedChannel = 'Chromium';
      if (USE_SYSTEM_CHROME) {
        try {
          this.log(`[Flow] 브라우저 시작 (profile=${path.basename(this.profileDir)}, 정식 Chrome 사용)...`);
          this.context = await chromium.launchPersistentContext(this.profileDir, {
            ...launchOpts,
            channel: 'chrome',
          });
          usedChannel = 'Chrome';
        } catch (e) {
          this.log(`[Flow] ⚠ 정식 Chrome 실행 실패 (${e.message.split('\n')[0].slice(0, 100)}) — Playwright Chromium 으로 폴백`);
          this.log('[Flow]   → Chrome 미설치 또는 경로 못 찾음. https://www.google.com/chrome 에서 설치 권장');
          this.context = await chromium.launchPersistentContext(this.profileDir, launchOpts);
        }
      } else {
        this.log(`[Flow] 브라우저 시작 (profile=${path.basename(this.profileDir)}, Chromium 사용 — USE_SYSTEM_CHROME=false)`);
        this.context = await chromium.launchPersistentContext(this.profileDir, launchOpts);
      }
      this.log(`[Flow] 브라우저 엔진: ${usedChannel}`);
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
    } else {
      this.log(`[Flow] 기존 브라우저 재사용 (profile=${path.basename(this.profileDir)})`);
    }

    // Flow 접속
    this.log('[Flow] Flow 접속 중...');
    await this.page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(3000);

    // 로그인 리다이렉트 대기 (auth callback → Flow 메인)
    if (this.page.url().includes('accounts.google') || this.page.url().includes('auth/callback')) {
      this.log('[Flow] 로그인 리다이렉트 대기...');
      await this.page.waitForURL('**/labs.google/fx/**', { timeout: 30000 }).catch(() => {});
      await this.page.waitForTimeout(5000);
    }

    await this._dismissBanners();

    if (this.page.url().includes('accounts.google')) {
      this.log('[Flow] 로그인이 필요합니다. 먼저 로그인해주세요.');
      throw new Error('Google 로그인이 필요합니다');
    }

    // v2.0: 403 네트워크 모니터 설정
    this._setupNetworkMonitor();

    let successCount = 0;
    // 스타일 프롬프트는 style-store.js 가 관리 (기본 28개 + 사용자 추가).
    // 여기서 require — 매번 최신 사용자 추가 스타일도 자동으로 반영됨.
    const StyleStore = require('./core/style-store');
    const stylePrompt = StyleStore.getPrompt(style)
                     || StyleStore.getPrompt('cinematic')
                     || 'cinematic film still, dramatic lighting, movie scene';

    // 원본 대본 저장
    fs.writeFileSync(path.join(outputDir, 'original_script.txt'),
      paragraphs.map((p, i) => `[${String(i + 1).padStart(2, '0')}]\n${p}\n`).join('\n'), 'utf-8');
    this.debug('[저장] 원본 대본 → original_script.txt');

    // 새 프로젝트 생성
    await this._ensureMainPage();
    await this._createNewProject();
    await this.page.waitForTimeout(2000);

    // 캐릭터 참조 이미지 업로드 (대본 분석 전에 먼저 완료)
    if (characterImages.length > 0) {
      await this._uploadCharacterImages(characterImages);
    }

    // 사전 설정 구문: 사용자 입력 우선, 없으면 첫 단락에서 자동 추출
    let presetEnglish = '';
    if (presetPrompt) {
      const presetShort = presetPrompt.substring(0, 150);
      presetEnglish = await this._translateToEnglish(presetShort) || presetShort;
      if (presetEnglish.length > 120) presetEnglish = presetEnglish.substring(0, 120);
      this.log(`[사전설정] 사용자 입력: ${presetShort}`);
    } else if (paragraphs.length > 0) {
      const firstPara = paragraphs[0].substring(0, 200);
      const autoPreset = await this._translateToEnglish(firstPara);
      if (autoPreset) {
        presetEnglish = this._extractSettingFromText(autoPreset).substring(0, 120);
        if (presetEnglish) this.log(`[사전설정] 자동 추출: ${presetEnglish.substring(0, 60)}...`);
      }
    }
    if (presetEnglish) this.debug(`[사전설정 번역] ${presetEnglish}`);

    // 대본 전체 분석 → 공통 시각 컨텍스트 추출 (일관성 유지)
    this.log('대본 분석 중...');
    const sceneContext = await this._analyzeSceneContext(paragraphs, stylePrompt, style);
    this.debug(`[분석] 컨텍스트: ${sceneContext.substring(0, 80)}...`);

    // 번역 + 프롬프트 미리 생성.
    // customPrompts[i] 가 비어있지 않으면 그대로 사용 (대괄호 그룹 — 한국어+스타일 직접).
    // null 또는 미지정 idx 는 기존 영문 변환 흐름.
    const translations = [];
    const prompts = [];
    let prevTranslated = null;
    for (let i = 0; i < paragraphs.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      const custom = (customPrompts && customPrompts[i]) ? String(customPrompts[i]) : null;
      let prompt;
      if (custom) {
        prompt = custom;
        this.log(`[프롬프트 ${num}] 대괄호 그룹 — 한국어+스타일 직접 (번역 스킵)`);
      } else {
        prompt = await this._buildEnglishPrompt(paragraphs[i], stylePrompt, ratio, sceneContext, prevTranslated, presetEnglish);
        prevTranslated = this._lastTranslated || null;
      }
      translations.push({ num, original: paragraphs[i].substring(0, 100), prompt });
      prompts.push(prompt);
    }

    // ─── 배치 모드 vs 순차 모드 ───
    if (batchMode && mediaType === 'image') {
      successCount = await this._runBatchMode(paragraphs, prompts, imgDir, {
        mediaType, ratio, model, count, withSubtitle, humanizedTyping, typingSpeed, downloadResolution,
      });
    } else {
      successCount = await this._runSequentialMode(paragraphs, prompts, imgDir, {
        mediaType, ratio, model, count, withSubtitle, humanizedTyping, typingSpeed, downloadResolution, frameImages,
      });
    }

    // SRT 자막 생성 — skipVrew(이미지만) 모드에선 생략 (우리 앱이 별도로 만듦)
    if (!config.skipVrew) this._generateSRT(paragraphs, path.join(subDir, 'subtitles.srt'));

    // Vrew 프로젝트 파일 생성 (.vrew)
    // skipVrew=true 면 이미지 생성만 하고 vrew 는 별도 saveVrew() 가 정확한 클립 단위로 만듦
    if (!config.skipVrew) {
      try {
        const vrewPath = path.join(outputDir, `${path.basename(outputDir)}.vrew`);
        await this._generateVrew(paragraphs, imgDir, vrewPath, kenburnsMode, maxChars, kenburnsSpeed);
        this.log(`[저장] Vrew 프로젝트 → ${path.basename(vrewPath)}`);
        this.send('vrew:generated', { path: vrewPath, file: path.basename(vrewPath) });
      } catch (err) {
        this.log(`[!] Vrew 생성 실패: ${err.message}`);
      }
    } else {
      this.log('[Vrew] skipVrew=true — 자동 생성 스킵 (saveVrew 사용)');
    }

    // 번역 텍스트 저장 — skipVrew(이미지만) 모드에선 생략
    if (!config.skipVrew) {
      let transTxt = '번역 결과\n' + '='.repeat(50) + '\n\n';
      translations.forEach(t => {
        transTxt += `[${t.num}] 원문: ${t.original}...\n`;
        transTxt += `[${t.num}] 프롬프트: ${t.prompt}\n\n`;
      });
      fs.writeFileSync(path.join(outputDir, 'translations.txt'), transTxt, 'utf-8');
      this.log('[저장] 번역 텍스트 → translations.txt');
    }

    // 프롬프트 목록 저장
    let promptsTxt = '';
    paragraphs.forEach((p, i) => {
      promptsTxt += `[${String(i + 1).padStart(2, '0')}] ${p.substring(0, 100)}\n\n`;
    });
    fs.writeFileSync(path.join(outputDir, 'prompts.txt'), promptsTxt, 'utf-8');

    // 실패 단락 목록 저장
    if (this._failedNums && this._failedNums.length > 0) {
      let failTxt = `실패한 단락 목록\n${'='.repeat(50)}\n총 ${this._failedNums.length}개 실패 (${paragraphs.length}개 중)\n\n`;
      for (const f of this._failedNums) {
        failTxt += `[${f.num}] ${f.text}${f.text.length >= 80 ? '...' : ''}\n`;
      }
      failTxt += `\n실패 번호만: ${this._failedNums.map(f => parseInt(f.num)).join(', ')}\n`;
      try {
        fs.writeFileSync(path.join(outputDir, '생성실패이미지.txt'), failTxt, 'utf-8');
        this.log(`[저장] 실패 목록 → 생성실패이미지.txt (${this._failedNums.length}개)`);
      } catch (e) {
        this.log(`[!] 실패 목록 저장 실패: ${e.message}`);
      }
    }

    // 브라우저 유지 (다음 생성에 재사용)
    this.log(`\n완료! 성공: ${successCount}/${paragraphs.length}`);
    // v1.13.22: rateExhausted 플래그 + completedNums/remainingNums 함께 전달 (renderer 폴백용)
    const completedNums = (this._completedNums || []).slice();
    const remainingNums = [];
    for (let j = 0; j < paragraphs.length; j++) {
      const n = String(j + 1).padStart(2, '0');
      if (!completedNums.includes(n)) remainingNums.push(n);
    }
    const result = {
      success: successCount,
      total: paragraphs.length,
      outputDir,
      rateExhausted: !!this._rateExhaustedFlag,
      reason: this._proactiveSwitchTriggered ? 'proactive-switch' : (this._rateExhaustedFlag ? 'rate-limit' : 'completed'),
      completedNums,
      remainingNums,
      profileId: this._currentProfileId || 'default',
    };
    this.send('done', result);
    // v1.13.46: 폴백(_rateExhaustedFlag) 또는 사용자 중지(_stopped) 시 잔존 창 즉시 종료.
    // 정상 완료는 동일 프로필 재호출 가능성 위해 컨텍스트 유지.
    if (this._rateExhaustedFlag || this._stopped) {
      const reason = this._stopped ? '사용자 중지' : `폴백 (${result.reason})`;
      await this._closeContextAndCleanup(reason);
    }
    // 로그 파일 경로 초기화 (다음 실행 때 새 파일로)
    this._logFilePath = null;
    this._failedNums = null;
    this._completedNums = null;
    return result;
  }

  // ─── 순차 모드 (기존 방식 + v2.0 개선) ───
  async _runSequentialMode(paragraphs, prompts, imgDir, opts) {
    let successCount = 0;
    let settingsConfigured = false;
    // 연속 실패 추적 (레이트 리밋/세션 붕괴 감지)
    let consecutiveFails = 0;
    const CONSECUTIVE_DEEP_RECOVERY = 5;  // 5회 연속 실패 시 60초 쿨다운 + 새로고침
    const CONSECUTIVE_ABORT = 10;          // 10회 연속 실패 시 생성 중단

    for (let i = 0; i < paragraphs.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      const para = paragraphs[i];
      let prompt = prompts[i];
      const shortText = para.substring(0, 15).replace(/[\n\r\\/:*?"<>|]/g, '').trim();

      // 중지 체크
      if (this._stopped) {
        this.log('사용자에 의해 중지됨');
        break;
      }

      // 일시정지 체크
      await this._waitIfPaused();
      if (this._stopped) break;

      // 계정당 하루 한도 — 작업 '중간'에도 검사 (run 시작 시에만 보면 세션 중 초과 가능).
      //   성공 카운트는 _saveImage 에서 증가하므로 매 그룹 진입 시 최신값으로 재확인.
      if (PER_PROFILE_DAILY_CAP > 0 && this.antiDetect &&
          typeof this.antiDetect.profileCount === 'function' &&
          this.antiDetect.profileCount() >= PER_PROFILE_DAILY_CAP) {
        const _pid = this._currentProfileId || 'default';
        const remainingNums = [];
        for (let j = i; j < paragraphs.length; j++) remainingNums.push(j + 1);
        this.log(`🛑 계정 ${_pid} 오늘 성공 ${this.antiDetect.profileCount()}장 — 작업 중 계정당 하루 한도(${PER_PROFILE_DAILY_CAP}장) 도달. 남은 ${remainingNums.length}개는 다음 프로필로 폴백 (구글 차단 예방).`);
        this.send('flow-rate-exhausted', {
          profileId: _pid,
          completedNums: this._completedNums ? this._completedNums.slice() : [],
          remainingNums,
          reason: 'daily-limit',
        });
        this._rateExhaustedFlag = true;
        break;
      }

      this.progress(i + 1, paragraphs.length, `${num}번 단락 처리 중...`);
      this.log(`\n[${num}/${paragraphs.length}] ${para.substring(0, 40)}...`);

      // v2.0: 기존 파일 건너뛰기
      if (this._shouldSkip(num, imgDir)) {
        this.log(`[${num}] 이미 존재, 스킵`);
        successCount++;
        if (this._completedNums) this._completedNums.push(num);
        this.send('image-done', { index: i, num });
        continue;
      }

      // v2.0: 403 감지 시 쿨다운 + 복구
      if (this._rateLimited) {
        await this._handleRateLimit();
      }

      try {
        // 장면별 캐릭터 매칭 → add_2 피커에서 선택
        if (this._characterMap && this._characterMap.length > 0) {
          const matched = this._matchCharacters(para, this._characterMap);
          if (matched.length > 0) {
            this.log(`  [캐릭터] ${matched.map(c => c.name).join(', ')} 매칭`);
            for (const char of matched) {
              await this._addCharacterReference(char.name);
            }
          }
        }

        // 에이전트 모드 OFF 보장 (자동 이미지 생성엔 마이너스 요인)
        await this._ensureAgentOff();

        // 프롬프트 입력
        if (opts.humanizedTyping) {
          await this._typePromptHumanized(prompt, opts.typingSpeed);
        } else {
          await this._typePrompt(prompt);
        }
        // 안티 디텍션: 타이핑 후 → 생성 클릭 전 휴먼 대기 (활성: 3~8초, 비활성: 500ms)
        await this.page.waitForTimeout(this.antiDetect.getPreSubmitDelay());

        // 첫 단락만 설정
        if (!settingsConfigured) {
          await this._configureSettings(opts);
          settingsConfigured = true;
        }

        // i2v: 영상 모드에서 이 단락의 소스 이미지를 프레임/애셋으로 첨부 (단락마다)
        if (opts.mediaType === 'video' && opts.frameImages && opts.frameImages[i]) {
          await this._attachFrameImage(opts.frameImages[i], num);
        }

        // 동영상 모드: 네트워크 캡처 시작
        const capturedVideos = [];
        let videoHandler = null;
        if (opts.mediaType === 'video') {
          videoHandler = async (response) => {
            try {
              const ct = response.headers()['content-type'] || '';
              const url = response.url();
              if (ct.includes('video/') || url.includes('.mp4') || url.includes('videoplayback')) {
                const body = await response.body().catch(() => null);
                if (body && body.length > 50000) {
                  this.debug(`[${num}] 동영상 캡처 (${Math.round(body.length / 1024)}KB)`);
                  capturedVideos.push(body);
                }
              }
            } catch {}
          };
          this.page.on('response', videoHandler);
        }

        // 만들기
        this.log(`[${num}] ${opts.mediaType === 'video' ? '동영상' : '이미지'} 생성 중...`);

        // 안티 디텍션: 한도 재확인 + 카운터 증가 + N개마다 강제 쿨다운
        {
          const before = this.antiDetect.beforeNextGeneration();
          if (before.warn) this.log(before.warn);
          if (!before.proceed) {
            this.log(`[!] ${before.reason}`);
            break;
          }
          const reg = this.antiDetect.registerGenerationStart();
          if (reg.cooldownMs > 0) {
            const sec = Math.round(reg.cooldownMs / 1000);
            this.log(`🛡️ 계정 보호 쿨다운: 세션 ${reg.sessionCount}회 생성 → ${sec}초 대기`);
            this.send('rate-limit', { waitSeconds: sec, reason: 'cooldown' });
            await this.page.waitForTimeout(reg.cooldownMs);
            if (this._stopped) break;
          }
        }

        await this._clickFinalCreateV2();

        // 생성 대기
        const waitTime = opts.mediaType === 'video' ? 180000 : 120000;
        const imageBuffer = await this._waitForImage(waitTime, opts.mediaType === 'video');

        // 네트워크 캡처 해제
        if (videoHandler) this.page.off('response', videoHandler);

        // 이미지/동영상 수신 후 저장 전 일시정지 체크
        await this._waitIfPaused();
        if (this._stopped) break;

        if (imageBuffer || capturedVideos.length > 0) {
          if (capturedVideos.length > 0) {
            // 동영상: 가장 큰 캡처 저장
            const largest = capturedVideos.sort((a, b) => b.length - a.length)[0];
            const finalPath = path.join(imgDir, `${num}_${shortText}.mp4`);
            fs.writeFileSync(finalPath, largest);
            this.log(`[${num}] 동영상 저장: ${path.basename(finalPath)} (${Math.round(largest.length / 1024)}KB)`);
          } else {
            await this._saveImage(imageBuffer, num, shortText, imgDir, opts);
          }
          successCount++;
          consecutiveFails = 0;
          // v1.13.21: 성공 시 rate-limit 카운터 리셋 + 세션 누적 카운터 점진 리셋
          this._consecutiveSuccessForRateReset++;
          if (this._consecutiveSuccessForRateReset >= 3 && this._sessionRateLimitCount > 0) {
            this.debug(`[rate-limit] 3회 연속 성공 — 세션 카운터 리셋 (${this._sessionRateLimitCount}→0)`);
            this._sessionRateLimitCount = 0;
            this._consecutiveSuccessForRateReset = 0;
          }
          this._resetGroupRateLimitCounter();
          if (this._completedNums) this._completedNums.push(num);
        this.send('image-done', { index: i, num });
        } else if (this._rateLimitDetected) {
          // v1.13.22~v1.13.26: Flow 차단 토스트 분기 — type 별 다르게 처리.
          // 'suspicious-activity' (비정상 활동 감지): 계정 봇 의심 차단 — 대기 의미 없음, 즉시 폴백.
          // 'rate-limit' (너무 빠른 요청): 일시 토스트 가능성 — 60초 대기 + 원본 1회 재시도 안전망.
          this._sessionRateLimitCount++;
          this._consecutiveSuccessForRateReset = 0;
          const detectedType = this._rateLimitDetectedType || 'rate-limit';
          const isSuspicious = detectedType === 'suspicious-activity';

          let rateLimitResolved = false;

          if (isSuspicious) {
            // v1.13.26: 비정상 활동 감지 — 60초 대기 없이 즉시 폴백.
            this.log(`🚨 프로필 ${this._currentProfileId || 'default'} 비정상 활동 감지 (그룹 ${num}) — 계정 차단 의심, 60초 대기 건너뛰고 즉시 다음 프로필로 폴백`);
            this.send('rate-limit', { waitSeconds: 0, reason: 'suspicious-activity', occurrence: 1 });
            // 토스트 정리만 시도
            try { await this._dismissFailure(); } catch {}
            // rateLimitResolved = false 유지 → 아래 폴백 로직 진입
          } else {
            // 기존 rate-limit 흐름: 60초 대기 + 1회 재시도
            const WAIT_MS = 60000;
            const waitSec = Math.round(WAIT_MS / 1000);
            this.log(`⏸ Flow rate-limit 감지 (그룹 ${num}, 프로필 ${this._currentProfileId || 'default'}) — ${waitSec}초 대기 후 원본 프롬프트 1회 재시도`);
            this.send('rate-limit', { waitSeconds: waitSec, reason: 'flow-toast', occurrence: 1 });

            // 1초 단위 대기 (pause/stop 즉시 반응)
            for (let waited = 0; waited < WAIT_MS && !this._stopped; waited += 1000) {
              await this._waitIfPaused();
              if (this._stopped) break;
              await this.page.waitForTimeout(1000);
            }
          }

          if (!isSuspicious && !this._stopped) {
            // 토스트 정리 + textbox 복구
            try { await this._dismissFailure(); } catch {}
            try { await this._waitForTextboxReady(); } catch {}

            // 원본 프롬프트 1회 재시도 (단순화 X)
            this._rateLimitDetected = false;
            try {
              await this._typePrompt(prompt);
              await this.page.waitForTimeout(500);
              await this._clickFinalCreateV2();
              const retryTimeout = opts.mediaType === 'video' ? 180000 : 120000;
              const retryBuffer = await this._waitForImage(retryTimeout, opts.mediaType === 'video');
              if (retryBuffer) {
                await this._saveImage(retryBuffer, num, shortText, imgDir, opts);
                this.log(`[${num}] rate-limit 후 재시도 성공!`);
                successCount++;
                consecutiveFails = 0;
                this._consecutiveSuccessForRateReset++;
                if (this._consecutiveSuccessForRateReset >= 3 && this._sessionRateLimitCount > 0) {
                  this._sessionRateLimitCount = 0;
                  this._consecutiveSuccessForRateReset = 0;
                }
                if (this._completedNums) this._completedNums.push(num);
        this.send('image-done', { index: i, num });
                this._resetGroupRateLimitCounter();
                rateLimitResolved = true;
              }
            } catch (retryErr) {
              this.debug(`  [rate-limit retry] ${retryErr.message}`);
            }
          }

          if (!rateLimitResolved) {
            // 재시도 실패 또는 stop — 현재 프로필 포기, run 종료. renderer 가 다음 프로필로 폴백.
            const remainingNums = [];
            for (let j = i; j < paragraphs.length; j++) {
              // paragraphs index j 에 대응하는 num 은 caller 에서 매핑하지만, 여기서는 단순히 paragraph idx (1-based)
              // 실제 그룹 num 은 renderer 의 _pendingGroupNums 로 매핑됨
              remainingNums.push(j + 1);
            }
            const exhaustReason = isSuspicious ? 'suspicious-activity' : 'rate-limit';
            const headerEmoji = isSuspicious ? '🚨' : '🛑';
            const headerLabel = isSuspicious ? '비정상 활동 감지로 즉시 차단' : 'rate-limit 도달';
            this.log(`${headerEmoji} 프로필 ${this._currentProfileId || 'default'} ${headerLabel} — run 종료, 남은 ${remainingNums.length}개 그룹은 다른 프로필로 폴백 시도`);
            this.send('flow-rate-exhausted', {
              profileId: this._currentProfileId || 'default',
              completedNums: this._completedNums ? this._completedNums.slice() : [],
              remainingNums,
              sessionRateLimitCount: this._sessionRateLimitCount,
              reason: exhaustReason,
            });
            this._rateExhaustedFlag = true;
            this._resetGroupRateLimitCounter();
            break; // for (i) 종료
          }
          // rateLimitResolved=true → for 루프 다음 iteration 자연 진행
        } else {
          // 재시도 전략: 최대 5회
          // 1~2회: 빠른 단순화 재시도
          // 3회부터: 10초 쿨다운 + 페이지 새로고침 + 배너/입력창 복구 + 단순화
          // 5회 실패 시 생성실패이미지.txt 기록
          const MAX_RETRIES = 5;
          let retrySuccess = false;
          for (let retryN = 1; retryN <= MAX_RETRIES && !retrySuccess; retryN++) {
            if (this._stopped) break;
            const heavyRecovery = retryN >= 3;

            if (heavyRecovery) {
              this.log(`[${num}] 재시도 ${retryN}/${MAX_RETRIES} — 10초 대기 + 페이지 새로고침`);
              await this.page.waitForTimeout(10000);
              if (this._stopped) break;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await this.page.waitForTimeout(3000);
                await this._dismissBanners().catch(() => {});
                await this._waitForTextboxReady().catch(() => {});
              } catch (reloadErr) {
                this.debug(`  [새로고침 실패] ${reloadErr.message}`);
              }
            } else {
              this.log(`[${num}] 재시도 ${retryN}/${MAX_RETRIES} (프롬프트 단순화)`);
              await this.page.waitForTimeout(3000);
            }

            // 재시도 횟수에 따라 프롬프트 단순화 강도 증가
            const simplifyLevel = Math.min(3, retryN);
            const simplifiedPrompt = this._buildSimplifiedPrompt(prompt, simplifyLevel);
            this.debug(`  [단순화 L${simplifyLevel}] ${simplifiedPrompt.substring(0, 80)}`);

            try {
              await this._typePrompt(simplifiedPrompt);
              await this.page.waitForTimeout(500);
              await this._clickFinalCreateV2();
              const retryTimeout = opts.mediaType === 'video' ? 180000 : 120000;
              const retryBuffer = await this._waitForImage(retryTimeout, opts.mediaType === 'video');
              if (retryBuffer) {
                await this._saveImage(retryBuffer, num, shortText, imgDir, opts);
                this.log(`[${num}] 재시도 ${retryN} 성공!`);
                successCount++;
                consecutiveFails = 0;
                if (this._completedNums) this._completedNums.push(num);
        this.send('image-done', { index: i, num });
                retrySuccess = true;
                break;
              }
            } catch (retryErr) {
              this.debug(`  [재시도 ${retryN} 오류] ${retryErr.message}`);
            }
          }
          if (!retrySuccess) {
            this.log(`[${num}] 생성 실패 — ${MAX_RETRIES}회 모두 실패, 생성실패이미지.txt에 기록`);
            if (this._failedNums) this._failedNums.push({ num, text: paragraphs[i].substring(0, 80) });
            consecutiveFails++;

            // v1.13.29: 연속 실패 감지 — 5회 도달 시 60초 대기 대신 즉시 폴백 트리거.
            // 그 계정으로 더 시도해도 의미 없다고 판단 (정책 위반 / 차단 / 세션 붕괴 등).
            // 다음 프로필로 폴백해 끝까지 작업 진행.
            if (consecutiveFails >= CONSECUTIVE_DEEP_RECOVERY) {
              this.log(`🛑 프로필 ${this._currentProfileId || 'default'} 에서 ${consecutiveFails}개 연속 실패 — 현재 프로필 차단 의심, 다음 프로필로 폴백 트리거`);
              const remainingNumsArr = [];
              for (let j = i + 1; j < paragraphs.length; j++) {
                remainingNumsArr.push(String(j + 1).padStart(2, '0'));
              }
              this.send('flow-rate-exhausted', {
                profileId: this._currentProfileId || 'default',
                completedNums: this._completedNums ? this._completedNums.slice() : [],
                remainingNums: remainingNumsArr,
                sessionRateLimitCount: this._sessionRateLimitCount,
                reason: 'consecutive-fails',
                consecutiveFails,
              });
              this._rateExhaustedFlag = true;
              break;
            }
          }
        }
      } catch (err) {
        this.log(`[${num}] 오류: ${err.message}`);
        // v1.13.29: catch 블록에서도 연속 실패 카운팅 (silent fail 방지).
        // 이전엔 throw 발생 시 fail 카운트 안 됨 → 0/N 케이스에서도 폴백 안 트리거.
        if (this._failedNums) this._failedNums.push({ num, text: paragraphs[i].substring(0, 80), reason: 'exception' });
        consecutiveFails++;
        if (consecutiveFails >= CONSECUTIVE_DEEP_RECOVERY) {
          this.log(`🛑 프로필 ${this._currentProfileId || 'default'} 에서 ${consecutiveFails}개 연속 실패(예외 포함) — 다음 프로필로 폴백 트리거`);
          const remainingNumsArr = [];
          for (let j = i + 1; j < paragraphs.length; j++) {
            remainingNumsArr.push(String(j + 1).padStart(2, '0'));
          }
          this.send('flow-rate-exhausted', {
            profileId: this._currentProfileId || 'default',
            completedNums: this._completedNums ? this._completedNums.slice() : [],
            remainingNums: remainingNumsArr,
            sessionRateLimitCount: this._sessionRateLimitCount,
            reason: 'consecutive-fails-exception',
            consecutiveFails,
          });
          this._rateExhaustedFlag = true;
          break;
        }
      }

      // v1.13.29: 0-success 안전망 — 첫 N개 연속 실패면 계정 차단 명확 신호. 즉시 폴백.
      // 5회 cap 도달 전이라도 처음부터 한 개도 못 만들면 그 계정 시도 무의미.
      if (successCount === 0 && consecutiveFails >= 3 && i < paragraphs.length - 1 && !this._rateExhaustedFlag) {
        this.log(`🛑 프로필 ${this._currentProfileId || 'default'} 처음 ${i + 1}개 시도 모두 실패 (성공 0) — 계정 차단 의심, 즉시 다음 프로필로 폴백`);
        const remainingNumsArr = [];
        for (let j = i + 1; j < paragraphs.length; j++) {
          remainingNumsArr.push(String(j + 1).padStart(2, '0'));
        }
        this.send('flow-rate-exhausted', {
          profileId: this._currentProfileId || 'default',
          completedNums: [],
          remainingNums: remainingNumsArr,
          sessionRateLimitCount: this._sessionRateLimitCount,
          reason: 'zero-success-early',
          consecutiveFails,
        });
        this._rateExhaustedFlag = true;
        break;
      }

      // v1.13.23: 적극적 순차 전환 — N개 그룹 성공 시 rate-limit 발생 전에 자동 교대
      // (renderer 가 proactiveSwitchEveryN 으로 등록 프로필 수 기반 자동 계산해서 전달)
      if (this._proactiveSwitchEveryN > 0 &&
          successCount >= this._proactiveSwitchEveryN &&
          i < paragraphs.length - 1 &&
          !this._stopped) {
        this.log(`🔄 프로필 ${this._currentProfileId} 에서 ${successCount}개 성공 — 적극적 순차 전환 정책에 따라 다음 프로필로 교대 (rate-limit 발생 전 회피)`);
        this._rateExhaustedFlag = true;
        this._proactiveSwitchTriggered = true;
        const remainingNumsArr = [];
        for (let j = i + 1; j < paragraphs.length; j++) {
          remainingNumsArr.push(String(j + 1).padStart(2, '0'));
        }
        this.send('flow-rate-exhausted', {
          profileId: this._currentProfileId || 'default',
          completedNums: this._completedNums ? this._completedNums.slice() : [],
          remainingNums: remainingNumsArr,
          sessionRateLimitCount: this._sessionRateLimitCount,
          reason: 'proactive-switch',
        });
        break;
      }

      // 다음 단락 준비
      if (i < paragraphs.length - 1) {
        this.log(`[${num}] 다음 단락 준비`);
        // 안티 디텍션: 가우시안 분포 (활성: 8~20초 + 10% 확률 30~60초 / 비활성: 2초 고정)
        const nextDelay = this.antiDetect.getHumanDelay();
        if (this.antiDetect.enabled) {
          this.log(`  [대기] ${(nextDelay / 1000).toFixed(1)}초`);
        }
        await this.page.waitForTimeout(nextDelay);
        // 다음 단락 진입 전 일시정지 체크
        await this._waitIfPaused();
        if (this._stopped) break;
      }
    }
    return successCount;
  }

  // ─── v2.0: 배치 모드 (프롬프트 연속 전송 → 일괄 다운로드) ───
  async _runBatchMode(paragraphs, prompts, imgDir, opts) {
    this.log('\n[배치] 배치 모드 시작 — 프롬프트 연속 전송 후 일괄 다운로드');

    // Phase 1: 프롬프트 연속 전송
    const sentIndices = [];
    let settingsConfigured = false;

    for (let i = 0; i < paragraphs.length; i++) {
      // 중지/일시정지 체크
      if (this._stopped) { this.log('사용자에 의해 중지됨'); break; }
      await this._waitIfPaused();
      if (this._stopped) break;

      const num = String(i + 1).padStart(2, '0');
      const shortText = paragraphs[i].substring(0, 15).replace(/[\n\r\\/:*?"<>|]/g, '').trim();

      // 기존 파일 건너뛰기
      if (this._shouldSkip(num, imgDir)) {
        this.log(`[${num}] 이미 존재, 스킵`);
        continue;
      }

      // 403 복구
      if (this._rateLimited) {
        await this._handleRateLimit();
        settingsConfigured = false;
      }

      this.progress(i + 1, paragraphs.length, `[배치 전송] ${num}번`);
      this.log(`[배치 전송 ${num}/${paragraphs.length}] ${paragraphs[i].substring(0, 30)}...`);

      try {
        // 텍스트 입력란 대기
        await this._waitForTextboxReady();

        // 에이전트 모드 OFF 보장 (자동 이미지 생성엔 마이너스 요인)
        await this._ensureAgentOff();

        if (opts.humanizedTyping) {
          await this._typePromptHumanized(prompts[i], opts.typingSpeed);
        } else {
          await this._typePrompt(prompts[i]);
        }

        if (!settingsConfigured) {
          await this._configureSettings(opts);
          settingsConfigured = true;
        }

        await this._clickFinalCreateV2();
        sentIndices.push(i);

        // 짧은 대기 (Flow가 프롬프트를 접수할 시간)
        await this.page.waitForTimeout(3000);
      } catch (err) {
        this.log(`[배치 전송 ${num}] 오류: ${err.message}`);
      }
    }

    this.log(`\n[배치] 전송 완료: ${sentIndices.length}개`);

    // Phase 2: 생성 완료 대기
    if (sentIndices.length === 0) return 0;

    this.log('[배치] 전체 생성 완료 대기 중...');
    await this._waitForAllGeneration(sentIndices.length, 180000);

    // Phase 3: 일괄 다운로드
    this.log('[배치] 일괄 다운로드 시작...');
    let successCount = 0;

    // 타일 스크롤하여 모든 이미지 로드
    const allImages = await this._collectAllGeneratedImages(sentIndices.length);

    for (let si = 0; si < sentIndices.length && si < allImages.length; si++) {
      // 중지/일시정지 체크 (다운로드 단계)
      if (this._stopped) break;
      await this._waitIfPaused();
      if (this._stopped) break;

      const idx = sentIndices[si];
      const num = String(idx + 1).padStart(2, '0');
      const shortText = paragraphs[idx].substring(0, 15).replace(/[\n\r\\/:*?"<>|]/g, '').trim();

      this.progress(si + 1, sentIndices.length, `[다운로드] ${num}번`);

      const buf = allImages[si];
      if (buf && buf.length > 10000) {
        await this._saveImage(buf, num, shortText, imgDir, opts);
        successCount++;
        if (this._completedNums) this._completedNums.push(num);
        this.send('image-done', { index: idx, num });
      } else {
        this.log(`[${num}] 다운로드 실패`);
      }
    }

    return successCount;
  }

  // ─── v2.0: 이미지 저장 헬퍼 ───
  async _saveImage(buffer, num, shortText, imgDir, opts) {
    // MP4 시그니처: 오프셋 4에 "ftyp"
    const isMp4 = buffer.length > 8 && buffer.slice(4, 8).toString() === 'ftyp';
    const ext = isMp4 ? 'mp4' : (buffer[0] === 0xFF && buffer[1] === 0xD8) ? 'jpg' : 'png';

    if (opts.withSubtitle) {
      const rawPath = path.join(imgDir, `${num}_raw.${ext}`);
      fs.writeFileSync(rawPath, buffer);
      const finalPath = path.join(imgDir, `${num}_${shortText}.png`);
      await this._addSubtitle(rawPath, shortText, finalPath);
      fs.unlinkSync(rawPath);
      this.log(`[${num}] 저장 완료: ${path.basename(finalPath)}`);
    } else {
      const finalPath = path.join(imgDir, `${num}_${shortText}.${ext}`);
      fs.writeFileSync(finalPath, buffer);
      this.log(`[${num}] 저장 완료: ${path.basename(finalPath)} (${Math.round(buffer.length / 1024)}KB)`);
    }
    // 계정별 '성공' 장수 +1 (계정당 하루 한도 + 표시용). 실패는 세지 않음.
    try { if (this.antiDetect && this.antiDetect.registerGenerationSuccess) this.antiDetect.registerGenerationSuccess(); } catch (_) {}
  }

  // ─── v2.0: 기존 파일 건너뛰기 ───
  _shouldSkip(num, imgDir) {
    try {
      const files = fs.readdirSync(imgDir);
      return files.some(f => f.startsWith(num + '_') && (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.mp4')));
    } catch { return false; }
  }

  // ─── v2.0: 설정 통합 메서드 (role="tab" 기반 — 실제 Flow DOM 검증 2026-06-05) ───
  // Flow 설정 팝업: 칩(🍌 Nano Banana/Veo … xN) 클릭 → role="tab" 요소들이 등장.
  //   · 이미지/동영상 토글: tab "이미지" / "동영상"
  //   · 비율: tab "16:9" "4:3" "1:1" "3:4" "9:16" (동영상 모드는 16:9/9:16만)
  //   · 매수: tab "1x" "x2" "x3" "x4"
  //   · 모델: button "🍌 Nano Banana 2" / "Veo 3.1 …" (드롭다운)
  // 접근성 이름이 정확히 그 텍스트라, Playwright getByRole 로 안정적으로 선택 (옛 텍스트/innerText 매칭 폐기).
  async _configureSettings(opts) {
    this.log(`  [설정] 미디어 ${opts.mediaType}, 비율 ${opts.ratio}, 매수 ${opts.count}, 모델 ${opts.model}`);

    // 1) 팝업 열기 — 칩 1회 클릭 후 비율 탭(role=tab)이 보일 때까지 확인. 이미 열려 있으면 재클릭 안 함(토글 닫힘 방지).
    let popupOpened = false;
    for (let r = 0; r < 3 && !popupOpened; r++) {
      const alreadyOpen = await this._isTabVisible(opts.ratio);
      if (!alreadyOpen) { await this._openSettingsPopup(); await this.page.waitForTimeout(800); }
      popupOpened = await this._isTabVisible(opts.ratio);
    }

    if (!popupOpened) {
      this.log('  [!] 미디어 설정 popup 안 열림 (role=tab 비율 미검출) — 진단 덤프:');
      await this._dumpRatioButtons(opts.ratio);
      this.log('  → 기본 설정으로 진행.');
      return;
    }

    // 2) 이미지/동영상 토글
    const mediaTab = opts.mediaType === 'video' ? '동영상' : '이미지';
    if (await this._clickTab(mediaTab)) this.log(`  [설정] ${mediaTab} 탭 ✓`);
    await this.page.waitForTimeout(400);   // 토글 후 비율/매수 재렌더 대기

    // 3) 비율
    if (await this._clickTab(opts.ratio)) this.log(`  [설정] 비율 ${opts.ratio} ✓`);
    else this.log(`  [!] 비율 ${opts.ratio} 탭 못 찾음`);
    await this.page.waitForTimeout(200);

    // 4) 매수 — Flow 표기 "1x"/"x2"/"x3"/"x4" (x1 입력은 1x 로 보정)
    const cm = String(opts.count || '').match(/(\d+)/);
    const countName = cm ? (cm[1] === '1' ? '1x' : `x${cm[1]}`) : String(opts.count || '');
    if (countName && await this._clickTab(countName)) this.log(`  [설정] 매수 ${countName} ✓`);
    await this.page.waitForTimeout(200);

    // 5) 모델 — 기본값과 다를 때만 드롭다운에서 변경
    const defaultModel = opts.mediaType === 'video' ? 'Veo 3.1 - Fast' : 'Nano Banana 2';
    if (opts.model && opts.model !== defaultModel) {
      await this._selectModel(opts.model);
    }

    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);
  }

  // Flow 설정 팝업의 role="tab" 가시성 확인 (팝업 열림 판별에 사용)
  // role=tab 의 접근성 이름에 아이콘 ligature 텍스트가 섞임 (2026-06-10 openclaude 실측):
  //   <i class="google-sym">crop_16_9</i> 에 aria-hidden 이 없어 이름이 "crop_16_9 16:9" 가 됨
  //   → exact:true('16:9') 매칭 실패. exact 우선 시도 후 부분일치(substring) 폴백.
  //   부분일치 충돌 없음 검증: '16:9'↔"crop_16_9 16:9"만, '9:16'↔"crop_9_16 9:16"만 매칭.
  _tabLocator(name) {
    return this.page.getByRole('tab', { name, exact: true }).or(
           this.page.getByRole('tab', { name, exact: false })).first();
  }

  async _isTabVisible(name) {
    try {
      return await this._tabLocator(name).isVisible({ timeout: 800 });
    } catch (_) { return false; }
  }

  // Flow 설정 팝업의 role="tab" 클릭 (이미지/동영상·비율·매수 공통). 성공 시 true.
  async _clickTab(name) {
    try {
      const tab = this._tabLocator(name);
      await tab.waitFor({ state: 'visible', timeout: 2500 });
      await tab.click({ timeout: 3000 });
      await this.page.waitForTimeout(150);
      return true;
    } catch (_) { return false; }
  }

  // ─── v2.0: 403 감지 + 쿨다운 + 세션 복구 ───
  _setupNetworkMonitor() {
    this._rateLimited = false;
    this._403Count = 0;

    this.page.on('response', (response) => {
      try {
        const status = response.status();
        const url = response.url();
        if ((status === 403 || status === 401) && url.includes('labs.google')) {
          this._403Count++;
          if (this._403Count >= 2 && !this._rateLimited) {
            this._rateLimited = true;
            this.log(`[!] 403 감지 (${this._403Count}회) — 속도 제한`);
          }
        }
      } catch {}
    });
  }

  async _handleRateLimit() {
    if (!this._rateLimited) return;

    // 안티 디텍션 활성: 적응형 쿨다운 (2~5분 랜덤). 비활성: 기존 60초 고정.
    const cooldownMs = this.antiDetect ? this.antiDetect.getRateLimitCooldown() : this._cooldownMs;
    const waitSec = Math.round(cooldownMs / 1000);
    if (this.antiDetect && this.antiDetect.enabled) {
      this.log(`[403] 안티 디텍션 강화 쿨다운 ${waitSec}초 대기 중... (2~5분 랜덤)`);
    } else {
      this.log(`[403] 쿨다운 ${waitSec}초 대기 중...`);
    }
    this.send('rate-limit', { waitSeconds: waitSec });

    await this.page.waitForTimeout(cooldownMs);

    // 세션 복구: 페이지 새로고침 + 새 프로젝트
    this.log('[403] 세션 복구 중...');
    await this.page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(3000);
    await this._dismissBanners();
    await this._createNewProject();
    await this.page.waitForTimeout(2000);

    this._rateLimited = false;
    this._403Count = 0;
    this.log('[403] 세션 복구 완료, 재개');
  }

  // ─── v2.0: 휴먼화 타이핑 ───
  async _typePromptHumanized(text, speedMultiplier = 1.0) {
    // Locator + 재시도 — DOM 재렌더로 인한 "Element is not attached" 방지 (_typePrompt 와 동일 정책)
    const inputLoc = this.page.locator('div[role="textbox"][contenteditable="true"]').first();
    await inputLoc.waitFor({ state: 'visible', timeout: 10000 });
    let clicked = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 마지막 시도는 가로채는 팝업을 닫고 force 클릭으로 돌파
        if (attempt === 3) { await this._dismissBlockingOverlay(true); await inputLoc.click({ timeout: 5000, force: true }); }
        else await inputLoc.click({ timeout: 5000 });
        clicked = true; break;
      }
      catch (e) {
        if (attempt === 3) throw e;
        this.debug(`[Flow] 입력창 클릭 재시도 ${attempt}/3 — ${e.message.split('\n')[0]}`);
        await this._dismissBlockingOverlay(attempt === 1);   // 가로채는 팝업이면 닫고 재시도
        await this.page.waitForTimeout(800);
      }
    }
    if (!clicked) throw new Error('프롬프트 입력창 클릭 실패');
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Control+a');
    await this.page.keyboard.press('Backspace');
    await this.page.waitForTimeout(200);

    // 문자별 랜덤 딜레이 타이핑
    for (const char of text) {
      await this.page.keyboard.type(char, { delay: 0 });
      const baseDelay = char === ' ' ? this._rand(18, 85) : this._rand(24, 120);
      let delay = Math.round(baseDelay / speedMultiplier);
      // 7% 확률로 추가 정지
      if (Math.random() < 0.07) delay += this._rand(35, 130);
      await this.page.waitForTimeout(delay);
    }

    await this.page.waitForTimeout(500);
    this.debug('[Flow] 프롬프트 입력 완료 (휴먼 타이핑)');
  }

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ─── v2.0: 텍스트박스 입력 가능 대기 ───
  async _waitForTextboxReady(timeout = 15000) {
    try {
      await this.page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout });
    } catch {
      // 타임아웃 시 페이지 새로고침 후 재시도
      this.log('  [!] 텍스트박스 미발견, 페이지 새로고침');
      await this.page.reload({ waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);
      await this._dismissBanners();
    }
  }

  // ─── v2.0: 배치 모드 - 전체 생성 완료 대기 ───
  async _waitForAllGeneration(expectedCount, timeout) {
    const startTime = Date.now();
    let lastCount = 0;

    while (Date.now() - startTime < timeout) {
      await this.page.waitForTimeout(5000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // 현재 생성된 이미지 수 카운트
      const count = await this.page.evaluate(() => {
        const imgs = document.querySelectorAll('img');
        let c = 0;
        for (const img of imgs) {
          if (img.offsetWidth > 100 && img.offsetHeight > 100 &&
              !img.src.includes('icon') && !img.src.includes('logo') &&
              !img.src.includes('avatar') && !img.src.includes('perlin') &&
              !img.src.includes('profile')) c++;
        }
        return c;
      });

      // 진행률 표시 감지
      const progressPct = await this._detectGenerationProgress();
      const pctStr = progressPct ? ` (${progressPct}%)` : '';

      if (count !== lastCount) {
        this.log(`  [배치] 생성 완료: ${count}/${expectedCount}${pctStr}`);
        lastCount = count;
      } else if (elapsed % 15 === 0) {
        this.log(`  [배치] 대기 중... ${elapsed}초${pctStr}`);
      }

      // 로딩 중인 이미지가 없으면 완료
      const isGenerating = await this.page.evaluate(() => {
        const els = document.querySelectorAll('span, div');
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (/^\d{1,2}%$/.test(text)) return true;
        }
        return !!document.querySelector('[role="progressbar"]');
      });

      if (!isGenerating && count >= expectedCount) break;
    }
  }

  // ─── v2.0: 생성 진행률 감지 ───
  async _detectGenerationProgress() {
    try {
      return await this.page.evaluate(() => {
        const els = document.querySelectorAll('span, div');
        for (const el of els) {
          const text = (el.textContent || '').trim();
          const rect = el.getBoundingClientRect();
          if (/^\d{1,3}%$/.test(text) && rect.y < 700 && rect.width > 10) {
            return parseInt(text);
          }
        }
        return null;
      });
    } catch { return null; }
  }

  // ─── v2.0: 배치 모드 - 모든 생성 이미지 수집 ───
  async _collectAllGeneratedImages(expectedCount) {
    const images = [];

    // 모든 이미지 요소 수집 (큰 이미지만)
    const imgInfos = await this.page.$$eval('img', imgs => imgs.map(i => ({
      src: i.src,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
      displayWidth: i.offsetWidth,
      displayHeight: i.offsetHeight,
    })).filter(i =>
      i.displayWidth > 100 && i.displayHeight > 100 &&
      !i.src.includes('icon') && !i.src.includes('logo') &&
      !i.src.includes('avatar') && !i.src.includes('perlin') &&
      !i.src.includes('profile') && i.src.startsWith('http')
    ));

    this.log(`[배치] 발견된 이미지: ${imgInfos.length}개`);

    for (let i = 0; i < Math.min(imgInfos.length, expectedCount); i++) {
      const info = imgInfos[i];
      try {
        await this.page.waitForTimeout(500);
        const fetchResult = await this.page.evaluate(async (url) => {
          try {
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const blob = await resp.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            });
          } catch { return null; }
        }, info.src);

        if (fetchResult) {
          const buf = Buffer.from(fetchResult.split(',')[1], 'base64');
          this.log(`  [다운로드 ${i + 1}/${expectedCount}] ${info.naturalWidth}x${info.naturalHeight}, ${Math.round(buf.length / 1024)}KB`);
          images.push(buf);
        } else {
          images.push(null);
        }
      } catch {
        images.push(null);
      }
    }

    return images;
  }

  // ─── v2.0: 2K/4K 고해상도 다운로드 ───
  async _downloadHighRes(tileElement, resolution = '2K') {
    try {
      // 타일 호버하여 메뉴 버튼 노출
      await tileElement.hover();
      await this.page.waitForTimeout(500);

      // more_vert 버튼 클릭
      const moreBtn = await tileElement.$('button:has-text("more_vert")');
      if (!moreBtn) return null;
      await moreBtn.click();
      await this.page.waitForTimeout(500);

      // "다운로드" 메뉴 클릭
      const dlBtn = await this.page.$('text=다운로드') || await this.page.$('text=Download');
      if (!dlBtn) return null;
      await dlBtn.click();
      await this.page.waitForTimeout(500);

      // 해상도 선택
      const resBtn = await this.page.$(`text=${resolution}`);
      if (resBtn) {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          resBtn.click(),
        ]);
        // 임시 파일로 저장 후 버퍼로 읽기
        const tmpPath = path.join(os.tmpdir(), `flow_dl_${Date.now()}`);
        await download.saveAs(tmpPath);
        const buf = fs.readFileSync(tmpPath);
        fs.unlinkSync(tmpPath);
        this.log(`  [고해상도] ${resolution} 다운로드 완료 (${Math.round(buf.length / 1024)}KB)`);
        return buf;
      }
    } catch (err) {
      this.log(`  [고해상도] 실패: ${err.message}`);
    }
    return null;
  }

  // ─── i2v: 영상 모드에서 소스 이미지를 '프레임/애셋'으로 첨부 ───
  // best-effort 셀렉터 + 상세 로그/덤프 — 실제 Flow 영상 UI 로그를 보고 정확히 고정 예정.
  async _attachFrameImage(imagePath, num) {
    try {
      if (!imagePath || !fs.existsSync(imagePath)) { this.log(`  [i2v ${num}] 소스 이미지 없음: ${imagePath}`); return false; }
      this.log(`  [i2v ${num}] 프레임 이미지 첨부 시도: ${path.basename(imagePath)}`);

      // 1) '프레임/애셋' 추가 컨트롤 클릭 (best-effort — 텍스트/aria 기반)
      const triggers = ['프레임', '애셋', '에셋', 'Frame', 'Asset', '이미지 추가', '추가', 'Add'];
      let clicked = false;
      for (const t of triggers) {
        try {
          const btn = this.page.getByRole('button', { name: t, exact: false }).first();
          if (await btn.isVisible({ timeout: 500 })) { await btn.click({ timeout: 1500 }); clicked = true; this.log(`  [i2v ${num}] '${t}' 컨트롤 클릭`); break; }
        } catch (_) {}
      }
      await this.page.waitForTimeout(400);

      // 2) 파일 input 에 이미지 설정 (hidden input 직접 — 대화상자 회피)
      let set = false;
      try {
        const inputs = await this.page.$$('input[type="file"]');
        for (const inp of inputs) {
          try {
            const accept = (await inp.getAttribute('accept')) || '';
            if (accept && !/image/i.test(accept)) continue;
            await this.page.evaluate((el) => { el.style.cssText = 'display:block !important; opacity:1; position:fixed; top:0; left:0; z-index:99999;'; }, inp);
            await inp.setInputFiles(imagePath);
            set = true; this.log(`  [i2v ${num}] 파일 input 업로드 ✓ (accept="${accept}")`); break;
          } catch (_) {}
        }
      } catch (_) {}

      if (!set) {
        this.log(`  [i2v ${num}] ⚠ 프레임 첨부 실패(트리거클릭=${clicked}) — UI 후보 덤프(이 목록에서 '애셋/프레임 추가' 항목을 알려주시면 정확히 고정):`);
        await this._dumpFrameAttachUI();
        return false;
      }
      await this.page.waitForTimeout(1500); // 업로드 반영 대기
      this.log(`  [i2v ${num}] 프레임 첨부 완료`);
      return true;
    } catch (e) { this.log(`  [i2v ${num}] 첨부 예외: ${e.message}`); return false; }
  }

  // i2v 첨부 UI 진단 — 버튼/입력 후보를 로그로 남겨 셀렉터 고정에 사용
  async _dumpFrameAttachUI() {
    try {
      const info = await this.page.evaluate(() => {
        const out = [];
        let i = 0;
        document.querySelectorAll('button, [role="button"], input[type="file"], [aria-label]').forEach((el) => {
          if (i++ > 80) return;
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('accept') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
          if (t) out.push(`${el.tagName.toLowerCase()}${el.type ? '[' + el.type + ']' : ''}: ${t}`);
        });
        return [...new Set(out)];
      });
      info.slice(0, 45).forEach((l) => this.log('    ' + l));
    } catch (e) { this.log('  [i2v DUMP] 실패: ' + e.message); }
  }

  // ─── v2.0: 캐릭터 참조 이미지 업로드 ───
  async _uploadCharacterImages(imagePaths) {
    this.log(`[캐릭터] ${imagePaths.length}개 참조 이미지 업로드 중...`);

    // hidden file input에 직접 파일 설정 (버튼 클릭 없이 — 열기 대화상자 방지)
    const validPaths = imagePaths.filter(p => fs.existsSync(p));
    if (validPaths.length === 0) {
      this.log('  [!] 유효한 이미지 파일 없음');
      return;
    }

    try {
      // file input을 visible로 만들고 파일 설정
      const fileInput = await this.page.$('input[type="file"][accept*="image"]');
      if (fileInput) {
        await this.page.evaluate(el => {
          el.style.cssText = 'display:block !important; opacity:1; position:fixed; top:0; left:0; z-index:99999;';
        }, fileInput);
        await this.page.waitForTimeout(300);
        await fileInput.setInputFiles(validPaths);
        this.log(`  [업로드] ${validPaths.length}개 파일 전송 중...`);

        // 동의 팝업 자동 처리
        await this.page.waitForTimeout(1500);
        try {
          const agreeBtn = await this.page.$('button:has-text("동의함")') || await this.page.$('button:has-text("I agree")');
          if (agreeBtn && await agreeBtn.isVisible()) {
            await agreeBtn.click();
            this.log('  [동의] 업로드 동의 팝업 확인');
            await this.page.waitForTimeout(1000);
          }
        } catch {}

        // 업로드 완료 감지
        this.log(`  업로드 대기 중...`);

        // 1단계: 이미지 로드 완료 대기
        for (let i = 0; i < 20; i++) {
          await this.page.waitForTimeout(3000);
          const loadStatus = await this.page.evaluate(() => {
            const imgs = document.querySelectorAll('img');
            let loaded = 0, total = 0;
            for (const img of imgs) {
              if (img.offsetWidth > 50 && img.offsetHeight > 50) {
                total++;
                if (img.complete && img.naturalWidth > 0) loaded++;
              }
            }
            return { loaded, total };
          });
          this.log(`  이미지 로드: ${loadStatus.loaded}/${loadStatus.total} (${(i + 1) * 3}초)`);
          if (loadStatus.loaded >= validPaths.length && loadStatus.loaded >= loadStatus.total) {
            break;
          }
        }

        // 2단계: 네트워크 idle 대기 (서버 업로드 완료)
        try {
          await this.page.waitForLoadState('networkidle', { timeout: 30000 });
        } catch {}

        // 3단계: 안정화 대기
        await this.page.waitForTimeout(3000);
        this.log(`  [캐릭터] ${validPaths.length}개 이미지 업로드 완료`);
      } else {
        this.log('  [!] file input 요소를 찾을 수 없음');
      }
    } catch (err) {
      this.log(`  [!] 업로드 실패: ${err.message}`);
    }

    // 업로드 후 ESC로 팝업 닫기 (갤러리 이미지 클릭 방지)
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(1000);
  }

  // ─── 갤러리에서 캐릭터 이미지 클릭 (상세보기 진입) ───
  async _clickGalleryImage(charName) {
    try {
      // 갤러리 타일에서 파일명으로 찾기
      const found = await this.page.evaluate((name) => {
        // 갤러리 이미지 타일들의 부모에서 파일명 매칭
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (r.width < 100 || r.height < 80 || r.y < 50) continue;
          // 이미지의 alt, title, 또는 근처 텍스트에서 이름 찾기
          const alt = img.alt || '';
          const title = img.title || '';
          const parent = img.closest('div');
          const parentText = parent ? parent.textContent : '';
          if (alt.includes(name) || title.includes(name) || parentText.includes(name)) {
            // 이 이미지의 위치 반환
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, charName);

      if (found) {
        await this.page.mouse.click(found.x, found.y);
        this.debug(`  [캐릭터] 갤러리에서 ${charName} 클릭`);
        return true;
      }

      // 대안: 파일명 텍스트로 찾기
      const exts = ['.jpg', '.jpeg', '.png', '.webp'];
      for (const ext of exts) {
        const fileName = `${charName}${ext}`;
        // 갤러리 영역(y < 800)에서만 파일명 찾기
        const el = await this.page.evaluateHandle((fn) => {
          const divs = document.querySelectorAll('div, span');
          for (const d of divs) {
            const r = d.getBoundingClientRect();
            if (r.y > 800 || r.y < 50) continue; // 갤러리 영역만
            if (d.textContent.trim() === fn && d.children.length === 0) return d;
          }
          return null;
        }, fileName);
        if (el && el.asElement()) {
          await el.asElement().click();
          this.debug(`  [캐릭터] 갤러리에서 ${fileName} 텍스트 클릭`);
          return true;
        }
      }

      this.debug(`  [캐릭터] 갤러리에서 ${charName} 못 찾음`);
      return false;
    } catch (err) {
      this.debug(`  [캐릭터] 갤러리 클릭 오류: ${err.message}`);
      return false;
    }
  }

  // ─── 캐릭터 참조 추가 (add_2 → 피커 → locator 스코핑 클릭) ───
  async _addCharacterReference(charName) {
    try {
      // 1. add_2 버튼 클릭
      const addBtn = this.page.locator('button.sc-addd5871-0').first();
      if (await addBtn.count() === 0) {
        this.log(`  [캐릭터] add_2 버튼 없음`);
        return;
      }
      await addBtn.click();
      this.log(`  [캐릭터] add_2 클릭`);

      // 2. 피커 열림 대기
      try {
        await this.page.waitForSelector('input[placeholder="애셋 검색"]', { timeout: 5000 });
      } catch {
        this.log(`  [캐릭터] 피커 안 열림`);
        return;
      }
      await this.page.waitForTimeout(1000);

      // 3. 검색
      const searchInput = await this.page.$('input[placeholder="애셋 검색"]');
      if (!searchInput) { this.log(`  [캐릭터] 검색란 없음`); return; }
      await searchInput.fill(charName);
      this.log(`  [캐릭터] "${charName}" 검색`);
      await this.page.waitForTimeout(2000);

      // 4. 피커 다이얼로그 안에서만 파일명 클릭 (locator 스코핑)
      const dialog = this.page.locator('div[role="dialog"][data-state="open"]');
      if (await dialog.count() === 0) {
        this.log(`  [캐릭터] 다이얼로그 없음`);
        return;
      }

      const exts = ['.jpg', '.jpeg', '.png', '.webp'];
      let selected = false;
      for (const ext of exts) {
        const fileName = `${charName}${ext}`;
        const fileText = dialog.locator(`text="${fileName}"`).first();
        if (await fileText.count() > 0) {
          await fileText.click({ timeout: 3000 });
          selected = true;
          this.log(`  [캐릭터] ${fileName} 선택 완료`);
          break;
        }
      }

      if (!selected) this.log(`  [캐릭터] ${charName} 파일 못 찾음`);
      await this.page.waitForTimeout(1500);

    } catch (err) {
      this.log(`  [캐릭터] ${charName} 오류: ${err.message}`);
    }
  }

  // ─── 대본에서 캐릭터 이름 매칭 (최대 5명) ───
  _matchCharacters(koreanText, charMap) {
    const matched = [];
    for (const char of charMap) {
      if (koreanText.includes(char.name)) {
        matched.push(char);
        if (matched.length >= 5) break; // Flow 최대 5개
      }
    }
    return matched;
  }

  // ─── 프로젝트 메인 화면 확인 (상세보기에 있으면 뒤로가기) ───
  async _ensureProjectView() {
    for (let retry = 0; retry < 5; retry++) {
      // 상세보기 판별: 페이지에 .jpg/.png 파일명이 헤더에 보이는지
      const inDetailView = await this.page.evaluate(() => {
        const els = document.querySelectorAll('div, span, h1, h2');
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.y > 60 || r.x > 300) continue; // 좌상단 영역만
          const t = el.textContent.trim();
          if (/\.(jpg|jpeg|png|webp)$/i.test(t) && t.length < 50) return true;
        }
        return false;
      });

      if (!inDetailView) return; // 메인 화면

      this.debug(`  [네비] 상세보기 감지 → 뒤로가기 (${retry + 1})`);
      // arrow_back 아이콘 버튼 클릭
      const icons = await this.page.$$('i.google-symbols, span.google-symbols');
      for (const icon of icons) {
        const text = await icon.textContent().catch(() => '');
        if (text.trim() !== 'arrow_back') continue;
        if (!await icon.isVisible().catch(() => false)) continue;
        const btn = await icon.evaluateHandle(el => el.closest('button') || el.closest('a'));
        if (btn && btn.asElement()) {
          await btn.asElement().click();
          await this.page.waitForTimeout(3000);
          break;
        }
      }
    }
  }

  // ─── 장면별 캐릭터 참조 이미지 선택 (add_2 → 피커 → 파일명 클릭) ───
  async _selectCharactersFromAssets(characters) {
    for (const char of characters) {
      try {
        // 1. add_2 버튼 클릭
        this.log(`  [캐릭터] ${char.name} 선택 시작...`);
        const addBtn = await this.page.$('button.sc-addd5871-0') ||
                       await this.page.$('button[aria-haspopup="dialog"]:has(i:text("add_2"))');
        if (!addBtn || !await addBtn.isVisible().catch(() => false)) {
          this.log('  [캐릭터] add_2 버튼 없음 — 건너뜀');
          continue;
        }
        await addBtn.click();
        this.log('  [캐릭터] add_2 클릭 완료');

        // 2. 피커 다이얼로그 열릴 때까지 대기
        try {
          await this.page.waitForSelector('input[placeholder="애셋 검색"]', { timeout: 5000 });
          this.log('  [캐릭터] 피커 열림');
        } catch {
          this.log('  [캐릭터] 피커 안 열림 — 건너뜀');
          continue;
        }
        await this.page.waitForTimeout(1000);

        // 3. 검색
        const searchInput = await this.page.$('input[placeholder="애셋 검색"]');
        if (!searchInput) { this.log('  [캐릭터] 검색란 없음'); continue; }
        await searchInput.fill(char.name);
        this.log(`  [캐릭터] "${char.name}" 검색 중...`);
        await this.page.waitForTimeout(2000);

        // 4. 피커 내부 이미지 클릭 (Playwright locator 사용)
        let selected = false;

        // 피커 다이얼로그를 Playwright locator로 찾기
        const dialogLocator = this.page.locator('div[role="dialog"][data-state="open"]');
        const dialogCount = await dialogLocator.count();

        this.log(`  [캐릭터] 다이얼로그 수: ${dialogCount}`);

        if (dialogCount > 0) {
          // 다이얼로그 안의 이미지 클릭 (검색 결과)
          const imgLocator = dialogLocator.locator('img').first();
          const imgCount = await imgLocator.count();
          this.log(`  [캐릭터] 피커 내 이미지: ${imgCount}개`);

          if (imgCount > 0) {
            try {
              await imgLocator.click({ timeout: 3000 });
              selected = true;
              this.log(`  [캐릭터] ${char.name} 피커 내 이미지 클릭 성공`);
            } catch (e) {
              this.log(`  [캐릭터] 이미지 클릭 실패: ${e.message}`);
            }
          }
        } else {
          this.log('  [캐릭터] 다이얼로그 없음');
        }

        if (!selected) this.log(`  [캐릭터] ${char.name} 선택 실패`);

        await this.page.waitForTimeout(1500);
      } catch (err) {
        this.debug(`  [캐릭터] ${char.name} 오류: ${err.message}`);
      }
    }
  }

  // ─── 기존 내부 메서드 (유지) ───

  async _dismissBanners() {
    try {
      const agree = await this.page.$('button:has-text("Agree"), button:has-text("동의함")');
      if (agree && await agree.isVisible()) { await agree.click(); await this.page.waitForTimeout(1000); }
    } catch {}
    try {
      const close = await this.page.$('button:has-text("close")');
      if (close && await close.isVisible()) { await close.click(); await this.page.waitForTimeout(1000); }
    } catch {}

    try {
      const changelogIframe = await this.page.$('iframe[src*="changelog"]');
      if (changelogIframe) {
        this.debug('[Flow] 체인지로그 팝업 감지');
        let dismissed = false;
        const startBtn = await this.page.$('button:has-text("시작하기")');
        if (startBtn && await startBtn.isVisible()) {
          await startBtn.click();
          this.debug('[Flow] "시작하기" 버튼으로 팝업 닫기');
          dismissed = true;
          await this.page.waitForTimeout(1000);
        }
        if (!dismissed) {
          await this.page.keyboard.press('Escape');
          await this.page.waitForTimeout(1000);
          const still = await this.page.$('iframe[src*="changelog"]');
          if (!still) dismissed = true;
        }
        if (!dismissed) {
          await this.page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="changelog"]');
            if (!iframe) return;
            let el = iframe;
            while (el.parentElement && el.parentElement !== document.body) {
              const style = window.getComputedStyle(el);
              if (style.position === 'fixed') break;
              el = el.parentElement;
            }
            el.remove();
          });
          await this.page.waitForTimeout(500);
        }
      }
    } catch {}
    // 클릭을 가로채는 Radix 다이얼로그 오버레이도 함께 정리 (세션 시작·새로고침 직후 선제 제거)
    try { await this._dismissBlockingOverlay(false); } catch {}
  }

  // ─── 클릭을 가로채는 떠 있는 팝업/오버레이 닫기 ───
  //   Flow 가 봇 의심·한도·프로모션 등으로 Radix 다이얼로그를 띄우면 그 오버레이
  //   (<div data-state="open" aria-hidden="true"> ...)가 pointer-events 를 가로채서
  //   입력창/버튼 클릭이 "intercepts pointer events" 로 timeout 난다.
  //   ① 정체를 로그로 남기고(진단) ② Escape·닫기버튼으로 닫고 ③ 끝내 안 닫히면 오버레이
  //   pointer-events 를 무력화해 클릭이 통과하도록 한다. 반환: 가로채는 오버레이를 봤는지.
  async _dismissBlockingOverlay(verbose = false) {
    try {
      const info = await this.page.evaluate(() => {
        const sel = '[data-state="open"][aria-hidden="true"], [role="dialog"], [role="alertdialog"]';
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return null;
        let best = '', bestLen = -1;
        for (const el of els) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > bestLen) { bestLen = t.length; best = t; }
        }
        return { count: els.length, text: best.slice(0, 160) };
      }).catch(() => null);
      if (!info) return false;
      if (verbose) this.log(`[Flow] ⚠ 클릭 가로채는 팝업 감지 (${info.count}개): "${info.text}"`);

      // 1) Escape 2회 (Radix 다이얼로그 기본 닫기)
      for (let i = 0; i < 2; i++) { await this.page.keyboard.press('Escape').catch(() => {}); await this.page.waitForTimeout(250); }
      // 2) 흔한 닫기/확인 버튼
      for (const s of ['button[aria-label="Close"]', 'button[aria-label="닫기"]',
                       'button:has-text("닫기")', 'button:has-text("확인")', 'button:has-text("Got it")',
                       'button:has-text("Dismiss")', 'button:has-text("나중에")']) {
        try {
          const b = this.page.locator(s).first();
          if (await b.count() && await b.isVisible()) { await b.click({ timeout: 1500 }).catch(() => {}); await this.page.waitForTimeout(300); }
        } catch {}
      }
      // 3) 그래도 남은 오버레이는 pointer-events 무력화 (클릭 통과). 실제 차단이면 이후 단계에서 감지됨.
      await this.page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-state="open"][aria-hidden="true"]')) {
          try { el.style.pointerEvents = 'none'; } catch (_) {}
        }
      }).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  async _ensureMainPage() {
    if (!this.page.url().includes('/flow') || this.page.url().includes('/project/') || this.page.url().includes('auth/callback')) {
      await this.page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await this.page.waitForTimeout(3000);
      // 리다이렉트 대기
      if (this.page.url().includes('auth/callback')) {
        await this.page.waitForURL('**/labs.google/fx/**', { timeout: 30000 }).catch(() => {});
        await this.page.waitForTimeout(3000);
      }
      await this._dismissBanners();
    }
  }

  async _createNewProject() {
    const btn = await this.page.$('button:has-text("새 프로젝트")') ||
                await this.page.$('button:has-text("New project")');
    if (btn && await btn.isVisible()) {
      await btn.click();
      await this.page.waitForTimeout(3000);
      await this._dismissBanners();
    }
  }

  // ─── 에이전트 모드 OFF 보장 ───
  // Flow 의 "에이전트" 토글이 켜져 있으면(aria-pressed="true") 자동 이미지 생성이
  // 비정상 동작(대화형 응답 등) → 생성 직전에 꺼준다. 버튼 없으면 조용히 스킵.
  async _ensureAgentOff() {
    // 에이전트 버튼 상태 읽기 — 텍스트는 "에이전트", "Agent", "에이전트 베타", "Agent (Beta)" 등
    // 부분일치로 잡고, ON 판별은 aria-pressed / aria-checked / data-state 여러 신호로.
    // 반환: { found, on } — on: true(켜짐)/false(꺼짐)/null(판별불가)
    const readState = () => this.page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const cand = Array.from(document.querySelectorAll(
        'button, [role="button"], [role="switch"], [role="tab"], [role="checkbox"]'
      ));
      const agent = cand.find(b => {
        const t = norm(b.innerText || b.textContent);
        return t.length <= 14 && /(에이전트|agent)/i.test(t);
      });
      if (!agent) return { found: false, on: null };
      const ap = agent.getAttribute('aria-pressed');
      const ac = agent.getAttribute('aria-checked');
      const ds = (agent.getAttribute('data-state') || '').toLowerCase();
      let on = null;
      if (ap !== null) on = (ap === 'true');
      else if (ac !== null) on = (ac === 'true');
      else if (ds) on = /(on|active|selected|checked|true)/.test(ds);
      return { found: true, on };
    });

    // 에이전트 세션 패널(채팅 UI)이 열려 있는지 — 열려 있으면 X/Escape 로 닫아 컴팩트 입력바로 복귀.
    // 패널 텍스트: "어떤 작업을 하고 싶으신가요" / "제목 없는 세션" (컴팩트 바의 "무엇을 만들고" 와 구분)
    const readPanelOpen = () => this.page.evaluate(() => {
      const t = document.body.innerText || '';
      return /어떤 작업을 하고 싶|제목 없는 세션|에이전트와|Untitled session/i.test(t);
    });
    const clickAgentChip = async () => {
      for (const sel of ['button:has-text("에이전트")', 'button:has-text("Agent")',
                          '[role="switch"]:has-text("에이전트")', '[role="switch"]:has-text("Agent")']) {
        try {
          const b = this.page.locator(sel).first();
          if (await b.count() > 0) { await b.click({ timeout: 3000 }); return true; }
        } catch {}
      }
      return false;
    };

    try {
      // 1) 에이전트 세션 패널 닫기 (열려 있으면) → 컴팩트 입력바로 복귀
      if (await readPanelOpen()) {
        this.log('[Flow] 에이전트 세션 패널 감지 — 닫기 시도');
        let closed = false;
        // 실측(2026-05-30): 닫기 X 버튼은 aria-label 없음 + Material 아이콘 리거처 "close" + 라벨 "닫기".
        // 따라서 has-text("닫기")/("close") 가 실제로 맞는 셀렉터. 옛 aria-label/✕ 셀렉터는 폴백으로만 유지.
        // ⚠ "닫기"·"close" 셀렉터는 동일한 X 버튼을 가리킴(실측). 두 번 클릭하면 패널이 다시 열리므로
        //    매칭되는 첫 셀렉터로 1회만 클릭하고 break (재클릭 금지). 닫힘 검증은 클릭 후 900ms 뒤 1회.
        for (const sel of ['button:has-text("닫기")', 'button:has-text("close")',
                            'button[aria-label="닫기"]', 'button[aria-label*="Close" i]', 'button[aria-label*="닫기" i]']) {
          try {
            const b = this.page.locator(sel).first();
            if (await b.count() > 0) {
              await b.click({ timeout: 2000 });
              await this.page.waitForTimeout(900);   // 닫힘 애니메이션 대기 (500ms 는 너무 짧음 — 실측)
              closed = !(await readPanelOpen());
              break;
            }
          } catch {}
        }
        if (!closed) { try { await this.page.keyboard.press('Escape'); } catch {} }
        await this.page.waitForTimeout(700);
        if (await readPanelOpen()) this.log('[Flow] ⚠ 에이전트 패널이 아직 열려 있음 — Flow 창에서 X 로 직접 닫아주세요');
        else this.log('[Flow] ✅ 에이전트 세션 패널 닫힘');
      }

      // 2) 에이전트 칩 상태 확인 후 OFF (클릭 + 검증 + 재시도)
      let st = await readState();
      if (!st.found) { this.log('[Flow] 에이전트 버튼 못 찾음 — 스킵 (Flow UI 변경 시 셀렉터 점검 필요)'); return; }
      if (st.on === false) { this.debug('[Flow] 에이전트 모드 이미 OFF'); return; }
      // on === true (켜짐) 또는 on === null (판별불가) → 끄기 시도 + 검증 + 재시도(최대 3)
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!(await clickAgentChip())) { this.log(`[Flow] ⚠ 에이전트 칩 클릭 실패 (시도 ${attempt}) — 수동 확인 필요`); return; }
        await this.page.waitForTimeout(500);
        st = await readState();
        if (st.on === false) { this.log('[Flow] ✅ 에이전트 모드 OFF 확인'); return; }
        if (st.on === null) {
          // 상태 판별 불가 — 한 번 껐으면 더 누르면 오히려 켤 수 있어 중단(과클릭 방지)
          this.log('[Flow] 에이전트 모드 OFF 시도(상태 판별 불가) — 1회 클릭 후 종료');
          return;
        }
        this.log(`[Flow] 에이전트 아직 ON — 재시도 ${attempt}/3`);
      }
      this.log('[Flow] ⚠ 에이전트 모드 OFF 실패 — Flow 창에서 수동으로 꺼주세요');
    } catch (e) {
      this.debug(`[Flow] 에이전트 OFF 확인 실패: ${e.message}`);
    }
  }

  async _typePrompt(text) {
    // ElementHandle 대신 Locator 사용 — 매 액션마다 셀렉터를 재조회하므로 DOM 재렌더로 인한
    // "Element is not attached to the DOM" 오류에 강함 (첫 단락: 캐릭터 업로드 직후 입력창 재렌더 대비).
    const inputLoc = this.page.locator('div[role="textbox"][contenteditable="true"]').first();
    await inputLoc.waitFor({ state: 'visible', timeout: 10000 });
    // 클릭 — stale/unstable(재렌더 애니메이션) 시 짧게 대기 후 재시도 (최대 3회)
    let clicked = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 마지막 시도는 가로채는 팝업을 닫고 force 클릭으로 돌파
        if (attempt === 3) { await this._dismissBlockingOverlay(true); await inputLoc.click({ timeout: 5000, force: true }); }
        else await inputLoc.click({ timeout: 5000 });
        clicked = true;
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        this.debug(`[Flow] 입력창 클릭 재시도 ${attempt}/3 — ${e.message.split('\n')[0]}`);
        await this._dismissBlockingOverlay(attempt === 1);   // 가로채는 팝업이면 닫고 재시도
        await this.page.waitForTimeout(800);
      }
    }
    if (!clicked) throw new Error('프롬프트 입력창 클릭 실패');
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Control+a');
    await this.page.keyboard.press('Backspace');
    await this.page.waitForTimeout(200);
    await this.page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await this.page.keyboard.press('Control+v');
    await this.page.waitForTimeout(1000);
    this.debug('[Flow] 프롬프트 입력 완료');
  }

  async _openSettingsPopup() {
    // 설정 칩 = 프롬프트 바에서 제출(→) 버튼 바로 왼쪽 버튼. 라벨은 모델·비율·매수·모드에 따라
    // 수시로 바뀜(예: "🍌 Nano Banana 2 crop_16_9 1x", "Veo 3.1 - Lite … x4", "동영상 x4").
    // → 라벨 변화에 안 흔들리는 단서로 찾는다:
    //   ① 매수 토큰(1x~x4 / x1~x4)으로 끝남 (모델·모드 무관 항상 존재) ← 1순위
    //   ② 모델/아이콘 키워드(Nano Banana/Veo/Imagen/Gemini/crop_) ← 보조
    //   (그래도 못 열면 _configureSettings 의 role=tab 재확인이 재시도 + 화살표 폴백으로 보강)
    const result = await this.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
      const COUNT_RE = /(?:^|\s)(?:[1-4]x|x[1-4])\s*$/;       // 끝이 매수 토큰
      const KW_RE = /Nano Banana|Veo|Imagen|Gemini|crop_/i;   // 모델/비율 아이콘 키워드
      const candidates = all.filter(b => {
        const t = (b.innerText || b.textContent || '').trim();
        return t.length > 0 && t.length < 120 && (COUNT_RE.test(t) || KW_RE.test(t));
      });
      // 매수 토큰으로 끝나는 후보 우선 (가장 안정적), 없으면 키워드 후보
      const m = candidates.find(b => COUNT_RE.test((b.innerText || b.textContent || '').trim()))
             || candidates[0];
      if (m) {
        // ⚠ 여기서 m.click() 하면 안 됨 — JS 합성 클릭으로는 이 popup 이 절대 안 열림
        //   (2026-06-10 openclaude 라이브 검증: 합성 click → 무반응, 실제 마우스 클릭 → role=tab popup 정상).
        //   그래서 element 에 태그만 달고, 바깥에서 Playwright 실클릭으로 누른다.
        m.setAttribute('data-pf-settings-chip', '1');
        return { ok: true, text: (m.innerText || '').trim().substring(0, 60).replace(/\n/g, ' | ') };
      }
      return { ok: false };
    });
    if (result.ok) {
      try {
        await this.page.click('[data-pf-settings-chip="1"]', { timeout: 5000 });   // 진짜 입력 클릭 (trusted event)
        this.debug(`  [popup] 설정 button 클릭: "${result.text}"`);
      } catch (e) {
        this.debug(`  [popup] 설정 칩 실클릭 실패: ${String(e.message).split('\n')[0]}`);
      } finally {
        await this.page.evaluate(() => {
          const el = document.querySelector('[data-pf-settings-chip]');
          if (el) el.removeAttribute('data-pf-settings-chip');
        }).catch(() => {});
      }
    } else {
      this.debug('  [popup] 설정 칩 못 찾음 — arrow 폴백');
      await this._clickArrowButton();
    }
  }

  async _clickArrowButton() {
    const selectors = [
      'button:has-text("arrow_forward")',
      'button:has-text("만들기"):not(:has-text("더 생성"))',
    ];
    for (const sel of selectors) {
      try {
        const btns = await this.page.$$(sel);
        for (const btn of btns) {
          if (await btn.isVisible()) { await btn.click(); return; }
        }
      } catch {}
    }
  }

  // 공통 헬퍼: text 매칭 → 클릭 가능한 부모 (button/role) 클릭
  // (v1.13.15 Flow selector fix) 2-tier 매칭:
  //   1차: leaf (children.length === 0) + 정확 매칭 — 기존 로직
  //   2차: leaf 조건 제거 + 정확 매칭 — 새 Flow UI 의 svg+text 다층 구조 대응
  async _clickLeafText(targetTexts) {
    return await this.page.evaluate((targets) => {
      const lowerTargets = targets.map(t => t.toLowerCase());
      const all = document.querySelectorAll('*');

      // 1차 — leaf + 정확 매칭 (옛 로직)
      for (const el of all) {
        if (!el.offsetParent) continue;
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim().toLowerCase();
        if (!lowerTargets.includes(t)) continue;
        let p = el;
        for (let i = 0; i < 6 && p && p !== document.body; i++) {
          const role = p.getAttribute && p.getAttribute('role');
          if (p.tagName === 'BUTTON' || role === 'radio' || role === 'option' || role === 'tab' || role === 'menuitem') {
            p.click();
            return { ok: true, text: el.textContent.trim(), via: `${p.tagName}/${role || '-'}` };
          }
          p = p.parentElement;
        }
        el.click();
        return { ok: true, text: el.textContent.trim(), via: `${el.tagName}/self` };
      }

      // 2차 — leaf 조건 제거 + 정확 매칭 (button/radio/option 등 element 자체 text 가 target)
      for (const el of all) {
        if (!el.offsetParent) continue;
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (!lowerTargets.includes(t)) continue;
        const role = el.getAttribute && el.getAttribute('role');
        if (el.tagName === 'BUTTON' || role === 'radio' || role === 'option' || role === 'tab' || role === 'menuitem') {
          el.click();
          return { ok: true, text: (el.innerText || el.textContent).trim(), via: `${el.tagName}/${role || '-'}-relaxed` };
        }
      }

      return { ok: false };
    }, targetTexts);
  }

  async _selectRatio(ratio) {
    try {
      // 1차: 기존 정확 텍스트 매칭 (회귀 방지 — 16:9 등 잘 되던 경로 유지)
      let result = await this._clickLeafText([ratio]);
      if (result.ok) { this.log(`  [설정] 비율 ${ratio} 클릭 ✓ (text/${result.via})`); return; }

      // 2차: 견고 매칭 — aria-label/title/부분포함 + 클릭가능 조상
      result = await this._clickRatioRobust(ratio);
      if (result.ok) { this.log(`  [설정] 비율 ${ratio} 클릭 ✓ (robust/${result.via})`); return; }

      // 3차: 실패 → 비율 버튼 실제 DOM 덤프 (사용자 보고용)
      this.log(`  [!] 비율 ${ratio} 자동 클릭 실패 — 진단 덤프:`);
      await this._dumpRatioButtons(ratio);
    } catch (e) {
      this.log(`  [!] 비율 클릭 실패: ${e.message}`);
    }
  }

  // 견고 매처 — aria-label / title / 정확텍스트 / 짧은부분포함 순으로 비율 버튼을 찾아 클릭.
  // svg+span 다층 구조나 아이콘/aria-only 버튼도 잡도록 매칭 폭을 넓힘.
  async _clickRatioRobust(ratio) {
    return await this.page.evaluate((rawRatio) => {
      const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();   // '9 : 16' → '9:16'
      const target = norm(rawRatio);

      const clickClickable = (el) => {
        let p = el;
        for (let i = 0; i < 6 && p && p !== document.body; i++) {
          const role = p.getAttribute && p.getAttribute('role');
          const hasTab = p.getAttribute && p.getAttribute('tabindex') !== null;
          if (p.tagName === 'BUTTON' || role === 'radio' || role === 'option' || role === 'tab' || role === 'menuitem' || hasTab) {
            p.click();
            return `${p.tagName}/${role || (hasTab ? 'tabindex' : '-')}`;
          }
          p = p.parentElement;
        }
        el.click();
        return `${el.tagName}/self`;
      };

      const all = Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent);

      // 우선순위 1: aria-label 정확/포함
      for (const el of all) {
        const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
        if (aria && (aria === target || aria.includes(target))) return { ok: true, via: 'aria=' + clickClickable(el) };
      }
      // 우선순위 2: title 정확/포함
      for (const el of all) {
        const title = norm(el.getAttribute && el.getAttribute('title'));
        if (title && (title === target || title.includes(target))) return { ok: true, via: 'title=' + clickClickable(el) };
      }
      // 우선순위 3: 텍스트 정확 일치 (공백 무시)
      for (const el of all) {
        if (el.children.length > 0) continue;   // leaf 우선
        const t = norm(el.textContent);
        if (t === target) return { ok: true, via: 'text=' + clickClickable(el) };
      }
      // 우선순위 4: 짧은 텍스트 부분 포함 (큰 컨테이너 오매칭 방지)
      for (const el of all) {
        const t = norm(el.innerText || el.textContent);
        if (t && t.length <= 8 && t.includes(target)) return { ok: true, via: 'contains=' + clickClickable(el) };
      }
      return { ok: false };
    }, ratio);
  }

  // 실패 시 — 비율 패턴이 들어간 보이는 요소를 실제 DOM 구조와 함께 로그로 덤프.
  async _dumpRatioButtons(ratio) {
    try {
      const dump = await this.page.evaluate(() => {
        const RATIO_RE = /16:9|9:16|4:3|3:4|1:1/;
        const rows = [];
        const seen = new Set();
        Array.from(document.querySelectorAll('*')).forEach(el => {
          if (!el.offsetParent) return;
          const text = (el.innerText || el.textContent || '').trim();
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          if (!(RATIO_RE.test(text) || RATIO_RE.test(aria) || RATIO_RE.test(title))) return;
          // leaf 또는 짧은 텍스트 요소만 (거대 컨테이너 제외)
          if (el.children.length > 0 && text.length > 40 && !aria && !title) return;
          const html = (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 120);
          if (seen.has(html)) return;
          seen.add(html);
          const parent = el.parentElement;
          rows.push({
            text: text.slice(0, 24),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            aria: aria.slice(0, 30),
            title: title.slice(0, 30),
            parent: parent ? `${parent.tagName.toLowerCase()}${parent.getAttribute('role') ? '[' + parent.getAttribute('role') + ']' : ''}` : '',
            html,
          });
        });
        return rows;
      });
      this.log(`  [DUMP] 비율 관련 요소 ${dump.length}개:`);
      for (const r of dump.slice(0, 40)) {
        this.log(`    "${r.text}" <${r.tag}${r.role ? ' role=' + r.role : ''}>${r.aria ? ' aria="' + r.aria + '"' : ''}${r.title ? ' title="' + r.title + '"' : ''} parent=${r.parent}`);
        this.log(`        html: ${r.html}`);
      }
      this.log(`  [DUMP 끝] 위에서 "${ratio}" 항목의 정확한 aria-label/text/구조를 알려주시면 정확히 고정합니다.`);
    } catch (e) {
      this.log(`  [DUMP 실패: ${e.message}]`);
    }
  }

  async _selectCount(count) {
    // x1 ↔ 1x 양쪽 시도 (Flow UI 는 "1x" 표시)
    const m = count.match(/x(\d+)/i);
    const alt = m ? `${m[1]}x` : count;
    try {
      const result = await this._clickLeafText([count, alt]);
      if (result.ok) this.log(`  [설정] 매수 ${count} 클릭 ✓ (text="${result.text}", via ${result.via})`);
      else this.log(`  [!] 매수 ${count} leaf text 못 찾음 (시도: ${count}, ${alt})`);
    } catch (e) {
      this.log(`  [!] 매수 클릭 실패: ${e.message}`);
    }
  }

  async _selectModel(model) {
    try {
      const dropdown = await this.page.$('button:has-text("Nano Banana")');
      if (dropdown && await dropdown.isVisible()) {
        await dropdown.click();
        await this.page.waitForTimeout(500);
        const opt = await this.page.$(`text="${model}"`);
        if (opt && await opt.isVisible()) await opt.click();
        await this.page.waitForTimeout(300);
      }
    } catch {}
  }

  async _clickFinalCreateV2() {
    // 전략 1: "arrow_forward만들기"
    try {
      const btns = await this.page.$$('button');
      for (const btn of btns) {
        if (await btn.isVisible()) {
          const text = await btn.textContent();
          if (text && text.includes('arrow_forward') && text.includes('만들기')) {
            await btn.click();
            return;
          }
        }
      }
    } catch {}

    // 전략 2: 프롬프트 옆 버튼
    try {
      const textbox = await this.page.$('div[role="textbox"]');
      if (textbox) {
        const siblings = await this.page.$$('div[role="textbox"] ~ button, div[role="textbox"] + * button');
        for (const btn of siblings) {
          if (await btn.isVisible()) { await btn.click(); return; }
        }
      }
    } catch {}

    // 전략 3: submit
    try {
      const btns = await this.page.$$('button[type="submit"], button[aria-label*="submit" i], button[aria-label*="send" i]');
      for (const btn of btns) {
        if (await btn.isVisible()) { await btn.click(); return; }
      }
    } catch {}

    // 전략 4: "만들기"
    try {
      const btns = await this.page.$$('button');
      for (const btn of btns) {
        if (await btn.isVisible()) {
          const text = (await btn.textContent() || '').trim();
          if (text === '만들기' || text === 'arrow_forward만들기' || text.endsWith('만들기')) {
            if (!text.includes('더 생성') && !text.includes('미디어')) {
              await btn.click();
              return;
            }
          }
        }
      }
    } catch {}

    // 전략 5: Enter
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press('Enter');
  }

  async _waitForImage(timeout, isVideo = false) {
    const startTime = Date.now();
    const prevSrcs = new Set();
    // 기존 이미지/비디오 src 모두 수집 (이전 생성물 혼입 방지)
    try {
      const existing = await this.page.$$eval('img', imgs => imgs.map(i => i.src).filter(s => s));
      existing.forEach(s => prevSrcs.add(s));
      const existingVids = await this.page.$$eval('video source, video[src]', els => els.map(el => el.src || el.getAttribute('src') || '').filter(s => s));
      existingVids.forEach(s => prevSrcs.add(s));
      // API redirect URL도 수집
      const apiUrls = await this.page.$$eval('img', imgs => imgs.map(i => i.src).filter(s => s && s.includes('getMediaUrlRedirect')));
      apiUrls.forEach(s => prevSrcs.add(s));
    } catch {}

    // 최소 5초 대기 후 새 이미지 감지 시작 (이전 이미지 리렌더링 방지)
    const minWaitMs = 5000;

    while (Date.now() - startTime < timeout) {
      await this.page.waitForTimeout(3000);

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // v2.0: 진행률 감지
      const pct = await this._detectGenerationProgress();
      if (elapsed % 15 === 0) {
        const pctStr = pct ? ` (${pct}%)` : '';
        this.log(`  ... ${elapsed}초 경과${pctStr}`);
      }

      // 실패 감지
      // v1.13.21~v1.13.26: 차단 토스트 우선 감지 — type 별 분기.
      // 'suspicious-activity' (비정상 활동 감지): 60초 대기 의미 없음 → 즉시 폴백.
      // 'rate-limit' (너무 빠른 요청): 60초 대기 후 원본 1회 재시도.
      try {
        const rl = await this._detectRateLimitText();
        if (rl) {
          this._rateLimitDetected = true;
          this._rateLimitDetectedText = rl.text;
          this._rateLimitDetectedType = rl.type || 'rate-limit';
          this._lastRateLimitAt = Date.now();
          if (this._rateLimitDetectedType === 'suspicious-activity') {
            this.log(`🚨 Flow 비정상 활동 감지 — "${rl.text.slice(0, 80)}" (계정 차단 의심, 즉시 다음 프로필로 폴백)`);
          } else {
            this.log(`⚠ Flow rate-limit 토스트 감지 — "${rl.text.slice(0, 80)}"`);
          }
          // 토스트 정리 (실패 카드 dismiss 와 동일 동작)
          try { await this._dismissFailure(); } catch {}
          return null;
        }
      } catch {}

      try {
        const failureText = await this.page.evaluate(() => {
          // v1.13.33: 비정상 활동 / 봇 의심 차단 키워드 — 매칭 시 {__suspicious:true} 객체 반환.
          // _detectRateLimitText 가 size 필터로 못 잡은 큰 차단 토스트의 이중 안전망.
          const SUSPICIOUS = /비정상적|이상\s*활동|봇.*감지|의심.*활동|abnormal\s*activity|unusual\s*activity|suspicious\s*activity|automated\s*behavior/i;
          const candidates = document.querySelectorAll('div, span, p, h1, h2, h3');
          for (const el of candidates) {
            if (el.children.length > 3) continue;
            const rect = el.getBoundingClientRect();
            if (rect.y > 800 || rect.width < 50) continue;
            const text = (el.textContent || '').trim();
            if (text.length > 400) continue;
            // 비정상 활동 우선 검사
            if (SUSPICIOUS.test(text)) {
              return { __suspicious: true, text: text.substring(0, 150) };
            }
            if (text.length > 200) continue;
            if ((text.startsWith('실패') && text.length < 150) ||
                text.includes('정책을 위반') || text.includes('위반할 수') ||
                text.includes('생성할 수 없') || text.includes('could not generate') ||
                text.includes('violates') || text.includes('Unable to generate')) {
              return text.substring(0, 100);
            }
          }
          return null;
        });
        // v1.13.33: 비정상 활동 매칭 → rate-limit 플래그 셋 + suspicious-activity 타입 → 호출자가 즉시 폴백 트리거
        if (failureText && typeof failureText === 'object' && failureText.__suspicious) {
          this.log(`🚨 Flow 비정상 활동 감지 (failureText 영역) — "${failureText.text.slice(0, 80)}"`);
          this._rateLimitDetected = true;
          this._rateLimitDetectedType = 'suspicious-activity';
          this._rateLimitDetectedText = failureText.text;
          this._lastRateLimitAt = Date.now();
          try { await this._dismissFailure(); } catch {}
          return null;
        }
        if (failureText) {
          this.debug(`  [!] 생성 실패 감지: ${failureText}`);
          // 실패 메시지 제거 (다음 프롬프트에 영향 안 주도록)
          await this._dismissFailure();
          return null;
        }
      } catch {}

      // 동영상 소스 감지 (video 태그 — 동영상 모드에서 우선)
      try {
        const videoSrcs = await this.page.$$eval('video source, video[src]', els => els.map(el => {
          const src = el.src || el.getAttribute('src') || '';
          const parent = el.closest('video') || el;
          return { src, w: parent.offsetWidth, h: parent.offsetHeight };
        }));
        for (const vs of videoSrcs) {
          if (!vs.src || prevSrcs.has(vs.src) || vs.w < 50) continue;
          if (vs.src.includes('icon') || vs.src.includes('logo')) continue;
          // blob: URL이면 직접 fetch
          await this.page.waitForTimeout(2000);
          const fetchResult = await this.page.evaluate(async (url) => {
            try {
              const resp = await fetch(url);
              if (!resp.ok) return null;
              const blob = await resp.blob();
              return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          }, vs.src);
          if (fetchResult) {
            const buf = Buffer.from(fetchResult.split(',')[1], 'base64');
            if (buf.length > 50000) {
              this.log(`  [동영상] ${Math.round(buf.length / 1024)}KB`);
              return buf;
            }
          }
        }
      } catch {}

      // 동영상 모드: 생성 완료 감지 후 타일 hover → video 활성화
      if (isVideo) {
        // 진행률이 있으면 아직 생성 중 → 계속 대기
        if (pct && pct < 99) continue;

        // 진행률이 없거나 99% 이상 → 생성 완료됐을 수 있음
        // 타일을 hover하여 video 재생 트리거
        try {
          const tiles = await this.page.$$('img');
          for (const tile of tiles) {
            const box = await tile.boundingBox();
            if (!box || box.width < 100 || box.height < 100) continue;
            const src = await tile.getAttribute('src');
            if (!src || prevSrcs.has(src) || src.includes('icon') || src.includes('logo') || src.includes('perlin') || src.includes('profile') || src.includes('avatar')) continue;
            // 새 타일 발견 → hover하여 video 활성화
            await tile.hover();
            await this.page.waitForTimeout(3000);
            break;
          }
        } catch {}

        // hover 후 video 태그가 나타났는지 다시 체크
        try {
          const vids = await this.page.$$eval('video source, video[src]', els => els.map(el => el.src || el.getAttribute('src') || '').filter(s => s.length > 0));
          for (const vsrc of vids) {
            if (prevSrcs.has(vsrc)) continue;
            const fetchResult = await this.page.evaluate(async (url) => {
              try {
                const resp = await fetch(url);
                if (!resp.ok) return null;
                const blob = await resp.blob();
                return new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.readAsDataURL(blob);
                });
              } catch { return null; }
            }, vsrc);
            if (fetchResult) {
              const buf = Buffer.from(fetchResult.split(',')[1], 'base64');
              if (buf.length > 100000) {
                this.log(`  [동영상] ${Math.round(buf.length / 1024)}KB`);
                return buf;
              }
            }
          }
        } catch {}

        // 이미지 썸네일은 건너뛰고 계속 대기
        continue;
      }

      // 최소 대기 시간 미경과 시 이미지 감지 건너뛰기
      if (Date.now() - startTime < minWaitMs) continue;

      // 새 이미지 감지 → fetch로 원본 다운로드 (이미지 모드만)
      try {
        const imgInfos = await this.page.$$eval('img', imgs => imgs.map(i => ({
          src: i.src,
          naturalWidth: i.naturalWidth,
          naturalHeight: i.naturalHeight,
          displayWidth: i.offsetWidth,
          displayHeight: i.offsetHeight,
        })));

        for (const info of imgInfos) {
          if (!info.src || prevSrcs.has(info.src)) continue;
          if (info.src.includes('icon') || info.src.includes('logo') || info.src.includes('avatar') || info.src.includes('profile') || info.src.includes('perlin')) continue;
          if (info.displayWidth < 100 || info.displayHeight < 100) continue;

          await this.page.waitForTimeout(2000);
          const fetchResult = await this.page.evaluate(async (url) => {
            try {
              const resp = await fetch(url);
              if (!resp.ok) return null;
              const blob = await resp.blob();
              return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          }, info.src);

          if (fetchResult) {
            const base64 = fetchResult.split(',')[1];
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 10000) {
              this.log(`  [원본] ${info.naturalWidth}x${info.naturalHeight}, ${Math.round(buf.length / 1024)}KB`);
              return buf;
            }
          }

          // fallback: screenshot
          const imgEl = await this.page.$(`img[src="${info.src}"]`);
          if (imgEl) {
            const buf = await imgEl.screenshot();
            if (buf.length > 3000) return buf;
          }
        }
      } catch {}
    }

    return null;
  }

  async _addSubtitle(imagePath, text, outputPath) {
    try {
      const imgData = fs.readFileSync(imagePath);
      const base64 = imgData.toString('base64');
      const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');

      const subtitlePage = await this.context.newPage();
      const result = await subtitlePage.evaluate(async ({ b64, subtitle }) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const fontSize = Math.max(18, Math.floor(img.width / 28));
            ctx.font = `bold ${fontSize}px "Malgun Gothic", sans-serif`;
            const metrics = ctx.measureText(subtitle);
            const pad = 16;
            const boxW = metrics.width + pad * 2;
            const boxH = fontSize + pad * 2;
            const boxX = (img.width - boxW) / 2;
            const boxY = img.height - boxH - 40;
            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.beginPath();
            ctx.roundRect(boxX, boxY, boxW, boxH, 10);
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(subtitle, img.width / 2, boxY + boxH / 2);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
          };
          img.src = 'data:image/png;base64,' + b64;
        });
      }, { b64: base64, subtitle: escaped });

      fs.writeFileSync(outputPath, Buffer.from(result, 'base64'));
      await subtitlePage.close();
    } catch (err) {
      fs.copyFileSync(imagePath, outputPath);
      this.log(`  [!] 자막 합성 실패, 원본 저장: ${err.message}`);
    }
  }

  _generateSRT(paragraphs, outPath) {
    let srt = '';
    let t = 0;
    paragraphs.forEach((text, i) => {
      const dur = Math.max(1, Math.min(6, Math.round((text.length / 10 + 0.3) * 10) / 10));
      srt += `${i + 1}\n${this._fmt(t)} --> ${this._fmt(t + dur)}\n${text.substring(0, 100)}\n\n`;
      t += dur;
    });
    fs.writeFileSync(outPath, srt, 'utf-8');
  }

  // ─── Vrew 프로젝트 파일 생성 ───
  _generateVrew_OLD_REMOVE(paragraphs, imgDir, vrewPath) {
    const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    const shortId = () => uid().replace(/-/g, '').substring(0, 10);

    // Vrew 3.8.0 검증된 템플릿 (실제 동작 확인됨)
    const VREW_TEMPLATE = {"version":16,"files":[{"version":1,"mediaId":"10000000-0000-0000-0000","sourceOrigin":"VREW_RESOURCE","fileSize":176444,"name":"10000000-0000-0000-0000.mp4","type":"AVMedia","videoAudioMetaInfo":{"duration":1,"audioInfo":{"sampleRate":44100,"codec":"wav","channelCount":1}},"sourceFileType":"VIDEO_AUDIO","fileLocation":"IN_MEMORY"}],"transcript":{"clips":[],"sceneNames":{},"translateInfo":null},"props":{"tracks":{},"assets":{},"overdubInfos":{},"analyzeDate":"2026-3-1 19:42:36","captionDisplayMode":{"0":true,"1":false},"mediaEffectMap":{"10000000-0000-0000-0000":{"filter":{"effectType":"filter","filterMediaId":"default-filter","filterAlphas":{"default-filter":0.5,"01-radiant-filter":0.5,"02-bossa-nova-filter":0.5,"03-aquamarine-filter":0.5,"04-optimism-filter":0.5,"05-torchlight-filter":0.5,"06-breezed-filter":0.5,"07-masquerade-filter":0.5,"08-tungsten-filter":0.5,"09-cranberry-filter":0.5,"10-nocturne-filter":1,"11-piano-filter":1,"12-newspaper-filter":1,"13-luminescent-filter":0.7,"14-incandescent-filter":0.7,"15-fluorescent-filter":0.7}}}},"markerNames":{"0":"","1":"","2":"","3":"","4":"","5":""},"flipSetting":{},"videoRatio":1.7777777777777777,"globalVideoTransform":{"zoom":1,"xPos":0,"yPos":0,"rotation":0},"videoSize":{"width":1920,"height":1080},"backgroundMap":{},"globalCaptionStyle":{"captionStyleSetting":{"mediaId":"uc-0010-simple-textbox","yAlign":"bottom","yOffset":0,"xOffset":0,"rotation":0,"width":0.96,"customAttributes":[{"attributeName":"--textbox-color","type":"color-hex","value":"rgba(0, 0, 0, 0)"},{"attributeName":"--textbox-align","type":"textbox-align","value":"center"}],"scaleFactor":1.7777777777777777},"quillStyle":{"font":"Pretendard-Vrew_700","size":"125","color":"#ffffff","outline-on":"true","outline-color":"#000000","outline-width":"6"}},"lastTTSSettings":{},"initProjectVideoSize":{"width":1920,"height":1080},"pronunciationDisplay":true,"projectAudioLanguage":"ko","audioLanguagesMap":{},"originalClips":[],"ttsClipInfosMap":{}},"comment":"TEMPLATE","projectId":"TEMPLATE","statistics":{"wordCursorCount":{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0},"wordSelectionCount":{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0},"wordCorrectionCount":{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0},"projectStartMode":"import","saveInfo":{"created":{"version":"3.8.0","date":"","stage":"release"},"updated":{"version":"3.8.0","date":"","stage":"release"},"loadCount":0,"saveCount":1},"savedStyleApplyCount":0,"cumulativeTemplateApplyCount":0,"ratioChangedByTemplate":false,"videoRemixInfos":{},"isAIWritingUsed":false,"clientLinebreakExecuteCount":0,"cumulativeNewTemplateApplyCount":0}};

    // 이미지 파일 매핑
    const imageFiles = {};
    try {
      for (const file of fs.readdirSync(imgDir)) {
        if (!/\.(jpg|jpeg|png)$/i.test(file)) continue;
        const match = file.match(/^(\d+)_/);
        if (match) imageFiles[parseInt(match[1])] = path.join(imgDir, file);
      }
    } catch { return; }

    const projectFiles = [];
    const sceneClips = [];
    const assets = {};
    const mediaFiles = []; // ZIP에 넣을 파일 목록
    this._vrewTracks = {};
    let currentTimeSec = 0;
    const CLIP_SEC = 5;

    const KB_PRESETS = [
      { startX: 0.0, startY: 0.5, startScale: 1.2, endX: 1.0, endY: 0.5, endScale: 1.2 },
      { startX: 0.5, startY: 0.0, startScale: 1.2, endX: 0.5, endY: 1.0, endScale: 1.2 },
      { startX: 0.5, startY: 0.5, startScale: 1.0, endX: 0.5, endY: 0.5, endScale: 1.3 },
      { startX: 1.0, startY: 0.5, startScale: 1.2, endX: 0.0, endY: 0.5, endScale: 1.2 },
      { startX: 0.5, startY: 1.0, startScale: 1.2, endX: 0.5, endY: 0.0, endScale: 1.2 },
      { startX: 0.5, startY: 0.5, startScale: 1.3, endX: 0.5, endY: 0.5, endScale: 1.0 },
    ];

    for (let i = 0; i < paragraphs.length; i++) {
      const imgPath = imageFiles[i + 1];
      const para = paragraphs[i];
      const clipId = shortId();

      // v16 클립 (Vrew 3.8.0 호환)
      const sceneId = shortId();
      const clip = {
        sceneId,
        words: [{
          id: shortId(),
          text: para.substring(0, 50),
          playbackRate: 1,
          duration: CLIP_SEC,
          aligned: false,
          type: 0,
          originalDuration: CLIP_SEC,
          originalStartTime: currentTimeSec,
          truncatedWords: [],
          assetIds: [],
        }, {
          id: shortId(),
          text: '',
          playbackRate: 1,
          duration: 0,
          aligned: false,
          type: 2,
          originalDuration: 0,
          originalStartTime: currentTimeSec + CLIP_SEC,
          truncatedWords: [],
          assetIds: [],
        }],
        captionMode: 'MANUAL',
        captions: [
          { text: [{ insert: para + '\n' }] },
          { text: [{ insert: '\n' }] },
        ],
        assetIds: [],
        dirty: { blankDeleted: false, caption: false, video: true },
        translationModified: { result: false, source: false },
        id: clipId,
      };

      // 이미지 에셋 (v15: assets에 직접 트랙 데이터)
      if (imgPath && fs.existsSync(imgPath)) {
        const mediaId = uid();
        const assetId = uid();
        const ext = path.extname(imgPath).toLowerCase().replace('.jpeg', '.jpg').replace('.', '');
        const fileName = `${mediaId}.${ext}`;
        const fileSize = fs.statSync(imgPath).size;

        projectFiles.push({
          version: 1,
          mediaId,
          sourceOrigin: 'USER',
          fileSize,
          name: fileName,
          type: 'Image',
          isTransparent: false,
          fileLocation: 'IN_MEMORY',
        });

        // v16: 에셋 → trackIds → 트랙
        const trackId = shortId();
        const kb = KB_PRESETS[i % KB_PRESETS.length];

        // tracks에 등록 (project.props.tracks에 추가됨)
        this._vrewTracks = this._vrewTracks || {};
        this._vrewTracks[trackId] = {
          trackId,
          mediaId,
          xPos: 0,
          yPos: 0,
          height: 1,
          width: 1,
          rotation: 0,
          zIndex: 1,
          type: 'image',
          originalWidthHeightRatio: 1.7778,
          isTrimmable: false,
          hasAlphaChannel: false,
          editInfo: {},
          fillType: 'cut',
          kenburnsAnimationInfo: kb,
        };

        assets[assetId] = { trackIds: [trackId], role: 'sub' };

        clip.assetIds = [assetId];
        clip.words[0].assetIds = [assetId];
        mediaFiles.push({ src: imgPath, zipName: `media/${fileName}` });
      }

      sceneClips.push(clip);
      currentTimeSec += CLIP_SEC;
    }

    // 기본 배경 비디오 (Vrew 필수)
    const baseVideoId = '10000000-0000-0000-0000';
    projectFiles.unshift({
      version: 1,
      mediaId: baseVideoId,
      sourceOrigin: 'VREW_RESOURCE',
      fileSize: 176444,
      name: `${baseVideoId}.mp4`,
      type: 'AVMedia',
      videoAudioMetaInfo: {
        duration: 1,
        audioInfo: { sampleRate: 44100, codec: 'wav', channelCount: 1 },
      },
      sourceFileType: 'VIDEO_AUDIO',
      fileLocation: 'IN_MEMORY',
    });
    // 최소 MP4 (1초 무음) — Vrew가 기대하는 기본 비디오
    mediaFiles.push({ zipName: `media/${baseVideoId}.mp4`, data: this._makeMinimalMp4() });

    // project.json (v16 — Vrew 3.8.0 호환)
    const now = new Date();
    const project = {
      version: 16,
      files: projectFiles,
      transcript: {
        clips: sceneClips,
        sceneNames: {},
        translateInfo: null,
      },
      props: {
        tracks: this._vrewTracks || {},
        assets,
        overdubInfos: {},
        captionDisplayMode: { '0': true, '1': false },
        mediaEffectMap: {},
        markerNames: { '0':'','1':'','2':'','3':'','4':'','5':'' },
        flipSetting: {},
        videoRatio: 1.7777777777777777,
        globalVideoTransform: { zoom: 1, xPos: 0, yPos: 0, rotation: 0 },
        videoSize: { width: 1920, height: 1080 },
        backgroundMap: {},
        globalCaptionStyle: {},
        initProjectVideoSize: { width: 1920, height: 1080 },
        pronunciationDisplay: true,
        projectAudioLanguage: 'ko',
        audioLanguagesMap: {},
        originalClips: [],
        ttsClipInfosMap: {},
      },
      comment: `3.8.0\t${now.toISOString()}`,
      projectId: uid(),
      statistics: {
        wordCursorCount: {'0':0,'1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0},
        wordSelectionCount: {'0':0,'1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0},
        wordCorrectionCount: {'0':0,'1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0},
        projectStartMode: 'import',
        saveInfo: {
          created: { version: '3.8.0', date: now.toISOString(), stage: 'release' },
          updated: { version: '3.8.0', date: now.toISOString(), stage: 'release' },
          loadCount: 0, saveCount: 1,
        },
        savedStyleApplyCount: 0,
        cumulativeTemplateApplyCount: 0,
        ratioChangedByTemplate: false,
        videoRemixInfos: {},
        isAIWritingUsed: false,
        clientLinebreakExecuteCount: 0,
        cumulativeNewTemplateApplyCount: 0,
      },
    };

    // ZIP 생성
    const projectJson = JSON.stringify(project);
    const zipParts = [];
    const centralDir = [];
    let offset = 0;

    const addFile = (name, data) => {
      const nb = Buffer.from(name, 'utf-8');
      const db = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      const crc = this._crc32(db);

      const lh = Buffer.alloc(30 + nb.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(10, 4);
      lh.writeUInt16LE(0, 8); // STORED
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(db.length, 18);
      lh.writeUInt32LE(db.length, 22);
      lh.writeUInt16LE(nb.length, 26);
      nb.copy(lh, 30);

      const cd = Buffer.alloc(46 + nb.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE((3 << 8) | 45, 4);
      cd.writeUInt16LE(10, 6);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(db.length, 20);
      cd.writeUInt32LE(db.length, 24);
      cd.writeUInt16LE(nb.length, 28);
      cd.writeUInt32LE(offset, 42);
      nb.copy(cd, 46);

      zipParts.push(lh, db);
      centralDir.push(cd);
      offset += lh.length + db.length;
    };

    addFile('project.json', projectJson);
    for (const mf of mediaFiles) {
      const fileData = mf.data || fs.readFileSync(mf.src);
      addFile(mf.zipName, fileData);
    }

    const cdOff = offset;
    const cdSz = centralDir.reduce((s, b) => s + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(centralDir.length, 8);
    eocd.writeUInt16LE(centralDir.length, 10);
    eocd.writeUInt32LE(cdSz, 12);
    eocd.writeUInt32LE(cdOff, 16);

    const zipBuf = Buffer.concat([...zipParts, ...centralDir, eocd]);
    fs.writeFileSync(vrewPath, zipBuf);
    this.log(`[Vrew] ${sceneClips.length}개 클립, ${projectFiles.length}개 이미지 → ${path.basename(vrewPath)}`);
  }

  _crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = this._crc32Table || (this._crc32Table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // 최소 유효 MP4 (무음 1초, 검은 화면)
  _makeMinimalMp4() {
    // ftyp + moov 최소 구조 (Vrew가 파싱 가능한 수준)
    // 실제로는 Vrew가 이 비디오를 재생하지 않고 배경 타임라인으로만 사용
    const hex = '0000001c667479706d703431000000006d7034316d7034326973' +
      '6f6d00000008667265650000026b6d6f6f760000006c6d76686400000000' +
      '00000000000000000000003e800000003e8000010000010000000000000000' +
      '000000000000010000000000000000000000000000000100000000000000' +
      '000000000000004000000000000000000000000000000000000000000000' +
      '00000002000001f3747261' +
      '6b0000005c746b686400000003000000000000000000000001000000003e' +
      '80000000000000000000000000000000010000000000000000000000000000' +
      '000100000000000000000000000000004000000007800000043800000000' +
      '01896d6469610000002c6d64686400000000000000000000000000003e80' +
      '0000003e800000000000000000000000000000';
    return Buffer.from(hex, 'hex');
  }

  // ─── Vrew 프로젝트 생성 (Python ZIP 패키저 사용) ───
  // 단락이 maxChars보다 길면 여러 조각으로 자름 (공백 기준, 의미 단위 우선)
  _splitByMaxChars(text, maxChars) {
    if (!text || text.length <= maxChars) return [text];
    // 문장 경계(.!?,) 우선 분할
    const parts = [];
    let remain = text;
    while (remain.length > maxChars) {
      // 1차: maxChars 이내 범위에서 문장 부호 찾기
      let cut = -1;
      for (let p = Math.min(maxChars, remain.length - 1); p >= Math.floor(maxChars * 0.5); p--) {
        if (/[.!?。,、]/.test(remain[p])) { cut = p + 1; break; }
      }
      // 2차: 공백 찾기
      if (cut < 0) {
        for (let p = Math.min(maxChars, remain.length - 1); p >= Math.floor(maxChars * 0.5); p--) {
          if (/\s/.test(remain[p])) { cut = p; break; }
        }
      }
      // 3차: 강제 자름
      if (cut < 0) cut = maxChars;
      parts.push(remain.substring(0, cut).trim());
      remain = remain.substring(cut).trim();
    }
    if (remain) parts.push(remain);
    return parts.filter(p => p.length > 0);
  }

  async _generateVrew(paragraphs, imgDir, vrewPath, kenburnsMode = 'uniform', maxChars = 30, kenburnsSpeed = 'normal') {
    // 빈 단락 제거
    paragraphs = paragraphs.filter(p => p && p.trim());
    // kenburnsSpeed는 SPEED_CONFIG에서 직접 사용 (slow/normal/fast)
    const { execFileSync } = require('child_process');
    const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    const sid = () => uid().replace(/-/g, '').substring(0, 10);

    // 이미지 매핑
    const imageFiles = {};
    try {
      for (const f of fs.readdirSync(imgDir)) {
        if (!/\.(jpg|jpeg|png|mp4)$/i.test(f)) continue;
        const m = f.match(/^(\d+)_/);
        if (m) imageFiles[parseInt(m[1])] = path.join(imgDir, f);
      }
    } catch { return; }

    // Vrew 템플릿 로드 (실제 동작하는 vrew에서 추출한 것)
    const templatePath = path.join(__dirname, 'vrew-template.json');
    let T;
    try {
      T = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    } catch {
      this.log('[!] vrew-template.json 없음, Vrew 내보내기 건너뜀');
      return;
    }

    const pj = JSON.parse(JSON.stringify(T));
    pj.projectId = uid();
    pj.comment = `3.8.0\t${new Date().toISOString()}`;
    pj.statistics.saveInfo.created.date = new Date().toISOString();
    pj.statistics.saveInfo.updated.date = new Date().toISOString();

    const mediaZip = [];
    // 글자수 기반 duration (초당 10자 — 빠른 전환)
    const calcDuration = (text) => {
      const dur = text.length / 10 + 0.3;
      return Math.max(2, Math.min(6, Math.round(dur * 10) / 10));
    };

    // TTS 텍스트 전처리 (Vrew preprocessInputText 동일)
    // em/en dash → 공백, 특수문자 제거, 한글/영어/숫자/,.?! 만 유지
    const ttsCleanText = (text) => {
      return text
        .replace(/[\u2013\u2014\u2e3b]/g, ' ')                     // em/en dash → 공백
        .replace(/[\x00-\x19]/g, '')                                // 제어 문자
        .replace(/[\u2000-\u2012\u2015-\u2bff]/g, '')              // 유니코드 특수기호
        .replace(/[\u3003-\u303f\u3099-\u309c]/g, '')              // CJK 기호
        .replace(/[()*/+:;<=>[\\\]^_{|}~@`]/g, '')                 // ASCII 특수문자
        .replace(/[\u300a\u300b\u3008\u3009\u300c\u300d]/g, '')    // 《》〈〉「」
        .replace(/^['"]|['"]$/g, '')                                // 시작/끝 따옴표
        .replace(/\s+/g, ' ').trim();
    };

    // 자막 인라인 스타일 (폰트, 크기, 외곽선)
    const CAPTION_ATTRS = { font: 'Pretendard-Vrew_700', size: '150', color: '#ffffff', 'outline-on': 'true', 'outline-color': '#000000', 'outline-width': '6' };

    // ─── TTS 설정 (msedge-tts로 실제 음성 생성 + 방안 D) ───
    // msedge-tts로 실제 음성을 미리 생성 → 정확한 duration으로 트랙 설정
    // Vrew에서 AI 목소리 교체 시 길이 불일치로 인한 검은화면 방지
    const DEFAULT_SPEAKER = {
      gender: 'female', age: 'middle', provider: 'vrew', lang: 'ko-KR',
      name: 'butter_f', speakerId: 'characteristic2', badge: 'Recommended',
      tags: ['_characteristic', 'cheesy', 'badgirl'], versions: ['v4'], isUnavailable: false,
    };
    let dummyTtsPath = null;
    let dummyBytes = 0;
    let dummyDur = 1;
    try {
      dummyTtsPath = path.join(__dirname, 'dummy-tts.mp3');
      dummyBytes = fs.statSync(dummyTtsPath).size;
    } catch {
      this.log('[!] dummy-tts.mp3 없음');
    }

    // TTS Manager 싱글톤 (voxcpm / gemini 2개 provider 추상화)
    let ttsManager = null;
    try {
      const { getInstance } = require('./tts/tts-manager');
      const { bootstrapNetwork } = require('./tts/network-bootstrap');
      ttsManager = getInstance({ logger: (m) => this.debug(m) });
      await bootstrapNetwork((m) => this.debug(m));
      await ttsManager.start();
    } catch (e) {
      this.debug(`[TTS] Manager 초기화 실패, 더미 음성 사용: ${e.message}`);
      ttsManager = null;
    }

    // TTS 음성 생성 임시 폴더
    const ttsTmpDir = path.join(os.tmpdir(), `vrew_tts_${Date.now()}`);
    fs.mkdirSync(ttsTmpDir, { recursive: true });

    if (!pj.props.ttsClipInfosMap) pj.props.ttsClipInfosMap = {};
    pj.props.lastTTSSettings = {
      pitch: 0, speed: 0, volume: 0,
      speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
    };

    // 클립별 TTS + ttsDubbing 파일 쌍 생성
    // TTS Manager 사용 가능 → 실제 음성 생성 (볼륨 0, 정확한 duration)
    // 실패 시 → 더미 파일 폴백
    const createClipDubbing = async (clipText) => {
      if (!dummyTtsPath && !ttsManager) return null;
      // 빈 텍스트 → 더미로 처리 (빈 클립에도 ttsDubbing 필수, 없으면 Vrew 무한 로딩)
      if (!clipText || !clipText.trim()) clipText = ' ';

      let ttsFilePath = dummyTtsPath;
      let ttsFileSize = dummyBytes;
      let ttsDuration = dummyDur;

      // TTS Manager 로 실제 음성 생성 (현재 msedge 만 활성)
      if (ttsManager) {
        try {
          const ttsOutPath = path.join(ttsTmpDir, `tts_${sid()}.mp3`);
          const { mp3Buffer, durationSec } = await ttsManager.synthesize(
            ttsCleanText(clipText),
            { provider: 'msedge' }
          );
          fs.writeFileSync(ttsOutPath, mp3Buffer);
          ttsFilePath = ttsOutPath;
          ttsFileSize = mp3Buffer.length;
          ttsDuration = durationSec;
        } catch (e) {
          this.debug(`[TTS] 음성 생성 실패, 더미 사용: ${e.message}`);
          ttsFilePath = dummyTtsPath;
          ttsFileSize = dummyBytes;
          ttsDuration = dummyDur;
        }
      }

      // TTS 파일 (ttsClip용) — 더미 (성우 이름 표시용)
      const ttsMid = sid();
      pj.files.push({
        version: 1, mediaId: ttsMid, sourceOrigin: 'VREW_RESOURCE',
        fileSize: dummyBytes, name: `${ttsMid}.mp3`, type: 'AVMedia',
        videoAudioMetaInfo: {
          duration: dummyDur,
          audioInfo: { sampleRate: 24000, codec: 'mp3', channelCount: 1 },
        },
        sourceFileType: 'TTS', fileLocation: 'IN_MEMORY',
      });
      pj.props.ttsClipInfosMap[ttsMid] = {
        pitch: 0, speed: 0, volume: 0,
        speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
        text: { raw: clipText, processed: ttsCleanText(clipText), textAspectLang: 'ko-KR' },
        duration: dummyDur,
      };
      mediaZip.push({ src: dummyTtsPath, name: `media/${ttsMid}.mp3` });

      // TTS_DUBBING 파일 (ttsDubbing용) — msedge-tts 실제 음성 (정확한 duration)
      const dubMid = sid();
      pj.files.push({
        version: 1, mediaId: dubMid, sourceOrigin: 'VREW_RESOURCE',
        fileSize: ttsFileSize, name: `${dubMid}.mp3`, type: 'AVMedia',
        videoAudioMetaInfo: {
          duration: ttsDuration,
          audioInfo: { sampleRate: 24000, codec: 'mp3', channelCount: 1 },
        },
        sourceFileType: 'TTS_DUBBING', fileLocation: 'IN_MEMORY',
      });
      mediaZip.push({ src: ttsFilePath, name: `media/${dubMid}.mp3` });
      return { ttsMid, dubMid, duration: ttsDuration, ttsDur: dummyDur };
    };

    // ─── 통일 sceneId (모든 클립을 한 씬으로) ───
    const unifiedSceneId = sid();

    // ─── 단락 = N클립 방식 (maxChars 기준 자동 분할) ───
    // 비디오(mp4)가 있는 단락은 분할 안 함 (타이밍 꼬임 방지)
    // 이미지만 있거나 파일 없는 단락은 maxChars 기준으로 분할
    const expanded = [];
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const imgIdx = pi + 1;
      const imgPath = imageFiles[imgIdx];
      const isVideoFile = imgPath && /\.mp4$/i.test(imgPath);
      if (isVideoFile || maxChars >= 54) {
        // 비디오 단락 또는 분할 안 함 모드 → 쪼개지 않음
        if (paragraphs[pi] && paragraphs[pi].trim()) expanded.push({ text: paragraphs[pi], imgIdx });
      } else {
        // 이미지/파일없음 단락은 maxChars로 분할
        const chunks = this._splitByMaxChars(paragraphs[pi], maxChars);
        for (const ch of chunks) {
          if (ch && ch.trim()) expanded.push({ text: ch, imgIdx });
        }
      }
    }
    // 파일 누락 경고
    const missingImgs = [];
    for (let pi = 0; pi < paragraphs.length; pi++) {
      if (!imageFiles[pi + 1]) missingImgs.push(pi + 1);
    }
    if (missingImgs.length > 0) {
      this.log(`[!] 이미지 누락 단락: ${missingImgs.join(', ')}번 (파일명 앞에 "${missingImgs[0]}_" 접두어 필요)`);
    }
    // 이미지 에셋 재사용 맵: imgIdx → assetId
    const imgAssetMap = {};
    this._paraDubMap = {};
    this._globalTimeOffset = 0;
    this._lastImgIdx = undefined;
    // 이미지 zIndex 카운터: 새 이미지마다 증가 (fade-in 겹침으로 끊김 방지)
    let imgZIndex = 0;

    for (let i = 0; i < expanded.length; i++) {
      const para = expanded[i].text;
      const imgIdx = expanded[i].imgIdx;
      // 이미지 없으면 직전/다음 단락 이미지 사용 (검은 화면 방지)
      let imgPath = imageFiles[imgIdx];
      if (!imgPath || !fs.existsSync(imgPath)) {
        for (let pi = imgIdx - 1; pi >= 1; pi--) {
          if (imageFiles[pi] && fs.existsSync(imageFiles[pi])) { imgPath = imageFiles[pi]; break; }
        }
        if (!imgPath || !fs.existsSync(imgPath)) {
          for (let pi = imgIdx + 1; pi <= paragraphs.length; pi++) {
            if (imageFiles[pi] && fs.existsSync(imageFiles[pi])) { imgPath = imageFiles[pi]; break; }
          }
        }
      }
      // 각 클립에 독립 TTS 생성 (모든 클립이 AI 목소리 변환 대상이 됨)
      const clipMedia = await createClipDubbing(para);
      // 클립 duration: TTS 실제 길이의 1.3배 (성우 변경 시 여유분 확보, 검은화면 방지)
      // 어떤 Vrew 성우로 바꿔도 이미지가 충분히 커버되도록
      const ttsDur = clipMedia?.duration || calcDuration(para);
      const totalDur = Math.max(ttsDur * 1.3, calcDuration(para));

      let dubAssetId = null;
      if (clipMedia) {
        const dubTid = sid();
        const dubAid = uid();
        pj.props.tracks[dubTid] = {
          trackId: dubTid, mediaId: clipMedia.dubMid, volume: 0,
          fade: { in: false, out: false },
          sourceIn: 0, sourceOut: clipMedia.duration, loop: false,
          playbackRate: 1, type: 'ttsDubbing',
          ttsFileInfo: {
            duration: clipMedia.duration,
            speaker: { ...DEFAULT_SPEAKER },
            volume: 0, speed: 0, pitch: 0, version: 'v4',
            text: { processed: ttsCleanText(para), raw: para, textAspectLang: 'ko-KR' },
          },
        };
        pj.props.assets[dubAid] = { trackIds: [dubTid], role: 'sub' };
        dubAssetId = dubAid;
      }

      // Vrew 정상 구조: 단락(이미지)이 바뀌면 타임라인 0 리셋
      // 같은 단락 내 분할 클립은 연속 유지
      if (this._globalTimeOffset === undefined) this._globalTimeOffset = 0;
      if (this._lastImgIdx !== undefined && this._lastImgIdx !== imgIdx) {
        this._globalTimeOffset = 0; // 새 단락 = 타임라인 리셋
      }
      this._lastImgIdx = imgIdx;
      const groupTimeOffset = this._globalTimeOffset;

      // 단어 단위 분할
      const wordsRaw = para.split(/\s+/).filter(w => w.length > 0);
      const totalChars = wordsRaw.reduce((s, w) => s + w.length, 0) || 1;
      const wordItems = [];
      let wt = groupTimeOffset;
      for (let wi = 0; wi < wordsRaw.length; wi++) {
        const w = wordsRaw[wi];
        const wd = Math.max(0.2, totalDur * (w.length / totalChars));
        let wordAssetIds = [];
        if (clipMedia) {
          const ttid = sid();
          const taid = uid();
          pj.props.tracks[ttid] = {
            trackId: ttid, mediaId: clipMedia.ttsMid, volume: 0,
            sourceIn: 0, sourceOut: Math.min(wd, clipMedia.ttsDur || dummyDur), loop: false,
            fade: { in: false, out: false },
            playbackRate: 1, type: 'ttsClip',
          };
          pj.props.assets[taid] = { trackIds: [ttid], role: 'main' };
          wordAssetIds.push(taid);
          if (wi === 0 && dubAssetId) {
            wordAssetIds.push(dubAssetId);
          }
        }
        wordItems.push({
          id: sid(), text: w, playbackRate: 1,
          duration: wd, aligned: false, type: 0,
          originalDuration: wd, originalStartTime: wt,
          truncatedWords: [], assetIds: wordAssetIds,
        });
        wt += wd;
      }
      // 그룹 누적 시간 업데이트
      if (this._paraDubMap[imgIdx]) {
        this._paraDubMap[imgIdx].timeOffset = wt;
      }
      // 전역 누적 시간 업데이트
      this._globalTimeOffset = wt;
      // end marker (type=2)
      wordItems.push({
        id: sid(), text: '', playbackRate: 1, duration: 0,
        aligned: false, type: 2, originalDuration: 0,
        originalStartTime: wt, truncatedWords: [], assetIds: [],
      });

      // 클립 생성 (단락 전체 텍스트를 하나의 clip으로)
      const clip = {
        sceneId: unifiedSceneId, id: sid(), captionMode: 'MANUAL',
        words: wordItems,
        captions: [
          { text: [{ attributes: CAPTION_ATTRS, insert: para }, { insert: '\n' }] },
          { text: [{ insert: '\n' }] },
        ],
        assetIds: [],
        dirty: { blankDeleted: false, caption: false, video: false },
        translationModified: { result: false, source: false },
      };
      pj.transcript.clips.push(clip);

      if (imgPath && fs.existsSync(imgPath)) {
        // 같은 이미지 → 동일 assetId 공유 (이전 방식 복원)
        // 세종대왕 파일 구조: 같은 이미지를 여러 클립이 공유, Ken Burns가 전체 구간을 커버
        if (imgAssetMap[imgIdx]) {
          const { aid: existAid } = imgAssetMap[imgIdx];
          clip.assetIds = [existAid];
          continue;
        } else {
        const mid = uid(), aid = uid(), tid = sid();
        const ext = path.extname(imgPath).toLowerCase().replace('.jpeg', '.jpg').replace('.', '');
        const fn = `${mid}.${ext}`;
        let trackIds = [tid]; // 기본: 트랙 1개 (이미지), 비디오는 2개
        let kb = null; // Ken Burns 정보 (이미지일 때만 설정)

        const isVideo = ext === 'mp4';
        const fileSize = fs.statSync(imgPath).size;
        if (isVideo) {
          const meta = this._getVideoMeta(imgPath);
          pj.files.push({
            version: 1, mediaId: mid, sourceOrigin: 'USER', fileSize, name: fn,
            type: 'AVMedia',
            videoAudioMetaInfo: {
              duration: meta.duration,
              videoInfo: { size: { width: meta.width, height: meta.height }, frameRate: meta.fps, codec: meta.vcodec },
              audioInfo: { sampleRate: meta.sampleRate, codec: meta.acodec, channelCount: meta.channels },
              mediaContainer: 'mp4',
            },
            sourceFileType: 'ASSET_VIDEO', fileLocation: 'IN_MEMORY',
          });
          // 비디오 트랙
          pj.props.tracks[tid] = {
            trackId: tid, mediaId: mid, xPos: 0, yPos: 0, height: 1, width: 1,
            rotation: 0, zIndex: 1, type: 'video',
            originalWidthHeightRatio: meta.width / meta.height,
            sourceIn: 0, sourceOut: meta.duration,
            isTrimmable: true, hasAlphaChannel: false, editInfo: {}, fillType: 'cut',
          };
          // 오디오 트랙 (볼륨 조절용)
          const audioTid = sid();
          pj.props.tracks[audioTid] = {
            trackId: audioTid, mediaId: mid,
            volume: 1, sourceIn: 0, sourceOut: meta.duration,
            loop: false, playbackRate: 1, type: 'videoAudio',
          };
          trackIds = [tid, audioTid];
        } else {
          pj.files.push({ version: 1, mediaId: mid, sourceOrigin: 'USER', fileSize, name: fn, type: 'Image', isTransparent: false, fileLocation: 'IN_MEMORY' });
          // Ken Burns 모드 분기
          // Vrew 소스 기반 Ken Burns + 안전 범위 클램프
          // Vrew user-image: padding=0.05, center 이동은 0.45~0.55 내로 제한
          // 안전 범위: scale이 작을수록(줌인) center 이동 범위가 넓어짐
          // scale 기반 물리적 한계만 적용 (확대된 상태에서는 검은 영역 불가능)
          const AR = 1.7778;
          const clampKB = (kb) => {
            // 검은 가장자리 완전 방지
            // 규칙: center가 [scale/2, 1-scale/2] 범위 밖이면 scale을 줄여(확대) 커버
            const M = 0.02; // 2% 안전 여유
            const clamp = (s, cx, cy) => {
              // center 위치에 필요한 최대 scale (이보다 크면 검은 부분 노출)
              const maxScaleX = Math.min(cx, 1 - cx) * 2;
              const maxScaleY = Math.min(cy, 1 - cy) * 2;
              let safeScale = Math.min(s, maxScaleX - M, maxScaleY - M);
              safeScale = Math.max(0.3, safeScale);
              // center를 안전 범위로 클램프
              const half = safeScale / 2 + M;
              return {
                scale: safeScale,
                centerX: Math.max(half, Math.min(1 - half, cx)),
                centerY: Math.max(half, Math.min(1 - half, cy)),
              };
            };
            return { from: clamp(kb.from.scale, kb.from.centerX, kb.from.centerY), to: clamp(kb.to.scale, kb.to.centerX, kb.to.centerY) };
          };
          // 세종대왕민낯.vrew 실측 기반 Ken Burns (34개 패턴에서 추출)
          // 원칙: scale<1일 때 확대→이동해도 검은 영역 없음
          // scale=1.0일 때 center≈0.50 → 검은 영역 없음
          // 이동 시 반드시 scale도 같이 변함 (순수 팬 없음)
          const SPEED_PRESETS = {
            slow: [
              // 줌인 (확대→원본, center 거의 고정)
              { from: { scale: 0.80, centerX: 0.52, centerY: 0.42 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 줌아웃 (원본→확대)
              { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.88, centerX: 0.51, centerY: 0.44 } },
              // 상→하 + 줌인
              { from: { scale: 0.70, centerX: 0.51, centerY: 0.39 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 하→상 + 줌인
              { from: { scale: 0.70, centerX: 0.51, centerY: 0.60 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 대각선 + 줌
              { from: { scale: 0.70, centerX: 0.53, centerY: 0.35 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 줌아웃 하→상
              { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.88, centerX: 0.51, centerY: 0.44 } },
            ],
            normal: [
              // 줌인 (실측: 0.70→1.00)
              { from: { scale: 0.70, centerX: 0.53, centerY: 0.35 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 줌아웃 (실측: 1.00→0.57)
              { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.57, centerX: 0.52, centerY: 0.51 } },
              // 상→하 + 줌 (실측: 0.54→1.00)
              { from: { scale: 0.54, centerX: 0.51, centerY: 0.37 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 하→상 + 줌아웃 (실측: 1.00→0.50)
              { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.50, centerX: 0.50, centerY: 0.44 } },
              // 대각선 (실측: 0.45→0.75)
              { from: { scale: 0.45, centerX: 0.22, centerY: 0.23 }, to: { scale: 0.75, centerX: 0.63, centerY: 0.62 } },
              // 대각선 반대 (실측: 0.70→0.72)
              { from: { scale: 0.70, centerX: 0.65, centerY: 0.35 }, to: { scale: 0.72, centerX: 0.36, centerY: 0.64 } },
              // 우→좌 + 줌인 (실측: 0.53→1.00)
              { from: { scale: 0.53, centerX: 0.61, centerY: 0.49 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 대각선 + 줌 (실측: 0.70→0.87)
              { from: { scale: 0.70, centerX: 0.65, centerY: 0.65 }, to: { scale: 0.87, centerX: 0.43, centerY: 0.44 } },
            ],
            fast: [
              // 줌인 드라마틱 (실측: 0.40→1.00)
              { from: { scale: 0.40, centerX: 0.53, centerY: 0.36 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 줌아웃 드라마틱 (실측: 1.00→0.50)
              { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.50, centerX: 0.53, centerY: 0.27 } },
              // 상→하 (실측: 0.41→1.00)
              { from: { scale: 0.41, centerX: 0.50, centerY: 0.20 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 하→상 (실측: 0.58→1.00)
              { from: { scale: 0.58, centerX: 0.51, centerY: 0.65 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 대각선 넓은 (실측: 0.44→1.00)
              { from: { scale: 0.44, centerX: 0.78, centerY: 0.22 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 대각선 반대 (실측: 0.53→1.00)
              { from: { scale: 0.53, centerX: 0.26, centerY: 0.74 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
              // 대각선 팬 (실측: 0.70→0.50)
              { from: { scale: 0.70, centerX: 0.35, centerY: 0.35 }, to: { scale: 0.50, centerX: 0.75, centerY: 0.75 } },
              // 줌인 + 좌측 (실측: 0.47→1.00)
              { from: { scale: 0.47, centerX: 0.63, centerY: 0.56 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
            ],
          };
          const presets = SPEED_PRESETS[kenburnsSpeed] || SPEED_PRESETS.normal;
          if (kenburnsMode === 'uniform') {
            // 균일 모드: 모든 클립이 같은 카메라 속도로 움직임
            // 이동 거리를 duration에 비례시켜 속도 일정하게 유지
            // 기준: 3초 클립에서 프리셋 전체 이동. 짧으면 덜, 길면 더 이동
            const base = presets[i % presets.length];
            const refDur = 6.0; // 기준 duration (6초에서 프리셋 전체 이동)
            const durRatio = Math.min(1.5, totalDur / refDur); // 비례 계수 (최대 1.5배)
            const lerp = (a, b, t) => a + (b - a) * t;
            kb = {
              from: {
                scale: lerp(base.to.scale, base.from.scale, durRatio),
                centerX: lerp(base.to.centerX, base.from.centerX, durRatio),
                centerY: lerp(base.to.centerY, base.from.centerY, durRatio),
              },
              to: base.to,
            };
          } else {
            // 고정 모드: 프리셋 그대로 사용
            kb = presets[i % presets.length];
          }
          // 안전 범위 클램프 (가장자리 검은 부분 방지)
          kb = clampKB(kb);
          // 세종대왕 정상 파일 구조에 맞춤 (assetEffectInfo 없음 = 검은화면 방지)
          pj.props.tracks[tid] = {
            trackId: tid, mediaId: mid, xPos: -0.004, yPos: 0, height: 1, width: 1.008,
            rotation: 0, zIndex: imgZIndex++, type: 'image', originalWidthHeightRatio: 1.7778,
            kenburnsAnimationInfo: { type: 'custom', from: kb.from, to: kb.to },
            editInfo: {},
            stats: { fillType: 'cut', fillMenu: 'floating', rearrangeCount: 0 },
          };
        }
        pj.props.assets[aid] = { trackIds, role: 'sub' };
        // assetId 저장
        imgAssetMap[imgIdx] = { mid, ext, isVideo, aid };
        clip.assetIds = [aid];
        mediaZip.push({ src: imgPath, name: `media/${fn}` });
        } // else 블록 끝
      }
    }

    // 임시 작업 폴더에 project.json + media 준비
    const tmpDir = path.join(os.tmpdir(), `vrew_${Date.now()}`);
    const tmpMedia = path.join(tmpDir, 'media');
    fs.mkdirSync(tmpMedia, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'project.json'), JSON.stringify(pj, null, 0), 'utf-8');
    for (const m of mediaZip) {
      fs.copyFileSync(m.src, path.join(tmpMedia, path.basename(m.name)));
    }

    // Node adm-zip으로 ZIP 생성 (Python 의존성 제거)
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addLocalFile(path.join(tmpDir, 'project.json'));
      if (fs.existsSync(tmpMedia)) {
        for (const fn of fs.readdirSync(tmpMedia).sort()) {
          zip.addLocalFile(path.join(tmpMedia, fn), 'media');
        }
      }
      zip.writeZip(vrewPath);
      this.log(`[Vrew] ${pj.transcript.clips.length}개 클립, ${mediaZip.length}개 이미지 → ${path.basename(vrewPath)}`);
    } catch (err) {
      this.log(`[!] Vrew 생성 실패: ${err.message || '알 수 없는 오류'}`);
    }

    // 임시 폴더 정리
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    try { fs.rmSync(ttsTmpDir, { recursive: true }); } catch {}
  }

  // ffprobe로 동영상 메타데이터 추출
  _getVideoMeta(filePath) {
    const defaults = { duration: 5, width: 1280, height: 720, fps: 24, vcodec: 'h264', hasAudio: false, sampleRate: 44100, acodec: 'aac', channels: 2 };
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
      ], { encoding: 'utf-8', timeout: 10000 });
      const info = JSON.parse(out);
      const vs = info.streams?.find(s => s.codec_type === 'video');
      const as = info.streams?.find(s => s.codec_type === 'audio');
      return {
        duration: parseFloat(info.format?.duration || vs?.duration || '5'),
        width: vs?.width || 1280,
        height: vs?.height || 720,
        fps: Math.round(eval(vs?.r_frame_rate || '24')),
        vcodec: vs?.codec_name || 'h264',
        hasAudio: !!as,
        sampleRate: parseInt(as?.sample_rate || '44100'),
        acodec: as?.codec_name || 'aac',
        channels: as?.channels || 2,
      };
    } catch {
      return defaults;
    }
  }

  async _translateToEnglish(koreanText) {
    try {
      const text = koreanText.replace(/\n/g, ' ').substring(0, 300);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(text)}`;
      const https = require('https');
      return new Promise((resolve) => {
        https.get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed[0].map(s => s[0]).join(''));
            } catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });
    } catch { return null; }
  }

  async _analyzeSceneContext(paragraphs, stylePrompt, style) {
    const intro = paragraphs.slice(0, 2).join(' ').substring(0, 400);
    const translatedIntro = await this._translateToEnglish(intro);
    if (!translatedIntro) return stylePrompt;

    const settingDesc = this._extractSettingFromText(translatedIntro);

    const fullSample = paragraphs.join(' ').substring(0, 300).toLowerCase();
    // 서양 동화 키워드 (먼저 체크 — 우선)
    const westernHints = ['공주', '왕자', '난쟁이', '마법사', '드래곤', '기사', '요정', '동화', '마녀', '유리관', '성에서', '왕국'];
    // 한국 전통 키워드 (애매한 '왕', '성' 제거)
    const koreanHints = ['사찰', '스님', '궁궐', '한복', '조선', '관리들', '전통 의복', '단청', '향로', '기와', '대감', '상궁', '내시'];

    // biblical cultureTag 는 사용자가 'biblical-' 접두사 스타일을 명시 선택했을 때만 적용
    // (현재: biblical-watercolor, biblical-chibi. 향후 biblical-oil 등 추가 시 자동 매칭).
    // 자동 키워드 판별을 제거한 이유: '말씀, 구원, 천사, 사도, 제자, 주님' 같은 단어가 일반
    // 한국어 대본에도 자주 나와 false positive 빈발 (공영장례 대본 같은 모던 한국 콘텐츠가
    // 갑자기 성경시대 설정으로 끼어드는 사고 발생).
    const isBiblical = typeof style === 'string' && style.startsWith('biblical-');
    const isWestern = !isBiblical && westernHints.some(k => fullSample.includes(k));
    const isKorean = !isBiblical && !isWestern && koreanHints.some(k => fullSample.includes(k));

    let cultureTag = '';
    if (isBiblical) cultureTag = 'ancient biblical era scene, Holy Land setting, people wearing ancient Middle Eastern robes and tunics, head coverings, sandals, first-century Judea atmosphere';
    else if (isWestern) cultureTag = 'fairy tale movie scene';
    else if (isKorean) cultureTag = 'Korean historical drama';

    // 공통 컨텍스트 = 스타일 + 문화권만 (장면 텍스트 제외 — 개별 프롬프트에서 포함)
    // 장면 텍스트를 넣으면 프롬프트가 너무 길어져서 정책 위반 확률 증가
    const parts = [stylePrompt];
    if (cultureTag) parts.push(cultureTag);

    const context = parts.join(', ');
    return context;
  }

  _extractSettingFromText(translatedText) {
    const sentences = translatedText
      .replace(/\.\s+/g, '.|')
      .split('|')
      .map(s => s.trim())
      .filter(s => s.length > 10);

    const settingIndicators = [
      'inside', 'in the', 'at the', 'on the', 'near', 'around', 'within',
      'filled with', 'surrounded by', 'covered', 'decorated',
      'atmosphere', 'air', 'light', 'dark', 'quiet', 'silent', 'peaceful',
      'warm', 'cold', 'misty', 'foggy', 'bright', 'dim', 'glow',
      'scent', 'smell', 'sound', 'echo', 'shadow',
      'morning', 'evening', 'night', 'dawn', 'sunset', 'midnight',
    ];

    const actionIndicators = [
      'walking', 'running', 'talking', 'saying', 'looking', 'holding',
      'sitting', 'standing', 'moving', 'entering', 'leaving',
      'praying', 'singing', 'dancing', 'fighting', 'crying', 'laughing',
    ];

    const settingSentences = [];
    for (const sent of sentences) {
      const lower = sent.toLowerCase();
      const hasSetting = settingIndicators.some(k => lower.includes(k));
      const isAction = actionIndicators.some(k => lower.includes(k));
      if (hasSetting && !isAction) settingSentences.push(sent);
    }

    if (settingSentences.length > 0) return settingSentences.join(', ').substring(0, 200);
    return sentences[0] ? sentences[0].substring(0, 150) : '';
  }

  async _buildEnglishPrompt(koreanText, stylePrompt, ratio, sceneContext, prevTranslated = null, presetEnglish = '') {
    const text = koreanText.replace(/\n/g, ' ').substring(0, 500);
    const translated = await this._translateToEnglish(text);

    if (!translated) {
      this.debug(`  [번역] 실패, 원문 사용`);
      this._lastTranslated = text;
      return `${sceneContext || stylePrompt}, ${ratio} aspect ratio, scene: ${text}, highly detailed, no text, no watermark`;
    }

    this.debug(`  [번역] ${translated.substring(0, 60)}...`);
    this._lastTranslated = translated;

    const safe = this._sanitizeForPolicy(translated);
    if (safe !== translated) this.debug(`  [안전화] ${safe.substring(0, 60)}...`);

    const context = sceneContext || stylePrompt;

    // 장면(주역) 먼저, 사전 설정(보조)은 뒤에
    const parts = [`${context}, ${ratio} aspect ratio`, `scene: ${safe}`];
    if (presetEnglish) parts.push(`setting: ${presetEnglish}`);
    parts.push('highly detailed, no text, no watermark');

    const prompt = parts.join(', ');
    this.debug(`  [프롬프트] ${prompt.substring(0, 80)}...`);
    return prompt;
  }

  _sanitizeForPolicy(text) {
    const replacements = [
      [/white[- ]?skinned/gi, 'fair and beautiful'],
      [/dark[- ]?skinned/gi, 'beautiful'],
      [/pale[- ]?skinned/gi, 'elegant'],
      [/poison(ed|ous)?/gi, 'enchanted'],
      [/venom(ous)?/gi, 'magical'],
      [/\bevil\b/gi, 'wicked'],
      [/\bkill(s|ed|ing)?\b/gi, 'defeats'],
      [/\bdead\b/gi, 'sleeping'],
      [/\bdeath\b/gi, 'slumber'],
      [/\bdie[sd]?\b/gi, 'falls asleep'],
      [/\bblood(y)?\b/gi, 'red'],
      [/\bweapon/gi, 'tool'],
      [/\bsword/gi, 'wand'],
      [/\bdagger/gi, 'wand'],
      [/\bkiss(es|ed|ing)?\b/gi, 'magical blessing'],
      [/prince's gentle touch/gi, 'magical spell breaking'],
      [/prince's magical blessing/gi, 'magical spell breaking'],
      [/with the prince's/gi, 'by a'],
      [/\bnaked\b/gi, 'dressed'],
      [/\bnude\b/gi, 'dressed'],
      [/\bcoffin/gi, 'crystal bed'],
      [/glass crystal bed/gi, 'crystal glass bed'],
      [/\btomb\b/gi, 'resting place'],
      [/\bgrave\b/gi, 'garden'],
      [/\bscream(s|ed|ing)?\b/gi, 'calls out'],
      [/\bterror/gi, 'surprise'],
      [/\bhorror/gi, 'wonder'],
      [/\bSnow White\b/gi, 'a beautiful princess'],
      [/\bCinderella\b/gi, 'a young maiden'],
      [/\bRapunzel\b/gi, 'a long-haired princess'],
      [/\bMaleficent\b/gi, 'a dark sorceress'],
      // 민감한 캐릭터/상황 묘사
      [/\bdwarfs?\b/gi, 'small friendly companions'],
      [/\bqueen\b/gi, 'noblewoman'],
      [/\bwitch(es)?\b/gi, 'mysterious woman'],
      [/\bslave/gi, 'servant'],
      [/\bdrunk(en)?\b/gi, 'merry'],
      [/\bdisguised as an old woman/gi, 'appearing as an elderly lady'],
      [/\bdisguised as/gi, 'appearing as'],
      [/\bhag\b/gi, 'elderly woman'],
      [/\bsteal(s|ing)?\b/gi, 'takes'],
      [/\btorture/gi, 'challenge'],
      [/\bwar\b/gi, 'conflict'],
      [/\bbattle\b/gi, 'confrontation'],
    ];

    let result = text;
    for (const [pattern, replacement] of replacements) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  // 실패 메시지 제거 (실패 타일 삭제)
  async _dismissFailure() {
    try {
      // 방법 1: "delete_fore" 삭제 버튼 클릭
      const btns = await this.page.$$('button');
      for (const btn of btns) {
        try {
          if (await btn.isVisible()) {
            const text = (await btn.textContent() || '').trim();
            if (text.includes('delete_fore') || text === 'delete') {
              await btn.click();
              await this.page.waitForTimeout(1500);
              this.debug('  [실패 타일 삭제됨]');
              return;
            }
          }
        } catch {}
      }

      // 방법 2: "프롬프트 재사용" 버튼 → 프롬프트 입력란으로 복귀
      for (const btn of btns) {
        try {
          if (await btn.isVisible()) {
            const text = (await btn.textContent() || '').trim();
            if (text.includes('프롬프트 재사용') || text.includes('undo')) {
              await btn.click();
              await this.page.waitForTimeout(1000);
              // 이전 프롬프트가 복원되므로 지워줌
              await this.page.keyboard.press('Control+a');
              await this.page.keyboard.press('Backspace');
              await this.page.waitForTimeout(500);
              this.debug('  [프롬프트 재사용으로 복구]');
              return;
            }
          }
        } catch {}
      }

      // 방법 3: 실패 텍스트를 DOM에서 직접 제거
      await this.page.evaluate(() => {
        document.querySelectorAll('div, span').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text.startsWith('실패') || text.includes('정책을 위반')) {
            let parent = el;
            for (let i = 0; i < 5; i++) {
              if (parent.parentElement) parent = parent.parentElement;
            }
            parent.remove();
          }
        });
      });
      await this.page.waitForTimeout(500);
    } catch {}
  }

  // Python 실행 에러를 고객 친화적 메시지로 정제 (명령/경로 노출 방지)
  _sanitizePyError(err) {
    const stdout = (err.stdout || '').toString();
    const stderr = (err.stderr || '').toString();
    const combined = (stderr + '\n' + stdout).trim();
    const msg = (err.message || '').toString();

    // Windows Store alias: "Python was not found..."
    if (/Python was not found/i.test(combined) || /Microsoft Store/i.test(combined)) {
      return 'Python이 설치되어 있지 않습니다. https://python.org 에서 설치해주세요';
    }
    // 일반 not found
    if (/ENOENT|not recognized|not found/i.test(msg) && !combined) {
      return 'Python이 설치되어 있지 않습니다. https://python.org 에서 설치해주세요';
    }
    // 타임아웃
    if (/ETIMEDOUT|timed? out/i.test(msg)) {
      return '작업 시간 초과';
    }
    // 실제 Python 에러가 있으면 첫 의미있는 줄만
    const lines = combined.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    // "Command failed:" 포함 줄은 제외 (명령 노출 방지)
    const useful = lines.filter(l => !/Command failed/i.test(l) && !/python/i.test(l.split(' ')[0]));
    if (useful.length > 0) return useful[useful.length - 1].substring(0, 200);
    return '알 수 없는 오류';
  }

  // 정책 위반 시 재시도용 단순화 프롬프트 (level: 1=가벼움, 2=중간, 3=최대 단순화)
  _buildSimplifiedPrompt(originalPrompt, level = 1) {
    // 커스텀/사전조립 프롬프트(클로드 왕복, Gemini 등 — "aspect ratio"/"scene:" 마커 없음)는
    // 잘라내면 핵심 내용(인물·시대)이 사라진다. 전체를 유지하고 민감어만 레벨별로 스크럽.
    const _hasLegacyMarkers = /\d+:\d+\s*aspect/i.test(originalPrompt) || /scene:/i.test(originalPrompt);
    if (!_hasLegacyMarkers) {
      let p = String(originalPrompt || '');
      if (level >= 2) {
        p = p
          .replace(/\b(blood|wound|pain|disease|illness|sick|rot|dirty|filthy|stink|smell|odor|pus|boil|ulcer|infect)\w*/gi, '')
          .replace(/\b(kill|murder|assassin|poison|torture|execut|behead|corpse|dead|die|death)\w*/gi, 'scene')
          .replace(/\b(naked|nude|sex|erotic)\w*/gi, '')
          .replace(/\s*,\s*,+/g, ', ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      return p;
    }

    const styleMatch = originalPrompt.match(/^(.+?),\s*\d+:\d+\s*aspect/i);
    const style = styleMatch ? styleMatch[1].trim().substring(0, 80) : 'cinematic scene';

    const sceneMatch = originalPrompt.match(/scene:\s*(.+?)(?:,\s*highly|$)/i);
    let scene = sceneMatch ? sceneMatch[1].trim() : originalPrompt.substring(0, 150);

    // 레벨별 단순화 강도
    scene = scene
      .replace(/\bseven\b/gi, 'a few')
      .replace(/\bsinging to the birds?\b/gi, 'enjoying nature')
      .replace(/\bholding\b.*?\bapple\b/gi, 'walking')
      .replace(/\bwakes? up from\b/gi, 'rises from');

    if (level >= 2) {
      // 민감 표현 추가 제거
      scene = scene
        .replace(/\b(blood|wound|pain|disease|illness|sick|rot|dirty|filthy|stink|smell|odor|pus|boil|ulcer|infect)\w*/gi, '')
        .replace(/\b(kill|murder|assassin|poison|torture|execut|behead|corpse|dead|die|death)\w*/gi, 'scene')
        .replace(/\b(naked|nude|sex|erotic)\w*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (level >= 3) {
      // 최대 단순화: 장면을 짧게 잘라 안전 태그만 남김
      scene = scene.split(/[,.]/)[0].trim().substring(0, 60);
      return `${style.substring(0, 40)}, serene scene, peaceful atmosphere, ${scene}`;
    }

    return `${style}, ${scene.substring(0, 120)}`;
  }

  // ─── Vrew 음성 겹침 정리 (ttsDubbing 트랙 제거) ───
  cleanupVrew(vrewPath) {
    const tmpDir = path.join(os.tmpdir(), `vrew_clean_${Date.now()}`);
    try {
      // 압축 해제
      const pyClean = `
import sys, json, zipfile, os

vrew, tmp = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(vrew, 'r') as z:
    z.extractall(tmp)
with open(os.path.join(tmp, 'project.json'), 'r', encoding='utf-8') as f:
    pj = json.load(f)

# ttsDubbing 트랙이 있는 클립 찾기
dub_tids = set(k for k,v in pj['props']['tracks'].items() if v.get('type') == 'ttsDubbing')
if not dub_tids:
    print('SKIP:0')
    sys.exit(0)

# ttsDubbing이 있는 클립에서: ttsClip 제거 + ttsDubbing을 ttsClip으로 승격
# 1. 어떤 word가 ttsDubbing asset을 갖고 있는지 → 해당 클립의 모든 ttsClip을 제거 대상으로
tts_tids_to_remove = set()
tts_mids_to_remove = set()
fixed_clips = 0

for clip in pj['transcript']['clips']:
    # 이 클립에 ttsDubbing이 있는지 확인
    has_dub = False
    for w in clip.get('words', []):
        for aid in w.get('assetIds', []):
            asset = pj['props']['assets'].get(aid, {})
            for tid in asset.get('trackIds', []):
                if pj['props']['tracks'].get(tid, {}).get('type') == 'ttsDubbing':
                    has_dub = True
                    break
    if not has_dub:
        continue
    fixed_clips += 1

    # 이 클립의 모든 단어에서 ttsClip asset 제거, ttsDubbing을 ttsClip으로 승격
    for w in clip.get('words', []):
        new_asset_ids = []
        for aid in w.get('assetIds', []):
            asset = pj['props']['assets'].get(aid, {})
            track_types = [pj['props']['tracks'].get(t, {}).get('type') for t in asset.get('trackIds', [])]
            if 'ttsClip' in track_types and 'ttsDubbing' not in track_types:
                # 기존 ttsClip → 제거
                for tid in asset.get('trackIds', []):
                    t = pj['props']['tracks'].get(tid, {})
                    if t.get('type') == 'ttsClip':
                        tts_tids_to_remove.add(tid)
                        tts_mids_to_remove.add(t.get('mediaId', ''))
                # asset도 제거 (new_asset_ids에 안 넣음)
            elif 'ttsDubbing' in track_types:
                # ttsDubbing → ttsClip으로 타입 변경
                for tid in asset.get('trackIds', []):
                    t = pj['props']['tracks'].get(tid, {})
                    if t.get('type') == 'ttsDubbing':
                        t['type'] = 'ttsClip'
                new_asset_ids.append(aid)
            else:
                new_asset_ids.append(aid)
        w['assetIds'] = new_asset_ids

# 제거 대상 ttsClip 트랙 삭제
for tid in tts_tids_to_remove:
    if tid in pj['props']['tracks']:
        del pj['props']['tracks'][tid]

# 빈 asset 정리
rm_aids = [aid for aid, a in pj['props']['assets'].items() if not a.get('trackIds')]
for aid in rm_aids:
    del pj['props']['assets'][aid]

# TTS_DUBBING 파일 → TTS로 변경 (승격)
for f in pj['files']:
    if f.get('sourceFileType') == 'TTS_DUBBING':
        f['sourceFileType'] = 'TTS'

# 사용 안 하는 ttsClip 미디어 파일 제거
# (다른 클립에서 아직 사용 중인 mediaId는 제거하면 안 됨)
used_mids = set(v.get('mediaId', '') for v in pj['props']['tracks'].values())
md = os.path.join(tmp, 'media')
removed_media = 0
for mid in tts_mids_to_remove:
    if mid in used_mids:
        continue
    # ttsClipInfosMap에서도 제거
    if mid in pj['props'].get('ttsClipInfosMap', {}):
        del pj['props']['ttsClipInfosMap'][mid]
    # files에서 제거
    pj['files'] = [f for f in pj['files'] if f.get('mediaId') != mid]
    for ext in ('.mp3', '.wav', '.mpga'):
        fp = os.path.join(md, mid + ext)
        if os.path.exists(fp):
            os.remove(fp)
            removed_media += 1

with open(os.path.join(tmp, 'project.json'), 'w', encoding='utf-8') as f:
    json.dump(pj, f, ensure_ascii=False)
with zipfile.ZipFile(vrew, 'w', zipfile.ZIP_DEFLATED) as zo:
    for root, dirs, files in os.walk(tmp):
        for fn in files:
            fp = os.path.join(root, fn)
            zo.write(fp, os.path.relpath(fp, tmp))
print('OK:' + str(fixed_clips))
`;
      const pyTmp = path.join(os.tmpdir(), `_vrew_clean_${Date.now()}.py`);
      fs.writeFileSync(pyTmp, pyClean, 'utf-8');
      const { execFileSync } = require('child_process');
      const result = execFileSync('python', [pyTmp, vrewPath, tmpDir], { encoding: 'utf-8', timeout: 30000 });
      try { fs.unlinkSync(pyTmp); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      if (result.includes('SKIP:0')) {
        this.log('[Vrew 정리] 겹침 트랙 없음, 정리 불필요');
        return 0;
      }
      const count = parseInt(result.split(':')[1]) || 0;
      this.log(`[Vrew 정리] ${count}개 클립 음성 승격 완료 (이전 음성 제거, 새 음성 유지)`);
      return count;
    } catch (err) {
      this.log(`[!] Vrew 정리 실패: ${err.message}`);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      return -1;
    }
  }

  _fmt(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s},000`;
  }
}

module.exports = { FlowAutomator };
