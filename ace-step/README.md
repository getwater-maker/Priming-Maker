# ACE-Step 음악 서버 (플리 음악 — ComfyUI 불필요)

'플리' 음악을 **ComfyUI 없이** 만드는 독립 서버입니다. Qwen 보이스디자인과 같은 방식:
앱이 음악 만들 때만 켜고(모델 GPU 로딩), 끝나면 끕니다. 그동안 음성변환(OmniVoice)은
겹치지 않게 앱이 막습니다(VRAM 보호).

## 처음 한 번만 — 설치
1. 이 폴더의 **`1_최초설치.bat`** 더블클릭.
2. PyTorch + ACE-Step 가 설치됩니다(약 2.5GB, 몇 분). 끝에 **`CUDA available: True`** + `DONE.` 이 뜨면 완료.

> 첫 음악 생성 때 음악 모델(약 14GB)이 `~/.cache/ace-step` 로 자동 다운로드됩니다(1회, 시간 걸림).

## 평소 사용 — 아무것도 안 함
설치 후에는 **앱이 알아서** 이 서버를 켜고 끕니다. 플리에서 「🎬 만들기」를 누르면 음악이 여기서 생성됩니다.

## 문제가 생기면
- `2_서버_수동테스트.bat` → 서버 수동 실행(로그 확인). `http://127.0.0.1:9894/health` 가
  `{"loaded":true}` 면 정상.
- `3_음악_테스트.bat` → 20초짜리 로파이 한 곡 생성해 `test.wav` 재생.
- 오류가 나면 서버 창의 로그를 복사해 개발자에게 보여주세요.

## 기술 메모 (개발자용)
- 서버: `ace_step_server.py` — stdlib HTTP, 포트 **9894**. `GET /health`,
  `POST /generate` (`{tags, lyrics, durationSec, inferStep, guidanceScale}` → `audio/wav`), `POST /shutdown`.
- 모델: `acestep.pipeline_ace_step.ACEStepPipeline`, bfloat16, 체크포인트 자동 다운로드.
- VRAM ~8GB. OmniVoice(유휴 ~3.3GB)와 합쳐 ~11GB → 음악 생성 중 앱이 TTS 합성을 막아 동시 스파이크(OOM) 방지.
  더 빠듯하면 서버를 `--cpu-offload` 로 띄우면 VRAM 절약(느려짐).
- 앱 연동: `venv\Scripts\python.exe ace_step_server.py --port 9894` 를 온디맨드 spawn → /health 대기 → /generate → /shutdown.
