# Shots-maker — 작업 컨텍스트 노트

> 다음 AI(또는 사람)가 5분 안에 컨텍스트를 복원하기 위한 노트. (PrimingFlow CLAUDE.md 스타일)

## 프로젝트 한 줄 요약
컷 단위로 완성된 "역사이야기" 쇼츠 대본(.md, 한 파일 3편) → 편별 TTS·이미지·(선택)비디오 →
**편별 Vrew 4.0.1 .vrew 파일**을 자동 생성하는 Electron 앱. PrimingFlow(D:\PrimingFlow)의 엔진을
복사·재활용한 독립 클론.

## 최근 버그픽스 (2026-06-17)
- 🐞 **Genspark 이미지가 UI에 안 붙음**: `generateImagesGenspark`는 `g.imagePath`를 정상 매핑하지만,
  make-all/image-build가 중간에 `pushDtoUpdate()`를 안 보내 작업 끝까지 썸네일이 안 보였음(Flow만 실시간).
  → make-all에서 `Promise.allSettled` 직후 + 영상 후, image-build/video-build 각 쇼츠 후 `pushDtoUpdate()` 추가.
  `generateHookVideosGrok`에 `onProgress` 콜백 추가 → 그룹별 영상 완성 시마다 UI 갱신(main이 pushDtoUpdate 전달).
- 🐞 **Grok 영상 완료 감지 실패(화면 구성 변경)**: `downloadButton` 셀렉터(`div.absolute.-right-14 button:nth-child(4)`)가
  새 UI와 안 맞아 `dlEnabled`가 계속 false → 실제 https videoUrl을 41초에 잡고도 5분 타임아웃 fallback까지 대기.
  → grok-engine 폴링을 **다운로드 버튼 비의존**으로 변경: 실제 https videoUrl + 비디오 ready(readyState≥2 & dur>1)가
  **2회 연속(≈10초 안정)** 잡히면 즉시 URL 직접 다운로드. 다운로드 버튼은 blob/실패 시 폴백으로만 사용.

## 최근 기능 추가 (2026-06-17, v0.1.5)
- **도형 위치·크기 고정**: vrew-builder `addShapeTrack` 폰트기반 계산 제거 → 사용자 .vrew 분석값 고정
  (xPos 0 / yPos 0.012 / width 1 / height 0.203). 배경 도형 **기본 ON**(parser `proj.bgEnabled=true`).
- **그룹 8초 재구성**(`P.mergeGroupsByTts`, IPC `merge-groups`, UI 🔗합치기 + **TTS 후 자동**): v0.1.9에서
  **문장 단위 그리디 패킹**으로 변경 — 모든 문장을 순서대로 8.0초 캡으로 다시 묶음. **큰 그룹은 쪼개지고
  (예 훅강화 12.6s→2그룹) 작은 그룹은 합쳐져** 결과 그룹 전부 <8.0초. 단일 문장>8초면 단독. 첫 문장 원본
  그룹의 phase/프롬프트 보존. tts-build 가 음성변환 직후 자동 호출(`pushDtoUpdate`). 워크플로우: TTS(자동 재구성)
  → 내보내기/가져오기로 프롬프트 → 이미지.
- **이미지 프롬프트 내보내기/가져오기/API**(`core/prompt-io.js`, IPC export-prompts/import-prompts/
  generate-prompts-api, UI 📤내보내기·📥가져오기+모달): PrimingFlow 포팅. 편-그룹 복합 라벨 `## [쇼츠-그룹]`로
  3편 한 번에. 안전치환(PROMPT_SAFE_RULES) 포함. API는 secret-store 키(gemini/claude/openai).
- **음성 배속을 MP3 에 직접 굽기 (Vrew 배속 폐기)**(v0.1.10): Vrew playbackRate 방식은 폐기.
  대신 `fillTts` 가 정속 WAV 합성 → ffmpeg `atempo=배속(기본1.15)` 로 **배속 MP3** 생성(피치 유지),
  `ttsDurationSec = 원본/배속`. 8초 그룹·.vrew 모두 이 배속 MP3 사용. vrew-builder `_playbackRate` 기본 1.
  capbar '음성배속'(기본 1.15) → ttsBuild/make-all 의 speed → fillTts(speedFactor). 검증: 2.30s→2.04s MP3,
  vrew playbackRate 전부 1.
  - 🐞 **(v0.1.11) 설치판 배속 미적용 버그**: pipeline.js 의 ffmpeg-static 경로가 asar 보정 없어 패키지 앱에서
    실행 실패 → atempo 실패 → 정속 WAV 폴백(평상시 속도로 들림). vrew-builder 처럼 `app.asar`→`app.asar.unpacked`
    보정 추가로 해결. fillTts 시작 시 ffmpeg 사용가능 여부 로그(🔊 적용 / ⚠ 미적용).

