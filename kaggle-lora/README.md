# Kaggle에서 Krea2(FLUX.1 Krea dev) 조선 스타일 LoRA 만들기

이 폴더 산출물
- `joseon-krea-dataset.zip` — 학습용 **197쌍**(jpg+txt, joseon 트리거) · 160MB → **Kaggle Dataset으로 업로드**
- `train_krea_lora.ipynb` — Kaggle에서 돌릴 **학습 노트북**
- `config.yaml` — ai-toolkit 설정(노트북 5번 셀에 같은 내용이 내장돼 있어 참고용)

---

## 사전 준비 (1회)

### A. HuggingFace 토큰 + Krea 라이선스 동의
1. https://huggingface.co/black-forest-labs/FLUX.1-Krea-dev → **Agree/Access** (게이트 모델이라 동의 안 하면 다운로드 실패)
2. https://huggingface.co/settings/tokens → **read** 권한 토큰 발급 → 복사

### B. Kaggle 세팅
1. https://kaggle.com 로그인 → 전화번호 인증(해야 GPU·인터넷 켜짐)

---

## 실행 순서

### 1) 데이터셋 업로드
- Kaggle → **Create → New Dataset** → `joseon-krea-dataset.zip` 드래그
- 제목 예: `joseon-krea-dataset` → Create
- (Kaggle이 zip을 자동 해제해도 되고 안 해도 됨 — 노트북이 알아서 처리)

### 2) 노트북 업로드
- Kaggle → **Create → New Notebook** → **File → Import Notebook** → `train_krea_lora.ipynb`

### 3) 노트북 설정 (우측 패널)
- **Settings → Accelerator = `GPU T4 x2`** (P100도 가능), **Internet = On**
- **Add-ons → Secrets** → `Add secret` → Label `HF_TOKEN`, Value = A에서 복사한 토큰
- **Input → Add Input** → 1)에서 만든 `joseon-krea-dataset` 추가

### 4) 실행
- 상단 **Run All** 또는 셀을 위에서부터 순서대로 실행
- 2번(설치) 3~5분, 6번(학습) **3~5시간** (T4 기준). 500스텝마다 loss·샘플 이미지 확인
- ⚠️ Kaggle 세션은 **최대 9시간** → 2500스텝은 한 세션에 끝남. 넉넉함.

### 5) 결과 받기
- 학습 끝나면 우측 **Output** 패널에 `joseon_krea_lora.safetensors` (최종 LoRA)
- 7번 셀이 `joseon_krea_lora_result.zip` 로 묶어줌 → 다운로드

---

## 결과 LoRA 사용법 (ComfyUI / Krea2)
- `.safetensors` 를 ComfyUI `models/loras/` 에 넣고, FLUX.1 Krea dev 워크플로에 **LoRA Loader** 추가
- 프롬프트 앞에 **`joseon,`** 트리거 워드를 붙이면 이 스타일이 적용됨
- LoRA 강도(strength)는 0.7~1.0 사이에서 조절

---

## 튜닝 노브 (config / 노트북 5번 셀에서 수정)
| 항목 | 기본값 | 언제 바꾸나 |
|---|---|---|
| `linear` / `linear_alpha` | 16 | 스타일이 약하면 32로 (용량·시간↑) |
| `steps` | 2500 | 과적합(똑같은 그림만) → 1500~2000, 약하면 3000 |
| `lr` | 1e-4 | 잘 안 배면 2e-4, 망가지면 5e-5 |
| `resolution` | [768] | 디테일 원하면 [1024] (단 T4에선 OOM/느림 위험) |
| `sample_every` | 500 | 시간 아끼려면 1000 이상으로 |

---

## ⚠️ T4 대응 (중요)
Kaggle T4·P100 은 **bf16 하드웨어 가속이 없다.** 학습 셀(6번)에서 bf16 관련 에러가 나면:
1. 5번 config 셀에서 `dtype: bf16` → **`dtype: float16`** 으로 변경
2. 5번·6번 셀 재실행

그래도 OOM(메모리 부족) 나면:
- `resolution: [768]` → `[512]`
- `linear: 16` 유지, `gradient_checkpointing: true` 확인 (이미 켜져 있음)

---

## 안 되면 대안 (유료지만 확실)
- **fal.ai `flux-krea-trainer`** — 데이터셋 업로드하면 클릭 몇 번에 30분~1시간, 몇 달러.
  Kaggle bf16 이슈로 시간 낭비 심하면 이쪽이 속 편함.
