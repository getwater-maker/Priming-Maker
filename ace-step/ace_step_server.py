# -*- coding: utf-8 -*-
"""
ACE-Step 음악 생성 서버 (Priming-Maker '플리' 용) — ComfyUI 불필요.
====================================================================
태그(스타일)+가사+길이로 음악(wav)을 만들어 돌려주는 초경량 HTTP 서버.
OmniVoice(9881)·Qwen보이스디자인(9893) 과 같은 온디맨드 로컬 서버 패턴. 기본 포트 9894.

앱(Electron)이 음악 만들 때만 이 서버를 켜고(모델 GPU 로딩), 끝나면 끈다.
그동안 앱은 음성변환(OmniVoice 합성)을 막아(뮤텍스) VRAM 동시 사용을 피한다.

엔드포인트
  GET  /health    → {"status":"ok","loaded":bool,"loading":bool,"error":str|null}
  POST /generate  본문 JSON {"tags":"...", "lyrics":"...", "durationSec":180,
                            "inferStep":60, "guidanceScale":15} → audio/wav 바이트
  POST /shutdown  → 서버 종료(앱이 프로세스를 직접 kill 해도 됨)

모델(3.5B, 약 14GB)은 첫 실행 시 ~/.cache/ace-step 로 자동 다운로드.
"""
import argparse
import json
import os
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── Windows symlink 권한 회피 (WinError 1314) ───────────────────────────────
# HuggingFace 캐시는 기본적으로 symlink 를 쓰는데, 윈도우에서 개발자모드/관리자가 아니면
# os.symlink 이 WinError 1314 로 실패하고 huggingface_hub 이 이를 못 잡아 다운로드가 크래시한다.
# are_symlinks_supported 를 False 로 고정 → HF 가 symlink 대신 파일 복사를 쓰게 해 권한 없이도 동작.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
try:
    import huggingface_hub.file_download as _hf_fd
    _hf_fd.are_symlinks_supported = lambda *a, **k: False
except Exception:
    pass

# ── torchaudio.save → soundfile 대체 ────────────────────────────────────────
# torchaudio 2.12 는 save 시 torchcodec(+FFmpeg) 을 요구하는데 미설치면 크래시한다.
# ACE-Step 이 torchaudio.save(path, waveform, sr) 로 wav 를 저장하므로, 이미 설치된
# soundfile 로 저장하도록 교체(추가 설치 불필요).
try:
    import torchaudio as _ta
    import soundfile as _sf
    import numpy as _np

    def _ta_save_sf(uri, src, sample_rate, channels_first=True, **kwargs):
        a = src.detach().cpu().float().numpy() if hasattr(src, "detach") else _np.asarray(src)
        if a.ndim == 2 and channels_first:
            a = a.T  # (channels, frames) → (frames, channels)
        _sf.write(str(uri), a, int(sample_rate))

    _ta.save = _ta_save_sf
except Exception:
    pass

_STATE = {"model": None, "loading": False, "loaded": False, "error": None}
_LOCK = threading.Lock()  # 생성은 한 번에 하나만(GPU 직렬화)

CKPT_DIR = None       # None = 자동 다운로드(~/.cache/ace-step)
CPU_OFFLOAD = False   # True 면 VRAM 절약(느려짐)


def _load_model():
    _STATE["loading"] = True
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline
        print(f"[ace-step] loading model (bfloat16, cpu_offload={CPU_OFFLOAD}) …", flush=True)
        model = ACEStepPipeline(
            checkpoint_dir=CKPT_DIR,
            dtype="bfloat16",
            torch_compile=False,
            cpu_offload=CPU_OFFLOAD,
            overlapped_decode=False,
        )
        _STATE["model"] = model
        _STATE["loaded"] = True
        print("[ace-step] model loaded - ready", flush=True)
    except Exception as e:
        _STATE["error"] = f"{type(e).__name__}: {e}"
        print("[ace-step] model load FAILED:\n" + traceback.format_exc(), flush=True)
    finally:
        _STATE["loading"] = False


_INST_MARKERS = {"", "(instrumental)", "instrumental", "[instrumental]", "[inst]",
                 "(연주곡)", "연주곡", "(inst)", "no vocals", "보컬 없음"}


def _norm_lyrics(lyrics):
    """가사가 비었거나 연주곡 표시면 ACE-Step 전용 태그 '[instrumental]' 로 강제한다.
    (빈 가사를 그냥 넘기면 ACE-Step 이 임의 가사(기본 중국어)를 만들어 부른다.)"""
    s = (lyrics or "").strip()
    if s.lower() in _INST_MARKERS:
        return "[instrumental]"
    return s


def _generate(tags, lyrics, duration, infer_step, guidance_scale):
    model = _STATE["model"]
    if model is None:
        raise RuntimeError("model not loaded")
    lyrics = _norm_lyrics(lyrics)
    fd, out_path = tempfile.mkstemp(suffix=".wav", prefix="acestep_")
    os.close(fd)
    with _LOCK:
        model(
            audio_duration=float(duration),
            prompt=tags or "",
            lyrics=lyrics or "[instrumental]",
            infer_step=int(infer_step),
            guidance_scale=float(guidance_scale),
            scheduler_type="euler",
            cfg_type="apg",
            omega_scale=10.0,
            save_path=out_path,
        )
    return out_path


class Handler(BaseHTTPRequestHandler):
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
            self._json(200, {"status": "ok", "loaded": bool(_STATE["loaded"]),
                             "loading": bool(_STATE["loading"]), "error": _STATE["error"]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path == "/shutdown":
            self._json(200, {"status": "bye"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path != "/generate":
            self._json(404, {"error": "not found"})
            return
        if not _STATE["loaded"]:
            self._json(503, {"error": "모델 로딩 중 또는 실패", "loading": _STATE["loading"], "detail": _STATE["error"]})
            return
        out_path = None
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(ln).decode("utf-8")) if ln else {}
            tags = (req.get("tags") or "").strip()
            lyrics = (req.get("lyrics") or "").strip()
            duration = float(req.get("durationSec") or 180)
            infer_step = int(req.get("inferStep") or 60)
            gscale = float(req.get("guidanceScale") or 15)
            if not tags:
                self._json(400, {"error": "tags(스타일)가 비어 있음"})
                return
            print(f"[ace-step] generate: {duration:.0f}s | {tags[:60]}", flush=True)
            out_path = _generate(tags, lyrics, duration, infer_step, gscale)
            with open(out_path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            print(f"[ace-step] done ({len(data)} bytes)", flush=True)
        except Exception as e:
            print("[ace-step] /generate ERROR:\n" + traceback.format_exc(), flush=True)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
        finally:
            try:
                if out_path and os.path.exists(out_path):
                    os.remove(out_path)
            except Exception:
                pass


def main():
    global CKPT_DIR, CPU_OFFLOAD
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9894)
    ap.add_argument("--checkpoint", default=None, help="체크포인트 폴더(미지정=자동 다운로드)")
    ap.add_argument("--cpu-offload", action="store_true", help="VRAM 절약(느려짐)")
    args = ap.parse_args()
    CKPT_DIR = args.checkpoint
    CPU_OFFLOAD = bool(args.cpu_offload)

    threading.Thread(target=_load_model, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[ace-step] server up: http://{args.host}:{args.port}  (health/generate/shutdown)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    print("[ace-step] server stopped", flush=True)


if __name__ == "__main__":
    main()