## 긴 문장 자동 분리 (2026-06-17, v0.1.16)
- 한 줄/컷에 마침표로 끊기는 문장 여러 개가 붙어 있으면(예 CTA 17.4초) 8초 그룹이 못 쪼개 초과 → 해결.
- 파서 `splitNarration(text, maxChars=28)`: ① `.?!。` 로 문장 분리(종결부호 유지) ② 그래도 28자(유효
  글자) 넘으면 쉼표로 절 분리. buildProjectModel(cut)·buildProjectModelGrouped(prose/grouped) 둘 다 적용.
  TTS 전 분리라 각 문장이 별도 음성 → 오디오 자르기 불필요. 이후 8초 패킹이 ≤8초 그룹으로 묶음.
- 검증: 17.4초 CTA → 4문장(~3-5초)으로 분리. 회귀 407단언 통과.

## 줄글(prose) 대본 형식 추가 (2026-06-17, v0.1.8)
- 신규 3번째 형식: `## 쇼츠 N` 안에 `제목:`(2줄) + `[훅]`/`[본론 심화]`/`[CTA]` 같은 **대괄호 그룹 헤더** + 그 아래 줄들=문장.
  `★CTA:` 같은 별표 라벨도 그룹 헤더로 인식. **이미지 프롬프트 없음** → TTS→합치기→내보내기/가져오기로 프롬프트 생성.
- 파서: `parseShortsBlockProse` + `buildProjectModelGrouped` 재사용. 감지 `format='prose'`(① 없고 `[..]`+`제목:` 있으면).
  proj.titleLine1/2 자동 세팅. 검증: 0617 파일 = prose 3편·6그룹·16/17/15문장, 회귀 407단언 통과.
- 테스트: prose 는 imagePrompt 단언 생략(없는 게 정상).

## Flow 이미지+영상 통합 (2026-06-17, v0.1.7 — i2v 첨부는 반복 보정 중)
- 이미지 엔진 select=**Google Flow** 선택 시 이미지·영상 **모두 Flow**로 (Grok 대신). Genspark 선택 시 이미지=Genspark/영상=Grok 유지.
- 엔진은 이미 이미지/동영상·비율·매수·모델(Veo) 선택 지원(`_configureSettings`/`_selectModel`/`_clickTab`). run()에
  **`frameImages` 옵션** 추가 → 영상 모드에서 단락마다 소스 이미지를 프레임/애셋으로 첨부(i2v).
- 신규 `_attachFrameImage(imagePath,num)`(flow-engine): **best-effort** 셀렉터(프레임/애셋 버튼+`input[type=file]`)
  + 실패 시 `_dumpFrameAttachUI()`로 버튼/입력 후보 로그 → **실제 로그 보고 셀렉터 고정 예정**(Grok/자막과 동일 반복법).
- main `runFlowVideos(project,mediaDir,logger,{videoCount,model,count})`: 앞 N개(이미지 있는) 그룹 → eng.run(video,
  frameImages) → 출력 .mp4 매핑. video-build/make-all 이 engine==='flow'면 이 경로, 아니면 Grok.
- UI: 헤더에 `#flowVideoModel`(Veo 3.1 Lite/Fast/3.1)·`#flowCount`(1x~4x) — 엔진=Flow일 때만 노출(`_toggleFlowOpts`).
- ⏳ **검증 필요**: 실제 Flow 영상 UI에서 프레임/애셋 첨부 셀렉터. 사용자가 한 번 돌려 `[i2v DUMP]` 로그 주면 고정.

## PrimingFlow와의 관계 (중요)
- 엔진(flow/genspark/grok-engine, vrew-builder, tts, video-renderer, anti-detect, project-model)은
  `D:\PrimingFlow\rebuild` 에서 **복사**해 사용. 수정 시 원본과 갈라짐을 인지할 것.
- 차이: PrimingFlow는 텍스트→자동 문장분리/그룹화/프롬프트생성. 본 앱은 **컷이 이미 확정**되어
  파서가 Sentence/Group을 직접 만들고 그 단계들을 건너뜀.
- 설정/상태 디렉토리: PrimingFlow=`~/.flow-app/`, 본 앱=**`~/.shots-maker/`** (절대 공유 금지).

## 실행
```powershell
cd D:\Shots-maker
npm install   # 첫 실행 시
npm start     # → electron .
```

## 대본 형식 (입력 계약) — 2형식 자동 감지 (core/cut-script-parser.js)
공통: H1 제목 + `>` 메타(목소리/9:16) + `## 쇼츠 N`(편) + `- 훅 자막(첫 프레임): ...`.
감지: 본문에 `- 음성/자막:` 또는 `**…그룹 N`이 있으면 **신규(grouped)**, 없으면 **구(cut)**.

