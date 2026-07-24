# Shots-maker — 작업 컨텍스트 노트

> 다음 AI(또는 사람)가 5분 안에 컨텍스트를 복원하기 위한 노트. (PrimingFlow CLAUDE.md 스타일)

## 프로젝트 한 줄 요약
컷 단위로 완성된 "역사이야기" 쇼츠 대본(.md, 한 파일 3편) → 편별 TTS·이미지·(선택)비디오 →
**편별 Vrew 4.0.1 .vrew 파일**을 자동 생성하는 Electron 앱. PrimingFlow(D:\PrimingFlow)의 엔진을
복사·재활용한 독립 클론.

## 🧩 ComfyUI 워크플로(이미지·비디오) 번들 자동 등록 — PC 무관 정합 (2026-07-24, v0.2.69)
> 증상: 아내 PC(깃허브 설치본)는 버전(코드)은 업데이트되는데 비디오 도구 드롭다운에 **LTX 가 아니라 Wan** 만 뜸.
- **원인(코드 확정)**: 워크플로 목록(`workflows[]`)·활성(`workflowPath`)은 **홈 설정파일**(`~/.priming-maker/comfy-video-config.json`,
  `comfy-image-config.json`)에만 저장 — 라이트 업데이트는 설치폴더 코드만 교체하고 홈 설정은 안 건드림. 등록은 예전에 **내 PC
  홈파일 수동 기록**("초기값 직접 기록")으로만 했고 경로가 **내 PC 절대경로(`D:\Priming\comfy\...`)**라 아내 PC 엔 전달 안 됨.
  코드엔 워크플로 자동 등록 로직이 아예 없었음(DEFAULTS.workflows=[]). 반면 워크플로 JSON 파일(`comfy/*.json`)은 git-tracked
  라 설치·업데이트로 모든 PC 에 내려가 있었음 — **파일은 있는데 "등록"만 안 된 상태.**
- **수정(B안 = 번들은 항상 보장, 로이 결정)**: `comfy-video.js`·`comfy-image.js` 에 `_ensureBundled(cfg)` 추가 →
  `loadConfig()` 가 매번 실행. **설치폴더 기준**(`COMFY_DIR = path.join(__dirname,'..','comfy')` — asar:false 라 dev·설치본 양쪽
  정확) 으로 번들 워크플로(비디오=Wan2.2 5B·LTX2.3 / 이미지=Z-Image·Krea2)를 목록에 보장하고, **파일명(basename) 일치하는 기존
  항목은 제거 후 재구성**(절대경로 표류·중복 정리). 사용자 커스텀 워크플로는 보존. **활성 경로 복구**: basename 이 번들과
  일치하면 설치폴더 경로로 교정(사용자 선택 존중), 비었거나 실재하지 않으면(타 PC 절대경로 등) 기본(비디오 LTX2.3·이미지
  Z-Image)로. cloud/apiKey/서버프로필 등 나머지 설정은 그대로 보존.
- **효과**: 이제 **업데이트만으로 모든 PC 가 동일하게** Wan·LTX(및 Z-Image·Krea2)를 드롭다운에 갖게 됨. 아내 PC 는 기존 활성
  (Wan)이 유지되되 옛 절대경로가 자기 설치폴더 경로로 복구되고 **LTX 도 선택 가능**. 새 설치는 기본 LTX. 내 PC 도 D:\Priming
  경로 자동 정합(폴더 옮겨도 안 깨짐). loadConfig 는 in-memory 시드(파일 강제 재기록 안 함) — 다음 saveConfig 때 자연 영속.
- 검증: dev PC(Wan·LTX·활성 LTX) / 아내PC 시뮬(옛 Wan 절대경로 1개 → 목록 2개·중복0·활성 Wan 복구·exists·cloud/apiKey 보존) /
  새설치(빈 설정→LTX 기본) / 이미지(Z-Image·Krea2) 통과. ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🔼 상단 버튼 = 큐 전체 + 「이미지→비디오」 통합 버튼 (A안 ①②) (2026-07-23, v0.2.68)
> 요청: 상단 이미지·비디오·TTS 버튼은 작업큐의 모든 대본을 관할(대본 위 버튼은 그 대본만). + 이미지 먼저 다 만들고
>   비디오 만드는 통합 버튼을 상단·대본위 양쪽에 추가.
- **안정 최우선 = 기존 단건 핸들러(image-build/video-build/tts-build) 무변경, 렌더러 큐 루프로 재사용.**
  `runStageQueue(stage)`(App.jsx): 현재 모드 큐의 items 를 순회하며 각 항목 `selectQueueItem` → 해당 stage IPC 호출 →
  끝나면 원래 보던 대본으로 복원. stage='tts'|'image'|'video'|'imgvid'.
- **상단 버튼 재배선**: 🎤 TTS→runStageQueue('tts'), 🖼 이미지→('image'), 🎬 비디오→('video'), 신규 **🖼→🎬 이미지+비디오**
  →('imgvid', 이미지 전부→비디오). 큐 1개면 그 1개만(기존과 동일 동작).
- **대본 위 버튼**: 그대로 그 대본만(onImg/onVid). 신규 **🖼→🎬**(runImgVid) = 그 대본 이미지 전부→비디오.
- **파드 반자동 연동**: runStageQueue 가 autoManage ON + GPU 단계(image/video/imgvid)면 루프 전 runpodStart 1회 · 후 runpodStop 1회
  (TTS 는 OmniVoice 라 파드 무관 → 안 건드림). 헤더 이미지·비디오 도구가 큐 전 대본에 공통 적용(v0.2.61·v0.2.67 정합).
- ⚠ 현재 모드 큐만 관할(롱폼 탭이면 롱폼 큐). 교차 모드는 「만들기」가 담당. 앱 재시작 반영, deps 무변경.
- A안 ①②③ 완료. 남은 것: ③번(RunPod 작업을 TTS 와 분리해 연속 처리 — 큰 개조)은 별도 승인 후.

## 🎛 채널편집에 이미지·비디오 제작 도구 기본값 (③ of A안) (2026-07-23, v0.2.67)
> 요청: 채널편집 팝업에서 스타일 항목처럼 이미지·비디오 제작 도구를 골라 저장 → 그 채널 선택 시 헤더 기본값으로.
- **preset 에 `imgEngine`·`videoEngine` 필드 추가**(채널 단위, per-mode 아님). save-preset 이 patch 를 generic 병합(preset-store.update
  `{...old,...patch}`)이라 IPC 무변경. get-preset-detail 이 전체 반환 → 복원됨.
- **채널편집 모달**: 「🖼 이미지 도구 · 🎬 비디오 도구」 섹션(스타일 옆) — 이미지(순환/유료/ComfyUI)·비디오(ComfyUI/Grok/Grok
  API/없음) select. saveChannel patch 에 imgEngine/videoEngine, openChannelEditor setCh 에 기본값(rotate/grok).
- **채널 선택 시 헤더 세팅**: 프리셋→상태 effect(restoringItemRef 가드 안)에서 `p.imgEngine`/`p.videoEngine` 있으면
  setImgEngine/setVideoEngine(레거시 정규화). styleId 와 동일 패턴 — 항목 복원 중엔 항목값 우선(안 덮음).
- 구체 워크플로(Krea2/LTX)·서버(RunPod/comfy.org)는 헤더 ⚙ ComfyUI 설정을 따름(채널은 "어느 도구"만). ⚠ 앱 재시작 반영.
- 남은 것(A안): ①상단 버튼 큐 전체 + ②「이미지→비디오」 통합버튼(상단·대본위) — 다음 착수.

## ⚡ RunPod 파드 반자동 켜기/끄기 (과금 절감, 안정 우선 격리 구현) (2026-07-23, v0.2.66)
> 요청: 내가 쓸 때만 파드 켜고 끝나면 꺼서 시간·비용 낭비 막기. (A안: ①②먼저 → ③나중. 안정 최우선.)
- **`core/runpod.js` 신설**(격리): RunPod GraphQL(`api.runpod.io/graphql`)로 podResume/podStop/pod status. 키=secret-store
  'runpod'. config(`~/.priming-maker/runpod-config.json`) `autoManage(기본 false)`·podId·gpuCount·readyTimeoutSec·stopOnAbort.
  **podId 는 활성 ComfyUI 주소(`<podId>-8188.proxy.runpod.net`)에서 자동 추출.** waitComfyReady=주소 200 폴링(콜드스타트 대기).
- **main.js**: `autoStartPodIfNeeded()`/`autoStopPodIfNeeded()` — autoManage ON + 활성 comfy 서버가 RunPod 일 때만. make-all·
  run-batch 진입 시 자동 켜고(ComfyUI 뜰 때까지 대기, 실패면 제작 중단), 끝나면 finally 로 자동 정지. 수동 doStartPod/doStopPod +
  IPC(get/set-runpod-key·config, runpod-start/stop/status). **autoManage 기본 OFF → 켜기 전엔 기존 동작 완전 무영향(안전).**
- **App.jsx**: 헤더 「⚡ RunPod」 버튼 → 모달(API 키·반자동 토글·중단시끄기·podId(선택) + ▶켜기/⏹끄기/상태). 콜드스타트 경고 문구.
- ⚠ **RunPod GraphQL 스키마 실측 필요**: 키 넣고 ▶켜기/상태 1회 확인(응답 로그로 남김). podResume/podStop input 이 다르면 쿼리만
  보정. GPU 재고 없으면 켜기 실패로 표시. ⚠ 콜드스타트(부팅+모델로딩 ~1~3분)는 stop/start 의 본질적 대가 — 곧 재사용이면 켜둠 권장.
- 남은 것: ①틈 제거(큐 한꺼번에), ③RunPod 작업을 TTS와 분리해 연속 처리(대본 안 섞이게 항목별 상태 분리 선행). 둘 다 미착수.

## 🐞 업스케일 중 영상 썸네일이 하나씩 깜빡이며 사라짐 → 경로 교체 끝에 일괄 (2026-07-23, v0.2.65)
> 증상: 업스케일 단계에서 "하나 끝나면 하나 사라지고 계속 반복" — 그룹 영상 썸네일이 순차로 깜빡(빈 화면→재등장).
- **원인**: `maybeUpscale` 이 그룹마다 업스케일 직후 `g.videoPath = NN_1080.mp4` 로 교체 + pushDtoUpdate → 그 그룹
  `<video src>` 가 바뀌어 브라우저가 영상을 리로드(잠깐 빈 화면). 순차 처리라 그룹 수만큼 하나씩 깜빡임 반복.
  (`media()` 는 캐시버스터 없음 — 리로드는 오직 경로가 바뀔 때만 발생.)
- **수정**: 루프 중엔 **videoStatus(오버레이)만** 갱신(src 무변경 → 리로드 없음). 경로 교체(`NN.mp4`→`NN_1080.mp4`)는
  `swaps[]` 에 모아뒀다가 **모든 업스케일이 끝난 뒤 한 번에 반영 + pushDtoUpdate 1회**. → 순차 깜빡임 제거(있어도 끝에 1회).
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🔀 ComfyUI 서버 프로필(comfy.org ↔ RunPod) 드롭다운 전환 (2026-07-23, v0.2.64)
> 요청: comfy.org 클라우드와 RunPod(자가 GPU)를 골라 쓰며 몇 번 써보고 최종 결정하겠다. 지금 상태에서 comfy.org도
>   쓸 수 있게. (배경: RunPod RTX PRO 4500 이 comfy.org 대비 느림 — 이미지 ~30초/장, i2v 8분+. comfy.org 는 이미지 ~5초.)
- **comfy-image/comfy-video config 에 `servers[]`·`activeServer` 추가**(DEFAULTS). 엔진은 무변경 — 여전히 baseUrl/cloud/apiKey
  를 읽음. servers 는 저장된 프로필 목록 `[{name,baseUrl,cloud,apiKey}]`, 선택 시 그 값을 live 필드로 복사(saveCfg).
- **⚙ ComfyUI 이미지/비디오 모달에 「서버」 드롭다운** 추가(워크플로 드롭다운과 동일 패턴): 프로필 선택→주소·클라우드·키 한 번에
  전환, 💾저장(현재 설정을 이름 붙여 프로필로), 🗑삭제. App.jsx pickComfyServer/saveComfyServer/removeComfyServer(+Cvid 짝).
- **홈 config 두 개에 프로필 2개 선주입**: RunPod(cloud:false, `02kqro91c1m3q7-8188.proxy.runpod.net`) · comfy.org(cloud:true,
  cloud.comfy.org + apiKey). activeServer=RunPod. → 앱에서 드롭다운만 바꿔 comfy.org↔RunPod 즉시 전환.
- ⚠ 앱 재시작 반영(라이트). deps 무변경. RunPod URL 은 파드별 — 파드 바뀌면 프로필 주소 갱신 필요.

## 🎬 LTX2.3 i2v 실사화 → Prompt Enhance(Gemma 증강) 자동 OFF (2026-07-22, v0.2.63)
> 증상: 이미지는 수채화로 잘 나오는데 i2v 영상은 사진처럼 실사화됨. 사용자 비디오 프롬프트엔 "실사" 단어 없음.
- **원인 2가지**: ① 비디오 프롬프트에 화풍 앵커(watercolor 등)가 0개 — i2v 디노이즈가 텍스처를 다시 그릴 때 붙잡을 말이
  없음. ② 워크플로 `Boolean (Enable Prompt Enhance)=true`(노드 320:328) → LTX 가 Gemma(LLM)로 프롬프트를 영화적으로
  재작성하며 realism 어휘를 얹음 → 화풍이 사진처럼 변질.
- **수정(방법 A, comfy-video.js `_buildGraph`)**: 그래프를 comfy 로 보내기 직전, `_meta.title` 이 "prompt enhance"류인
  PrimitiveBoolean 노드를 찾아 **value=true → false 강제**(우리 프롬프트 그대로 사용). UI 토글이 아니라 **전송 시 제어** —
  워크플로 파일 수정 불필요. 실제 워크플로(320:328)로 감지 검증 통과. deps 무변경, 앱 재시작 반영(라이트).
- ⚠ 이 블록은 작업트리에 미커밋 상태로 남아 있던 것(v0.2.56 발행 때 누락) — 이번에 커밋·발행. 남은 개선(방법 B):
  i2v 프롬프트에 이미지 스타일(수채화 앵커) 자동 앞붙이기(미적용).

## 🐞 중단 눌러도 '이미지 생성 중' 스피너 고착 + 전 그룹 동시 표시 → 정리 + 배치만 표시 (2026-07-22, v0.2.62)
> 증상: 중단 눌러도 여러 그룹 카드가 계속 `🖼 이미지 생성 중…` 스피너를 돎. + 만들 때 지금 만드는 그룹만이 아니라
>   전 그룹이 한꺼번에 '생성 중'으로 뜸(v0.2.58 은 comfy 경로만 1개씩 적용).
- **Bug 1(스피너 고착)**: 중단(`abort` IPC)이 `S.abort=true` 만 하고 그룹의 `imageStatus/videoStatus`('generating'·
  'upscaling')는 안 건드림. genspark/flow 배치는 만들다 만 그룹이 'generating' 에 남아 카드 스피너가 영원히 돎.
  - 수정: `clearGeneratingStatus()` 신설 — 전 큐(longform/shorts)·활성 파싱본의 모든 그룹을 훑어 'generating'→
    (자산 있으면 'done', 없으면 'idle'), 'upscaling'→동일 정리. abort 핸들러가 이걸 호출 + pushDtoUpdate. 어느 엔진
    경로(comfy·genspark·flow·업스케일)든 중단 즉시 스피너 해제.
