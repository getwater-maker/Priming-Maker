/**
 * vrew-builder — Project (sentences + groups) → .vrew
 *
 * Vrew 4.0.1 음성 정상 형식 (test.vrew 분석 결과):
 *   - ttsDubbing 트랙 사용 안 함 (이게 음성 무음의 원인이었음)
 *   - ttsClip 트랙이 실제 음성 mp3 의 mediaId 를 직접 가리킴
 *   - 한 sentence 의 N sub-clip = N ttsClip 트랙, 같은 mediaId, sourceIn/sourceOut 으로 시간 슬라이스
 *   - volume: 1 (NOT 0 — 0 은 음소거)
 *   - dummy mp3 / TTS_DUBBING 파일 등록 X
 *
 *   - 1 sub-clip = 1 transcript clip (사용자 요구)
 *   - clip.words = [N type:0 word + 1 type:2 종료 마커]  ← Vrew 본가 STT 형식
 *     · 각 word 가 자기 ttsClip 트랙의 asset 을 가리킴 (단어 단위 자막 표시)
 *     · 같은 sentence audio 의 sourceIn/sourceOut 시간 슬라이스 (mp3 한 개 공유)
 *     · 단어 timing 은 글자수 비율로 추정 (PrimingFlow 는 STT 안 씀)
 *   - clip.captions = sub-clip 텍스트 (한 줄로 통합 표시)
 *   - clip.assetIds = [imageAid] (그룹 이미지)
 *   - 그룹 = 1 image 트랙 + 1 image asset (role:'sub'). 그룹 내 모든 clip 이 같은 asset 공유
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { splitLongSentenceAlgo } = require('../core/long-sentence-splitter/algo-splitter');
const { splitCaptionLines, meaningfulLen } = require('../core/caption-splitter');

// ffmpeg 바이너리 경로 (ffmpeg-static 패키지). asar 패키징 시
// app.asar.unpacked 로 풀려 있어야 spawn 가능 — package.json asarUnpack 참고.
let _ffmpegPath = null;
try {
  _ffmpegPath = require('ffmpeg-static');
  // Electron asar 환경에서 unpacked 경로로 보정
  if (_ffmpegPath && _ffmpegPath.includes('app.asar') && !_ffmpegPath.includes('app.asar.unpacked')) {
    _ffmpegPath = _ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch (_) {}

// wav → mp3 (libmp3lame, 192kbps, 24kHz mono — OmniVoice 출력 그대로 인코딩)
// .vrew 호환성 향상 (Vrew 가 mp3 권장 형식). 실패 시 false.
function wavToMp3(wavPath, mp3Path) {
  if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) return false;
  try {
    const r = spawnSync(_ffmpegPath, [
      '-y', '-i', wavPath,
      '-codec:a', 'libmp3lame',
      '-b:a', '192k',
      '-ar', '24000', '-ac', '1',
      mp3Path,
    ], { stdio: 'pipe' });
    return r.status === 0 && fs.existsSync(mp3Path);
  } catch (_) {
    return false;
  }
}

// 모든 WAV 문장을 MP3 로 **병렬** 사전 변환 (동시 N개). 반환: Map<wavPath, mp3Path>.
// 기존엔 빌드 루프에서 spawnSync 로 1개씩 직렬 변환 → 366개면 ~9분. 이걸 비동기 spawn 병렬로
// 바꿔 수십 초로 단축 + 변환 중 메인 스레드가 양보되어 진행률 UI 도 갱신됨. (MP3 출력 유지 = 형식 안전)
async function preConvertWavsToMp3(sentences, log, concurrency = 8) {
  const { spawn } = require('child_process');
  const map = new Map();
  if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) return map;  // ffmpeg 없으면 루프가 wav 그대로 폴백
  const uniq = [...new Set(
    (sentences || [])
      .map(s => s && s.ttsAudioPath)
      .filter(p => p && path.extname(p).toLowerCase() === '.wav' && fs.existsSync(p))
  )];
  if (!uniq.length) return map;
  log(`[Vrew] WAV→MP3 병렬 변환 시작 — ${uniq.length}개 (동시 ${concurrency})`);

  let idx = 0, done = 0;
  const convertOne = (wavPath) => new Promise((resolve) => {
    const mp3Path = path.join(os.tmpdir(), `pf_tts_${sid()}.mp3`);
    let p;
    try {
      p = spawn(_ffmpegPath, [
        '-y', '-i', wavPath,
        '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '24000', '-ac', '1',
        mp3Path,
      ], { stdio: 'ignore' });
    } catch (_) { done++; return resolve(); }
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp3Path)) map.set(wavPath, mp3Path);
      done++;
      if (done % 20 === 0 || done === uniq.length) log(`[Vrew] WAV→MP3 변환 ${done}/${uniq.length}`);
      resolve();
    });
    p.on('error', () => { done++; resolve(); });
  });

  const worker = async () => { while (idx < uniq.length) { await convertOne(uniq[idx++]); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, worker));
  log(`[Vrew] WAV→MP3 변환 완료 — 성공 ${map.size}/${uniq.length}`);
  return map;
}

// Vrew 본가가 STT 로 만드는 word 단위 자막을 흉내 — 공백 기준 어절 분리.
// 빈 입력은 [원문] 그대로 1개 토큰으로 처리해 트랙이 깨지지 않게 함.
function splitWordsForVrew(text) {
  const t = String(text || '').trim();
  if (!t) return [''];
  const tokens = t.split(/\s+/).filter(s => s.length > 0);
  return tokens.length > 0 ? tokens : [t];
}

const TEMPLATE_PATH = path.join(__dirname, '..', 'vrew-template.json');
const VREW_MAX_CHARS = 20;

const FIXED_MP4_MEDIA_ID = '10000000-0000-0000-0000';

// AI 고지 자막 (Vrew 시스템 텍스트박스)
const TEXTBOX_MEDIA_ID = 'uc-0010-simple-textbox';
const TEXTBOX_DUMMY_BIN = path.join(__dirname, 'dummy', 'uc-0010-simple-textbox.bin');
const TEXTBOX_DUMMY_META = path.join(__dirname, 'dummy', 'uc-0010-simple-textbox.meta.json');

// 도형(제목 배경) — Vrew shape 트랙 + Svg(.vbin) 템플릿 (사용자 .vrew 분석 형식)
const SHAPE_VBIN = path.join(__dirname, 'dummy', 'shape-square.vbin');
// #RRGGBB + 불투명도(0~100) → #RRGGBBAA
function _hex8(color6, opacityPct) {
  let c = String(color6 || '#000000').replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  c = c.slice(0, 6).padEnd(6, '0');
  const a = Math.max(0, Math.min(255, Math.round((Number(opacityPct) || 0) / 100 * 255)));
  return '#' + c + a.toString(16).padStart(2, '0');
}

// 채널 로고 오버레이 프리셋
const LOGO_POSITION_PRESETS = {
  'top-left':     { anchorX: 'left',  anchorY: 'top',    margin: 0.02 },
  'top-right':    { anchorX: 'right', anchorY: 'top',    margin: 0.02 },
  'bottom-left':  { anchorX: 'left',  anchorY: 'bottom', margin: 0.02 },
  'bottom-right': { anchorX: 'right', anchorY: 'bottom', margin: 0.02 },
};
const LOGO_SIZE_PRESETS = {
  small:  { width: 0.10, height: 0.10 },
  medium: { width: 0.15, height: 0.15 },
  large:  { width: 0.20, height: 0.20 },
};

// mp4 헤더(moov/trak/tkhd/mvhd) 직접 파싱 — width/height/duration 추출.
// grok-store 추정값(1280x720) 이 실제 영상(예: 1280x704) 과 어긋나면 Vrew 가
// 메타와 실제 frame 차이만큼 흰 letterbox 띠를 그리므로 정확한 값이 필요.
// 이미지 실제 픽셀 크기 (PNG/JPEG 헤더 파싱, 의존성 없음). 실패 시 null.
function readImageSize(p) {
  try {
    const b = fs.readFileSync(p);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // PNG
    if (b[0] === 0xFF && b[1] === 0xD8) { // JPEG
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        let m = b[i + 1];
        while (m === 0xFF && i + 1 < b.length) { i++; m = b[i + 1]; }
        if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        }
        const len = b.readUInt16BE(i + 2); i += 2 + len;
      }
    }
    return null;
  } catch { return null; }
}

// ffmpeg -i 로 해상도/길이 추출 — moov 가 파일 끝에 있는 mp4(ffmpeg 인코딩/업스케일·Grok 출력 등)
// 에서 헤더 박스 파싱이 실패할 때의 신뢰 폴백.
function ffmpegVideoMeta(filePath) {
  if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) return null;
  try {
    const r = spawnSync(_ffmpegPath, ['-hide_banner', '-i', filePath], { encoding: 'utf8' });
    const txt = (r.stderr || '') + (r.stdout || '');
    const m = txt.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
    if (!m) return null;
    const out = { width: parseInt(m[1], 10), height: parseInt(m[2], 10), duration: 0 };
    const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (dm) out.duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
    return (out.width > 0 && out.height > 0) ? out : null;
  } catch (_) { return null; }
}

function readMp4VideoMeta(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const bufSize = Math.min(stat.size, 4 * 1024 * 1024); // 첫 4MB 면 moov 포함 충분(faststart)
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, 0);
    const out = { width: 0, height: 0, duration: 0 };
    walkMp4Boxes(buf, 0, buf.length, out);
    if (out.width > 0 && out.height > 0) return out;
  } catch (_) {
    /* 박스 파싱 실패 → 아래 ffmpeg 폴백 */
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  // moov 가 파일 끝에 있는 mp4 → ffmpeg 로 정확히 추출
  return ffmpegVideoMeta(filePath);
}