▸ **신규(grouped) — 권장** (0611이 이 형식):
```
**🎬 그룹 1 ｜훅 (이미지 → 비디오)**       ← 그룹 헤더: 번호·단계·모드
- 음성/자막:
  - 문장1
  - 문장2                                  ← 그룹당 문장 여러 개
- 🖼️ 이미지: `image prompt`
- 🎬 → 비디오(I2V): `i2v video prompt`     ← 🎬 그룹(훅·절정)만
**🎞️ 그룹 2 ｜본론 (이미지 + 모션)**
- 🖼️ 이미지: `...`
- 🎞️ 모션: slow zoom-in …                  ← 켄번스 힌트(영상 아님, group.motionNote)
```
단계: 훅/본론/재훅·심화/절정 직전/CTA. 모드: "이미지 → 비디오"(I2V) / "이미지 + 모션".

▸ **구(cut) — 하위호환**: `① (훅) 나레이션` + 다음 줄 백틱 이미지 프롬프트 (컷=문장=그룹 1:1:1).
- **(2026-06-17 추가) 컷별 비디오 프롬프트**: 이미지 백틱 줄 다음에 `🎬 \`video prompt\`` 를 쓰면
  그 컷이 Grok 영상이 될 때 **기본값 대신** 그 프롬프트 사용(+isI2V 표시). `🎞 모션설명`은 videoPrompt
  없을 때 폴백/켄번스. 파서 `parseShortsBlock`(🎬/🎞 줄 인식)→`buildProjectModel`(g.videoPrompt/motionNote).
  ⚠️ 영상이 되는 컷은 **영상 개수(앞에서 N개)** 로 정해짐 — 특정 컷을 영상화하려면 N이 그 컷을 포함해야 함.
- 검증: 0611=grouped, 0612~0619=cut. `node test/parser.test.js` 419 단언 통과.

## 데이터 매핑
- 그룹(또는 컷) → **Group**: imagePrompt(🖼️ 백틱 **그대로**), videoPrompt(🎬 I2V 백틱),
  phase, mode('i2v'|'motion'), isI2V, motionNote. 음성/자막 줄(또는 컷 나레이션) → **Sentence**(그룹에 다수 가능).
- `## 쇼츠 N` → Project 1개(aspect '9:16'). 한 파일 → Project N개 → .vrew N개.
- 영상: **사용자 입력 개수 N(헤더 🎬[N])만큼 앞 그룹부터** Grok 영상화(isI2V 고정 폐지, PrimingFlow 개수방식).
  모션 프롬프트 = group.videoPrompt(I2V) || motionNote || Grok 기본. 나머지 그룹은 이미지+켄번스.
  생성·삽입은 PrimingFlow 엔진(grok/flow/genspark)+vrew-builder 그대로(세로영상=비디오트랙).
- `splitIntoSentences`/`buildGroups` 미사용 (대본이 그룹·문장을 이미 명시).

## 핵심 모듈
- `core/cut-script-parser.js` — ★신규 파서 (가장 자주 수정).
- `core/project-model.js` — Sentence/Group/Project (PrimingFlow에서 복사, 무수정).
- `vrew/vrew-builder.js` — .vrew 4.0.1 생성 (복사). 형식 변경 시 PrimingFlow CLAUDE.md의
  "4.0.1 호환 변경표" 참조. 검증본: `D:\PrimingFlow\test.vrew` / `01.vrew`.
- `tts/` — OmniVoice(근간, 포트 9881, 중후한 남성)+Gemini 폴백.
- `flow-engine/genspark-engine/grok-engine.js` + `anti-detect.js` — 자동화·봇회피
  (일일한도 PER_PROFILE_DAILY_CAP=45, 상태는 `~/.shots-maker/anti-detect-state.json`).
- `main.js` — IPC 오케스트레이션(파서→TTS→이미지→비디오→편별 .vrew). 편별 N회 호출 래퍼 포함.

## 출력
- 1차: 편별 .vrew (Vrew에서 마무리). 2차: 편별 MP4(ffmpeg, video-renderer).