- **Bug 2(전 그룹 동시 표시)**: `pipeline.js generateImagesGenspark` 가 시작 시 `idx.forEach(...imageStatus='generating')`
  로 **대상 전체(예 33장)를 한꺼번에** 표시. → 그 선표시 제거하고, **배치 루프에서 지금 제출하는 6장만** 'generating'
  표시(Genspark 는 한 번에 최대 6장이라 실제 동시 생성분 만큼만). 이전/이후 배치는 done/idle. finalize(444)가 남은
  'generating'→'fail' 로 정리하는 건 그대로. (comfy 경로는 이미 v0.2.58 로 1개씩 — 무변경.)
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🐞 큐 제작 시 이어받은 대본이 헤더 이미지·비디오 도구를 무시 → 헤더(큐 단위) 우선 (2026-07-22, v0.2.61)
> 증상: 헤더에서 ComfyUI Krea2 로 골랐는데, 큐의 두 번째 대본(작업본 이어받기)이 `🔄 이미지 순환: genspark→flow`
>   로 돌아감. 비디오도 같은 현상.
- **원인**: run-batch 가 `ie = (s.imgEngine!=null) ? s.imgEngine : common.imgEngine` — **항목 저장값(s) 우선, 헤더(common)
  폴백**(v0.2.46 "항목별 도구" 설계). 이어받기한 대본은 저장된 옛 imgEngine(rotate/genspark)을 들고 있어, 헤더에서
  comfy 로 바꿔도 그 값은 **그 시점 활성 항목에만** 저장되고 이어받은 항목은 옛 값으로 실행됨. videoEngine 도 동일.
- **수정(로이 결정)**: 이미지·비디오 **생성 도구는 헤더(공통=큐 단위) 우선**으로 뒤집음 — `ie = (common.imgEngine!=null)
  ? common.imgEngine : (s.imgEngine||'genspark')`, videoEngine 도 동일. "어느 서비스/GPU로 만드냐"는 큐 전체 공통
  선택이므로 헤더에서 한 번 고르면 큐 전 항목에 적용. (스타일·배속·AI고지·영상범위·채널은 그대로 항목별 유지.)
  렌더러는 이미 `common`에 헤더 imgEngine/videoEngine 을 실어 보내고 있었음(App.jsx:507 의도와 일치하게 정렬).
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🐞 X로 지운 이미지가 만들기 때 캐시에서 부활 + 중단인데 폴더 열림 (2026-07-22, v0.2.60)
> 증상 ① 그룹 이미지를 X로 지운 뒤 만들기 → 지웠던 그 이미지가 그대로 다시 들어옴. ② 중단 눌러도 완료된 것처럼
>   출력폴더가 열림.
- **Bug 1 원인(이미지 전용)**: `clear-asset`(X)는 `imagePath=null` 만 하고 미디어캐시는 안 지움 → `prefillImageCache`
  가 만들기 시작 시 같은 키(prompt+style+aspect+engine) 캐시를 찾아 옛 이미지를 복사해 넣음. (비디오는 `MC.get(videoKey)`
  prefill 자체가 없어 부활 안 함 — 안전.)
  - 수정: clear-asset 이미지 삭제 시 `g.imageCleared=true` + 저장해둔 `g._imgCacheKey` 로 캐시파일 `MC.del`.
    prefillImageCache 는 `imageCleared` 그룹 건너뜀. cacheGeneratedImages 는 새 이미지 캐시 시 key 저장 + 플래그 해제
    (재생성 후엔 재활용 허용). → 지운 그룹은 캐시 무시하고 새로 생성. 순서: prefill(skip)→생성→cache(플래그 해제).
- **Bug 2 원인**: `runMakeAllCore` 4단계 vrew·폴더는 이미 `if(!S.abort)` 로 중단 시 생략됨. 그러나 **run-batch(큐 제작)
  핸들러 끝의 최종 폴더열기 `shell.openPath(S.outRoot)` 가 중단 무관하게 항상 실행**됨.
  - 수정: `if (!S.abort) { shell.openPath(...) }` 가드 추가. 이제 중단 시 폴더 안 열림(vrew 는 원래 생략됨).
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🐞 큐 항목 전환 시 영상범위·배속·스타일·AI고지 초기화 → 항목별 값 보존 (2026-07-22, v0.2.59)
> 증상: 헤더 영상범위(vidFrom~vidTo)를 바꾸고 다른 롱폼 큐를 클릭하면 초기화됨(1번 파일 1~5, 2번 파일 1~3 불가).
- **원인 2개(둘 다 기본값 useEffect 가 applySettings 복원값을 덮어씀)**:
  ① 범위 기본값 effect(deps: dto.fileTitle·isLf·introSig·lastNum) — 항목 전환 시 dto.fileTitle 바뀌면 `setVidFrom(1)
     ·setVidTo(도입부끝/마지막)` 로 복원된 범위를 덮음.
  ② 프리셋/모드 기본값 effect(deps: presetName·mode·modeProfiles) — 채널이 다른 항목으로 전환 시 fire 되어
     `setTtsSpeed·setStyleId·setAiNotice` 를 프리셋 기본값으로 덮음(같은 채널 항목끼린 안 걸림).
- **수정(App.jsx, ref 가드)**: `hasStoredRangeRef`(항목에 저장된 범위 있으면 범위 effect skip)·`restoringItemRef`
  (복원 중이면 프리셋 effect 가 배속·스타일·AI고지 덮어쓰기 skip, 단 자막·분할은 채널값이라 무조건 적용). applySettings
  진입 시 두 ref set, **사용자가 채널 직접 선택(switchModeForChannel)·새 대본 열기(openScript)·모드 전환(switchMode)**
  때만 clear → 그때만 기본값 적용. → 항목별 범위·배속·스타일·AI고지가 큐 전환에도 유지됨. 빌드 통과.
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🖼 이미지 '생성 중' 스피너 — 만드는 그룹 카드에만 표시 (2026-07-22, v0.2.58)
> 요청: 배치 이미지 생성 시 "이미지 생성 중"이 안 뜨거나 엉뚱하게 떴음 → 실제로 그 순간 만드는 그룹 카드에만.
- 원인: `runComfyImages`(comfy 배치)가 그룹 생성 직전 `g.imageStatus='generating'` 을 안 켜고, 실패 시에도
  상태를 안 바꿔서 comfy 경로엔 스피너가 아예 안 떴음(빈 '+'). (UI App.jsx:2348 은 imageStatus==='generating'
  일 때만 `🖼 이미지 생성 중…` 오버레이 렌더 — regen-group 단건만 이걸 설정하고 있었음.)
- 수정(main.js runComfyImages 루프): 각 그룹 textToImage 직전 `imageStatus='generating'`+pushDtoUpdate,
  끝나면 성공 'done'/실패 'fail'+pushDtoUpdate. **순차 루프라 항상 1개 그룹만 'generating'** → 딱 그 카드에만
  스피너. 실패에도 해제해 고착 방지. (genspark/flow 는 6장 배치 병렬이라 '1개만'이 애매 — comfy 경로만 적용,
  사용자가 comfy Krea2 로 이전 중이라 실사용 경로.)
- ⚠ 앱 재시작 반영(라이트). deps 무변경.

## 🐞 TTS 동시 실행 → `TTS provider 'omnivoice' not available` 크래시 → TTS 직렬 큐 (2026-07-22, v0.2.57)
> 증상: 아내와 동시 작업(또는 한 사람이 🎤 그룹재생성 + 전체 TTS빌드 동시 클릭) 시 `tts G1 컷N`·`tts 롱폼 컷N`
>   이 번갈아 찍히다 `⚠ 컷N TTS 실패 — TTS provider 'omnivoice' not available` + 전체빌드의 `🗑 전체삭제`가
>   다른 작업 음성파일까지 지움.
- **원인(코드 확정)**: `tts/tts-manager.js` `getInstance()` 가 **모듈 싱글톤** 반환 → tts-build·tts-group·make-all·
  run-batch 가 **공용 TTS 매니저 하나를 공유**. 한 작업의 `refreshProvider`(provider stop+delete 후 재연결)·
  `mgr.stop()`(providers 맵 전체 clear)가 **동시에 도는 다른 작업의 provider 를 없애** → `synthesize` 가
  `providers.get('omnivoice')` 실패 → tts-manager.js:200 `not available` throw. (앱 내 동시 실행만 해당 —
  두 PC 는 각자 매니저라 무관, 서버 쪽은 이벤트루프 블로킹으로 이미 직렬이라 OOM 무관.)
- **수정(main.js)**: `enqueueImageJob` 패턴을 본떠 **`enqueueTtsJob(label, fn)` 직렬 큐** 신설(프로미스 체인 +
  대기 카운터). tts-build·tts-group·make-all·run-batch 네 핸들러를 전부 이 큐로 감쌈(여는 줄 `=> enqueueTtsJob(
  '…', async () => {` + 닫는 줄 `}))` — 본문 무변경). 한 번에 하나만 싱글톤을 건드림 → 충돌 0. 뒤 작업은 앞
  작업 끝나면 자동 실행(손실 0). 실패 격리(앞 작업 실패해도 다음 실행).
- **트레이드오프(수용)**: make-all/run-batch(긴 파이프라인)도 같은 큐라, 파이프라인 실행 중 클릭한 수동 🎤/빌드는
  파이프라인이 끝날 때까지 대기(`⏳ … 큐 대기` 로그로 가시화). 크래시·손실보다 훨씬 나음. 단위검증: 겹친 3작업이
  최대동시=1·A→B→C 순서·B실패에도 C실행 확인.
- ⚠ 설치본 반영은 **앱 재시작**(라이트 업데이트). deps 무변경.

## 🌡 OmniVoice 서버 GPU 온도 기록 로거 (2026-07-22)
> 요청: 동시 TTS 시 GPU 온도 급상승 우려 → 실제 온도를 기록으로 남기게. (GPU=메인 PC=OmniVoice 서버에만 있음)
- **위치**: OmniVoice 서버 `D:\Work\TTS_Engine\06_OmniVoice\api.py`(Priming 저장소 밖 — git/매니페스트 무관, **서버
  재시작 필요**). Priming 앱은 무수정. 의존성 추가 없음(nvidia-smi 서브프로세스, venv 무수정).
- **구현**: 별도 데몬 스레드가 3초마다 `nvidia-smi` 로 온도·전력·사용률·메모리·팬·클럭을 읽어 **작업 중일 때만**
  `logs/gpu_YYYYMMDD.csv` 에 기록(유휴 잡음 제외, 작업 종료 직후 1줄=쿨다운 시작점 포함). `_model.generate()` 가
  이벤트루프를 막아도 OS 스레드라 계속 측정됨. `/tts` 에 `active_tts` 카운터(inc/finally dec), `/gpu` 조회
  엔드포인트(현재값+오늘 피크). 문법·nvidia-smi 파싱·CSV 단위검증 통과.
- **실측 발견**: 부하 시 84°C·100%·150W(전력상한 이미 150)·팬 nvidia-smi상 0%. 팬 0%는 유휴 제로-RPM 모드거나
  nvidia-smi가 이 카드 RPM 미판독일 가능성 큼(부하 때 실물 팬 회전 육안확인 필요). 84°C는 RTX3060 사양(93°C)
  내 안전·스로틀 미발동. 전력상한은 이미 150이라 온도 저감 효과 없음 → 필요 시 팬 커브가 답.

## 🐞 LTX2.3 i2v — 사용자 이미지 대신 "이집트 여왕" 영상이 나옴 → 프롬프트·해상도·길이 주입 실패 (2026-07-21, v0.2.56)
> 증상: LTX2.3 비디오 생성 시 그룹 이미지가 아니라 LTX 샘플이미지(egyptian queen)가 i2v 되는 것처럼 보임.
- **실측 진단(클라우드 `/api/jobs` 로 실행된 그래프 회수 — 강력한 디버깅 수단)**: 이미지 업로드·주입은 구버전에서도
  정상이었음(실행 그래프 LoadImage=사용자 이미지 해시, `/api/view` 로 내려받아 육안 확인 = 조선 수채화).
  진짜 원인 = **프롬프트 미주입**: LTX 워크플로는 프롬프트가 PrimitiveStringMultiline("Prompt")→TextGenerateLTX2Prompt
  (Gemma 증강)→CLIPTextEncode(text=**링크**) 구조라, 구코드(CLIPTextEncode 리터럴만 주입)가 대상 못 찾고 **기본 프롬프트
  ("Egyptian royal in blue-and-gold headdress…" = 샘플이미지 묘사문)가 그대로 실행** → 2단계 i2v(2단 strength 0.7)+
  프롬프트 증강(EnablePromptEnh=true)이 영상 내용을 프롬프트 쪽으로 끌고 가 샘플이미지가 쓰인 것처럼 보임.
  해상도(1280×720 기본)·길이(5초 기본, TTS 무시)도 미주입이었음.
- **수정(comfy-video.js — 작업트리에 있던 미발행분 검증 후 발행)**: 프롬프트→문자열 Primitive("Prompt") value(네거티브
  제외), 해상도→Width/Height PrimitiveInt, 길이→Duration Primitive(초, 없으면 Length/Frames=프레임) 주입 + 업로드·큐
  진단 로그. 실워크플로 단위검증(이미지·프롬프트·1280×704·6초 주입 확인). `comfy/video_ltx2_3_i2v.json` 저장소 추가.
- **폴더명 이관**(D:\Priming-Maker→D:\Priming): 코드 폴백 경로(ace-step/qwen-design/lora-collect)·홈 설정파일
  (comfy-image-config·lora-collect·tts-presets scriptFolder)·문서(cd 경로) 갱신. GitHub 저장소명은 그대로(발행 무영향).
- ⚠ 사용자는 설치본(라이트 업데이트) 사용 — **발행 후 앱 재시작해야 반영**. 실행 그래프 확인법: `/api/jobs?limit=N` →
  `/api/jobs/{id}`.workflow.prompt (X-API-Key 헤더).

## 🐞 큐 만들기가 항목 이미지도구(comfy)를 무시하고 순환 실행 → 서버 it.settings 우선 (2026-07-19, v0.2.55)
> 증상: 이미지 도구를 ComfyUI Z-image 로 바꿨는데 「만들기(큐)」 시 Genspark→Flow(순환)로 만듦. workspace.json 의
>   큐 항목들은 모두 `imgEngine:"comfy"` 였음(서버 저장은 정상).
- **원인**: `set-queue-settings`(디바운스)는 서버 `it.settings` 만 갱신하고 **렌더러로 DTO 를 안 되돌림** →
  렌더러 `queue.items[].settings` 가 stale. run-batch 가 렌더러 plan 의 `entry.settings`(=stale, imgEngine 옛값)를
  써서 순환 실행. 서버 it.settings(comfy)는 무시됨.
