# Qwen3-TTS 보이스디자인 (참조음성 만들기)

텍스트 설명("중저음의 차분한 60대 남성 내레이터" 같은)만으로 **새 목소리**를 만들어,
그 목소리를 OmniVoice 의 **참조음성**으로 등록하는 기능입니다. 한 번 만들어 두면
이후 모든 음성변환을 그 목소리로 하게 됩니다.

## 처음 한 번만 — 설치

1. 이 폴더의 **`1_최초설치.bat`** 를 더블클릭.
2. PyTorch·Qwen3-TTS 가 설치됩니다(약 2.5GB, 몇 분). 창에 "설치 완료!"가 뜨면 끝.
3. 창을 닫으세요.

> 첫 보이스디자인을 실행할 때 목소리 모델(약 4.5GB)이 자동으로 한 번 다운로드됩니다.

## 평소 사용 — 아무것도 안 함

설치 후에는 **앱(프로그램)이 알아서** 이 서버를 켜고(보이스디자인 시작할 때) 끕니다
(끝나면). VRAM 을 잠깐만 쓰고, 그동안 음성변환(OmniVoice)과 겹치지 않게 앱이 관리합니다.

## 문제가 생기면

- `2_서버_수동테스트.bat` 를 더블클릭하면 서버가 수동으로 켜집니다. 창에 나오는 로그를
  복사해 개발자에게 보여주면 원인을 바로 잡을 수 있습니다.
- 확인 주소: 브라우저에서 `http://127.0.0.1:9893/health` → `{"status":"ok","loaded":true}` 면 정상.

## 기술 메모 (개발자용)

- 서버: `qwen_design_server.py` — stdlib HTTP, 포트 **9893**. `GET /health`, `POST /design`
  (`{instruct, text, language}` → `audio/wav`), `POST /shutdown`.
- 모델: `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`, bfloat16, **attn=sdpa**(flash-attn 회피).
- VRAM: 1.7B ≈ 6GB. OmniVoice(유휴 ≈ 3.3GB)와 공존 가능하나, 앱이 "디자인 중엔 음성변환 금지"
  뮤텍스로 동시 사용(→OOM)을 차단.
- 앱 연동: Electron 이 `venv\Scripts\python.exe qwen_design_server.py --port 9893` 를 온디맨드로
  spawn → `/health` loaded 대기 → `/design` 호출 → 끝나면 `/shutdown` 또는 프로세스 kill.