## 추가 기능 (최신)
- 썸네일 **✕ 삭제**(IPC clear-asset): 그룹 image/video 비움.
- 영상 개수 = **셀렉트(기본 '랜덤')**. 랜덤이면 쇼츠마다 1~min(3,그룹수) 무작위(main `resolveVideoCount`). 숫자 선택 시 그 값.
- 자막 옵션(위치/미세조정/정렬/크기) 변경 시 **미리보기 재생 중이면 즉시 반영**(applyCaptionStyle 재호출).
- 도형 가로 = **영상 전체 폭(width 1)**, 세로만 텍스트 크기 따라 가변.
- 비GPU PC: TTS 멀티엔진(OmniVoice 원격GPU / **Gemini API** / **Supertonic 로컬CPU 9882**) 이미 포함 →
  채널 engine을 gemini/supertonic으로 하면 GPU 없이 동작(PrimingFlow 구조 그대로).
  **Gemini API 키 입력**: ⚙ 채널편집 모달의 'Gemini 키' → IPC get/set-gemini-key → `tts/secret-store`('gemini'.key).
  gemini-provider.init()이 그 키를 읽음. 비GPU PC는 gemini 채널 선택 + 키 입력하면 음성 생성.
- 패키징: `npx electron-builder --win nsis --x64 --publish never` → dist/Shots-maker Setup 0.1.0.exe(+latest.yml).
  자동업데이트는 그 둘을 GitHub Releases에 올리면 동작(토큰 없이 드래그업로드 가능). repo: getwater-maker/Shots-maker(푸시됨).
- GitHub 자동업데이트: main에 `electron-updater` `checkForUpdatesAndNotify`(패키징 시만), package.json
  `build.publish`(github getwater-maker/Shots-maker) + `npm run dist`. 발행은 repo 생성 + GH_TOKEN 필요(수동).

## 구현 순서 (계획서: ~/.claude/plans/...0611-glistening-lagoon.md)
0. 이 CLAUDE.md 작성 ✅
1. cut-script-parser.js + node 단위 테스트 (0611 → projects 3·컷 5·imagePrompt 매핑)
2. PrimingFlow 모듈 복사 + package.json + 앱 부팅
3. 파서 → .vrew 직결(빈 자산)으로 출력 파이프라인 선검증
4. TTS 연결 → 5. 이미지 연결 → 6. 편별 .vrew 3개 완성
7. (2차) Grok 비디오, MP4 편별 렌더

## 디버깅 팁 (PrimingFlow에서 계승)
- 로그 `[Vrew] (4.0.1 호환)` 보이면 정상. `.vrew.debug.json` 옆에 생성됨 → test.vrew와 라인 비교.
- main process(엔진) 변경은 앱 완전 재시작 필요. ui/index.html은 Ctrl+R 반영.

## 진행 상황
- ✅ 0단계: CLAUDE.md 작성
- ✅ 1단계: `core/cut-script-parser.js` + `test/parser.test.js`. **2형식(grouped/cut) 자동 감지** 파서.
  실제 대본 9개 파싱, 단언 419개 통과. (0611=grouped: 5그룹·9문장·I2V 플래그, 나머지=cut)
- ✅ 그룹 형식 대응: 그룹당 문장 다수 → DTO sentences[], UI 문장목록·I2V/모션 배지·그룹시간,
  I2V 영상은 isI2V 그룹만(group.videoPrompt 사용). vrew-builder는 다중문장 그룹을 이미 지원.
- ✅ 2단계(부분): vrew 파이프라인 모듈 복사(vrew-builder, long-sentence-splitter, media-utils,
  vrew-template.json, vrew/dummy) + package.json + `npm install adm-zip ffmpeg-static`.
  (electron/playwright/wavesurfer 미설치 — 엔진·UI 단계에서 설치)
- ✅ 3단계: `build-shorts.js` 헤드리스 CLI — 파서 → (DRY: ffmpeg 무음) → vrew-builder 편별 호출.
  0611 대본 → 편별 .vrew 3개 생성 검증 완료. videoRatio 0.5625/1080×1920, 자막에 실제 나레이션
  박힘, .vrew=유효 zip(project.json+mp3). **남은 검증: 사용자가 Vrew 4.0.1에서 직접 열어보기.**
- ✅ 4단계: 실제 TTS 연결. tts/ 모듈 복사(파이썬 백엔드 제외), build-shorts.js에 OmniVoice 연결.
  기본 프리셋 "역사이야기"(중후한 남성, ref=02_저음 2단계.wav, speed 1.2, seed 5697) 재사용.
  프리셋의 captionStyle·aiNotice·disableLongSplit도 .vrew opts로 전달 → 채널과 동일한 자막/AI고지.
  0611 쇼츠1 실측: 5컷 합성(4.0/3.68/3.52/3.36/5.70s), wav→mp3 5/5, AI고지 자막 삽입, .vrew 생성 OK.