- **수정**: run-batch 가 `const s = { ...entry.settings, ...it.settings }` — **서버쪽 it.settings(진짜 최신) 우선**.
  imgEngine 뿐 아니라 videoEngine·presetName·배속·스타일 등 항목별 설정 전부 최신값으로 실행됨.
- make-all(단건)은 헤더 state 를 직접 넘겨 무관(스테일 없음). 큐 경로만 영향.

## ⬆ 업스케일 중인 그룹 시각 표시 (2026-07-18, v0.2.54)
> 요청: 업스케일 시 어느 그룹 영상을 처리 중인지 화면에 보이게.
- maybeUpscale(main.js): 각 그룹 업스케일 전 `g.videoStatus='upscaling'`+pushDtoUpdate, 끝나면 'done'+pushDtoUpdate.
  로그도 `⬆ [i/N] G{num} 영상 업스케일 → WxH…` + 종료 `⬆ 업스케일 완료 (n/N)`.
- toDTO videoStatus 에 'upscaling' 추가(주석). App.jsx Thumb: videoPath 있고 videoStatus==='upscaling' 이면
  영상 썸네일 위에 genOv('⬆ 업스케일 중…') 스피너 오버레이(이미지 'generating' 오버레이와 동일 패턴).

## 🐞 서버 주소 오타(포트 중복·스킴 누락) → 자동 보정 (2026-07-18, v0.2.53)
> 증상: 로컬 GPU 이미지 `X ComfyUI 연결 실패 (127.0.0.1:8188:8188)` — 주소칸에 포트가 두 번 + http:// 누락.
>   ComfyUI 자체는 127.0.0.1:8188 정상 리스닝 중이었음(주소 오타가 유일한 원인).
- comfy-image/comfy-video 생성자 + set-tts-server: `trim` → 스킴 없으면 `http://` 자동 추가 →
  `(:\d+)(?::\d+)+$` 로 **꼬리 포트 중복 오타 접기**(`host:8188:8188`→`host:8188`). 실측 5케이스 통과.
- 사용자 설정파일(comfy-image-config.json)의 오타 값도 직접 교정. ⚠ PowerShell 로 JS 원라이너 테스트 시
  쌍따옴표 안 `$1` 이 PS 변수로 삼켜짐 — replace 콜백 검증은 bash 로.

## ⏸ 한도 배지 통계줄 앞 이동 + Grok 수동 버튼 쿨다운 스킵 (2026-07-18, v0.2.52)
> 요청: Genspark "7월 18일 오전 11:08에 재설정" 팝업 시 그 시각을 **capbar(분할·AI고지·⏱통계 줄) 맨 앞**에
>   "젠스파크 이미지 생성가능시간: 7월 18일 오전 11:08" 로 표시 + 순환이면 Genspark 건너뛰고 Flow 직행. Grok 도 동일.
- **이미 있던 것(확인)**: 한도 메시지 파싱→계정 쿨다운 기록(v0.2.19)·순환의 Genspark 무접속 건너뜀→Flow 직행,
  Grok 쿨다운 기록+make-all 3단계 생략(v0.2.30). 이번 팝업도 정상 기록돼 있었음(cooldowns.default=7/18 11:08).
- **바꾼 것**: ① 헤더 구석의 gsCool/grokCool 배지를 **capbar 맨 앞**으로 이동, 문구 "🖼 젠스파크 이미지 생성가능시간:
  7월 18일 오전 11:08"(fmtKoTime — 12시간제 한국어) / "🎬 Grok 비디오 생성가능시간: …". 60초 폴링·재시작 유지 그대로.
  ② **video-build/video-group**(수동 🎬 버튼)에도 grok/grok10 이면 grokCoolUntil() 스킵 가드 추가(브라우저 안 띄움) —
  기존엔 make-all 파이프라인에만 있었음. grok-api/comfy 는 쿨다운 무관(가드 제외).

## 🐞 ComfyUI 클라우드 체크 + LAN IP 혼합 → fetch failed → 클라우드면 항상 comfy.org (2026-07-17, v0.2.51)
> 증상: 아내 PC 이미지 `fetch failed` 연발. 로그 "클라우드(Krea2) … http://100.112.7.63:8188" = 클라우드 체크 켠 채
>   주소를 LAN(Tailscale) IP로 둠. 클라우드 방식(/api·X-API-Key)을 로컬 IP로 보내 실패. health()는 클라우드면
>   apiKey만 확인(실접속 X)이라 "연결 OK" 오탐.
- comfy-image/comfy-video 생성자: `cloud && localhost`일 때만 치환 → **`cloud && !cloud.comfy.org`면 항상 치환**.
  클라우드 체크 시 주소칸(로컬/LAN IP)과 무관하게 cloud.comfy.org 로. 혼합 오설정 원천 차단.
- 선택: **클라우드**=주소 무관·comfy.org(간단, 메인 PC 불필요) / **로컬 via Tailscale**=클라우드 해제+주소
  100.x:8188+메인 PC ComfyUI `--listen`+방화벽 8188(현재 미가동·규칙 없음).

## 🐞 워크플로 추가 시 `prompt() is not supported` — window.prompt → 이름 모달 (2026-07-16, v0.2.50)
> 증상: 아내 PC ⚙ ComfyUI ＋추가 시 `워크플로 추가 오류: prompt() is not supported`. (메인 PC는 설정파일 직접
>   기록이라 안 겪음.) 원인: pickComfyWf/pickCvidWf 가 `window.prompt()` 사용 — 일부 Electron 렌더러에서 미지원/예외.
- 프로미스 기반 **이름 입력 모달**(`askName`/`nameAsk`) 추가로 window.prompt 2곳 대체. Enter=확인/Esc=취소.
- 이 로그로 확인된 정상 동작: OmniVoice **Tailscale 연결됨**(tts 컷 생성) + ComfyUI **클라우드 연결 OK**.

## 🖧 TTS 서버 주소 설정 UI 추가 (다른 PC=Tailscale/LAN) (2026-07-16, v0.2.49)
> 배경: 아내 PC를 Tailscale 씬클라이언트로. OmniVoice 주소를 앱에서 바꿀 UI가 없어(설정파일만) 추가.
- IPC get/set/test-tts-server (tts-config setProvider). preload getTtsServers/setTtsServer/testTtsServer.
- 헤더 「🖧 TTS서버」 버튼 → 모달(OmniVoice·Supertonic baseUrl + 연결테스트). 이 PC에만 저장(~/.flow-app/tts-config.json).
- OmniVoice 는 방화벽 Private 규칙이 **Tailscale 인터페이스(Private)**까지 커버 → Tailscale IP(100.x)로 이미 접속됨.
  ComfyUI 는 클라우드가 다PC에서 더 간단(메인 8188 미가동). Voice Design(qwen-design)은 로컬 spawn 전용 — 원격은 추후 코드.
- ⚠ 다른 PC TTS 실패 주원인: OmniVoice 주소가 그 PC에서 안 닿는 IP. Public 프로필이면 방화벽 차단(Private로 바꾸거나 Tailscale).

## 🐞 TTS OmniVoice 콜드스타트(모델 재로딩) 연결 실패 → 재시도 창 확대 (2026-07-16, v0.2.48)
> 증상: 아내 PC에서 `omnivoice 미가동`. 그러나 브라우저로 `192.168.219.157:9881/health` = `{"status":"ok"}` (닿음).
- **원인**: 네트워크·방화벽 아님. OmniVoice 서버가 유휴 후 **모델 재로딩 중**(로딩 시 /health 503)이라 앱의 재시도 창
  (v0.2.41: 3회×5초 + 3초 타임아웃 ≈ 24초)을 넘김. 로딩 완료 후엔 200(그래서 브라우저는 정상).
- **수정**: makeTtsManager 재시도 **3→6회, 5→6초**(≈36초+타임아웃)로 콜드스타트(15~40초) 견딤. omnivoice init
  헬스 타임아웃 3→5초. 서버가 진짜 꺼져 있으면 연결거부는 즉시 실패라 최악 대기만 늘 뿐(수용).

## 🖼 Genspark 침묵 정체(무응답) 감지 → 추정 쿨다운·조기 Flow 전환 (2026-07-16, v0.2.47)
> 증상: Genspark가 한도 메시지 없이 조용히 정체(제출은 되는데 0장, 75초 정체 반복)해도 다음 이미지 가능시간이
>   표시 안 됨. 기존 표시는 명시적 "…재설정됩니다" 메시지 파싱에만 의존했는데, 이 경우 메시지가 안 뜸.
- pipeline `generateImagesGenspark`: 단건 재생성이 **연속 3장 무응답(비차단·비한도 실패)**이면 `limitReached='__STALL__'`
  세팅 후 조기 종료(배치 성공·단건 성공 시 카운트 리셋). → 남은 배치·단건 헛시도(장당 ~75초) 안 함.
- main run-batch genspark 분기: `'__STALL__'` 이면 **30분 추정 쿨다운** setCooldown + "침묵 정체(추정, 메시지 없음)" 로그
  → 순환이 즉시 다음 엔진(Flow)으로. genspark-cooldown 배지에 추정 시각 표시(앱 재시작해도 유지).
- 명시적 한도 메시지가 뜨는 경우는 기존대로 정확한 재설정 시각 파싱(무변경). ⚠ 추정이라 과부하로 더 빨리 풀리면 30분 뒤 재시도.

## 🐞 큐 항목 전환 시 이미지·비디오 엔진 초기화 → 항목별 도구 보존 (2026-07-16, v0.2.46)
> 증상: 다중 큐에서 "이 작업엔 이 도구, 저 작업엔 저 도구"를 지정해도 항목 이동 사이 엔진이 초기화됨.
- **원인 ①(UI 리셋)**: App.jsx applySettings 가 `imgEngine==='comfy'` 를 **`rotate` 로 강제 마이그레이션**(구 comfy 이미지
  제거 시절 잔재). comfy 이미지(z-image/Krea2) 부활했는데 이게 남아 있어, 항목 전환마다 comfy→순환으로 되돌리고
  디바운스 저장이 그 값을 **항목에 영구 덮어씀**(진짜 초기화). → 마이그레이션 제거(레거시 genspark/flow 단독만 rotate 로).
- **원인 ②(런타임 무시)**: run-batch 가 v0.2.24에서 **헤더(common) 엔진을 전 항목에 강제** 적용 → 항목별 도구가 실행 때
  무시됨. → **항목별 값(s.videoEngine/s.imgEngine) 우선, 헤더는 폴백**으로 변경(제거된 flow/wan/grok10 만 grok 보정).
- 이제 각 큐 항목이 자기 이미지·비디오 도구를 기억하고 만들기 때도 그대로 사용. 헤더 드롭다운은 **활성 항목의 도구를 편집**
  (디바운스로 그 항목에 저장). 모든 항목을 한 번에 바꾸는 건 각 항목 선택해 변경(추후 '전체 적용' 옵션 여지).

## 🐞 화면 검색(Ctrl+F) 프리징 — 타이핑마다 findInPage → 디바운스 (2026-07-15, v0.2.45)
> 증상: 검색 기능 쓰면 프리징. 원인: 검색 input onChange 가 **글자마다** `find-in-page` 호출.
- Electron `findInPage` 는 호출당 전체 DOM 스캔+강조인데, 화면이 대본 수십 컷+영상 수십 개라 DOM 이 거대 →
  타이핑 한 글자마다 풀스캔이 연달아 큐잉돼 렌더러가 밀려 멈춤.
- **수정**: `runFind` 에 디바운스 — 타이핑(findNext=false)은 280ms 멈춘 뒤 1회만, Enter/화살표(findNext=true)는 즉시.
  `findTimerRef` 로 이전 타이머 취소. closeFind 도 타이머 정리. (검색어 지우면 즉시 stopFindInPage)

## 🗂 채널 드롭다운 그룹 구분선 (2026-07-15, v0.2.44)
> 요청: 채널이 많아질 예정 → 구분자(-----)로 구분. 결정: **그룹 이름으로 자동 구분**(사용자 선택).
- preset 에 `group` 필드 추가. listPresets·save-preset 반환에 group 포함. ⚙ 채널편집 모달에 **「그룹(구분)」 입력란**
  (datalist 로 기존 그룹 자동완성) → saveChannel patch 에 group.
- 헤더 채널 드롭다운: group 별로 묶고 그룹마다 `──── 그룹명 ────` **disabled option 구분선**(선택 불가) + 그룹 내
  채널은 앞에 전각공백 들여쓰기. 그룹 없는 채널은 맨 위에. 빈 그룹이면 구분 없이 그대로.

## ✏ 채널(프리셋) 이름 변경 기능 추가 (2026-07-15, v0.2.43)
> 요청: 채널명을 수정할 방법이 없었음(추가·삭제만 있었음).
- IPC `rename-preset({oldName,newName})` — preset id 유지, name 만 교체. 중복·빈이름 방어. 현재 세션 큐 항목
  `settings.presetName`·활성 `S.preset.name` 도 옛→새 이름으로 갱신(참조 깨짐 방지). preload `renamePreset`.
- ⚙ 채널편집 모달 상단에 **채널 이름 입력란** 추가. `saveChannel` 이 origName(`ch._raw.name`)과 다르면
  renamePreset 먼저 호출 후 새 이름으로 savePreset. 저장 시 presetName state 도 새 이름으로.

## 🐞 큐 만들기 시 완료(done) 항목 재작업·vrew 재열림 → 완료 건너뜀 (2026-07-15, v0.2.42)
> 증상: 완료(86·88)·실패(87)·진행중(89)·대기(90) 섞인 큐에서 「만들기」 → 완료된 86·88도 다시 만들고
>   그 .vrew 를 또 엶. 게다가 완료된 60컷+영상 대본으로 활성 전환·재렌더·vrew 재열기까지 겹쳐 앱이 잠깐 멈춤.
- **원인**: run-batch(main)·plan 빌드(App.jsx)가 큐의 **모든** 항목을 status 무시하고 재실행.
- **수정**: ① App.jsx plan 빌드에서 `status==='done'` 항목 제외(정확한 개수·미전송) ② main run-batch 에서도
  `it.status==='done'` 이면 활성전환/실행/ vrew 재열기 없이 스킵(`⏭ 이미 완료 — 건너뜀`, 안전망). 종료 로그에 `완료건너뜀 N`.
  → 완료 대본(60컷+영상) 재렌더·vrew 재열기가 사라져 만들기 시 멈춤도 크게 완화. 모두 완료면 "만들 대본이 없습니다".
- done 은 워크스페이스에 유지(재시작해도 완료 스킵). 진짜 다시 만들려면 그 큐를 지우고 다시 열기.

## 🐞 큐에서 TTS 서버 순간 미응답 = 대본 통째 스킵 → 재시도 추가 (2026-07-15, v0.2.41)
> 증상: 5개 큐 중 87회만 실패 — `TTS 엔진 'omnivoice' 미가동`. 직후 88·89회는 정상 연결.
- **원인**: `makeTtsManager`(pipeline.js)가 대본 시작마다 `refreshProvider`→OmniVoice `/health`(3초 타임아웃) **1회**만 확인.
  직전 86회의 대형 작업(TTS 983초+비디오 2418초, 중단) 직후 LAN OmniVoice(192.168.219.157:9881) 서버가 부하 회복/모델
  재로딩 중이라 그 **3초 창**을 놓침 → 재시도 없이 그 대본 실패 처리(`다음 대본 계속`). 일시적(88·89회 즉시 정상)이었음.