function walkMp4Boxes(buf, off, end, out) {
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) break;
    const body = off + headerSize;
    const bodyEnd = off + size;

    if (type === 'moov' || type === 'trak' || type === 'mdia' ||
        type === 'minf' || type === 'stbl') {
      walkMp4Boxes(buf, body, bodyEnd, out);
    } else if (type === 'mvhd') {
      const v = buf.readUInt8(body);
      let p = body + 4; // version(1) + flags(3)
      if (v === 0) {
        p += 4 + 4; // creation, modification
        const timescale = buf.readUInt32BE(p); p += 4;
        const duration  = buf.readUInt32BE(p);
        if (timescale > 0) out.duration = duration / timescale;
      } else if (v === 1) {
        p += 8 + 8; // creation, modification (64-bit)
        const timescale = buf.readUInt32BE(p); p += 4;
        const duration  = Number(buf.readBigUInt64BE(p));
        if (timescale > 0) out.duration = duration / timescale;
      }
    } else if (type === 'tkhd') {
      const v = buf.readUInt8(body);
      // version 0: creation(4)+modification(4)+track_id(4)+reserved(4)+duration(4)+reserved2(8) = 28
      // version 1: creation(8)+modification(8)+track_id(4)+reserved(4)+duration(8)+reserved2(8) = 40
      // 그 후 layer(2)+alt_group(2)+volume(2)+reserved(2)+matrix(36) = 44
      // 마지막에 width(4)+height(4) (16.16 fixed point)
      let p = body + 4;
      if (v === 0)      p += 28 + 44;
      else if (v === 1) p += 40 + 44;
      else              { off += size; continue; }
      if (p + 8 > bodyEnd) { off += size; continue; }
      const w = buf.readUInt32BE(p) / 65536;
      const h = buf.readUInt32BE(p + 4) / 65536;
      // 비디오 트랙만 width/height > 0 (오디오 트랙은 0)
      if (w > 0 && h > 0) {
        out.width  = Math.round(w);
        out.height = Math.round(h);
      }
    }
    off += size;
  }
}

const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
const sid = () => uid().replace(/-/g, '').substring(0, 10);

// 자막 글자 속성 (사용자가 영상.vrew 에서 검증한 값 — 100pt 가 1080p 에서 적정)
const CAPTION_ATTRS = {
  font: 'Pretendard-Vrew_700', size: '90', color: '#ffffff',
  'outline-on': 'true', 'outline-color': '#000000', 'outline-width': '6',
};

// 자막 박스 위치/정렬 — 사용자가 Vrew 4.0.1에서 직접 설정한 .vrew 분석으로 확정한 값.
//   ★ 위치는 clips[i].captions[j].style 가 지배(전역 globalCaptionStyle 아님).
//   가운데 = yAlign:'middle', yOffset:0. 미세조정(Vrew 슬라이더) N → yOffset = N*0.0025 (예: 80→0.2, +=아래).
//   좌우 가운데 = --textbox-align:'center', xOffset 0. 폰트 size '90'(쇼츠 기본).
//   width 0.96, textbox 배경 투명. scaleFactor 는 9:16=0.5625 로 빌드시 갱신.
const CAPTION_STYLE = {
  mediaId: 'uc-0010-simple-textbox',
  yAlign: 'middle',
  yOffset: 0,
  xOffset: 0,
  rotation: 0,
  width: 0.96,
  customAttributes: [
    { attributeName: '--textbox-color', type: 'color-hex', value: 'rgba(0, 0, 0, 0)' },
    { attributeName: '--textbox-align', type: 'textbox-align', value: 'center' },
  ],
  scaleFactor: 1.7777777777777777,
};

const DEFAULT_SPEAKER = {
  gender: 'female', age: 'middle', provider: 'vrew', lang: 'ko-KR',
  name: 'butter_f', speakerId: 'characteristic2', badge: 'Recommended',
  tags: ['_characteristic', 'cheesy', 'badgirl'],
  versions: ['v4'], isUnavailable: false,
};

// 켄번스 패턴 풀 — 12개(줌2·팬4·대각4·코너푸시2)로 확장, 시선 집중·다양성↑.
// ★ Vrew 좌표: scale = "이미지에서 보이는 영역의 비율"(1.0=전체, 작을수록 줌인).
//   크롭창이 이미지를 벗어나면(=center 가 [scale/2, 1−scale/2] 밖) 뒤 검정이 노출됨.
//   아래 패턴은 전부 그 안전범위 안에서 설계 + _kenBurnsFor 가 한 번 더 클램프(안전망).
const KEN_BURNS_PATTERNS = [
  // 0) 중앙 슬로우 줌인 (전체 → 확대)
  { from: { scale: 0.95, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.62, centerX: 0.50, centerY: 0.50 } },
  // 1) 중앙 줌아웃 (확대 → 전체)
  { from: { scale: 0.62, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.95, centerX: 0.50, centerY: 0.50 } },
  // 2) 좌 → 우 가로 팬 (줌 고정)
  { from: { scale: 0.66, centerX: 0.34, centerY: 0.50 }, to: { scale: 0.66, centerX: 0.66, centerY: 0.50 } },
  // 3) 우 → 좌 가로 팬
  { from: { scale: 0.66, centerX: 0.66, centerY: 0.50 }, to: { scale: 0.66, centerX: 0.34, centerY: 0.50 } },
  // 4) 하 → 상 세로 팬
  { from: { scale: 0.66, centerX: 0.50, centerY: 0.66 }, to: { scale: 0.66, centerX: 0.50, centerY: 0.34 } },
  // 5) 상 → 하 세로 팬
  { from: { scale: 0.66, centerX: 0.50, centerY: 0.34 }, to: { scale: 0.66, centerX: 0.50, centerY: 0.66 } },
  // 6) 좌상 → 중앙 대각 줌인
  { from: { scale: 0.70, centerX: 0.37, centerY: 0.37 }, to: { scale: 0.80, centerX: 0.50, centerY: 0.50 } },
  // 7) 우상 → 중앙 대각 줌인
  { from: { scale: 0.70, centerX: 0.63, centerY: 0.37 }, to: { scale: 0.80, centerX: 0.50, centerY: 0.50 } },
  // 8) 좌하 → 중앙 대각 줌인
  { from: { scale: 0.70, centerX: 0.37, centerY: 0.63 }, to: { scale: 0.80, centerX: 0.50, centerY: 0.50 } },
  // 9) 우하 → 중앙 대각 줌인
  { from: { scale: 0.70, centerX: 0.63, centerY: 0.63 }, to: { scale: 0.80, centerX: 0.50, centerY: 0.50 } },
  // 10) 전체 → 우상 코너로 푸시인
  { from: { scale: 0.92, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.60, centerX: 0.62, centerY: 0.40 } },
  // 11) 전체 → 좌하 코너로 푸시인
  { from: { scale: 0.92, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.60, centerX: 0.38, centerY: 0.60 } },
];

// 인접 그룹이 같은 패턴을 받지 않도록 의사 난수 시퀀스 (소수 곱셈 + 오프셋).
// 곱수 7 은 풀 길이 12 와 서로소 → 인덱스가 0~11 전부 비반복 순회.
function _pickKenBurnsIndex(groupIdx) {
  const len = KEN_BURNS_PATTERNS.length;
  return ((groupIdx * 7) + 3) % len;
}

// ★ 검정 방지 클램프: scale 은 (0,1] (1 초과면 이미지보다 큰 영역 = 검정), center 는
//   크롭창이 이미지 안에 머물도록 [scale/2, 1−scale/2] 로 접음. 손으로 쓴 패턴이 범위를
//   벗어나도(또는 향후 수정으로) 절대 뒤 배경이 노출되지 않게 하는 안전망.
function _clampKbFrame(f) {
  const s = Math.min(1, Math.max(0.2, Number(f.scale) || 1));
  const m = s / 2;
  const clamp = (v, d) => Math.min(1 - m, Math.max(m, (v == null ? d : Number(v))));
  return { scale: s, centerX: clamp(f.centerX, 0.5), centerY: clamp(f.centerY, 0.5) };
}
function _kenBurnsFor(groupIdx) {
  const kb = KEN_BURNS_PATTERNS[_pickKenBurnsIndex(groupIdx)];
  return { from: _clampKbFrame(kb.from), to: _clampKbFrame(kb.to) };
}