- ✅ Electron UI 셸: electron 33 설치, `bootstrap.js`(엔트리, userData=~/.shots-maker/electron 격리)
  + `preload.js`(contextBridge api) + `main.js`(창+IPC, 권위 데이터 S 보유, DTO 전달)
  + `ui/index.html`(모닝커피 팔레트, 편 카드·컷별 표시·전체/편별 TTS·.vrew 버튼·로그콘솔).
  공유 로직은 `core/pipeline.js`로 추출(CLI build-shorts.js와 공용). `npm start` 부팅 성공(4프로세스).
  IPC: list-presets / open-script / tts-build({shortsNum,dry,presetName}) / export-vrew / open-folder.
- ✅ 5단계: 이미지 연결 (Genspark + Flow 둘 다). 엔진 복사(genspark-engine, flow-engine, anti-detect,
  style-store, image/), playwright 설치(시스템 Chrome 사용, 브라우저 다운로드 생략).
  - Genspark: `pipeline.generateImagesGenspark()` — `generateImagesBatch({prompts,outputPaths})`에
    group.imagePrompt 그대로 투입, `_aspectRatio='9:16'`, 결과를 group.imagePath에 매핑. 출력 `쇼츠N_images/cutM.png`.
  - Flow: `main.js runFlowImages()` — FlowAutomator.run({paragraphs, customPrompts=imagePrompt 그대로,
    ratio '9:16'}) 이벤트 기반, win 필요. images/NN*.png(num=01..)를 group에 매핑. 출력 `쇼츠N_flow/images/`.
  - 브라우저 엔진은 `~/.flow-app` 프로필/anti-detect 재사용(기존 로그인 유지 + 일일한도 정확 공유).
  - IPC `image-build({shortsNum, engine})`, UI: 이미지 엔진 select + 🖼 전체/편별 버튼.
  - ⚠️ main process 변경 → **앱 완전 재시작 필요**. 실제 생성은 브라우저+로그인 필요(사용자 검증).
  - 🐞 **함정(해결)**: Genspark는 `chromium.launchPersistentContext`로 **Playwright 내장 Chromium**을 씀
    (시스템 Chrome 채널 미지정). 그래서 `npx playwright install chromium` 필수 — 안 깔면 "이미지 안 생성".
    (Flow는 channel:'chrome' 시스템 크롬). 현재 chromium-1223 설치됨(playwright 1.60.0).
  - UI: 로그콘솔에 **📋 복사** 버튼 추가(navigator.clipboard, execCommand 폴백).
- ✅ 6단계(부분): 훅 컷 Grok image-to-video. grok-engine.js 복사, `pipeline.generateHookVideosGrok()`
  — phase==='훅' & imagePath 있는 컷만 `generateVideoFromImage({imagePath,prompt,outputPath})`,
  `_aspectRatio='9:16'`(세로 6초). 결과를 group.videoPath에 매핑. 출력 `쇼츠N_video/cutM.mp4`.
  IPC `video-build({shortsNum})`, UI 🎬 전체/편별 훅영상 버튼. Grok은 X(트위터) 로그인 필요.
- ✅ vrew-builder 9:16 영상 지원: 기존엔 9:16이면 영상 무시(이미지만)였으나, **세로 영상이면 비디오
  트랙 사용**하도록 보정(`_useVideo = _aspect!=='9:16' || vertical`). Grok 세로영상 → .vrew 훅 컷 애니메이션.
  ffmpeg 1080x1920 합성영상으로 비디오트랙 삽입 검증 완료.
- ✅ UI: 컷마다 들어간 **이미지/비디오 파일명 표시**(🖼/🎬, prompt는 숨김). 로그 📋 복사 버튼.
- ⏭ 남음: MP4 편별 렌더(video-renderer 편별 N회 래퍼) — 선택.