- **수정**: `makeTtsManager(logger, engine, opts)` 에 재시도 추가 — 실패 시 5초 간격 **3회** 재연결 후에만 미가동 판정.
  모든 호출 경로(make-all·run-batch·tts-build·tts-group) 공통 적용. gemini(키기반)는 즉시 성공/실패라 영향 미미.
  interactive 단건에서 서버가 진짜 꺼져 있으면 ~18초 대기 후 실패(수용 가능), 배치 무인 실행은 blip 견딤.

## 🐞 일괄첨부 시 앱 멈춤 — media:// 프로토콜 동기 파일읽기 → 스트리밍 (2026-07-15, v0.2.40)
> 증상: 대본 선택 후 「📎 일괄첨부」로 여러 영상 첨부하면 프로그램이 멈춤(freeze).
- **원인**: `protocol.handle('media')` 가 파일을 **동기**(`fs.readFileSync`/`fs.readSync`)로 통째 읽음(main.js:242).
  영상 `<video>` 요소는 초기 로드 때 `Range: bytes=0-`(=전체)로 요청 → **206 분기도 파일 전체를 동기 읽기**.
  일괄첨부로 여러 영상 썸네일이 동시에 media:// 를 요청 → **메인 프로세스가 동기 I/O 에 줄줄이 묶여 IPC 응답 불가 = 앱 전체 멈춤**.
  (큰 mp4 여러 개 = 통째 버퍼 할당까지 겹쳐 메모리 급증.)
- **수정**: `fs.createReadStream` + `require('stream').Readable.toWeb(...)` 로 **비동기 스트리밍** 응답(206/200 양쪽).
  파일을 통째 메모리로 안 올리고 청크로 흘려보냄 → 동시에 여러 영상이 로드돼도 메인 프로세스가 안 멈춤.
  Electron 33(Node 20)에서 `Readable.toWeb` + protocol.handle 스트림 바디 지원. 자막·미리보기 재생도 동일 경로라 함께 개선.
- ⚠ bulk-attach 는 g.videoPath 를 **원본 선택 경로**로 지정(미디어폴더 복사 안 함) — 파일을 지우면 끊김(현행 유지, 별도).

## 🎬 ComfyUI i2v 비디오 엔진 (Wan 2.2 5B / LTX · 로컬·클라우드) 추가 (2026-07-15, v0.2.38)
> 요청: Grok API 무료크레딧 불가+건당 과금 → ComfyUI i2v 로 전환. 사용자가 `D:\Priming\comfy\video_wan2_2_5B_ti2v.json`
> 다운(일단 comfy 클라우드). 이미지 comfy 경로(comfy-image.js)를 비디오용으로 확장.
- **엔진** `core/comfy-video.js`(구 comfy-engine.js i2v 로직 이식): `/upload/image` 로 그룹 이미지 업로드 →
  워크플로 LoadImage.image=업로드명. **LoadImage 없으면 자동 주입** → i2v latent 노드(class_type ~/ImageToVideo/)의
  `start_image` 에 연결(이 Wan JSON 은 LoadImage 미포함이라 필수). 프롬프트(Positive CLIPTextEncode, Negative 회피)·
  길이(초→`length`=4n+1 프레임, fps·videoMaxSec 반영)·해상도(비율)·seed 주입 → /prompt → 폴링 → /view 다운로드(webm→mp4 ffmpeg).
  로컬(/history)·클라우드(cloud.comfy.org /api + X-API-Key + extra_data.api_key_comfy_org, /job/{id}/status→/jobs/{id}) 양쪽.
- **설정** `~/.priming-maker/comfy-video-config.json`(이미지 comfy 와 별개): baseUrl·cloud·apiKey·workflows[]·workflowPath·
  fps(24)·videoMaxSec(8, 0=제한없음)·sendDims·timeoutSec. IPC get/set-comfy-video-config·pick-comfy-video-workflow·test-comfy-video.
  초기값 직접 기록(cloud=true, 이미지 config 의 apiKey 복사, Wan2.2 5B 등록).