function ttsCleanText(text) {
  return String(text)
    .replace(/[–—⸻]/g, ' ')
    .replace(/[\x00-\x19]/g, '')
    .replace(/[ -‒―-⯿]/g, '')
    .replace(/[〃-〿゙-゜]/g, '')
    .replace(/[()*\/+:;<=>[\\\]^_{|}~@`]/g, '')
    .replace(/[《》〈〉「」]/g, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ').trim();
}

function estimateAudioDuration(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.wav') return Math.max(0.5, (stat.size - 44) / 48000);
    return Math.max(0.5, stat.size / 6000);
  } catch { return 1.0; }
}

// AI 고지 자막 트랙 추가 (Vrew 4.0.1 web 텍스트박스)
function addAiNoticeTrack(pj, opt, clipDurations, log, frameRatio) {
  const text = String(opt.text || '').trim();
  if (!text) {
    log('[Vrew] AI 고지 자막 텍스트 비어있음 — 트랙 생략');
    return null;
  }

  // startDelay (ms) 계산
  let startDelayMs = 0;
  if (opt.startMode === 'seconds') {
    startDelayMs = Math.max(0, Math.round((parseFloat(opt.startSeconds) || 0) * 1000));
  } else {
    // 'clip' 모드 — 1-based, startClip 의 시작 시점 = clip[0..startClip-2] duration 합
    const n = Math.max(1, parseInt(opt.startClip || 1, 10)) - 1;
    let acc = 0;
    for (let i = 0; i < Math.min(n, clipDurations.length); i++) acc += clipDurations[i];
    startDelayMs = Math.round(acc * 1000);
  }
  const durationSeconds = Math.max(0, parseFloat(opt.durationSeconds) || 0); // 0 = 끝까지

  // zIndex — image 트랙 최상단 위에 한 칸. 사용자가 직접 추가한 .vrew 형식과 일치.
  const imageZs = Object.values(pj.props.tracks)
    .filter(t => t.type === 'image')
    .map(t => Number.isFinite(t.zIndex) ? t.zIndex : 0);
  const webZIndex = (imageZs.length ? Math.max(...imageZs) : 0) + 2;

  const tid = sid();

  // 색상 처리 — 사용자가 .vrew 파일을 분석해 확인한 표준 형식:
  //   fontColor    — 텍스트 색 (default #FFFFFF)
  //   outlineColor — 외곽선 색
  //   outlineNone  — true 면 outline-on:'false' 로 외곽선 비활성
  //   bgColor      — 배경 색 (6자리 hex 그대로 = 100% 불투명)
  //   bgNone       — true 면 --textbox-color attribute 자체를 제거해 투명 처리.
  //                  (이전엔 '#00000000' 으로 보냈는데 Vrew 4.0.1 의 color-hex 가
  //                   8자리 hex 를 인식 못 하고 흰색 default 로 fallback 되는 문제)
  const fontColor    = String(opt.fontColor    || opt.color || '#FFFFFF');
  const outlineColor = String(opt.outlineColor || '#000000');
  const bgRaw        = String(opt.bgColor      || '#FFFFFF').toLowerCase();
  const bgNone       = !!opt.bgNone;
  const outlineNone  = !!opt.outlineNone;

  const textAttrs = {
    size: String(opt.fontSize || '75'),
    color: fontColor,
    font: 'Pretendard-Vrew_700',
    'outline-color': outlineColor,
    'outline-on': outlineNone ? 'false' : 'true',
    'outline-width': '6',
    ...(opt.bold   ? { bold: true }   : {}),
    ...(opt.italic ? { italic: true } : {}),
  };

  // customAttributes — bgNone 처리.
  // 사용자가 Vrew 에서 직접 "배경 없음" 으로 만든 영상.vrew 와 동일한 형식 사용:
  //   { type: 'color-hex', value: '#00000000' }  (alpha=00 의 8자리 hex)
  // 옛 코드의 color-rgba 'rgba(0,0,0,0)' + textbox-bg-opacity 조합은 Vrew 4.0.1 일부 경로에서
  // 흰색 fallback 되는 결함이 있었음. 검증된 hex 표기로 통일.
  const customAttributes = [
    { attributeName: '--textbox-align', type: 'textbox-align', value: 'start' },
  ];
  if (bgNone) {
    customAttributes.unshift({ attributeName: '--textbox-color', type: 'color-hex', value: '#00000000' });
  } else {
    customAttributes.unshift({ attributeName: '--textbox-color', type: 'color-hex', value: bgRaw });
  }

  pj.props.tracks[tid] = {
    trackId: tid,
    mediaId: TEXTBOX_MEDIA_ID,
    xPos: 0.02, yPos: 0.047,
    height: 0, width: 0.6,
    rotation: 0, zIndex: webZIndex,
    type: 'web',
    deltas: {
      textarea: {
        ops: [
          { insert: text, attributes: textAttrs },
          { insert: '\n' },
        ],
      },
    },
    loop: true,
    durationSeconds,
    importType: 'copy_and_paste',
    enabledInlineTypes: ['bold','italic','font','size','color','background','outline-color','shadow-color'],
    customAttributes,
    assetEffectInfo: { type: 'fade-in', duration: opt.fadeMs || 1500, startDelay: startDelayMs },
    stats: { styledInFloatingMenu: true, styledInPanel: false },
    scaleFactor: frameRatio || 1.7777777777777777,
  };

  const aid = uid();
  pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };

  // files[] 에 Html 항목 등록 (이미 있으면 skip)
  if (!pj.files.find(f => f.mediaId === TEXTBOX_MEDIA_ID)) {
    if (fs.existsSync(TEXTBOX_DUMMY_META)) {
      const meta = JSON.parse(fs.readFileSync(TEXTBOX_DUMMY_META, 'utf-8'));
      pj.files.push(meta);
    } else {
      log('[Vrew] dummy/uc-0010-simple-textbox.meta.json 누락 — files[] Html 항목 미등록');
    }
  }

  // 노출 구간에 해당하는 clip 들에만 web asset 추가.
  // Vrew 4.0.1 의 web 트랙 durationSeconds 필드는 영상 끝까지 무한 재생되므로,
  // 노출 종료 컨트롤은 clip.assetIds link 를 노출 구간에 한정하는 방식으로 처리.
  // durationSeconds === 0 → 끝까지 (모든 clip 에 추가).
  const visibleStartMs = startDelayMs;
  const visibleEndMs = durationSeconds > 0
    ? startDelayMs + durationSeconds * 1000
    : Infinity;

  // 🔑 노출 시작(startSeconds)은 assetEffectInfo.startDelay 가 영상 시작 기준 '절대시간'으로 처리한다.
  //    그래서 asset 은 반드시 0번 clip 부터 연결해야 startDelay 가 영상 0초 기준으로 동작 → 정확히 5초에 등장.
  //    (예전엔 [start,end] 와 겹치는 clip 만 연결 → 첫 clip 시작(~4초) + startDelay(5초) = ~9초 등장 버그)
  //    종료는 '노출 종료(visibleEnd)' 를 포함하는 clip 까지만 연결 → 그 clip 끝나면 사라짐(clip 단위).
  let cumMs = 0;
  let linkedClipCount = 0;
  for (let i = 0; i < pj.transcript.clips.length; i++) {
    const c = pj.transcript.clips[i];
    const clipStartMs = cumMs;
    const clipDurMs = (clipDurations[i] || 0) * 1000;
    const clipEndMs = clipStartMs + clipDurMs;
    // 0번 clip ~ 노출종료를 포함하는 clip 까지 연결 (시작은 startDelay 가 5초로 띄움).
    const link = clipStartMs < visibleEndMs;
    if (link) {
      if (!Array.isArray(c.assetIds)) c.assetIds = [];
      if (!c.assetIds.includes(aid)) c.assetIds.push(aid);
      linkedClipCount++;
    }
    cumMs = clipEndMs;
  }

  log(`[Vrew] AI 고지 자막 추가: "${text.substring(0, 30)}..." startDelay=${startDelayMs}ms duration=${durationSeconds === 0 ? '끝까지' : durationSeconds + 's'} → ${linkedClipCount}/${pj.transcript.clips.length} clips link, zIndex=${webZIndex}`);
  return { trackId: tid, assetId: aid };
}

// 제목 배경 도형 (shape 트랙 + Svg .vbin). 제목 줄을 덮는 박스. 색/테두리/모서리/점선 조절.
//   세로 = 제목 시작~끝, 가로 = 제목 폰트크기·글자수 비례 (사용자 요구). 제목보다 아래(zIndex).
function addShapeTrack(pj, bg, t, frameRatio, mediaZip, log, clipIds = null, yShift = 0) {
  if (!fs.existsSync(SHAPE_VBIN)) { log('[Vrew] 도형 템플릿(.vbin) 없음 — 배경 생략'); return null; }
  const mid = uid();
  pj.files.push({ version: 1, mediaId: mid, sourceOrigin: 'USER', fileSize: fs.statSync(SHAPE_VBIN).size, name: `${mid}.xml`, type: 'Svg', fileLocation: 'IN_MEMORY' });
  mediaZip.push({ src: SHAPE_VBIN, name: `${mid}.vbin` });

  // 도형 위치·크기 고정 — 사용자 .vrew 분석값으로 고정(폰트/줄수와 무관하게 항상 동일).
  //   xPos 0(좌측 끝), yPos 0.012(상단), width 1(전체 폭), height 0.203.
  const yTop = 0.012 + yShift;
  const height = 0.203;
  const width = 1;
  const xPos = 0;

  // 제목(web)보다 아래 zIndex
  const imgZs = Object.values(pj.props.tracks).filter((x) => x.type === 'image' || x.type === 'video').map((x) => (Number.isFinite(x.zIndex) ? x.zIndex : 0));
  const z = (imgZs.length ? Math.max(...imgZs) : 0) + 1;

  const tid = sid();
  pj.props.tracks[tid] = {
    trackId: tid, mediaId: mid, xPos, yPos: yTop, height, width, rotation: 0, zIndex: z,
    type: 'shape', dimensionType: 2, shapeType: 0, shapeSource: 'square',
    stroke: {
      color: _hex8(bg.borderColor || '#000000', bg.borderOpacity != null ? bg.borderOpacity : 0),
      width: Number(bg.borderWidth) || 0,
      isDashed: !!bg.dashed,
      isRounded: (Number(bg.cornerRounding) || 0) > 0,
    },
    plane: { color: _hex8(bg.fillColor || '#000000', bg.fillOpacity != null ? bg.fillOpacity : 50) },
    cornerRounding: Math.max(0, Math.min(1, (Number(bg.cornerRounding) || 0) / 100)),
  };
  const aid = uid();
  pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
  const targetClips = clipIds ? pj.transcript.clips.filter((c) => clipIds.includes(c.id)) : pj.transcript.clips;
  for (const c of targetClips) { if (!Array.isArray(c.assetIds)) c.assetIds = []; if (!c.assetIds.includes(aid)) c.assetIds.push(aid); }
  return true;
}

// 제목(훅) 상단 고정 텍스트 트랙 — 최대 2줄, 줄별 크기·색상·정렬. 영상 전체에 표시.
//   addAiNoticeTrack 과 동일한 web/textbox(uc-0010) 방식. 줄별 정렬 위해 줄마다 별도 트랙.
function addTitleTrack(pj, title, frameRatio, log, clipIds = null, yShift = 0) {
  const lines = [
    { text: String(title.line1 || '').trim(), st: title.l1 || {}, y: 0.035 + yShift },
    { text: String(title.line2 || '').trim(), st: title.l2 || {}, y: 0.115 + yShift },
  ].filter((l) => l.text);
  if (!lines.length) return null;

  if (!pj.files.find((f) => f.mediaId === TEXTBOX_MEDIA_ID)) {
    if (fs.existsSync(TEXTBOX_DUMMY_META)) pj.files.push(JSON.parse(fs.readFileSync(TEXTBOX_DUMMY_META, 'utf-8')));
    else log('[Vrew] 제목: textbox meta 누락');
  }
  const baseZs = Object.values(pj.props.tracks)
    .filter((t) => t.type === 'image' || t.type === 'video' || t.type === 'web')
    .map((t) => (Number.isFinite(t.zIndex) ? t.zIndex : 0));
  let z = (baseZs.length ? Math.max(...baseZs) : 0) + 2;

  for (const ln of lines) {
    const tid = sid();
    const align = ln.st.align === 'left' ? 'start' : (ln.st.align === 'right' ? 'end' : 'center');
    pj.props.tracks[tid] = {
      trackId: tid, mediaId: TEXTBOX_MEDIA_ID,
      xPos: 0.02, yPos: ln.y, height: 0, width: 0.96,
      rotation: 0, zIndex: z++, type: 'web',
      deltas: { textarea: { ops: [
        { insert: ln.text, attributes: {
          size: String(ln.st.size || 110), color: String(ln.st.color || '#ffffff'),
          font: 'Pretendard-Vrew_700', 'outline-color': '#000000', 'outline-on': 'true', 'outline-width': '6',
        } },
        { insert: '\n' },
      ] } },
      loop: true, durationSeconds: 0, importType: 'copy_and_paste',
      enabledInlineTypes: ['bold', 'italic', 'font', 'size', 'color', 'background', 'outline-color', 'shadow-color'],
      customAttributes: [
        { attributeName: '--textbox-color', type: 'color-hex', value: '#00000000' },
        { attributeName: '--textbox-align', type: 'textbox-align', value: align },
      ],
      // 제목은 처음부터 항상 표시 — assetEffectInfo 필드 자체를 넣지 않는다(즉시 표시).
      //   🔴 type:'none' 이라도 assetEffectInfo 가 web/textbox 트랙에 있으면 Vrew 내보내기가
      //      실패한다(정상 .vrew 분석: 제목 web 트랙에 이 필드 없음). 필드 생략이 정답.
      stats: { styledInFloatingMenu: true, styledInPanel: false },
      scaleFactor: frameRatio || 0.5625,
    };
    const aid = uid();
    pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
    const targetClips = clipIds ? pj.transcript.clips.filter((c) => clipIds.includes(c.id)) : pj.transcript.clips;
    for (const c of targetClips) {
      if (!Array.isArray(c.assetIds)) c.assetIds = [];
      if (!c.assetIds.includes(aid)) c.assetIds.push(aid);
    }
  }
  return true;
}

// 채널 로고 오버레이 트랙 추가 (image type, 모서리 배치, 모든 clip 에 표시)
function addLogoTrack(pj, opt, mediaZip, zIndexBase, log) {
  if (!opt.path || typeof opt.path !== 'string' || !fs.existsSync(opt.path)) {
    log(`[Vrew] 로고 옵션 켜졌으나 파일 없음 — 트랙 생략 (path: ${opt.path})`);
    return null;
  }

  const sizePreset = LOGO_SIZE_PRESETS[opt.size] || LOGO_SIZE_PRESETS.medium;
  const posPreset = LOGO_POSITION_PRESETS[opt.position] || LOGO_POSITION_PRESETS['top-right'];
  const w = sizePreset.width, h = sizePreset.height, m = posPreset.margin;
  const xPos = (posPreset.anchorX === 'left') ? m : (1 - w - m);
  const yPos = (posPreset.anchorY === 'top')  ? m : (1 - h - m);

  const mid = uid();
  const aid = uid();
  const tid = sid();
  const ext = (path.extname(opt.path).toLowerCase().replace('.jpeg','.jpg').replace('.','')) || 'png';
  const fn = `${mid}.${ext}`;
  const fileSize = fs.statSync(opt.path).size;

  pj.files.push({
    version: 1, mediaId: mid, sourceOrigin: 'USER',
    fileSize, name: fn, type: 'Image',
    isTransparent: ext === 'png', fileLocation: 'IN_MEMORY',
  });

  pj.props.tracks[tid] = {
    trackId: tid, mediaId: mid,
    xPos, yPos, height: h, width: w,
    rotation: 0,
    zIndex: zIndexBase + 1,
    type: 'image',
    originalWidthHeightRatio: 1.0,
    editInfo: {},
    stats: { fillType: 'fit', fillMenu: 'floating', rearrangeCount: 0 },
  };
  pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
  mediaZip.push({ src: opt.path, name: fn });

  // 모든 clip 의 assetIds 에 logo asset 추가 (영상 전체에 노출)
  for (const c of pj.transcript.clips) {
    if (!Array.isArray(c.assetIds)) c.assetIds = [];
    if (!c.assetIds.includes(aid)) c.assetIds.push(aid);
  }

  log(`[Vrew] 채널 로고 추가: ${path.basename(opt.path)} ${opt.position}/${opt.size}`);
  return { trackId: tid, assetId: aid, mediaId: mid };
}

function validateOutput(pj, sentenceCount, imageGroupCount) {
  const errs = [];
  const warns = [];
  if (!pj.files[0] || pj.files[0].mediaId !== FIXED_MP4_MEDIA_ID) {
    errs.push(`files[0] 의 mediaId 가 ${FIXED_MP4_MEDIA_ID} 가 아님 (template 손상?)`);
  }
  const tts = pj.files.filter(f => f.sourceFileType === 'TTS').length;
  const img = pj.files.filter(f => f.type === 'Image').length;
  if (tts !== sentenceCount) errs.push(`TTS file 수 ${tts} ≠ sentence 수 ${sentenceCount}`);
  // Image 는 그룹 + (선택) 로고 → 부족하면 검은 배경으로 대체됨 (경고만)
  if (img < imageGroupCount) warns.push(`Image file 수 ${img} < 이미지 그룹 수 ${imageGroupCount} (부족분은 검은 배경)`);

  let imgMissingClips = 0;
  for (const c of pj.transcript.clips) {
    if (!c.id) errs.push(`clip 에 id 없음`);
    if (c.captionMode !== 'MANUAL') errs.push(`clip ${c.id} captionMode != MANUAL`);
    if (!Array.isArray(c.assetIds) || c.assetIds.length === 0) {
      imgMissingClips++;
    }
    const w = c.words || [];
    // 단어 단위 자막: N type:0 word + 1 type:2 종료 마커 (최소 2개)
    if (w.length < 2) errs.push(`clip ${c.id} words 길이 ${w.length} < 2 (최소 word 1 + 종료 마커 1)`);
    if (w[0]?.type !== 0) errs.push(`clip ${c.id} words[0].type != 0`);
    const last = w[w.length - 1];
    if (last?.type !== 2) errs.push(`clip ${c.id} words[last].type != 2 (종료 마커)`);
    if (w[0]?.assetIds?.length !== 1) errs.push(`clip ${c.id} words[0].assetIds 길이 ${w[0]?.assetIds?.length} != 1`);
    if (last?.assetIds?.length !== 0) errs.push(`clip ${c.id} words[last].assetIds 비어야 함`);
  }

  // ttsClip 트랙 수 = sub-clip 안 단어 수 합 (단어 단위 분리 후) + 휴지(type:1)
  const totalWordTracks = pj.transcript.clips.reduce((sum, c) => {
    const ws = c.words || [];
    return sum + ws.filter(w => w.type === 0 || w.type === 1).length;
  }, 0);
  const ttsTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'ttsClip').length;
  const dubTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'ttsDubbing').length;
  if (ttsTrackCount !== totalWordTracks) errs.push(`ttsClip 트랙 ${ttsTrackCount} ≠ word 트랙 합 ${totalWordTracks}`);
  if (dubTrackCount !== 0) errs.push(`ttsDubbing 트랙 ${dubTrackCount} != 0 (4.0.1 형식에선 사용 안 함)`);

  // role 분포
  const trackTypeOfAsset = (a) => pj.props.tracks[a.trackIds[0]]?.type;
  for (const [aid, a] of Object.entries(pj.props.assets)) {
    const tt = trackTypeOfAsset(a);
    if (tt === 'ttsClip' && a.role !== 'main') errs.push(`asset ${aid} (ttsClip) role != 'main'`);
    if (tt === 'image' && a.role !== 'sub') errs.push(`asset ${aid} (image) role != 'sub'`);
    if (tt === 'web' && a.role !== 'sub') errs.push(`asset ${aid} (web) role != 'sub'`);
  }

  // AI 고지 web 트랙이 있다면 files[] 에 Html 항목 등록 보장
  const webTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'web').length;
  if (webTrackCount > 0) {
    const hasHtml = pj.files.some(f => f.mediaId === 'uc-0010-simple-textbox' && f.type === 'Html');
    if (!hasHtml) errs.push(`web 트랙 ${webTrackCount}개 있으나 files[] 에 uc-0010-simple-textbox (Html) 없음`);
  }

  if (imgMissingClips > 0) warns.push(`이미지 누락 clip ${imgMissingClips}개 — 해당 sub-clip 은 vrew 에서 검은 배경`);

  return { errs, warns };
}

async function buildVrew({ sentences, groups, vrewPath, opts = {} }) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  let T;
  try {
    T = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`vrew-template.json 로드 실패: ${e.message}`);
  }

  const pj = JSON.parse(JSON.stringify(T));
  if (!pj.files[0] || pj.files[0].mediaId !== FIXED_MP4_MEDIA_ID) {
    throw new Error(`template 첫 mp4 항목 (${FIXED_MP4_MEDIA_ID}) 누락 — vrew-template.json 손상`);
  }

  // (쇼츠) 출력 비율 — 9:16 이면 캔버스·비율·자막 scaleFactor 를 세로로 (쇼츠브루.vrew 샘플 검증값).
  // 16:9 면 템플릿 기본값(1920×1080 / 1.7778) 그대로 유지.
  // 비율: 9:16(쇼츠) / 1:1(정사각) / 16:9(롱폼)
  const _aspect = (opts.aspect === '9:16' || opts.aspect === '1:1') ? opts.aspect : '16:9';
  // scaleFactor(자막 좌표계) = width/height. 정상 .vrew 분석값: 16:9=1.7778 / 9:16=0.5625 / 1:1=1.0.
  const _frameRatio = _aspect === '9:16' ? 0.5625 : (_aspect === '1:1' ? 1.0 : 1.7777777777777777);
  const _canvasW = _aspect === '16:9' ? 1920 : 1080;
  const _canvasH = _aspect === '9:16' ? 1920 : (_aspect === '1:1' ? 1080 : 1080);
  // 🔴 videoRatio = 캔버스 가로/세로. Vrew 4.2.x 는 이 값으로 화면비를 인식한다.
  //    16:9=1.7778 · 9:16=0.5625 · 1:1=1.0. (정답본 비교 2026-06-24: 0618 롱폼=1.7778, 9:16=0.5625)
  //    ⚠ 과거 "둘 다 0.5625 상수" 는 오진 — 9:16 파일만 보고 내린 결론이라 롱폼(16:9)이 세로로 열렸음.
  //    → _frameRatio(=가로/세로) 를 그대로 사용. 쇼츠(9:16)는 0.5625 로 동일, 롱폼만 1.7778 로 교정.
  //    web/shape 오버레이 ×_overlayScale 은 별개로 유지(쇼츠 자막·제목 위치, make1.vrew 검증값).
  const _videoRatio = _frameRatio;
  const _overlayScale = (16 / 9) * (_canvasH / _canvasW);
  if (pj.props && pj.props.videoSize) { pj.props.videoSize.width = _canvasW; pj.props.videoSize.height = _canvasH; }
  if (pj.props && pj.props.initProjectVideoSize) { pj.props.initProjectVideoSize.width = _canvasW; pj.props.initProjectVideoSize.height = _canvasH; }
  if (pj.props) { pj.props.videoRatio = _videoRatio; }
  if (pj.props && pj.props.globalCaptionStyle && pj.props.globalCaptionStyle.captionStyleSetting) {
    pj.props.globalCaptionStyle.captionStyleSetting.scaleFactor = _frameRatio;
  }
  log(`[Vrew] 출력 비율 ${_aspect} (캔버스 ${_canvasW}×${_canvasH}, videoRatio ${_videoRatio}, scaleFactor ${_frameRatio}, overlayScale ${_overlayScale.toFixed(4)})`);

  // Vrew 배속(playbackRate) — 기본 1(미사용). 배속은 음성 MP3 에 atempo 로 이미 구워져 있으므로
  //   Vrew 단계에선 정속(1) 재생. (원하면 opts.playbackRate 로 추가 가속 가능하나 기본은 1)
  const _playbackRate = (opts.playbackRate != null && Number(opts.playbackRate) > 0) ? Number(opts.playbackRate) : 1;

  // 사용자가 프리셋에서 지정한 자막 옵션을 기본값에 병합 (없으면 기본값 사용)
  const _userCap = opts.captionStyle || {};

  // 정렬 'random' 은 빌드 1회당 한 번만 좌/가운데 중 결정 → 영상 안에서 일관 유지
  let resolvedAlign = _userCap.align;
  if (resolvedAlign === 'random') {
    resolvedAlign = (Math.random() < 0.5) ? 'start' : 'center';
    log(`[Vrew] 자막 정렬 랜덤 → '${resolvedAlign === 'start' ? '좌' : '가운데'}' (이 영상 전체 동일)`);
  }

  // 크기 'random' 도 동일 — 빌드 1회당 한 번만 100/125 중 결정 → 영상 안에서 일관 유지
  let resolvedSize = _userCap.size;
  if (resolvedSize === 'random') {
    resolvedSize = (Math.random() < 0.5) ? '100' : '125';
    log(`[Vrew] 자막 크기 랜덤 → '${resolvedSize}px' (이 영상 전체 동일)`);
  }

  // 위치 'random' — 빌드 1회당 한 번만 -0.125 / -0.15 / -0.175 중 결정 → 영상 안에서 일관 유지
  let resolvedYOffset = _userCap.yOffset;
  if (resolvedYOffset === 'random') {
    const choices = [-0.125, -0.15, -0.175];
    resolvedYOffset = choices[Math.floor(Math.random() * choices.length)];
    log(`[Vrew] 자막 위치 랜덤 → '${(resolvedYOffset * 100).toFixed(1)}%' (이 영상 전체 동일)`);
  }

  const captionAttrs = {
    ...CAPTION_ATTRS,
    ...(resolvedSize          ? { size: String(resolvedSize) }                 : {}),
    ...(_userCap.fontColor    ? { color: _userCap.fontColor }                  : {}),
    ...(_userCap.outlineColor ? { 'outline-color': _userCap.outlineColor }     : {}),
    ...(_userCap.bold         ? { bold: true }                                 : {}),
    ...(_userCap.italic       ? { italic: true }                               : {}),
  };
  // ★ 위치는 clips[].captions[].style 가 지배 (사용자 .vrew 분석 확정).
  //   yAlign: 'middle'(가운데) 등은 _userCap.yAlign 우선, 없으면 CAPTION_STYLE 기본('middle').
  const captionStyle = {
    ...CAPTION_STYLE,
    scaleFactor: _frameRatio,   // (쇼츠) 9:16=0.5625 / 16:9=1.7778
    ...(_userCap.yAlign ? { yAlign: _userCap.yAlign } : {}),
    ...(resolvedYOffset != null ? { yOffset: resolvedYOffset } : {}),
    ...(_userCap.width   != null ? { width:   _userCap.width   } : {}),
    customAttributes: CAPTION_STYLE.customAttributes.map(a => {
      if (a.attributeName === '--textbox-align' && resolvedAlign) {
        return { ...a, value: resolvedAlign };
      }
      return { ...a };
    }),
  };

  // 전역 globalCaptionStyle 은 사용자 known-good .vrew 처럼 yAlign/yOffset 은 템플릿 그대로 두고
  // (위치는 클립별 style 이 지배), scaleFactor 만 위에서 갱신됨. align/width 는 일관성 위해 맞춤.
  if (pj.props && pj.props.globalCaptionStyle && pj.props.globalCaptionStyle.captionStyleSetting) {
    const gcs = pj.props.globalCaptionStyle.captionStyleSetting;
    if (_userCap.width != null) gcs.width = _userCap.width;
    if (Array.isArray(gcs.customAttributes) && resolvedAlign) {
      const a = gcs.customAttributes.find(x => x.attributeName === '--textbox-align');
      if (a) a.value = resolvedAlign;
    }
  }

  const nowIso = new Date().toISOString();
  pj.projectId = uid();
  pj.comment = `4.0.1\t${nowIso}`;
  pj.statistics.saveInfo.created = { version: '4.0.1', date: nowIso, stage: 'release' };
  pj.statistics.saveInfo.updated = { version: '4.0.1', date: nowIso, stage: 'release' };
  pj.props.tracks = {};
  pj.props.assets = {};
  pj.props.ttsClipInfosMap = {};
  pj.props.originalClips = [];
  pj.props.lastTTSSettings = {
    pitch: 0, speed: 0, volume: 0,
    speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
  };
  pj.transcript.clips = [];
  pj.transcript.sceneNames = {};
  pj.transcript.translateInfo = null;

  const mediaZip = [];
  const unifiedSceneId = sid();

  // ---------- 1. 그룹 미디어 등록 (비디오 우선, 없으면 이미지) ----------
  const groupImageAsset = new Map();
  const groupTopY = new Map();   // 그룹별 미디어 상단 y (레터박스면 영상/이미지 위쪽 검정띠 끝). 0=꽉참
  const groupClips = new Map();  // 그룹별 clip id 목록 (제목/도형을 그룹 클립에만 링크)
  let groupIdx = 0;
  const missingImg = [];
  for (const g of groups) {
    // (a) 비디오가 있으면 비디오 자산 + video/videoAudio 두 트랙 생성 (음소거)
    //     9:16 쇼츠 캔버스: 세로 영상만 사용(가로 16:9 그록영상은 흰 여백 → 이미지 폴백).
    //     16:9 롱폼: 영상 있으면 그대로 사용.
    //     (Shots-maker: Grok이 _aspectRatio='9:16'로 세로 영상을 내므로 훅 컷 애니메이션 반영됨)
    if (g.videoPath && fs.existsSync(g.videoPath)) {
      const _vmeta0 = readMp4VideoMeta(g.videoPath);
      { // 영상은 항상 사용 — 캔버스와 비율이 비슷하면 꽉 채우고, 다르면(가로↔9:16 등) 레터박스 가운데(전체 표시)
      const mid = uid();
      const aid = uid();
      const videoTid = sid();
      const audioTid = sid();
      const fn = `${mid}.mp4`;
      const fileSize = fs.statSync(g.videoPath).size;

      // 비디오 메타데이터 — 실제 mp4 헤더(moov/tkhd/mvhd) 직접 파싱이 1순위.
      let videoWidth = 1280, videoHeight = 720, dur = 6;
      const realMeta = _vmeta0;
      if (realMeta) {
        videoWidth  = realMeta.width;
        videoHeight = realMeta.height;
        if (realMeta.duration > 0) dur = realMeta.duration;
        log(`[Vrew] mp4 메타: ${path.basename(g.videoPath)} ${videoWidth}x${videoHeight}, ${dur.toFixed(2)}초`);
      } else {
        // mp4 헤더 파싱 실패 시 기본값(Grok 720p 16:9) 사용
        videoWidth = 1280; videoHeight = 720; dur = 5;
        log(`[Vrew] mp4 헤더 파싱 실패 — 기본값 사용: ${videoWidth}x${videoHeight}, ${dur}초`);
      }

      // 비디오 자산 (사용자 샘플 vrew 형식 그대로)
      pj.files.push({
        version: 1, mediaId: mid, sourceOrigin: 'USER',
        fileSize, name: fn, type: 'AVMedia',
        videoAudioMetaInfo: {
          duration: dur,
          videoInfo: {
            size: { width: videoWidth, height: videoHeight, rotation: 0 },
            frameRate: 24, codec: 'h264', colorSpace: 'unknown',
          },
          audioInfo: { sampleRate: 48000, codec: 'aac', channelCount: 2 },
          mediaContainer: 'm4a',
        },
        sourceFileType: 'ASSET_VIDEO', fileLocation: 'IN_MEMORY',
      });

      // 비디오 트랙 — 8% 확대 + 가운데 정렬로 letterbox 띠 + 인코딩 artifact 제거.
      // (사용자가 Vrew 에서 수동으로 하던 "영상 키우고 가운데 정렬" 자동화)
      //
      // 비율 차이: 영상(예: 1280x704=1.818) ↔ 화면 16:9(=1.778) ≈ 2.3%
      // 5% 마진(이전 값)이면 letterbox 자체는 가려지지만 Grok 출력의 영상 마지막
      // 1~2픽셀 row 가 흰색 인코딩 artifact 로 남는 케이스 발견 → 사용자가 화면
      // 하단에 얇은 흰 줄을 봤음. 8% 마진으로 늘려서 가장자리 픽셀까지 화면 밖으로
      // 밀어냄 (각 변 4%씩 잘림 — 영상 중앙 콘텐츠는 그대로 보존).
      // 비율: 캔버스와 비슷하면 8% 확대 cover(꽉 채움), 다르면(가로영상↔9:16 등) 비율유지 레터박스 가운데(전체 표시).
      const _vRatio = videoHeight > 0 ? (videoWidth / videoHeight) : _frameRatio;
      const _vMismatch = Math.abs(_vRatio - _frameRatio) > 0.06;
      let _vx, _vy, _vw, _vh;
      if (_vMismatch) {
        const _scale = Math.min(_canvasW / videoWidth, _canvasH / videoHeight);
        _vw = (videoWidth * _scale) / _canvasW;
        _vh = (videoHeight * _scale) / _canvasH;
        _vx = (1 - _vw) / 2; _vy = (1 - _vh) / 2;       // 가운데
        log(`[Vrew] G${g.num} 영상 ${videoWidth}x${videoHeight}(비율${_vRatio.toFixed(2)}) — 비율유지 가운데 레터박스(전체 표시)`);
      } else {
        const SCALE = 1.08, OFFSET = (1 - SCALE) / 2;   // 8% 확대 cover + 가운데
        _vx = OFFSET; _vy = OFFSET; _vw = SCALE; _vh = SCALE;
      }
      pj.props.tracks[videoTid] = {
        trackId: videoTid, mediaId: mid,
        xPos: _vx, yPos: _vy, height: _vh, width: _vw,
        rotation: 0, zIndex: groupIdx, type: 'video',
        sourceIn: 0, sourceOut: dur,
        originalWidthHeightRatio: _vRatio,
        isTrimmable: true, hasAlphaChannel: false,
        editInfo: {},
        fillType: 'cut',                 // 트랙 박스가 영상 비율과 동일 → cut 이어도 잘리지 않고 전체 표시
      };
      // 비디오 오디오 트랙 — volume:0 (PrimingFlow TTS 만 들리도록 음소거)
      pj.props.tracks[audioTid] = {
        trackId: audioTid, mediaId: mid,
        volume: 0, sourceIn: 0, sourceOut: dur,
        loop: true, playbackRate: 1, type: 'videoAudio',
      };
      pj.props.assets[aid] = { trackIds: [videoTid, audioTid], role: 'sub' };
      groupImageAsset.set(g.id, { aid, mid, fn, isVideo: true, videoTid, audioTid });
      groupTopY.set(g.id, _vMismatch ? _vy : 0); // 레터박스면 영상 상단 y(검정띠 끝)
      mediaZip.push({ src: g.videoPath, name: fn });
      groupIdx++;
      continue;
      }
    }

    // (b) 비디오 없으면 기존 이미지 분기 (이미지도 비율 다르면 가운데 레터박스)
    if (!g.imagePath || !fs.existsSync(g.imagePath)) {
      missingImg.push(g.num ?? g.id);
      continue;
    }
    const mid = uid();
    const aid = uid();
    const tid = sid();
    const ext = (path.extname(g.imagePath).toLowerCase().replace('.jpeg', '.jpg').replace('.', '')) || 'png';
    const fn = `${mid}.${ext}`;
    const fileSize = fs.statSync(g.imagePath).size;

    pj.files.push({
      version: 1, mediaId: mid, sourceOrigin: 'USER',
      fileSize, name: fn, type: 'Image',
      isTransparent: false, fileLocation: 'IN_MEMORY',
    });

    // 이미지 실제 비율 확인 — 캔버스와 다르면(예: 1:1 이미지를 9:16 쇼츠에) 늘리지 않고
    // 비율 유지한 채 상하좌우 가운데 배치(레터박스). 비슷하면 기존처럼 꽉 채움(켄번스).
    const isz = readImageSize(g.imagePath);
    const imgRatio = (isz && isz.w > 0 && isz.h > 0) ? (isz.w / isz.h) : _frameRatio;
    const mismatch = Math.abs(imgRatio - _frameRatio) > 0.06;
    let track;
    if (mismatch) {
      // contain: 캔버스 안에 비율 유지로 맞춤 + 가운데. 그 박스 안에서 켄번스 적용(레터박스 유지).
      const scale = Math.min(_canvasW / isz.w, _canvasH / isz.h);
      const wF = (isz.w * scale) / _canvasW;
      const hF = (isz.h * scale) / _canvasH;
      const kb = _kenBurnsFor(groupIdx);
      track = {
        trackId: tid, mediaId: mid,
        xPos: (1 - wF) / 2, yPos: (1 - hF) / 2, height: hF, width: wF,
        rotation: 0, zIndex: groupIdx, type: 'image',
        originalWidthHeightRatio: imgRatio,
        kenburnsAnimationInfo: { type: 'custom', from: { ...kb.from }, to: { ...kb.to } },
        editInfo: {},
        stats: { fillType: 'cut', fillMenu: 'floating', rearrangeCount: 0 },
      };
      log(`[Vrew] 그룹${g.num} 이미지 ${isz.w}x${isz.h}(비율${imgRatio.toFixed(2)}) — 가운데 비율유지 + 켄번스`);
    } else {
      const kb = _kenBurnsFor(groupIdx);
      track = {
        trackId: tid, mediaId: mid,
        xPos: _aspect === '16:9' ? -0.004 : 0, yPos: 0, height: 1, width: _aspect === '16:9' ? 1.008 : 1,
        rotation: 0, zIndex: groupIdx, type: 'image',
        originalWidthHeightRatio: _frameRatio,
        kenburnsAnimationInfo: { type: 'custom', from: { ...kb.from }, to: { ...kb.to } },
        editInfo: {},
        stats: { fillType: 'cut', fillMenu: 'floating', rearrangeCount: 0 },
      };
    }
    pj.props.tracks[tid] = track;
    pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
    groupImageAsset.set(g.id, { aid, mid, fn });
    groupTopY.set(g.id, track.yPos || 0); // 레터박스면 이미지 상단 y(검정띠 끝)
    mediaZip.push({ src: g.imagePath, name: fn });
    groupIdx++;
  }

  // ---------- 2. sentence 루프 ----------
  let imageGroupCount = groupImageAsset.size;
  let sentenceCount = 0;
  const missingTts = [];
  const clipDurations = []; // index = transcript clip 순번 (0-based), value = 초

  // ★ WAV→MP3 를 빌드 루프 전에 병렬 사전 변환 (직렬 spawnSync 9분 → 병렬 수십 초). MP3 출력 유지.
  const _mp3Cache = await preConvertWavsToMp3(sentences, log, 8);

  for (const s of sentences) {
    if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath)) {
      missingTts.push(s.num);
      continue;
    }

    const ttsDur = s.ttsDurationSec || estimateAudioDuration(s.ttsAudioPath);
    const srcExt = (path.extname(s.ttsAudioPath).toLowerCase().replace('.', '')) || 'mp3';

    // (a) TTS 파일 — wav 면 mp3 변환 (Vrew 호환성). 실패 시 wav 그대로 fallback.
    const ttsMid = sid();
    let ttsSrc  = s.ttsAudioPath;
    let outExt  = srcExt;
    let codec   = (srcExt === 'wav') ? 'wav' : 'mp3';
    if (srcExt === 'wav') {
      // 1순위: 병렬 사전 변환 캐시. 미스(변환 실패)면 동기 1회 폴백, 그래도 실패면 wav 그대로.
      const cachedMp3 = _mp3Cache.get(s.ttsAudioPath);
      if (cachedMp3 && fs.existsSync(cachedMp3)) {
        ttsSrc = cachedMp3;
        outExt = 'mp3';
        codec  = 'mp3';
      } else {
        const mp3Path = path.join(os.tmpdir(), `pf_tts_${ttsMid}.mp3`);
        if (wavToMp3(s.ttsAudioPath, mp3Path)) {
          ttsSrc = mp3Path;
          outExt = 'mp3';
          codec  = 'mp3';
        } else {
          log(`[Vrew] wav→mp3 변환 실패 — wav 그대로 사용: ${path.basename(s.ttsAudioPath)}`);
        }
      }
    }
    const ttsFn = `${ttsMid}.${outExt}`;
    const ttsBytes = fs.statSync(ttsSrc).size;
    pj.files.push({
      version: 1, mediaId: ttsMid, sourceOrigin: 'VREW_RESOURCE',
      fileSize: ttsBytes, name: ttsFn, type: 'AVMedia',
      videoAudioMetaInfo: {
        duration: ttsDur,
        audioInfo: { sampleRate: 24000, codec, channelCount: 1 },
      },
      sourceFileType: 'TTS', fileLocation: 'IN_MEMORY',
    });
    mediaZip.push({ src: ttsSrc, name: ttsFn });

    // (b) ttsClipInfosMap entry — key = ttsMid (실제 음성 mediaId)
    const cleanText = ttsCleanText(s.text);
    pj.props.ttsClipInfosMap[ttsMid] = {
      pitch: 0, speed: 0, volume: 0,
      speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
      text: { raw: s.text, processed: cleanText, textAspectLang: 'ko-KR' },
      duration: ttsDur,
    };

    // (c) sub-clip 펼치기 — 1 sub-clip = 1 Vrew clip.
    // 한 줄 = 공백무시 최대 captionMaxChars(기본 8)자 + 쉼표 끊기 (core/caption-splitter).
    // 시간은 줄의 비공백 글자수에 비례 분배.
    const maxCap = (opts && opts.captionMaxChars) || 8;
    let subClips;
    if (opts && opts.disableLongSplit) {
      subClips = [{ text: s.text, weight: 1.0 }];
    } else {
      const lines = splitCaptionLines(s.text, maxCap);
      subClips = (lines.length > 0)
        ? lines.map((t) => ({ text: t, weight: Math.max(1, meaningfulLen(t)) }))
        : [{ text: s.text, weight: 1.0 }];
    }
    const totalWeight = subClips.reduce((sum, c) => sum + (c.weight || 1), 0) || 1;

    const groupAsset = groupImageAsset.get(s.groupId);
    const clipAssetIds = groupAsset ? [groupAsset.aid] : [];

    let acc = 0;
    for (let i = 0; i < subClips.length; i++) {
      const vc = subClips[i];
      const w = (vc.weight || 1) / totalWeight;
      const clipDur = ttsDur * w;
      const isLast = (i === subClips.length - 1);
      const sourceIn = acc;
      const sourceOut = isLast ? ttsDur : Math.min(acc + clipDur, ttsDur);
      const realDur = sourceOut - sourceIn;

      // 단어 단위 ttsClip 트랙 — 같은 sentence audio 의 시간 슬라이스를 단어 수만큼.
      // (Vrew 본가의 STT 결과처럼 N word 가 각자 자기 ttsClip asset 을 가리킴)
      const tokens = splitWordsForVrew(vc.text);
      const totalChars = tokens.reduce((sum, t) => sum + (t.length || 0), 0) || 1;

      const wordsArr = [];
      let wAcc = 0;
      for (let wi = 0; wi < tokens.length; wi++) {
        const tk = tokens[wi];
        const isLastWord = (wi === tokens.length - 1);
        // 글자수 비율로 sub-clip 시간 분배. 마지막 단어는 잔여 시간 모두 흡수.
        const wDur = isLastWord
          ? Math.max(0, realDur - wAcc)
          : realDur * ((tk.length || 1) / totalChars);

        const wTtsTid = sid();
        const wTtsAid = uid();
        pj.props.tracks[wTtsTid] = {
          trackId: wTtsTid, mediaId: ttsMid, volume: 1,
          sourceIn:  sourceIn + wAcc,
          sourceOut: sourceIn + wAcc + wDur,
          loop: false, fade: { in: false, out: false },
          playbackRate: 1, type: 'ttsClip',
        };
        pj.props.assets[wTtsAid] = { trackIds: [wTtsTid], role: 'main' };

        wordsArr.push({
          id: sid(),
          text: tk,
          playbackRate: _playbackRate,
          duration: wDur,
          aligned: false,
          type: 0,
          originalDuration: wDur,
          originalStartTime: wAcc,
          truncatedWords: [],
          assetIds: [wTtsAid],
        });
        wAcc += wDur;
      }

      // 종료 마커 (type:2)
      wordsArr.push({
        id: sid(),
        text: '',
        playbackRate: _playbackRate,
        duration: 0,
        aligned: false,
        type: 2,
        originalDuration: 0,
        originalStartTime: realDur,
        truncatedWords: [],
        assetIds: [],
      });

      const _clipId = sid();
      if (!groupClips.has(s.groupId)) groupClips.set(s.groupId, []);
      groupClips.get(s.groupId).push(_clipId);
      pj.transcript.clips.push({
        sceneId: unifiedSceneId,
        id: _clipId,
        captionMode: 'MANUAL',
        words: wordsArr,
        // captions 마다 style 직접 박아 자막 위치(yOffset 등) 영구 보존
        // (사용자가 프리셋에서 변경한 size/align/yOffset/width/색상을 병합한 값 사용)
        captions: [
          {
            text: [{ insert: vc.text + '\n', attributes: { ...captionAttrs } }],
            style: { ...captionStyle, customAttributes: captionStyle.customAttributes.map(a => ({ ...a })) },
          },
          {
            text: [{ insert: '\n', attributes: { ...captionAttrs } }],
            style: { ...captionStyle, customAttributes: captionStyle.customAttributes.map(a => ({ ...a })) },
          },
        ],
        assetIds: [...clipAssetIds],
        dirty: { blankDeleted: false, caption: false, video: false },
        translationModified: { result: false, source: false },
      });
      clipDurations.push(realDur);

      acc = sourceOut;
    }

    sentenceCount++;
  }

  if (pj.transcript.clips.length === 0) {
    throw new Error('생성할 클립 없음 — TTS 가 변환된 sentence 가 하나도 없음');
  }

  // ---------- 2.4. 비디오 트랙의 sourceOut 을 그룹 sentence 시간 합으로 갱신 ----------
  // 비디오 자체는 6초인데 그룹 sentence 가 더 길면 loop:true 로 늘려 재생.
  for (const g of groups) {
    const ga = groupImageAsset.get(g.id);
    if (!ga || !ga.isVideo) continue;
    let groupDur = 0;
    for (const s of sentences) {
      if (s.groupId === g.id && s.ttsAudioPath && s.ttsDurationSec) {
        groupDur += s.ttsDurationSec;
      }
    }
    if (groupDur > 0) {
      const vTrack = pj.props.tracks[ga.videoTid];
      const aTrack = pj.props.tracks[ga.audioTid];
      if (vTrack) vTrack.sourceOut = groupDur;
      if (aTrack) aTrack.sourceOut = groupDur;
    }
  }

  // ---------- 2.45. 제목 배경 도형 + 제목(훅) — 전체 클립 1회(연속) ----------
  // 1번~마지막 클립까지 항상 표시되므로 그룹별로 자르지 않고 한 번에 전체 클립에 깔음(끊김·재페이드 없음).
  // 위치: 9:16 캔버스면 상단 안전구역(살짝 아래)으로. (9:16 꽉찬 그룹=안전구역, 레터박스 그룹=상단 검정띠 안 → 둘 다 자연스러움)
  if (opts.title && (opts.title.line1 || opts.title.line2)) {
    const tinfo = { line1: opts.title.line1, line2: opts.title.line2, t1Size: opts.title.l1 && opts.title.l1.size, t2Size: opts.title.l2 && opts.title.l2.size };
    const yShift = (_aspect === '9:16') ? 0.05 : 0; // 9:16 상단 안전구역
    if (opts.titleBg && opts.titleBg.enabled) {
      try { addShapeTrack(pj, opts.titleBg, tinfo, _frameRatio, mediaZip, log, null, yShift); }
      catch (e) { log(`[Vrew] 제목 배경 도형 실패: ${e.message}`); }
    }
    try { addTitleTrack(pj, opts.title, _frameRatio, log, null, yShift); }
    catch (e) { log(`[Vrew] 제목 트랙 실패: ${e.message}`); }
    log(`[Vrew] 제목 상단 고정(전체 클립 1회, yShift=${yShift})`);
  }

  // ---------- 2.5. AI 고지 자막 (web 트랙) ----------
  if (opts.aiNotice && opts.aiNotice.enabled) {
    try {
      addAiNoticeTrack(pj, opts.aiNotice, clipDurations, log, _frameRatio);
    } catch (e) {
      log(`[Vrew] AI 고지 자막 추가 실패: ${e.message}`);
    }
  }

  // ---------- 2.6. 채널 로고 오버레이 (image 트랙) ----------
  if (opts.logo && opts.logo.enabled) {
    try {
      addLogoTrack(pj, opts.logo, mediaZip, groupIdx, log);
    } catch (e) {
      log(`[Vrew] 로고 트랙 추가 실패: ${e.message}`);
    }
  }

  // ---------- 2.7. 오버레이(web/shape) 트랙 X좌표 스케일 (9:16/1:1 화면비 인식) ----------
  // Vrew 는 제목·도형·AI고지 같은 web/shape 트랙의 xPos/width 좌표계로 캔버스 화면비를 인식한다.
  //   - 미디어(video/image) 트랙은 0..1(캔버스) 공간 그대로(width≈1 + fillType:cut = 커버) → 건드리지 않음.
  //   - 자막(transcript.clips[].captions[].style) 도 별도 좌표계 → 건드리지 않음.
  //   - web/shape 만 ×_overlayScale, 중앙 보존(xPos = 중앙 − width/2).
  // 16:9 는 _overlayScale=1 이라 무변경(롱폼 영향 없음). make1.vrew(사용자 검증본) 기준.
  if (_overlayScale !== 1) {
    let _nScaled = 0;
    for (const _t of Object.values(pj.props.tracks)) {
      if ((_t.type === 'web' || _t.type === 'shape') && typeof _t.width === 'number' && typeof _t.xPos === 'number') {
        const _c = _t.xPos + _t.width / 2;
        _t.width = _t.width * _overlayScale;
        _t.xPos = _c - _t.width / 2;
        _nScaled++;
      }
    }
    log(`[Vrew] 오버레이 트랙 X좌표 ×${_overlayScale.toFixed(4)} 적용: ${_nScaled}개 (${_aspect})`);
  }

  // ---------- 3. self-check ----------
  const { errs, warns } = validateOutput(pj, sentenceCount, imageGroupCount);
  if (warns.length > 0) {
    log(`[Vrew] self-check 경고:\n  - ${warns.join('\n  - ')}`);
  }
  if (errs.length > 0) {
    log(`[Vrew] self-check 실패:\n  - ${errs.join('\n  - ')}`);
    if (!opts.skipSelfCheck) {
      throw new Error(`vrew self-check 실패 (${errs.length}건):\n${errs.join('\n')}`);
    }
  }

  // ---------- 4. ZIP ----------
  const tmpDir = path.join(os.tmpdir(), `vrew_build_${Date.now()}`);
  const tmpMedia = path.join(tmpDir, 'media');
  fs.mkdirSync(tmpMedia, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'project.json'), JSON.stringify(pj), 'utf-8');
  for (const m of mediaZip) {
    fs.copyFileSync(m.src, path.join(tmpMedia, m.name));
  }
  // AI 고지 자막 트랙이 추가되었으면 uc-0010-simple-textbox.bin 도 동봉
  // (ZIP 안 파일명은 .bin, files[].name 은 .html — Vrew 매핑 규칙)
  if (opts.aiNotice && opts.aiNotice.enabled && opts.aiNotice.text) {
    if (fs.existsSync(TEXTBOX_DUMMY_BIN)) {
      fs.copyFileSync(TEXTBOX_DUMMY_BIN, path.join(tmpMedia, 'uc-0010-simple-textbox.bin'));
    } else {
      log(`[Vrew] dummy/uc-0010-simple-textbox.bin 누락 — AI 고지 자막이 빈 박스로 표시될 수 있음`);
    }
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFile(path.join(tmpDir, 'project.json'));
  if (fs.existsSync(tmpMedia)) {
    for (const fn of fs.readdirSync(tmpMedia).sort()) {
      zip.addLocalFile(path.join(tmpMedia, fn), 'media');
    }
  }
  zip.writeZip(vrewPath);

  log(`[Vrew] (4.0.1 test.vrew 형식) ${pj.transcript.clips.length}개 clip · ${imageGroupCount}개 image · ${sentenceCount}개 TTS → ${path.basename(vrewPath)}`);
  if (missingImg.length > 0) log(`[Vrew] 이미지 누락 그룹: ${missingImg.join(', ')}`);
  if (missingTts.length > 0) log(`[Vrew] TTS 누락 sentence: ${missingTts.join(', ')}`);

  if (opts.dumpJson !== false) {
    try {
      const dumpPath = vrewPath + '.debug.json';
      fs.writeFileSync(dumpPath, JSON.stringify(pj, null, 2), 'utf-8');
      log(`[Vrew] 진단 dump: ${path.basename(dumpPath)}`);
    } catch {}
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  return {
    vrewPath,
    clipCount: pj.transcript.clips.length,
    imageCount: imageGroupCount,
    sentenceCount,
    missing: missingTts,
    missingImages: missingImg,
  };
}

module.exports = { buildVrew };
