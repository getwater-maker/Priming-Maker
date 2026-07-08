# -*- coding: utf-8 -*-
"""
Qwen3-TTS Voice Design 서버 (Priming-Maker 용)
==============================================
텍스트 설명(instruct)으로 "새 목소리"를 만들어 wav 로 돌려주는 초경량 HTTP 서버.
OmniVoice(9881)·voxcpm(9892) 와 같은 로컬 서버 패턴. 기본 포트 9893.

앱(Electron)이 필요할 때만 이 서버를 띄우고, 끝나면 종료한다(온디맨드).
그래서 평소엔 VRAM 을 전혀 안 먹고, 보이스디자인 하는 잠깐만 1.7B 모델이 GPU 에 올라간다.

엔드포인트
  GET  /health   → {"status":"ok","loaded":bool,"loading":bool,"error":str|null}
  POST /design   본문 JSON {"instruct": "...목소리 설명...", "text": "미리들을 문장",
                            "language": "Korean"} → audio/wav 바이트 반환
  POST /shutdown → 서버 종료(앱이 프로세스를 직접 kill 해도 됨)

설치·실행은 setup_and_run.bat 참조. flash-attn 없이(sdpa) 동작하도록 구성.
"""
import argparse
import io
import json
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── 모델 상태(백그라운드 로딩) ───────────────────────────────────────────────
_STATE = {"model": None, "sr": None, "loading": False, "loaded": False, "error": None}
_LOCK = threading.Lock()  # generate 는 한 번에 하나만(GPU 직렬화)

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"


def _load_model():
    """서버 시작 시 백그라운드 스레드에서 모델을 GPU 에 올린다(콜드스타트 1회)."""
    global MODEL_ID
    _STATE["loading"] = True
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        print(f"[qwen-design] loading model: {MODEL_ID} (bfloat16, sdpa)", flush=True)
        model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            # flash-attn 대신 PyTorch 내장 SDPA — 윈도우에서 별도 빌드 불필요.
            attn_implementation="sdpa",
        )
        _STATE["model"] = model
        _STATE["loaded"] = True
        print("[qwen-design] model loaded - ready", flush=True)
    except Exception as e:
        _STATE["error"] = f"{type(e).__name__}: {e}"
        print("[qwen-design] model load FAILED:\n" + traceback.format_exc(), flush=True)
    finally:
        _STATE["loading"] = False


def _synth(instruct: str, text: str, language: str):
    """보이스디자인 1회. wav(np.ndarray), sr(int) 반환."""
    model = _STATE["model"]
    if model is None:
        raise RuntimeError("모델 미로딩")
    with _LOCK:
        wavs, sr = model.generate_voice_design(
            text=text,
            language=language or "Korean",
            instruct=instruct,
        )
    wav = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
    return wav, sr


def _wav_bytes(wav, sr) -> bytes:
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    # 콘솔 스팸 억제
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._json(200, {
                "status": "ok",
                "loaded": bool(_STATE["loaded"]),
                "loading": bool(_STATE["loading"]),
                "error": _STATE["error"],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path == "/shutdown":
            self._json(200, {"status": "bye"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path != "/design":
            self._json(404, {"error": "not found"})
            return
        if not _STATE["loaded"]:
            self._json(503, {"error": "모델 로딩 중 또는 실패", "loading": _STATE["loading"], "detail": _STATE["error"]})
            return
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(ln).decode("utf-8")) if ln else {}
            instruct = (req.get("instruct") or "").strip()
            text = (req.get("text") or "").strip()
            language = (req.get("language") or "Korean").strip()
            if not instruct:
                self._json(400, {"error": "instruct(목소리 설명)가 비어 있음"})
                return
            if not text:
                text = "안녕하세요. 이 목소리로 이야기를 들려드리겠습니다."
            wav, sr = _synth(instruct, text, language)
            data = _wav_bytes(wav, sr)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            print("[qwen-design] /design ERROR:\n" + traceback.format_exc(), flush=True)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    global MODEL_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9893)
    ap.add_argument("--model", default=MODEL_ID)
    args = ap.parse_args()
    MODEL_ID = args.model

    # 모델은 백그라운드로 로딩 → 서버는 즉시 떠서 /health 로 진행상황 보고.
    threading.Thread(target=_load_model, daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[qwen-design] server up: http://{args.host}:{args.port}  (health/design/shutdown)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    print("[qwen-design] server stopped", flush=True)


if __name__ == "__main__":
    main()