- **비디오 드롭다운**: Grok(브라우저)/Grok API(유료)/**ComfyUI: <워크플로>**(value `comfy::<path>`)/없음. comfy 선택 시 「⚙ ComfyUI」 →
  설정 모달(로컬·클라우드/키/워크플로 추가·전환/최대길이·fps/타임아웃). main `runComfyVideos`(이미지 있는 그룹만 i2v,
  duration=그룹 TTS초, 출력 media-N/NN.mp4) + `genGroupVideos` 디스패치(grok-api / comfy[::path] / 브라우저 Grok).
- comfy 는 브라우저 아님 → grokVideoPipeline=false → make-all 순차 3단계 실행. 저장된 videoEngine 정규화에서 'comfy' 제외 유지.
- ⚠ **실측 필요**: ① comfy.org 클라우드가 `/api/upload/image`(i2v 소스 업로드)를 받는지 ② Wan22ImageToVideoLatent 에
  start_image 자동주입이 실제로 먹는지(안 되면 ComfyUI 에서 Load Image→start_image 연결 후 API 포맷 재저장) ③ 클라우드 length·해상도 한계.

## 🎬 Grok Imagine 비디오 API (image→video, 브라우저 없이) 추가 (2026-07-15, v0.2.36)
> 요청: "비디오에서 Grok api를 이용할수 있도록 해줘". 브라우저 Grok(SuperGrok 구독, 주간한도)과 별개의 **유료 사용량 과금** API.
- **엔진** `core/grok-api.js`: xAI 공식 REST. 제출 `POST https://api.x.ai/v1/videos/generations`
  (`Authorization: Bearer <키>`, body `{model:'grok-imagine-video', prompt, image(base64 data URI), duration(1~15), aspect_ratio, resolution:'720p'}`)
  → `{request_id}` → 폴링 `GET /v1/videos/{id}` (3초 간격, ≤7분) → `{status: done|pending|failed|expired, video:{url}}` →
  `video.url` 다운로드. `generateVideo`(url) / `generateVideoToFile`(mp4). 키=secret-store `'xai'`.
- **비디오 엔진 드롭다운**: `Grok (브라우저)` / **`Grok API (유료)`**(value `grok-api`) / `없음`. grok-api 선택 시 「⚙ 키」 버튼 →
  xAI 키 입력 모달(console.x.ai 발급 안내). IPC `get-xai-key`/`set-xai-key`.
- **디스패치**: main.js `genGroupVideos(pr, mediaDir, onlyNums, videoEngine)` — `grok-api`면 `runGrokApiVideos`(이미지 있는 그룹만
  i2v, prompt=videoPrompt‖motionNote‖기본, duration=그룹 TTS초 clamp1~15‖6, 출력 media-N/NN.mp4, 성공 g.videoPath·실패 g.videoStatus='fail'),
  그 외는 기존 `P.generateHookVideosGrok`(브라우저). video-build·make-all 3단계·video-group 3곳이 이 래퍼 사용.
- grok-api 는 브라우저가 아니라 **파이프라인/쿨다운 제외**(grokVideoPipeline=false → _grokCool=0, videoPipeline=false) →
  make-all 에서 순차 3단계로 실행. 429는 사용량/결제 한도로 중단(브라우저 주간한도 쿨다운과 무관).
- ⏳ **실측 필요**: ① `image` 필드 형식(base64 data URI 로 보냄 — 공식 문서 명시 약함, 실패 시 로그의 `xAI 4xx:` 응답 보고
  URL 방식/필드명 조정) ② 폴링 응답 실제 shape(status/video.url) 확인. xAI 키+결제 설정 후 영상 1개로 검증.

## 🖼 Flow 계정 라운드로빈 + 한도 판정 계정별로 (2026-07-14, v0.2.20)
> 증상: 그룹 단건 재생성마다 항상 같은(첫 가용) Flow 계정만 사용 → 한 계정에 시도 집중.
>       "일일 한도 50회 초과 (현재 92회)" 경고는 **모든 계정 합계**(anti-detect todayCount) 기준이라 오해 유발.
- **라운드로빈**: flow-accounts 에 `lastUsedId` 저장(markUsed 시) + `pickNext(excludeIds)` —
  마지막 사용 계정의 '다음'부터 available(캡·쿨다운 통과) 계정 선택. runFlowImages nextAcc 가 pickNext 사용.
  단건 재생성 연타 → 계정 1→2→3→4→1… 분산 (단위검증: 순환·제외·캡소진·쿨다운 4케이스).
- **한도 판정 계정별**: anti-detect checkDailyLimit/beforeNextGeneration 판정을 todayCount(전역)에서
  **profileCount(현재 계정 성공 장수)** 기준으로. 메시지 "이 계정 N회 · 오늘 전체 M회" 병기.
  flow-engine 로그도 동일 표기. stop 모드가 멀쩡한 계정을 차단하던 여지 제거.
- ⚠ anti-detect profiles 카운트는 '성공 장수'(registerGenerationSuccess) — 시도 카운트 아님(사용자 정책).

## 🖼 이미지 한도 쿨다운 기억 + 재생성 직렬 큐 (2026-07-14, v0.2.19)
> 증상 ① 그룹 단건 재생성마다 한도 걸린 Genspark 에 접속→제출→한도 확인→Flow 폴백(시간 낭비)
>      ② 재생성 진행 중 다른 그룹 생성 클릭 → 같은 브라우저를 잡아 먼저 작업이 죽음("Target page ... closed")
- **한도 쿨다운**: genspark 한도 메시지("…7월 14일 오후 3:39에 재설정됩니다")에서 재설정 시각 파싱
  (`parseLimitResetTime` main.js — 파싱불가/오파싱(24h 초과)은 지금+60분) → `accounts.js setCooldown/cooldownUntil`
  (계정별, `~/.priming-maker/genspark-accounts.json` cooldowns) → activeAccounts/pickActive 가 쿨다운 계정 제외
  → 순환이 접속 시도 없이 "⏭ Genspark 건너뜀(재설정 HH:MM 이후)" 로그 후 다음 엔진 직행.
  pipeline.js limitReached 가 bool 대신 **감지 메시지 문자열**을 담아 반환(파싱용, truthy 호환).
  ⚠ 한도 후 첫 1회는 여전히 접속함(감지해야 시각을 앎) — 그 1회가 쿨다운을 기록.
- **직렬 큐**: main.js `enqueueImageJob` — regen-group·image-build 를 하나의 promise 체인으로 순차 실행.
  뒤 클릭은 "⏳ 큐 대기 (앞에 N건)" 로그 후 자기 차례에 실행. 앞 작업 실패해도 다음 실행(체인 유지).
  검증: 순차성·실패격리·반환값 단위테스트 + 쿨다운 스토어/파서 단위테스트(실메시지 7/14 15:39 정파싱) 통과.
- make-all 의 이미지 단계는 큐 미적용(범위 밖 — 필요시 추후).

## 📖 러닝헤드 — 장 시작 페이지 밑줄 제거 + '제N회' 뒤 공백 (2026-07-13, v0.2.15)
> 요청: ① 회차 시작 페이지의 헤더 밑줄(글자 없이 떠 있는 줄) 제거 ② 러닝헤드 "제16회여포의…"→"제16회 여포의…"
- **② 공백**: `string-set: chapter-title content()` 를 h2 에서 뽑으면 h2 가 `<span.ch-no>제16회</span>여포의…`
  로 쪼개져 사이 공백이 사라짐 → 장마다 **숨김 앵커** `<span class="ch-rh">${c.title}</span>`(display:none)
  를 h2 앞에 두고 거기서 string-set. 원문(공백 포함) 그대로 러닝헤드에 들어감.
- **① 밑줄**: vivliostyle 은 **내용이 비어도 @top-center 의 border-bottom 을 그림**(실측) → first-except 로
  글자만 비는 장 시작 페이지에 '떠 있는 줄'이 남았음. `page: chapstart` 로 그 페이지만 명명하려 했으나
  **h2 에 page 를 주면 강제 개행으로 제목만 홀로 떨어짐**(제목+리드+본문 분리 = 실패, 폐기).
  → **해결: 밑줄을 상자 테두리(border-bottom)가 아니라 '글자 밑줄'(text-decoration:underline +
  text-underline-offset:5pt + color #ccc)로** 변경. 글자가 있을 때만 그려지므로 장 시작 페이지(글자 빔)엔
  자동으로 안 나옴. 계속 페이지엔 러닝헤드 글자 밑에 밑줄. 정렬(짝=왼/홀=오 바깥)·간격 유지.
  ⚠ 부작용: 밑줄이 판면 전폭이 아니라 **글자 폭에 맞음**(러닝헤드가 길어 실제론 거의 전폭). headerLine 옵션 유지.
- 실측: 장시작 p9 밑줄 없음 / 계속 p10·p11 러닝헤드+밑줄 정상 / 쪽수 안 늘어남(제목 안 떨어짐). 테스트 4종 통과.

## 📖 미리보기 목차 쪽번호 '??' 최종 해결 — 캐시버스터 폐기, 조판마다 새 파일명 (2026-07-13, v0.2.14)
> 증상: 앱 미리보기에서만 목차 쪽번호가 전부 `??`(CLI PDF 는 정상). v0.2.10 의 '#t='→'?t=' 수정으로도 미해결.
- **원인(iframe 실측)**: previewUrl 에 `?t=<ts>` 쿼리 캐시버스터 → CoreViewer 로드 URL 은 쿼리 포함인데
  vivliostyle 이 목차 `#ch-N` href 를 절대화한 값은 **쿼리 없음** → 같은문서 판정 실패 → 외부 문서 취급
  → target-counter 해석 포기 = `??`. **URL 에 쿼리든 프래그먼트든 붙이면 깨진다.**
- **수정**: main `book-preview` 가 조판마다 `_preview/book-<Date.now()>.html` **새 파일명**으로 저장
  (기존 book*.html 삭제) + BookView 는 쿼리 없이 URL 그대로 로드 — 새 URL 이라 캐시 무효 + anchor 일치.
  수정 후 href 가 `#viv-id-…` 내부 anchor 로 정상 변환, 쪽번호 실측(11/17/23/…).
- 미리보기 목차 번호는 표지 안내 페이지(미리보기 전용) 때문에 PDF 보다 +2 — 미리보기 하단 폴리오와는
  일치(자기일관), PDF 는 정확. book-ui.smoke 에 「목차 ?? 회귀」 단언 추가. 테스트 4종 통과.

## 📖 판권 [자유문] 중복 제거 — 표는 메타, 고지문만 자유문 (2026-07-13, v0.2.13)
> 증상: 사용자가 [판권] 섹션에 판권 전체(제목·원작·편역·펴낸이·펴낸곳·초판발행·ISBN·ⓒ)를 산문으로
>   다시 써넣으니, 상단 `> 메타`로 만든 자동 표 + 그 자유문이 **둘 다** 나와 발행일·ISBN·저자가 중복 인쇄.
- **결정(사용자 확정, Option 1)**: 표는 `> 메타`로 자동 생성, [판권] 자유문은 **표에 없는 고유 정보(고지문)만** 남김.
- **구현**(html-builder colophonHtml): `filterColophonSection` — [판권] 각 문단을 줄 단위로 훑어
  `colophonLineRedundant` 가 **표·제목·ⓒ에 이미 있는 줄**이면 버림. 규칙 = ① 제목/부제 재기술 ②
  `ⓒ/©`(author·translator·copyright 있으면 — 하단 cp-legal 자동) ③ `라벨+값`(원작·지은이·편역·펴낸이·
  펴낸곳·발행일/초판·ISBN·정가·부가기호·주소·전화·이메일 등)이 **해당 메타가 실제로 채워져 있을 때만**.
  → 메타에 없는 고유 정보는 보존(무손실). ⚠ 정규식 `\b` 는 한글 경계 미인식 → 초판/발행 라벨은 `\s+` 사용.
- 검증: 천하대란 원고(자유문에 전부 재기술) → 표 + 고지문 2줄(편집저작권·AI활용)만, 되풀이 8줄 제거.
  고전의뜰 목표 원고(고지문=문장뿐) → 5문장 전부 보존(안 걸림). 테스트 4종 통과.
- ⚠ **G: 원고는 Google Drive 스트리밍** — 동기화 중이면 읽을 때마다 옛/새 버전이 오락가락(파싱은 새 내용,
  PDF 는 옛 내용으로 나온 원인). 검증 땐 로컬로 스냅샷 후 작업. [[gpu-server-ollama-architecture]]

## 📖 출판 조판 = 목표 최종본 정합 (2026-07-13, v0.2.11)
> 기준: 사용자 확정본 `G:\...\02_출판용\POD_최종\[POD] 원고_고전의뜰 삼국지_01.pdf`(구 앱 산출, 208쪽 A5).
> 원고 = `02_출판용\출판_삼국지_1권_부속물.md` + `출판_삼국지_제NNN회.md`(구 앱 형식). 실측 재현 완료.
- **파서 강화(구 앱 회차파일)**: detectBookFileKind 에 `# 제N회` 우선 판정(내부 `## [목차]` 마커에 속아
  native 오판하던 것) · normalizeChapterFile 이 헤딩 전 평문 `라벨: 값`(META_KEYS)을 `>` 메타로,
  구 마커(`# [목차]` 등) 제거, 짧은 첫 평문 → `## ` 승격 · normalizeEssentialFile 은 비예약 H1 도
  `## [이름]` 커스텀 섹션으로(lastZone 상속: 에필로그 뒤 '다음 이야기' = back).
- 🔴 **인용으로 새던 메타**: 장 헤딩 아래 `> 플랫폼: 교보` 류(연속 여러 줄이 한 quote 로 병합)가
  본문에 인쇄되고 **장의 첫 블록을 차지해 리드문(*이탤릭*) 감지까지 깨뜨림** → quote 의 전 줄이
  META_KEYS 매칭이면 통째로 meta 흡수(기존값 우선). 리드문 중앙 배치 복구.
- **편역 라벨**: META_KEYS 에 편역/편역자/편역이/번역/엮은이 → translator + **translatorLabel('편역이') 보존**.
  판권 행 라벨·속표지(`N 편역`)·ⓒ 저작권자(translator 우선 — 편역서 편집저작권) 모두 반영.
- **목차**: 본문 장(제N회)만 + flex 점선 리더 + target-counter 쪽번호 — 목표본과 동일(13/29/45/…).
- **장 표제**: `제N회`(윗줄 .ch-no)/제목(아랫줄) 2줄 중앙, 위 16% 여백. 문단간격 기본 5pt.
- **판권**: 앞 판권(판권위치=앞)은 **속표지 뒷면(verso)** — cp-front 의 break-before recto→page.
  하단 배치 = `.cp-wrap margin-top 44%`(⚠ %마진은 판면 **너비** 기준; flex height:100% 하단정렬은
  vivliostyle 조각화에서 미해석이라 폐기). 라벨 min-width 제거(라벨 바로 뒤 ｜). **[판권] 자유문은
  flushPara 가 개행 보존**(`join('\n')` + cp-notes p pre-line) — 고지문 줄 단위 조판.
- 테스트 4종 통과(parser 44단언 · multi 260쪽+ePub · pdf 39쪽+표지 · UI E2E). deps 0a1409dd 유지(라이트 업데이트 OK).
- ⏳ 발행일·출판등록·주소·ISBN·가격·QR 은 원고에 없으면 빈 행 생략 — 앱 책정보 폼 입력 시 목표본과 완전 동일.

## 📖 출판(POD) 실입고 점검 — 표지검증 사각·바코드 규격·판형 불일치 수정 (2026-07-12, v0.2.6)
> 실제 부크크/교보POD 입고 전 전수 점검(테스트 4종 + 멀티에이전트 감사 20건 → 검증 후 반영). 수정 후 4종 재통과.
- 🔴 **표지 치수 검증이 죽어 있었음**: readImageSize 는 `{w,h}` 반환인데 book-attach-cover·epub
  cropFrontCover 가 `dim.width` 를 읽어 **검증·크롭이 한 번도 실행된 적 없음** → dim.w/h 로 수정.
  표지 첨부 필터에서 TIFF 제거(Chromium 렌더 불가 → 빈 표지 인쇄 위험).
- **판형 폴백 통일**: html-builder(내지)가 미등록 판형이면 A5, main(표지·책등)은 플랫폼 기본으로
  제각각 폴백 → 내지/표지 판형 불일치 입고거절 위험. main 과 동일식(TRIM_SIZES 검증)으로 통일.
- **바코드 GS1 규격화**: 표지 자동조판 svg 폭 32mm 고정 → 부가기호(EAN-5) 포함 시 배율 ~57%(스캔불가).
  모듈수×0.264mm(80% 배율)로 동적 계산(부가기호 포함 ≈45mm) + 바높이 200px + quiet 11모듈.
  ISBN 하이픈 병기는 사용자 입력 표기 우선(한국 발행자번호 2~6자리 가변). 체크섬 오류 시 무경고→경고.
- **빌드시 표지 재검증**: 첨부 후 쪽수가 변해도 재검증 없이 object-fit:fill 스트레치되던 것 →
  book-build-pdf 가 최종 스프레드로 validateCoverImage 재실행+경고. 표지 실패가 '완료'로 보이던 것
  → coverError 반환+BookView 구분 표시. [판권] 섹션 부재 시 경고(법정 기재사항 누락 방지).
- **UI 안전망**: 미리보기 실패 시 '조판 중…' 고착 해제, 표지가이드/바코드 저장실패 통보, 쪽수 미확정
  (책등 0mm) 상태에서 가이드 생성 차단, 원고 전환 시 lastPagesRef 리셋, ePub 쪽수미확정 크롭 생략.
- 남은 개선(미적용·제안): 표지만 재생성 버튼(현재 내지 선행 필수), spine ratio 허용 1%→mm 환산 경고.

## 🧹 코드 정비 — ComfyUI 완전 제거·BGM ACE-Step 이관 (2026-07-12, v0.2.3)
> 전수 감사(IPC 사슬·죽은 코드·낡은 문구) 후 확정분만 반영. IPC main↔preload↔renderer 115:115 일치 확인.
- **BGM 3.5단계 → ACE-Step 독립 서버**(core/ace-step.js, 플리 음악과 동일 경로): 기존엔 comfy-engine
  textToAudio(127.0.0.1:8188)로 가서 **항상 "음악 서버 연결 실패"로 죽던 상태**를 해소. 생성 중
  `S.musicActive` 뮤텍스(TTS·보이스디자인 차단), 출력 `bgm_*.wav` → loopAudioTo. resolveBgmPath 폴백이
  `.wav` 도 잡도록 확장.
- **ComfyUI 흔적 완전 제거**: comfy-engine.js·core/comfy-config.js **파일 삭제**(참조 0 확인),
  get/set/test-comfy IPC + preload API + ⚙ Comfy 모달(도달 불가 죽은 UI 4천자) 제거.
  ENGINE_META 의 comfy 항목, "(ComfyUI는 순환과 별개)" 등 낡은 문구 정리.
- **가드 보강**: `tts-group`(그룹 단건 재변환)에 gpuBusyReason 뮤텍스 추가(음악/디자인 중 차단).
- **잔재 정리**: 채널편집의 ch.gemini/gkey 데이터 배관(UI 필드는 이미 제거됨), runTts 의 사장된
  force 파라미터(구 '다시 변환' 전용), make-all 1·2단계 주석의 "로컬 ComfyUI 순차" 서술 갱신.
- ⚠ 남은 것: ace-step/qwen-design 폴더의 venv 는 로컬 전용(매니페스트·git 제외). BGM 이 이제
  ACE-Step 를 쓰므로 첫 BGM 생성 시 모델 로딩(~30초) 후 곡 생성. 미설치면 "BGM 없이 진행" graceful.

## 🎞 프리미어 XML 3종 수정 (2026-07-04, v0.1.79)
- **오디오**: `s.ttsAudioPath` 가 캐시/임시 경로면 프리미어가 엉뚱한 파일을 물거나(존재 시) 조용히 건너뜀(부재 시 무음).
  → `buildPremiereXml(a.ttsDir)` 로 **tts-N 폴더 정본(`<num>.mp3/wav`) 우선** 참조 + 못 찾으면 컷 번호 경고 로그.
- **이미지**: Premiere 는 스틸을 원본 픽셀 그대로 배치(1376×768 → 화면에 안 참) → 파일 실치수(readImageSize, **{w,h} 반환** 주의)
  + `Basic Motion` scale 키프레임(xmeml)로 **cover 배율 → ×1.1 켄번스**(그룹 홀짝 줌인/줌아웃).
- **자막**: export-premiere 가 XML 옆에 `_premiere.srt` 동시 생성(Premiere 캡션 가져오기용, captionMaxChars 반영).

## 🎵📖 BGM .vrew 삽입 확정 + 발음사전 UI + 그룹TTS 재변환 + BGM표시 (2026-07-04, v0.1.73)
- 🐞 **BGM 이 .vrew 에 안 들어가던 문제 해결 — 수동 삽입 .vrew 샘플 분석으로 형식 확정**:
  Vrew BGM = ① `files[]` 에 `sourceFileType:'BGM'` 파일 + ② `props.tracks[tid]` 에 **`type:'bgm'`** 트랙
  (`fade:{in,out}`, `loop:true`, `sourceOut=파일길이`) + ③ `props.assets[aid]={trackIds:[tid],role:'sub'}` +
  ④ **그 aid 를 전 clip 의 assetIds 에 추가**(수동샘플 실측: 731 clip 전부 참조). ①②③④ 다 있어야 Vrew 가 BGM 렌더.
  ⚠ v0.1.73 에서 ③④(asset·clip링크)를 "전역이라 불필요"로 오판해 제거 → 트랙만 있고 asset 없어 **안 들림**.
  v0.1.77 에서 asset + 전 clip 링크 복원(zip 오디오는 `.mp3` 그대로, TTS 와 동일해 Vrew 로드 OK). 볼륨 0.15.
- 🎤 **그룹 TTS 재변환("🎤")이 같은 음성 나오던 문제**: `tts-group` 이 force 없이 호출→기존 음성 건너뜀 + seed 고정.
  → `fillTtsList(...force=true)` + **seed 매 클릭 랜덤화**(같은 seed=결정적 동일). 매번 새 take 로 뽑힘.
- 📖 **발음사전 UI 추가**(백엔드 omnivoice-dict-store 는 이미 있음, UI 만 없었음): IPC `dict-list`/`dict-save`(+
  tts-manager.invalidateDict) + preload + 「📖 발음사전」 모달. entry `{source,pron,enabled}` — **자막은 대본 그대로,
  TTS 만 교정**(applyOmniVoiceDict 가 synthesize 전 치환). 예: 정약용→정냐굥. 저장 후 TTS 재변환해야 반영.
- 🎵 **BGM 프롬프트 표시**: toDTO 에 `bgmMood`(대본 지정) + `bgmUsed`(실제 사용 무드, 생성 후) → 첫 그룹 카드에
  「🎵 BGM:」 줄 + 복사 버튼(bgmOn 일 때).

## 🧹 엔진 단순화 — Krea2·LTX·Wan·Flow영상 제거 (2026-07-04, v0.1.71)
> 사용자 요청: 이미지·영상 엔진을 브라우저 기반만 남기고 ComfyUI 이미지/영상 엔진 제거. **ACE-Step 오디오(플리·BGM)는 유지.**
- **이미지 엔진** = `순환(Flow+Genspark)` 하나만. `comfy`(Krea2_Turbo) 옵션·`runComfyImages`·순환 루프의 comfy 슬롯 제거.
  UI 드롭다운 → 「이미지: 순환」 라벨 + ⚙ 순환 버튼만.
- **영상 엔진** = `Grok` / `없음` 만. `flow`(runFlowVideos)·`comfy`(LTX)·`wan`(runComfyVideos) 옵션·함수·디스패치 전부 제거.
  make-all 파이프라인/3단계·video-build·video-group 모두 Grok 단일 경로로 단순화. `clipMaxOf`=10 고정, `noLocalGpuImg`=true,
  `videoPipeline`=canParallel&&grok. 레거시 마이그레이션: 저장된 comfy/wan/flow 영상 → grok, comfy 이미지 → rotate.
- **유지**: `comfy-engine.js`·`comfy-config.js`·⚙ Comfy 모달(서버/클라우드/오디오 섹션만) — ACE-Step 음악(플리)·BGM 이 씀.
  comfy-engine 의 imageToVideo/textToImage 는 이제 미사용(무해한 dead 메서드, 나중 정리 가능). comfy-config 의 wan*·video* 필드도 무해하게 잔존.
- ⚠ 이번 세션에서 붙였던 Wan i2v(아래 v0.1.68 항목)는 이 릴리스로 **제거됨**(설명은 이력용으로 남김).

## 📖 출판 독립화·표지 안내 페이지·구조 체크박스 개편·작성 가이드 (2026-07-03, v0.1.69)
> 사용자 리뷰 2차 반영 — 출판을 영상과 완전 분리된 개별 기능으로.
- **롱폼↔출판 분리**: 롱폼 헤더 「📖 출판편집」 버튼·openBookFromLongform 제거. 출판은
  「📖 원고 열기」로만 진입(open-book-path IPC 는 E2E 용으로 유지). longform-parser 의
  예약섹션 스킵은 안전망으로 유지.
- **미리보기 1쪽 = 표지 안내 페이지**(coverInfoHtml, **미리보기 전용 — 내지 PDF 미포함**):
  치수 표(판형/스프레드 mm·px/책등/날개/재단·안전여백) + 축소 다이어그램(구획·재단선 빨강·안전선
  초록). **표지 이미지 첨부 시 다이어그램 배경에 깔려 치수 정합을 눈으로 확인**. book-preview 가
  opts.coverInfo 전달(build-pdf 는 안 함). 쪽수 보고·표시는 -1 보정("표지 / N쪽").
- **구조 체크박스 개편**: 원고에 쓴 섹션 = 자동 체크. **체크 해제 = 원고 보존한 채 출력에서만
  제외**(layout.excluded — html-builder front/back/목차/판권/표지 covers 전부 필터). 원고에 없는
  섹션 체크 시에만 템플릿 삽입(기존). 「판권 구성」 패널(17종 체크박스) 삭제 — 판권은 [판권] 섹션
  자유문이 정본(마커만 있으면 메타 자동 생성 폴백), 위치 select 는 규격 패널.
- **특별 섹션(반복 코너)**: layout.specialKeyword(쉼표 복수) — 일치하는 소제목(###) 구간을
  `div.special-sec`(옅은 배경 노트 박스, 0.93em, 들여쓰기 없음)로 조판. 삼국지 '역사 노트' 용.
- **관행 보정**: 문단 간격 기본 10pt→**0**(관행=들여쓰기만), 소제목 아래 여백 10→8pt(위25:아래8),
  반표제지·속표지 제목에 fileTitle 폴백(메타 없을 때 1쪽이 빈 페이지로 나오던 문제).
- **원고 작성 가이드**: `docs/출판-원고-가이드.md` — 규약 설명이 HTML 주석으로 들어 있는 "살아있는
  예시"(파서로 규약 검증 통과 확인). IPC `book-save-guide`(showSaveDialog 복사) + 헤더 「📄 작성
  가이드」 버튼. 구 출판-원고-예시.md 삭제. h1=책제목 고정(가이드에 명시).
- .bkactions 버튼 3개 크기 통일(flex:1).

## 🍌 Nano Banana 2 Lite — Flow 이미지 모델 선택 추가 (2026-07-03, v0.1.68)
- **배경**: 2026-06-30 Google 이 신모델 `gemini-3.1-flash-lite-image`(Nano Banana 2 Lite) 정식 출시
  — Nano Banana 2 대비 절반 가격·약 2.7배 빠름(공식 발표). Genspark/Flow 양쪽 다 지원 가능성 있으나,
  **Genspark 는 코드에 "Nano Banana 2"가 하드코딩**(검증만, 선택 로직 없음)돼 있어 변경 위험이 크고,
  **Flow 는 이미 `_selectModel()` 로 모델을 텍스트 매칭 선택하는 인프라가 있어** 이쪽으로 추가.
- **구현**: `core/image-rotation.js` DEFAULTS 에 `flowImageModel`(기본 'Nano Banana 2') 추가(load/save
  이미 patch 를 그대로 병합하는 제네릭 구조라 IPC 변경 불필요) → `main.js runFlowImages()` 가
  `Rot.load().flowImageModel` 을 읽어 `eng.run({..., model})` 로 전달(flow-engine.js 는 이미
  `opts.model` 을 image/video 공통으로 처리 — **엔진 코드 변경 없음**). UI: 「⚙ 순환」 모달의 Flow 행에
  select(Nano Banana 2 / Nano Banana 2 Lite) 추가.
- **안전장치**: `_selectModel()` 이 드롭다운에 해당 텍스트가 없으면 **조용히 무시하고 기존 모델 유지**
  (에러 없음) — Flow 웹 UI 에 아직 이 옵션이 안 떴어도 앱이 깨지지 않음.
- ⏳ **실측 필요(중요)**: Google 공식 발표는 Flow 를 롤아웃 대상으로 명시했으나, **Flow 웹 UI 드롭다운에
  "Nano Banana 2 Lite" 라는 정확한 라벨이 떠 있는지는 미확인**(genspark.ai/Flow 상세 UI가 자동 조사에서
  차단됨). 사용자가 Flow 로 이미지 1장 만들 때 로그의 "모델 Nano Banana 2 Lite" 표시 후 실제로 다른
  모델이 적용됐는지(속도·화질 차이) 1회 확인 필요. 라벨이 다르면(예: "Nano Banana 2 Flash Lite") select
  의 value 문자열만 그에 맞게 고치면 됨.
- Genspark 는 이번 범위 제외(하드코딩된 모델 검증 로직을 실제 선택 로직으로 바꿔야 해서 더 위험) —
  Flow 경로가 실측으로 확인되면 다음으로 고려.

## 🎬 Grok 새 UI 대응·비디오 파이프라인·프리미어 XML + 📖 행간 관행 (2026-07-03, v0.1.67)
- **Grok 새 UI(2026-07) 대응**: 제출 후 "이미지" 화면에 머물고 생성물은 **사이드바 진행률(N%)
  썸네일**로만 표시 → video 요소 못 찾아 5분 타임아웃 → 실패 → 재시도(크레딧 추가 차감)되던 문제.
  폴링 루프에 ① 진행률 배지(N% 텍스트) 감지+로그 ② 썸네일 좌표 클릭으로 비디오 화면 진입(최대 4회)
  ③ 진행률 보이는 동안 타임아웃 연장(절대 상한 15분) 추가 (grok-engine.js 폴링부). ⏳ 실전 1회 실측 필요.
- **이미지→비디오 파이프라인 Grok 확장**: 기존 videoPipeline(Comfy 클라우드 한정)을
  `videoEngine==='grok'` 에도 — Grok 은 별도 크롬 프로필이라 Genspark/Flow 이미지와 비충돌.
  videoStage 를 "준비된 그룹 모아서 편별 배치 호출"로 개편(Grok 은 호출당 브라우저 기동이라 단건 비효율).
  Grok 'auto' 길이는 그룹 TTS 필요 → ttsReady 요구. **Flow 비디오는 이미지와 같은 브라우저라 파이프라인 제외**.
- **프리미어 Pro 임포트**: `core/premiere-xml.js` — FCP7 XML(xmeml v4) 시퀀스(V1=그룹 비디오/이미지
  스틸, A1=문장 TTS 순차, 30fps, 16:9/9:16/1:1). 비디오가 그룹보다 짧으면 잔여를 이미지로 채움.
  IPC `export-premiere` + 카드 「🎞 프리미어」 버튼(.vrew 뒤). Premiere: 파일>가져오기, 자막은 .srt 캡션.
  pathurl=`file://localhost/D%3a/...`. 스모크: 더미 자산 165프레임 검증.
- 카드 「🎬 영상」 라벨 → 「🎬 비디오」.
- **📖 행간 관행**: 기본 1.65(구 앱) → **1.8** (한국 단행본 관행 = 글자크기의 1.7~2.0배, 10pt→18pt).
  삼국지 261→275쪽. 기존 원고의 저장된 layout 은 유지(새 원고부터 1.8).

## 📖 머리글 정렬·내용 확장 + 휠 넘기기 / 🎵 BGM·플리 코드 점검 (2026-07-03, v0.1.66)
- **머리글**: 내용 5종(책제목/책부제/장제목/소제목(절)/없음) × 정렬 3종(왼쪽/가운데/오른쪽) —
  짝/홀 각각 선택. 기본 = 짝수쪽 책제목 왼쪽 / 홀수쪽 장제목 오른쪽(바깥 정렬 관행).
  부제=`.book-subtitle-anchor` string-set, 절=`section.chapter h3` string-set(sec-title).
  ⚠ **vivliostyle 마진박스 실측**: `@top-left` 단독=글자 세로 쌓임 / `@top-left`+`@top-center`
  병용=공간 분할로 왼쪽 글이 중앙에 밀림 → **`@top-center` 단일 박스 + width(판면폭 mm 명시) +
  text-align** 이 정답(좌표 실측: 짝수쪽 x0=판면 왼쪽 끝, 홀수쪽 x1=판면 오른쪽 끝 정확).
- **미리보기 휠 넘기기**: iframe doc 'wheel' 리스너(250ms 스로틀) → navigateToPage NEXT/PREV.
- **🎵 BGM 점검 4건 수정**: ① addBgmTrack 의 `assetEffectInfo:{type:'none'}` 제거(제목 web 트랙에서
  Vrew 내보내기 실패시켰던 패턴 — startDelay>0 일 때만 검증된 fade-in) ② sourceOut 을
  min(총길이, 파일실측길이)로(소스 범위 초과 방어) ③ **💾 재export 에도 BGM 포함**(pr._bgmPath 재사용,
  스냅샷 bgmPath/bgmVolume 저장·복원 — 재시작 후에도 유지) ④ 플리 곡 길이를 mp3 실측으로 보정
  (make-playlist 생성 직후 + make-playlist-video 입구 — 스펙 180초 ≠ 실제 출력이면 배경 루프·자막 어긋남).
  textToAudio·makeBoomerang/loopBoomerangTo·loopAudioTo 는 이상 없음(리뷰 완료).
  BGM 트랙이 Vrew 에서 실제로 들리는지는 여전히 실측 필요(안 들리면 수동 .vrew 샘플로 필드 확정).

## 📖 출판 조판 8종 개선 — 사용자 리뷰 반영 (2026-07-03, v0.1.65)
> 삼국지 미리보기 검토 피드백 8건 반영. 조판 기본값 = **구 Book Publishing 앱 사용자 설정 그대로**
> (defaults.ts 실측: KoPub바탕 Light 10pt/1.65/자간-0.4pt/들여15pt/문단간격10pt/여백 20·15·20·17).
- **① 폰트**: KoPubWorld 바탕·돋움 이식. ⚠ **woff2·otf(CFF)는 Chromium PDF 가 Type3 로 구움** →
  fonttools(cu2qu)로 **TrueType 변환**해 동봉(Light/Bold만, 56MB) = Type0(CID) 임베딩 실측.
  본문 폰트 select(KoPub바탕/돋움/나눔명조/고딕) + 굵기 300/400/700. `assets/fonts/` 는 라이트업데이트
  제외라 기존 설치본은 나눔 폴백 — 다음 설치본 재배포에 포함.
- **② 표지 구성**: 예약 섹션 zone 'cover' — `## [뒷표지]`(소개글) `## [앞날개]` `## [뒷날개]` `## [책등]`
  (구조 패널 「표지 구성」). 표지 PDF 가 배경 이미지(선택) 위에 조판: 앞표지 제목·저자 오버레이(옵션),
  책등 세로쓰기(자동=제목·저자·출판사), 뒷표지 소개글(위 10%부터)+**ISBN 바코드+정가**(우하단),
  날개 글. 이미지 없이 텍스트만으로도 표지 PDF 생성 가능. buildCoverPdf compose 파라미터.
- **③ 여백**: 기본 20/15/20/17(구 앱) + UI 4필드. **④ 목차 쪽번호**: leader() 가 코어(미리보기)와 CLI 에서
  달라 점선 리더 폐기 → **absolute 우측 고정 쪽번호**로 통일(양쪽 동일 실측).
- **⑤ 머리글·쪽번호 선택**: 짝/홀 각각 책제목/장제목/없음, 구분선 on/off(9pt 회색 고딕), 쪽번호
  바깥하단/가운데/숨김. **⑥ 문단**: 문단 간격(pt)·들여쓰기(pt) UI. **⑦ 소제목(## = h3)**: 크기·고딕/본문체·
  굵기·정렬·장식문자(❖ 기본)·위아래 여백. **⑧ 판권**: 자동 항목 17종 체크박스(colophonFields)+위치(앞/뒤)
  — 「판권 구성」 패널. 자유문([판권] 내용) 있으면 체크박스 무시 안내.
- 구현: html-builder pageCss 가 옵션 전부 반영(CSS 순서 = 폰트→테마→pageCss 오버라이드),
  layout 옵션은 item.settings.book 영속(bookDTO.layoutSaved 로 복원). BookView LAYOUT_DEFAULTS.

## 📖 출판 모드 확장 — 다중 파일 원고·ePub·바코드·표지가이드 (2026-07-03, v0.1.64)
> D:\PrimingBook(구 Book Publishing 앱) 기능 이식. **사용자 실원고 = 삼국지연의 1권**
> (`D:\PrimingBook\book-publishing\data\삼국지연의_1권_필수파일.md` + `출판_삼국지_제001~015회.md`)로 실측 검증.
- **다중 파일 원고**: 「📖 원고 열기」 multiSelections — 필수파일(평문 `책제목:` 메타 + `===앞부속물===` 구분 +
  `# 헌사`/`# 판권` H1 부속물) + 회차 파일(H1(또는 첫 줄 평문)=장, `*이탤릭*`=리드문, H2=절) N개 → 한 권.
  구현: book-parser `parseBookFiles` — 파일별 **라인수 보존 변환**(`# 헌사`→`## [헌사]`, 평문 메타→`> 메타`,
  회차 헤딩 +1레벨) 후 결합 → 기존 parseBookText. `_files[{path,kind,startLine,lineCount}]` 오프셋으로
  결합 라인↔원본 파일 역매핑(`resolveSourceLine`) → 클릭-편집이 **원본 파일의 올바른 줄**을 수정
  (IPC `book-get-lines`/`book-apply-edit`). 메타·섹션 토글은 essential 파일에 기록(스타일 보존: 평문/`>`).
  정렬 = essential 먼저 + 파일명 숫자 정렬. 워크스페이스 `settings.book.files` 복원. `# 속표지/# 표제지`
  지시 섹션은 RESERVED zone:'ignore'(내용 버림 — 앱이 자동 조판). 다중일 때 ✏대본수정(전체 텍스트)은 차단.
- **판권 자유 문구**: `[판권]` 섹션에 내용이 있으면(AI 활용 고지 등) 자동 테이블 대신 그대로 조판(cp-free).
- **장 리드문**: 장 첫 블록이 `*...*` 전체 이탤릭이면 type 'lead' → 제목 아래 이탤릭 부제.
- **ISBN 바코드**: `core/book/isbn-barcode.js` — 의존성 없는 EAN-13+부가기호(EAN-5) SVG(인코딩 테이블 직접).
  pyzbar 디코딩 실측 통과. IPC `book-export-barcode`(SVG 저장) + BookView 「🏷 바코드」가 PNG 변환도 저장.
  메타 `> 부가기호: 03910`(isbnAddon).
- **표지 가이드**: BookView 「📐 표지 가이드」 — 300dpi 투명 PNG(재단선 빨강/안전선 초록/책등·날개 구분+치수)
  를 canvas 로 그려 IPC `book-save-asset` 로 저장. 캔바 밑그림 레이어용.
- **ePub 3.0**: `core/book/epub-builder.js` + IPC `book-build-epub` + 「📱 ePub」. ⚠ **adm-zip 은 writeZip 때
  이름순 정렬**해 mimetype=첫 엔트리 규격을 못 지킴 → zlib+CRC32 **MiniZip**(직접 조립, mimetype STORED) 사용.
  각주=epub:type noteref/footnote(팝업). 전자책 표지 = `> 전자책표지:` 경로 우선, 없으면 인쇄 표지 스프레드에서
  **앞표지를 ffmpeg 크롭**. 판권 자유문 재사용.
- 🐞 **미리보기 쪽수 왜곡(255→660쪽) 해결**: CoreViewer 를 앱 document 에 직접 렌더하면 **앱 전역 CSS
  (p 마진·14px 폰트)가 조판 DOM 에 캐스케이드**돼 실측 페이지 분할이 부풀음 → **iframe 격리**
  (`viewportElement`=iframe 내 div + `window: iframe.contentWindow`, 클릭은 iframe doc 리스너). 미리보기=PDF 쪽수 일치 실측.
  같은 원인 계열로 html-builder 는 CSS 변수(:root/var()) 대신 값 직접 치환.
- 🐞 **모드 전환 크래시 수정**: 출판→롱폼 탭 전환 시 한 프레임 동안 book dto 가 Cards 에 들어와
  `dto.projects.length` TypeError → 가드 보강 (App.jsx:1585).
- 테스트: `test/book-multi.smoke.js`(삼국지 16파일 → 255쪽 PDF+ePub 구조 검증) + book-ui.smoke 에
  다중 파일 케이스(255쪽 조판 확인). `npm run test:book` 에 포함.

## 📖 출판(POD) 모드 — MD 원고 → 내지·표지 PDF (2026-07-02, v0.1.62)
- 모드 토글 **4-way**: 롱폼/쇼츠/🎵플리/**📖출판**. 롱폼과 원고(.md) **공유** — 롱폼 헤더 「📖 출판편집」
  버튼(IPC `open-book-path`, 무인자=현재 대본)으로 전환. 출판에서 고친 텍스트는 같은 .md 에 저장돼 롱폼에도 반영.
- **원고 규약** (`docs/출판-원고-예시.md`): `# 제목` + `> 라벨: 값` 메타(저자/ISBN/정가/출판등록…) +
  **`## [예약섹션]`**(헌사·추천사·역자서문·서문·일러두기·목차·프롤로그/에필로그·후기·감사의글·부록·참고문헌·
  저자소개·판권 — 별칭 허용, 관행 순서로 자동 재배열) + 일반 `## N장.` = 본문 장(`## N부.` = 부 표제지),
  H3=절/H4=소절, `>`=인용, ` ```시 `=시(행 보존), `![캡션](경로)`=삽화, `[^1]`=각주. [목차]·[판권]은 마커만
  (자동 생성 — 목차 쪽번호 target-counter, 판권지는 메타로 조판+법정 7필드 미입력 경고).
  **롱폼 파서는 `## [예약]` 섹션을 스킵**(book-parser.stripBookSections — longform-parser 전처리).
- **모듈**: `core/parsers/book-parser.js`(MD→BookModel, lineStart/End 소스매핑) ·
  `core/book/platform-presets.js`(부크크〔공식 규격도구 실측: 46판/A5/B5/A4·bleed3·날개100 고정·min50p〕/
  교보POD〔신국판 등 6종〕/작가와〔베타-부크크 준용〕+ 용지 낱장두께) · `spine-calc.js`(책등=(쪽÷2)×두께,
  표지 스프레드=`bleed3+[날개100]+뒤+책등+앞+[날개100]+3`×`높이+6`) · `html-builder.js`+`book-theme.css`
  (CSS Paged Media) · `pdf-builder.js`(**@vivliostyle/cli 자식 프로세스**, ELECTRON_RUN_AS_NODE=1 +
  playwright chromium `--executable-browser` 재사용, PDF 쪽수는 zlib 로 ObjStm 해제 카운트).
- **조판 확정 사항(스모크 실측)**: 목차 쪽번호(`target-counter`+`leader(dotted)`) ✓ · 러닝헤드 짝수쪽=책제목/
  홀수쪽=장제목(**`string(chapter-title, first-except)`** — `@page name:first` 는 vivliostyle 에서 장별로 안 먹혀
  first-except 로 장 시작 러닝헤드 생략) ✓ · `break-before: recto`+`@page :blank` 백면 ✓ · `float: footnote` 각주 ✓
  · 판형 MediaBox 127×188mm 정확 ✓. **폰트: 가변(variable) TTF 는 Chromium 이 Type3 로 구움** → 정적
  나눔명조/고딕(OFL, assets/fonts/book/) 동봉 = CIDFontType2 정상 임베딩. **CLI 는 HTML 을 HTTP 서빙하므로
  file:/// 서브리소스 차단** → `prepareWorkAssets()`가 폰트·이미지를 _work 로 복사해 상대경로 참조.
- **UI**: `renderer/src/BookView.jsx` 3-pane — 좌 책구조(섹션 체크=MD 템플릿 삽입/삭제 IPC `book-toggle-section`) /
  중앙 **실제 페이지 미리보기**(@vivliostyle/core CoreViewer, media:// 로 조판 HTML 로드, 렌더 완료 시
  `book-report-pages` 로 쪽수 보고→책등 계산) + **문단 클릭-편집**(data-src-line → `book-apply-edit` 로 원본 .md
  줄 치환) / 우 설정(규격·조판·표지 첨부〔치수검증 validateCoverImage〕·책정보 폼=`book-set-meta` 가 `> 메타줄` 갱신).
- **출력**: `<채널 outLong||outputFolder>/출판/<원고명>/` 에 `<제목>_내지.pdf` + `<제목>_표지.pdf`(표지 이미지
  첨부 시). press-ready(PDF/X-1a)는 Ghostscript 필요라 옵션(기본 off — 부크크·교보는 일반 PDF 입고 가능).
- 테스트: `npm run test:book` = book-parser.test(44단언) + book-pdf.smoke(헤드리스 PDF) + book-ui.smoke(Playwright
  _electron E2E: 부팅→로드→미리보기 조판→클릭-편집→.md 저장 왕복).
- ⚠ **deps 변경**(@vivliostyle/cli·core, markdown-it) → **이 릴리스는 설치파일 재배포 필요**(라이트업데이트는
  "재설치 필요" 안내가 뜸). markdown-it 은 현재 미사용(인라인 렌더 자체 구현) — 향후 확장용.
- ⏳ **실측 필요**: 부크크 규격체크 도구에 실제 내지·표지 PDF 업로드 1회 확인(사용자). 대형 원고(300p+)의
  미리보기 렌더 속도(renderAllPages) 체감 확인.

## 🎬 Wan i2v 영상 엔진 추가 (2026-07-02)
- 영상 엔진 드롭다운에 **`Wan (i2v)`** 추가 (Grok/Flow/LTX2.3/**Wan**/없음). LTX·Wan **병행** — 각자 워크플로 슬롯.
- 구조: `comfy` 영상 엔진은 워크플로 JSON 종속이 없는 범용 i2v 라, Wan 은 **다른 워크플로만 갈아끼움**. `videoEngine==='wan'`
  이면 `runComfyVideos(...,{wan:true})` 가 cfg 를 `{workflowPath:wanWorkflowPath, videoFps:wanFps, videoMaxSec:wanMaxSec, timeoutSec:wanTimeoutSec}`
  로 오버라이드. 캐시 태그 `comfy-wan`. **클라우드(comfy.org) 설정(cloud/apiKey)은 그대로 물려받음** — Wan 도 클라우드에서 동작.
