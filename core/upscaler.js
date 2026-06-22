/**
 * upscaler.js — 비디오 업스케일 (480p/720p → 1080p)
 *
 *  1순위: Real-ESRGAN ncnn-vulkan (애니/일러스트 모델 realesr-animevideov3) — RTX 3060 등 Vulkan GPU.
 *         프레임 추출 → AI 업스케일 → 원본 fps·오디오로 재조립.
 *  폴백 : ffmpeg lanczos + unsharp (무GPU·즉시).
 *
 *  Real-ESRGAN 실행파일은 최초 1회 자동 다운로드 → ~/.shots-maker/realesrgan/.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch {}

let _ffmpeg = null;
try {
  _ffmpeg = require('ffmpeg-static');
  if (_ffmpeg && _ffmpeg.includes('app.asar') && !_ffmpeg.includes('app.asar.unpacked')) {
    _ffmpeg = _ffmpeg.replace('app.asar', 'app.asar.unpacked');
  }
} catch {}

const RE_DIR = path.join(os.homedir(), '.shots-maker', 'realesrgan');
const RE_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const RE_EXE_NAME = 'realesrgan-ncnn-vulkan.exe';

// 디렉토리에서 실행파일 재귀 검색 (zip 구조가 서브폴더일 수 있음)
function _findExe(dir) {
  let hit = null;
  const walk = (d) => {
    if (hit) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase() === RE_EXE_NAME) hit = p;
    }
  };
  walk(dir);
  return hit;
}

function realesrganExe() { return _findExe(RE_DIR); }

// GitHub releases 리다이렉트 추적 다운로드
function _download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('리다이렉트 과다')); return; }
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'shots-maker' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        resolve(_download(res.headers.location, dest, depth + 1));
        return;
      }
      if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dest); } catch {} reject(new Error('HTTP ' + res.statusCode)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    req.setTimeout(120000, () => { req.destroy(new Error('다운로드 시간초과')); });
  });
}

// Real-ESRGAN 준비 (없으면 다운로드+압축해제). 성공 시 exe 경로, 실패 시 null.
async function ensureRealesrgan(logger) {
  const log = logger || (() => {});
  let exe = realesrganExe();
  if (exe) return exe;
  if (!AdmZip) { log('[업스케일] adm-zip 없음 — Real-ESRGAN 자동설치 불가'); return null; }
  try {
    fs.mkdirSync(RE_DIR, { recursive: true });
    const zipPath = path.join(RE_DIR, '_re.zip');
    log('[업스케일] Real-ESRGAN 최초 다운로드 중 (~30MB, 1회만)…');
    await _download(RE_URL, zipPath);
    log('[업스케일] 압축 해제 중…');
    new AdmZip(zipPath).extractAllTo(RE_DIR, true);
    try { fs.unlinkSync(zipPath); } catch {}
    exe = realesrganExe();
    if (exe) log('[업스케일] Real-ESRGAN 준비 완료'); else log('[업스케일] 압축 해제 후 실행파일 없음');
    return exe;
  } catch (e) { log('[업스케일] Real-ESRGAN 준비 실패: ' + e.message); return null; }
}

// 입력 mp4 의 fps 추출 (ffmpeg stderr 파싱, 실패 시 24)
function _getFps(input) {
  try {
    const r = spawnSync(_ffmpeg, ['-i', input], { encoding: 'utf8' });
    const s = (r.stderr || '') + (r.stdout || '');
    const m = s.match(/([\d.]+)\s*fps/);
    if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 240) return v; }
  } catch {}
  return 24;
}

/**
 * 비디오 업스케일 → output (정확히 width×height).
 * opts: { width=1080, height=1920, model='realesr-animevideov3', scale=2, logger, autoDownload=true, abortSignal }
 * 반환: { ok, method: 'realesrgan'|'ffmpeg' }
 */
async function upscaleVideo(input, output, opts = {}) {
  const log = opts.logger || (() => {});
  if (!_ffmpeg) throw new Error('ffmpeg 미설치');
  if (!fs.existsSync(input)) throw new Error('입력 영상 없음: ' + input);
  const W = opts.width || 1080, H = opts.height || 1920;
  const model = opts.model || 'realesr-animevideov3';
  const scale = String(opts.scale || 2);

  let exe = realesrganExe();
  if (!exe && opts.autoDownload !== false) exe = await ensureRealesrgan(log);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm_up_'));
  const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir); fs.mkdirSync(outDir);
  try {
    if (exe) {
      // 1) 프레임 추출
      spawnSync(_ffmpeg, ['-y', '-i', input, path.join(inDir, '%08d.png')], { stdio: 'ignore' });
      const nframes = fs.readdirSync(inDir).filter((f) => f.endsWith('.png')).length;
      if (nframes > 0 && !(opts.abortSignal && opts.abortSignal())) {
        const fps = _getFps(input);
        log(`[업스케일] ${nframes}프레임 (${fps}fps) → Real-ESRGAN(${model} ${scale}x)…`);
        // 2) AI 업스케일 (폴더 일괄)
        const r = spawnSync(exe, ['-i', inDir, '-o', outDir, '-n', model, '-s', scale, '-f', 'png'], { stdio: 'ignore' });
        const okFrames = (() => { try { return fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length; } catch { return 0; } })();
        if (r.status === 0 && okFrames >= nframes * 0.9) {
          // 3) 재조립 + 정확 해상도 + 원본 오디오
          const rr = spawnSync(_ffmpeg, ['-y', '-framerate', String(fps), '-i', path.join(outDir, '%08d.png'),
            '-i', input, '-map', '0:v:0', '-map', '1:a:0?',
            '-vf', `scale=${W}:${H}:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
            '-c:a', 'copy', '-shortest', output], { stdio: 'ignore' });
          if (rr.status === 0 && fs.existsSync(output)) { log(`[업스케일] ✅ Real-ESRGAN ${W}x${H} 완료`); return { ok: true, method: 'realesrgan' }; }
          log('[업스케일] 재조립 실패 — ffmpeg 폴백');
        } else {
          log(`[업스케일] Real-ESRGAN 결과 부족(${okFrames}/${nframes}) — ffmpeg 폴백`);
        }
      }
    }
    // 폴백: ffmpeg lanczos + unsharp (AI 아님)
    log('[업스케일] ffmpeg lanczos 업스케일(폴백)…');
    const r2 = spawnSync(_ffmpeg, ['-y', '-i', input,
      '-vf', `scale=${W}:${H}:flags=lanczos,unsharp=5:5:0.8:5:5:0.0`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'copy', output], { stdio: 'ignore' });
    if (r2.status === 0 && fs.existsSync(output)) { log(`[업스케일] ✅ ffmpeg ${W}x${H} 완료 (보간, AI 아님)`); return { ok: true, method: 'ffmpeg' }; }
    throw new Error('ffmpeg 업스케일 실패');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { upscaleVideo, ensureRealesrgan, realesrganExe };