## UI (index.html) 현재 구성
- 레이아웃: 상단 헤더 + 좌(본문 카드)/우(로그 패널) 2분할. (로그를 하단→우측 이동)
- 편별 그룹 카드: 헤더에 편 제목·그룹수·**합계시간**, 내부 그룹들은 **2열 그리드**(1,2/3,4/5,6, `.cuts-grid`).
- 그룹 행: **3배 썸네일(150×264)** + 헤더(G번호·단계배지·🎬I2V/🎞️모션 배지·그룹시간) + 문장 목록(각 ▶시간) + 자산명.
- 영상 썸네일은 **autoplay muted loop**로 실제 재생되어 보임. 썸네일 클릭 → 크게보기 모달(showPreview).
- **미리보기 재생 플레이어**(#player, playShorts): 편별 ▶미리보기 / 헤더 ▶전체 미리보기 →
  9:16 스테이지에서 그룹마다 이미지/영상 + 문장 TTS 오디오(media://) + 자막을 **순서대로 재생**.
  오디오 없으면 그룹시간/2.5s 타이머. DTO sentences에 audio(ttsAudioPath) 포함.
- 썸네일/자산 미리보기는 `media://<encoded-abs-path>` 커스텀 프로토콜로 로컬 파일 로드.
  🔴 **비디오 검정화면 버그**: `net.fetch(file://)`가 Range 요청에 ERR_UNEXPECTED → protocol.handle에서
  **Range 직접 처리**(fs.readSync 슬라이스 → 206 Content-Range)로 교체. 이미지는 200 전체. 비디오 미리보기 정상화.
  썸네일 클릭 → 모달 크게보기. 미리보기 음성은 IPC read-audio(base64).
- UI 정리: 배지 이모지 제거(I2V/모션), 제목 1줄 라벨 🔖 제거, capbar 안내문구 제거.
- 무음(DRY) 체크박스 = TTS 없이 무음으로 .vrew 구조 검증. 채널 select = 목소리·자막·AI고지 프리셋 선택.
- 작업목록 **3열 그리드**. 그룹 헤더줄(.narr) 배경색 + 본문(.sents) 사이 빈 줄. 자산 파일명 표시 제거.
- 썸네일 클릭 → **이미지/영상 첨부·교체**(IPC `attach-asset`, 파일 대화상자, 확장자로 image/video 판별).
- 로그창 = **우하단 작은 떠있는 창**(fixed, 330×230), 바 클릭으로 접기/펼치기(.collapsed).
- 채널 편집: 헤더 ⚙ → 모달(#chmodal). 속도/참조음성/참조텍스트/시드/AI고지 편집 → `save-preset`(preset-store.update).
- 자막 설정 바(#capbar): 크기·**상하위치(기본 '가운데'=-0.5)**·**미세조정 px 입력(+아래/−위, /1920)**·정렬·**🎤속도**.
  capOverride yOffset = base + px/1920. 💾 .vrew 시 `exportVrew({captionStyle})`, 🎤 TTS 시 `ttsBuild({speed})`.
- 🔴 **자막 위치/크기 — 사용자 .vrew 분석으로 확정**: 위치는 **클립별 `captions[].style`가 지배**
  (전역 globalCaptionStyle 아님). 가운데=`yAlign:'middle', yOffset:0`, 미세조정 N → `yOffset=N*0.0025`
  (예 80→0.2, +아래/−위). 좌우 가운데=`--textbox-align:'center'`. 폰트 `size`(기본 90, 옵션 25~300).
  vrew-builder CAPTION_STYLE 기본을 middle/0/center/size90 으로 변경. 검증: 가운데+80 → middle/0.2/90 일치 OK.
- 자막 줄 분할: `core/caption-splitter.js` — **공백무시 8자 + 쉼표에서 끊기**. vrew-builder가 이걸로 sub-clip
  생성(20자 algo 대체). DTO sentences[].lines = 편 전체 이어지는 넘버링(01|,02|…). UI에 번호+줄 표시.
- 미리보기: 이미지 그룹 **켄번스 CSS 애니메이션**, 영상 그룹 재생. 자막은 capbar 위치(yAlign middle, top%=50+yOffset*50),
  제목(훅 자막)은 **상단 고정**(#stageTitle, titleSize/titleColor).
- 출력경로(재설정): **`<채널 outputFolder>/<대본파일명>/`** + **쇼츠별 폴더 `media-N`(이미지+영상)·`tts-N`(음성)·
  `subtitles-N`(SRT)** + 루트에 `쇼츠N.vrew`. main `shortsDirs(outRoot,N)`. .vrew 생성 즉시 `shell.openPath`.
- 파일명: media-N/`{그룹2자리}.ext`(01.png,01.mp4), tts-N/`{문장num}.wav`. Flow는 임시폴더 생성→번호매칭(실패시 순서)
  복사. Flow 내부 vrew 빌드용 더미 `dummy-tts.mp3`(무음) 추가로 ENOENT 로그 제거.
- 이미지 스타일: `core/style-store.js`(28종) → 헤더 `#styleSel`. **PrimingFlow 방식: `<stylePrompt>, <대본 imagePrompt>`**
  (스타일을 앞). 채널편집 모달 `이미지 스타일` 사전설정(preset.styleId), 임의 변경 가능.
- Flow: **FlowAutomator 단일 인스턴스 재사용**(S.flowEng) — 매번 new 하면 같은 프로필에 크롬창 중복 실행/"비정상 종료".
  run()이 기존 브라우저 health-check 후 재사용. before-quit에서 context.close. (Genspark는 매 호출 stop()로 정상 종료)
- Flow **실시간 첨부**: 생성 중 work폴더 2.5s 폴링(`mapFlowImagesOnce` 멱등) → 새 이미지를 media-N/NN로 복사·그룹에
  즉시 매핑 → `win.webContents.send('dto-update', toDTO)` → 렌더러 `onDtoUpdate`가 DTO 교체·재렌더(썸네일 라이브).
  종료 시 순서폴백 최종 매핑.
- 🐞 **Flow 크롬창 누적/about:blank/이미지 안만들어짐**: 앱이 비정상 종료(force-kill 등)되면 Flow 크롬이 정리 안 돼
  프로필 락(Singleton*)이 남음 → 다음 실행 시 "복원하시겠습니까" + 빈 창이 쌓이고 Flow 진입 실패. 해결:
  `cleanChromeProfile(profileDir)`로 첫 실행 전 **Singleton 락 삭제 + Preferences exit_type=Normal/exited_cleanly** 세팅.
  before-quit에서 context.close. **남은 stray 크롬창은 사용자가 한 번 모두 닫아야 함**(락 점유 중이면 새 실행 충돌).
- 파일명(#ftitle)은 **자막설정 줄 왼쪽**(grow로 자막항목은 우측). 긴 이름은 줄임표+title 호버. 헤더는 버튼 한 줄.
- 자막 줄 글자수 **기본 7자**, UI(capbar #capChars)에서 조절. 글자수 카운트 = **공백·쉼표·마침표·느낌표·물음표 제외**(한글·영숫자만).
  export/make에 captionMaxChars 전달. 렌더러도 동일 splitLines로 넘버링 표시(문장별 시간표시 제거).
- 미리보기: 클립(7자)별로 자막을 TTS 길이에 비례해 순차 표시(stepCaptions). **전체 미리보기=편 사이 1초 검은화면**.
  그룹 시간 옆 **▶(단일 그룹 미리보기)** 버튼(data-prevgroup). 편별/그룹별/전체 재생(playProjects/playGroup).
- ⚡ 전체만들기/💾.vrew: 새 폴더구조·SRT·captionMaxChars 반영 + .vrew 자동 열기.
- 자막 분할 v2 (`core/caption-splitter.js`): **어절(조사 포함) 안 쪼갬**(긴 단어는 넘쳐도 1줄 → "다." 고아 방지),
  쉼표 끊기, **균형 DP**(최대 줄길이 최소화), **접속부사(그런데/그리고…) 단독 줄**. 사용자 그룹3 예시와 정확 일치.
  렌더러 splitLines도 동일. 기본 7자, 카운트는 한글·영숫자만(공백·문장부호 제외).
- 제목(훅) = **각 쇼츠 카드에서 2줄 편집**(텍스트+줄별 크기·색상·정렬, 기본 가운데). project.titleLine1/2 + t1*/t2*,
  IPC set-title({shortsNum,field,value}). DTO·save/load 포함. 미리보기 상단 표시 + **.vrew 번인**(vrew-builder
  `addTitleTrack`: 줄마다 web/textbox 트랙 상단 고정, durationSeconds 0=전체, 줄별 정렬). 검증: 2줄 트랙 OK.
- 일괄첨부 = **파일 다중선택**(openFile+multiSelections, 폴더선택 폐지). 파일명 앞 숫자=그룹, 같은번호 영상우선.
- Genspark는 **6장씩 배치 청크**(generateImagesGenspark, 한 장씩 X). 미리듣기 오디오는 fetch→blob(media:// 직접재생 실패 우회).
- 앱 표시: 그룹헤더(G·배지·모션·시간) 15px 동일크기, 자막(.sent) 14px. 문장별 시간표시 제거.
- 자산 파일명 `{그룹번호2자리}_s{N}.ext`(예 `01_s1.mp4`) — 일괄첨부 `^0*(\d+)`가 그룹번호로 매핑(훅=01).
- 미리보기 TTS: IPC `read-audio`(파일→base64 data URL)로 재생(media:// fetch가 렌더러에서 막히는 문제 우회).
- 제목 배경 도형: 사용자 .vrew 분석 → `type:'shape'`(dimensionType2/shapeType0/square) + `files[].Svg` + zip `media/<id>.vbin`
  (EJS 템플릿, `vrew/dummy/shape-square.vbin`). plane.color=`#RRGGBBAA`(채우기색+불투명도), stroke(테두리 색/불투명도/두께/점선),
  cornerRounding(0~1). vrew-builder `addShapeTrack`(제목보다 아래 zIndex, 전체 clip 링크). 세로=제목 덮음, 가로=폰트·글자수 비례.
  카드 제목영역에 도형 컨트롤(채우기/테두리/모서리/점선), project.bg* 필드, set-title/DTO/save 포함. 검증: shape+Svg+1:1 OK.
- 이미지/영상 비율: 헤더 `#aspectSel`(9:16 기본/1:1) → IPC set-aspect로 전 프로젝트 aspect 설정.
  Genspark/Flow/Grok `_aspectRatio=project.aspect`, vrew-builder 1:1(캔버스 1080×1080, ratio 1.0) 지원.
- **이미지 비율 불일치 시 중앙 배치**: vrew-builder `readImageSize`(PNG/JPEG 헤더)로 실제 비율 측정 →
  캔버스와 다르면(예: 1:1 이미지를 9:16에) **늘리지 않고 contain 중앙 배치(fillType 'fit', 켄번스 없음)**.
  비슷하면 기존처럼 꽉채움+켄번스. 검증: 1024² → width1/height0.563/yPos0.219 OK.
- 일괄첨부(IPC bulk-attach): 폴더 선택 → 파일명 앞 숫자=그룹번호 매핑, 같은 번호면 **영상 우선**.
- 채널 편집(⚙): 속도·참조음성·참조텍스트·**출력폴더·대본폴더**·이미지스타일·시드·AI고지 (save-preset).
- 대본 열기: 선택 채널의 `scriptFolder`가 dialog 기본 경로(open-script에 presetName 전달). 출력경로도 그 채널 outputFolder 기준.
- 헤더 1줄: 좌(🎬·채널명만·⚙·대본열기·프로젝트·불러오기) + grow + 우(스타일·엔진·비율·미리보기·TTS·이미지·I2V·만들기·.vrew·출력폴더).
  파일명은 그 아래 줄(#ftitle 볼드). 무음(DRY) 제거. 채널 select는 채널명만 표시(★·엔진 suffix 제거).
- 프로젝트 저장/불러오기: `~/.shots-maker/projects/<base>.smproj.json` 스냅샷(IPC save/load-project).
- ⚡ 전체 만들기(IPC make-all): TTS+이미지 동시(Promise.allSettled) → I2V영상 → .vrew → 출력폴더 열기.
- 헤더 파일명 전체표시+볼드. 그룹 헤더줄 배경+우측정렬 시간+폰트확대. 자산 파일명줄 제거.
- ⏭ **미해결**: 제목(훅)을 .vrew 영상 상단에 **번인**(현재 앱/미리보기만). Vrew 상단 텍스트트랙 형식 필요 →
  사용자가 Vrew에서 상단 제목 넣은 .vrew 샘플 주면 그 형식 맞춰 구현(자막 위치 잡은 방식과 동일).

## 앱 구조 (현재)
- 엔트리 `bootstrap.js` → `main.js`(IPC) ↔ `preload.js` ↔ `ui/index.html`(렌더러).
- `core/pipeline.js` = parseScript/toDTO/getPreset/listPresets/makeTtsManager/fillTts/fillSilent/buildProjectVrew.
- CLI `build-shorts.js`도 동일 파이프라인 사용. UI/CLI 어느 쪽이든 같은 결과.
- 실행: `npm start`(UI) 또는 `node build-shorts.js "<대본.md>" [--only N] [--dry]`(헤드리스).

## TTS 연결 핵심 (4단계에서 확정)
- **설정 재사용**: TTS는 `~/.flow-app/`의 tts-presets.json/tts-config.json/ref-audio/dict를 **그대로 재사용**
  (격리 예외 — 동일 목소리·재설정 불필요). 격리는 브라우저/봇회피 상태에만 적용.
- baseUrl: `http://192.168.219.157:9881` (LAN GPU PC, tts-config.json). /health 200 확인.
- ⚠️ **버그 주의**: `TTSManager.start()`는 omnivoice/supertonic 연결을 await하지 않음(Gemini만 await).
  헤드리스에서는 `await ttsMgr.refreshProvider(engine)`로 연결 완료를 기다린 뒤 사용해야 함.
- 프리셋 선택: `presetStore.getDefault()` 또는 `--preset <name>`. OmniVoice는 Voice Clone =
  refAudioPath+refText 필요(프리셋에 경로 들어있음). provider.synthesize → {mp3Buffer(=wav), durationSec}.

## build-shorts.js (헤드리스 CLI)
- `node build-shorts.js "<대본.md>" [--out <dir>] [--no-dry] [--only N]`
- 기본 DRY: TTS 없이 무음 오디오로 .vrew 구조 검증. 출력: `output/<파일베이스>/쇼츠N.vrew`(+.debug.json).
- `--no-dry`: 실제 자산 경로(아직 TTS/이미지 미연결 — 4·5단계에서 구현).

## 미해결/다음 작업
- 사용자 Vrew 4.0.1에서 output 의 .vrew 3개 정상 로드 확인 (자막·9:16·타임라인).
- OmniVoice 백엔드(포트 9881) 이 PC에서 가동 가능한지 확인 후 4단계 TTS 연결.
- 이미지/비디오 엔진(flow/genspark/grok)은 playwright 설치 + 로그인 세션 필요 → 5단계+.