- comfy-config: `wanWorkflowPath`·`wanFps(16)`·`wanMaxSec(0=videoMaxSec)`·`wanTimeoutSec(0=timeoutSec)`·`videoFps(0=초)` 추가.
- **클라우드 Wan = 단일 API 노드 `Wan2ImageToVideoApi`** (예: `D:\Priming\Wan2.7 I2V\api_wan2_7_i2v.json`).
  로컬 Wan(CLIPTextEncode+WanImageToVideo.length 프레임)과 다름 → 엔진이 둘 다 처리:
  - 프롬프트 주입(`_buildGraph`): CLIPTextEncode.text 없으면 **`model.prompt`/prompt/positive** 키 자동 주입(부정 프롬프트 보존).
  - 길이 주입(`_setVideoDuration`): 필드명으로 초/프레임 자동 판별 — **`model.duration`/duration/seconds=초**, `length`/`num_frames`=프레임(초×videoFps).
    클라우드 Wan 은 model.duration(초)라 fps 무시됨. 로컬 Wan 은 fps=16 로 프레임 변환.
- **워크플로 2종 — 노드 종류로 유·무료 갈림**:
  - ❌ `Wan2ImageToVideoApi`(API 노드) = comfy.org 가 파트너(Alibaba) 유료 API 를 중계 → **API 크레딧 과금** + 헤드리스 REST 는 계정 인증 필요
    (`_queue` 가 `extra_data.api_key_comfy_org` 전달로 "Unauthorized" 대응). 길이=`model.duration`(초), 프롬프트=`model.prompt`.
  - ✅ **로컬노드 워크플로**(`UNETLoader`+`WanImageToVideo`+`CLIPTextEncode`+`KSamplerAdvanced`+`SaveVideo`) = 클라우드 GPU 에서
    직접 실행 = **구독 GPU 시간만(추가 크레딧 X)**. 예: `D:\Priming\Wan2.2 I2V\video_wan2_2_14B_i2v.json`(Wan 2.2 14B, 검증됨).
- **로컬노드 Wan 2.2 주입 특이점**(comfy-engine 이 처리, 실측 검증):
  - 프롬프트: CLIPTextEncode 가 **긍정/부정 2개** → `_buildGraph` 가 **제목(positive/negative)으로 긍정 노드 선택**(부정에 주입 금지).
  - 길이: `Float (Duration)`(초) 프리미티브 → 워크플로가 `floor(초×fps+1)`로 프레임 자동계산. `_setVideoDuration` 브랜치③ 이
    **제목으로 초/프레임 판별**해 Duration 엔 '초'를 넣음(프레임값 넣으면 폭발). WanImageToVideo.length 는 링크라 안 건드림.
  - 해상도: `WanImageToVideo` 의 width/height(640² 고정) → `_setVideoDims` 자동탐지②가 **width/height 리터럴 직접 주입**(16:9→832×480).
  - seed: 클라우드 API 노드가 int32 검증 → `_buildGraph` seed 를 **0..2147483647** 로 제한.
- ⏳ **실측 필요**: (API 노드) 출력이 `_scanMedia`/`_waitCloud` 로 잡히는지 · (로컬노드 Wan 2.2) 실제 생성 mp4/업스케일 완주 1회 확인.

## 🎵 '플리' 모드 — ACE-Step 음악 생성 (2026-06-30)
- 모드 토글이 **롱폼/쇼츠/🎵플리** 3-way. 라벨에서 "16:9·9:16" 표기 제거. 플리는 ACE-Step(ComfyUI) 음악 전용.
- **흐름**: 클로드가 채팅에서 **플리 스펙(.md)** 생성 → 앱 「🎵 플리 스펙 열기」로 로드 → ⚡ 음악 전체 생성 →
  곡마다 **로컬 ComfyUI ACE-Step API**(comfy-engine `textToAudio`) → `<출력폴더>/플리/<스펙명>/NN_제목.mp3`. TTS·자막·.vrew 없음.
- 스펙 형식: `core/parsers/playlist-parser.js`(`## NN · 제목` + tags/스타일 · lyrics/가사 · length/길이). 예시: `docs/플리-스펙-예시.md`.
  연주곡 = 가사 빈값/`(instrumental)`/`(연주곡)`. `instrumental` 태그는 tags 에 포함.
- ComfyUI: `comfy-config` 에 `audioWorkflowPath`·audioTagsNodeId·audioLyricsNodeId·audioDurationNodeId·audioTimeoutSec 추가.
  comfy-engine `_buildAudioWorkflow`(tags→TextEncodeAceStepAudio.tags, lyrics, seconds 자동탐지) + `_waitAudio` + `_downloadAudio`(출력 확장자 보존).
  ⚙ Comfy 모달에 "🎵 음악(ACE-Step)" 섹션. **이미지(Krea2)·영상(LTX)와 같은 REST 패턴** — 워크플로 JSON 1개만 "저장(API 포맷)"으로 지정.
- main.js: `S.modes.playlist` 큐 추가, `normMode`(3-way), `currentDTO`/`playlistDTO`, IPC `open-playlist-spec`·`make-playlist`,
  워크스페이스 직렬화/복원 3-way. 플리는 .smproj 스냅샷 스킵(워크스페이스+스펙.md 가 진실). App.jsx `PlaylistView` + `isPl` 분기.
- ⏳ **실측 필요**: ACE-Step "API 포맷" 워크플로 JSON 이 있어야 실제 생성됨(없으면 graceful 에러). 노드 자동탐지 구조는 실제 워크플로로 1회 검증 필요.
  미설정/실패는 이미지·영상과 동일하게 {success:false} 로 안전 처리. 음악 품질 검증(ACE-Step 1곡) 후 워크플로 export 가 선행.
- 🎬 **플리 배경(무한루프 영상)+.vrew (2026-07-01, v0.1.47)**: 음악만 만들던 플리를 **영상화**까지. PlaylistView 헤더
  「🎬 배경+vrew」(IPC `make-playlist-video`). 흐름: 스펙 `> 배경:`(없으면 컨셉/제목) → Krea2 이미지(16:9)
  → LTX i2v 짧은 클립 → **부메랑(정방향+역방향)으로 seamless** → 곡마다 곡 길이(+1s)로 stream-copy 루프
  (`core/playlist-video.js` makeBoomerang/loopBoomerangTo, ffmpeg=media-utils.getFfmpegPath). 그 뒤
  `buildPlaylistProject`(곡=그룹[배경 루프 videoPath]+문장[곡제목=자막, mp3=오디오], aspect 16:9) → `P.buildProjectVrew`
  로 `<출력>/플리/<제목>.vrew`. 배경 1개 공통 + 곡 제목 자막(YouTube 챕터·단속 차별화). vrew-builder 는 16:9+videoPath
  면 영상 트랙 사용(line 844, 비율 무관). 영상 실패 시 이미지 배경으로 폴백. playlist-parser 에 bgPrompt 파싱 추가.
  ⏳ **실측 필요**: Vrew 에서 .vrew 정상 로드(배경 영상 트랙·곡별 길이 매칭)·LTX 480p 배경 화질(필요 시 업스케일 추가).

## 🎵 대본 지정 BGM 프롬프트 + BGM 기본 ON (2026-07-04, v0.1.72)
- **대본에 배경음악 프롬프트**: 메타 줄 `> 🎵 배경음악: <영문 ACE-Step 태그>`(배경음악/배경음/BGM, `·`·`|`·개행 앞 정지).
  longform-parser·cut-script-parser 가 파일 전체 스캔 → `proj.bgmMood`. **쇼츠는 3편 공통**(파일 상단 1줄).
  ⚠ cut 파서는 루프에서 `meta=parseMeta()` 재할당되므로 bgmMood 는 **별도 지역변수**로 보관(meta 에 안 얹음).
- **우선순위**: `deriveBgmMood` = 작업바 moodOverride → **proj.bgmMood(대본 지정)** → Ollama → Gemini → 기본값.
- **BGM 기본 ON**: App.jsx `bgmOn` 기본값 false→**true**(저장된 설정에 값 있으면 존중). 음악 서버 미설정이어도 graceful(로그만).
- 가이드: `docs/대본-작성-가이드.md` 공통원칙 #4 + 롱폼/쇼츠 템플릿에 배경음악 줄 추가.

## 🎵 롱폼/쇼츠 BGM(ACE-Step 배경음) 자동 삽입 (2026-07-01, v0.1.50)
- 작업바 「🎵 BGM」 체크 + 무드칸(빈값=대본 자동). ⚡만들기 시 **3.5단계**(비디오 뒤·.vrew 앞, main.js runMakeAllCore)에서
  편별 총길이(=ttsDurationSec 합) 계산 → `deriveBgmMood`(대본 무드 → ACE-Step 태그: **moodOverride 우선 → Ollama → Gemini →
  기본값** `calm, cinematic, ambient, soft piano, slow tempo, warm, instrumental`) → `comfy-engine.textToAudio`(≤180s 생성)
  → `media-utils.loopAudioTo`(총길이로 재인코딩 루프) → `pr._bgmPath`.
- **음악만 로컬 서버**: `audioBaseUrl` 있으면 그 주소로(cloud:false), 이미지/영상은 클라우드 그대로 (플리 패턴 재사용).
- .vrew 삽입: 4단계 ep 에 `bgm:{enabled,audioPath,volume(기본0.15),loop}` 부착 → `pipeline.buildProjectVrew` 가 `opts.bgm` 전달
  → **`vrew-builder.addBgmTrack`**: AVMedia(sourceOrigin USER, sourceFileType ASSET_AUDIO) 등록 + `videoAudio` 타입 트랙
  (volume 0.15, loop, sourceOut=총길이, assetEffectInfo.startDelay 0) + asset(role sub) → **clip[0] 에만 링크**(AI고지 절대배치와 동일).
- UI(App.jsx): bgmOn/bgmMood 상태 + capbar 컨트롤 + make args `bgm`. 💾 재export 경로는 미포함(⚡만들기 전용). 롱폼·쇼츠 공통.
- ⏳ **실측 검증 필요(중요)**: Vrew 가 **독립 오디오 BGM 트랙**에 기대하는 정확한 JSON 미확정 — `videoAudio` 는 원래 영상에 묶인
  타입이라 best-effort. Vrew 에서 BGM 이 안 들리면 **BGM 수동 삽입한 .vrew 샘플을 받아 files/tracks/assets 필드 확정**
  (자막·제목·도형 잡던 "사용자 .vrew 분석" 방식). 계획서: `~/.claude/plans/ace-step-prancy-planet.md`.
- 🔜 **SFX(효과음)**: 이번 범위 제외. ACE-Step 은 음악 전용이라 효과음 불가 → 추후 로컬 SFX 라이브러리 + 대본 마커([효과음: …])
  + `addSfxTrack`(startDelay 타임스탬프)로 별도 구현 예정.

## 🐞 쇼츠 9:16 .vrew = 화면비 가로로 표시 + 내보내기 실패 — 실제 원인 2가지 (2026-06-24)
> ⚠️ 이전의 "videoRatio 역수" 진단은 **오진**이었음. videoRatio 는 화면비와 무관한 상수(정상 .vrew 는
>   16:9·9:16 모두 **0.5625**). 사용자 정답본(make1.vrew = 프로그램 .vrew 를 9:16 으로 직접 수정) 정밀 비교로 확정.

**① 화면비가 9:16 이 아니라 16:9(가로)로 열림 — 원인: 오버레이 트랙 X좌표계**
- Vrew 는 videoSize/videoRatio 가 아니라 **web/shape(제목·도형·AI고지) 트랙의 xPos/width 좌표계**로 캔버스
  화면비를 인식한다. 우리는 이 좌표를 16:9 기준 0..1(예 제목 width 0.96)로만 써서 Vrew 가 가로로 펼침.
- 수정(vrew-builder.js buildVrew 끝 "2.7"): web/shape 트랙만 xPos/width 를 **×_overlayScale**(중앙 보존).
  `_overlayScale = (16/9)×(canvasH/canvasW)` → **16:9=1.0(무변경=롱폼 안전) · 9:16=(16/9)²=3.1605 · 1:1=1.7778**.
  **미디어(video/image)는 그대로**(width≈1 + fillType:cut = 커버 — ×스케일 하면 캔버스에서 사라짐).
  **자막(transcript.clips[].captions[].style)도 그대로**(별도 좌표계). videoRatio 는 상수 **0.5625** 로 통일.
- 검증: make1 의 영상 z=1~3 은 ×3.16(자동변환 잔재)이지만 사용자가 직접 고친 z=0·z=4 는 `width=1+fillType:cut`.
  자막·도형·제목만 ×3.16. → 미디어 유지 + 오버레이만 스케일 = 9:16 + 미디어 보임 + 내보내기 정상(실측 확인).

**② 내보내기 자체가 실패(제목 텍스트가 원인) — 원인: 제목 web 트랙의 assetEffectInfo**
- 정상 .vrew 의 제목 web 트랙엔 `assetEffectInfo` 필드가 **없음**. 우리는 `assetEffectInfo:{type:'none',...}` 를
  넣어 둠 → Vrew 내보내기 실패(type:'none' 이라도 web/textbox 트랙에 있으면 안 됨).
- 수정(vrew-builder.js addTitleTrack ~585): `assetEffectInfo` 줄 **삭제**(필드 생략 = 즉시 표시). 실측 내보내기 성공.

## 라이트 자동 업데이트 — 변경 파일만 교체 (2026-06-23)
- 요청: 설치는 1회, 이후엔 바뀐 파일만 설치폴더에 받아 즉시 최신으로 실행. (기존 팝업→다운→인스톨→재시작 단계 제거)
- 구조: **asar 비활성**(package.json `build.asar:false` — 개별 파일 교체 가능) + `light-updater.js` + `scripts/gen-manifest.js`.
  - `light-updater.applyUpdates()` 가 **bootstrap.js 에서 `require('./main.js')` 하기 전에** await 호출 →
    GitHub(main) 의 `update-manifest.json`(파일별 sha1)과 설치폴더 파일 해시 비교 → 다른 파일만 raw URL 로
    받아 원자적 교체(tmp→rename) → 그 실행이 곧바로 최신. 오프라인/실패면 조용히 현재 버전 진행. dev 는 건너뜀.
  - **deps(node_modules) 변경**은 파일 교체로 불가 → manifest.deps 해시 다르면 적용 멈추고 "재설치 필요" 안내(앱 ready 후 dialog).
    즉 package.json dependencies 바꾼 릴리스는 설치파일 재배포 필요. 그 외 JS/렌더러 변경은 전부 이 방식.
  - 오래된 렌더러 에셋(이전 빌드 해시) 자동 정리(manifest 에 없는 renderer/dist/assets 삭제).
- 발행: 코드 변경 후 **`npm run update:publish`**(vite build + gen-manifest) → `update-manifest.json`+변경파일 **git commit + push**.
  raw.githubusercontent.com 은 public repo 라 토큰 불필요(CDN 캐시 ~5분).
- .gitignore: `dist/`→`/dist/`(루트 설치산출물만 무시). **renderer/dist 와 update-manifest.json 은 커밋 대상**(raw 로 받기 때문).
- 기존 `auto-updater.js`(electron-updater/NSIS)는 bootstrap 에서 호출 제거(파일은 남김). electron-updater 의존성은 미사용.

## AI 고지 = 양쪽 모드 선택형, 기본값만 모드별 (2026-06-23)
- 요청: 롱폼·쇼츠 **둘 다 선택 가능**. 강제 아님. 기본값만 다름 — **롱폼 표시 ON / 쇼츠 미표시 OFF**.
- main: `forceAiNoticeIfLongform` → **`resolveAiNotice(preset, want)`**. 모드 무관하게 `enabled:!!want`(사용자 선택).
  롱폼은 켜질 때만 5초후 5초 타이밍 적용, 쇼츠는 preset 타이밍 유지. export-vrew·runMakeAllCore 4단계·run-batch
  (s.aiNotice) 호출부가 `aiNotice` 전달. run-batch 는 `clipMaxOf(videoEngine)` 도 전달(쇼츠 재구성).
- 렌더러: capbar 'AI 고지' 체크박스 **양쪽 모드 노출**. 기본값은 preset 로드 effect 에서 `setAiNotice(mode==='longform')`
  로 세팅(롱폼 true/쇼츠 false). make/export 가 `aiNotice` 그대로 전달(강제값 제거). currentSettings/applySettings 에 포함.
  채널편집 모달 체크박스는 안내문만(실제 표시는 작업바 토글이 결정).

## Flow 창 닫기 + 이미지 미생성 시 .vrew 차단 (2026-06-23)
- **Flow 크롬 창 마무리**: 기존엔 S.flowEng 를 재사용하려고 앱 종료(before-quit) 때만 닫아 작업 끝나도 창이 남음.
  → `closeFlowEng()`(main.js, `_closeContextAndCleanup` 호출) 추가 + runMakeAllCore 끝 / image-build / video-build
  종료 시 호출. 재사용은 한 번의 실행 안에서만, 끝나면 창 닫음. (다음 실행은 getFlowEng 가 새로 띄움)
- **이미지(쇼츠는 영상) 미생성 그룹 있으면 .vrew 생성 차단 + 팝업**: `missingVisualGroups(pr)` =
  imagePrompt 있는데 imagePath·videoPath 둘 다 없는 그룹. 있으면 그 편 .vrew 를 건너뛰고
  `warnIncompleteVisuals()` 가 `dialog.showMessageBox` 로 어느 편 G몇이 빠졌는지 팝업. runMakeAllCore 4단계 +
  export-vrew(💾) 양쪽 적용. (쇼츠는 영상이 있으면 이미지가 있었던 것 → image|video 둘 중 하나면 OK)
- 참고: vrew-builder 의 `Image file 수 0 < 이미지 그룹 수 N` self-check 경고는 **이미지 파일 개수만** 세서
  영상으로 대체된 그룹을 못 알아보는 false alarm(경고 로그일 뿐, 차단 아님). 실제 차단은 위 main 게이트가 담당.

## 전체만들기 = 단계별 일괄 처리 (2026-06-23)
- 요청: 대본 1개(쇼츠1·2·3)를 **하나의 덩어리**로 — 쇼츠마다 TTS→이미지→영상→vrew 를 끝내고 다음으로
  가지 말고, **전 쇼츠 TTS(쇼츠1 1그룹~쇼츠N 마지막)→ 전 쇼츠 이미지 → 전 쇼츠 영상 → 전 쇼츠 .vrew** 순서로.
- `runMakeAllCore`(main.js) 재구성: `projects` 한 번 필터 후 1·2·3·4단계 루프로 분리. 각 단계는 전 쇼츠를 돈다.
  - 1단계 TTS: fillTts + (쇼츠 모드면) `mergeGroupsByTts(clipMaxSec)` 그룹 재구성까지 — tts-build 와 동일.
    이제 make-all 이 TTS 버튼 없이도 그룹 재구성을 포함(원클릭 정합성). clipMaxSec 는 renderer makeAll 이 전달.
  - 부수효과: 단계 완전 순차 → ComfyUI(로컬 GPU) 이미지와 OmniVoice TTS 가 안 겹쳐 VRAM 충돌 자동 해소
    (예전 comfy 전용 순차 분기 제거). 트레이드오프: Genspark/Flow 의 'TTS∥이미지' 동시 실행은 사라짐(의도).
  - 중단(S.abort): 단계 사이/내부에서 멈추되 **4단계 .vrew 는 항상 실행**(만들어진 자산으로 best-effort 패키징).
  - opts 에 `clipMaxSec` 추가. run-batch(큐)도 shortsNum 필터만 다를 뿐 동일 경로라 영향 없음.

## 버그픽스 2건 (2026-06-23)
- 🐞 **쇼츠2부터 이미지가 Genspark→Flow 로 빠짐**: 원인은 Genspark 서비스 한도가 아니라 **앱 자체 캡**
  (`core/genspark-accounts.json` dailyCap=45)에 오늘 카운트 45 도달 → `activeAccounts()` 빈 배열 → 순환이
  Flow 로 폴백(main.js:548). 사용자 의도 = "Genspark 일일한도는 알 수 없고, Genspark 가 보내는 휴식/한도
  **메시지**(genspark-engine `_detectLimitMessage`)를 감지했을 때만 Flow 전환". → **Genspark 캡을 무제한으로**:
  `core/accounts.js` 에 `defaultCap` 인자 + `dailyCap<=0` = 무제한(pickActive/activeAccounts 항상 활성, setCap 0 허용),
  `genspark-accounts.js` 가 `makeAccountStore('genspark','gs',0)` 로 호출. 기존 상태파일도 dailyCap:0·count 초기화.
  UI: Genspark 계정 모달 "0=무제한" 안내 + "오늘 N/무제한" 표시. (tts/genspark-store 의 maxDaily 는 이미 0=무제한)
- 🐞 **쇼츠2 Grok 영상 실패 후 .vrew 만들고 다음 쇼츠로 + G1 "영상 변환 중" 고착**: `start()` 의 첫 진입이
  `waitUntil:'networkidle'`(grok-engine.js:302)이라 grok.com SPA 에서 30초 타임아웃(특히 Flow 크롬 동시 실행 시).
  게다가 `await this.start()` 가 generateVideoFromImage 의 try **밖**이라 예외가 그대로 위로 던져져 → 그룹 status
  가 'generating' 에 고착 + make-all(main.js:1332)이 삼키고 다음 쇼츠로. → ① 302 를 `'load'` 로(399 와 동일 정책)
  ② start() 를 try 안으로 이동(실패도 {success:false} 반환) ③ pipeline `generateHookVideosGrok` 에 **그룹별 1회
  자동 재시도**(실패 시 eng.stop() 후 재진입) + try/catch 로 항상 'done'/'fail' 종결(배지 고착·전체중단 방지).

## ComfyUI 클라우드(comfy.org) 지원 (2026-06-23)
- RunPod 설치/GPU 할당이 어려워 **comfy.org 공식 클라우드**로 전환 옵션 추가. 로컬/RunPod 경로는 그대로.
- comfy-config: `cloud`(bool)·`apiKey` 필드 추가. cloud=true 면 baseUrl 이 로컬이면 `https://cloud.comfy.org` 로 보정.
- comfy-engine: 클라우드 분기 — ① 모든 경로에 `/api` 접두(`_url`) ② 모든 요청에 `X-API-Key` 헤더(`_headers`)
  ③ health=API키 존재확인 ④ 폴링을 `/history/{id}` 대신 `/api/job/{id}/status`(상태) + `/api/jobs/{id}`(outputs)
  로 전환(`_waitCloud`) ⑤ `/api/view` 는 서명 URL 302 → fetch 자동추적. 업로드/큐/다운로드/이미지·비디오 wait 공용화(`_scanMedia`/`_extractOutputs`).
- UI(App.jsx ⚙ ComfyUI 모달): '클라우드 모드' 체크박스 + (체크 시) 'API 키' 입력란. 워크플로는 동일하게 '저장(API 포맷)' JSON.
- 플랜: API 접근은 Standard($20)+. 직접 학습 LoRA 가져오기는 Creator($35)+. 현재 사용자는 기본 모델만 → Standard 가정.
- ⏳ **실측 검증 필요**: `/api/jobs/{id}` 의 outputs 구조·`/api/view` 동작은 실제 키로 한 번 돌려 확인(엔진 셀렉터 반복법과 동일).
  응답 구조가 다르면 `_extractOutputs`/`_scanMedia` 만 보정하면 됨(로그에 응답 일부 출력하도록 처리됨).

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
cd D:\Priming
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
