/**
 * build-shorts.js — 헤드리스 빌드 CLI (Electron UI 없이 파이프라인 검증/실행)
 *
 *   node build-shorts.js "<대본.md>" [--out <dir>] [--dry] [--only N]
 *
 * 흐름: cut-script-parser → (오디오) → vrew-builder 편별 호출 → 편별 .vrew 출력.
 *
 * --dry (기본 ON): TTS 없이 ffmpeg 무음 오디오(나레이션 길이 추정)로 .vrew 구조를 선검증.
 *                  실제 TTS/이미지 연결 전, Vrew에서 자막·9:16 캔버스·타임라인을 먼저 확인하는 용도.
 * (추후 --tts omnivoice 등으로 실제 음성 연결 예정)
 *
 * 출력: <out>/<파일베이스>/쇼츠1.vrew, 쇼츠2.vrew, ... (+ .debug.json)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { parseCutScriptFile } = require('./core/cut-script-parser');
const { buildVrew } = require('./vrew/vrew-builder');
const presetStore = require('./tts/preset-store');
const { getInstance: getTTS } = require('./tts/tts-manager');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}

// ── 인자 파싱 ───────────────────────────────────────────────
//   기본: 실제 TTS(OmniVoice, 기본 프리셋). --dry: 무음 placeholder.
function parseArgs(argv) {
  const a = { script: null, out: null, dry: false, only: null, preset: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--dry') a.dry = true;
    else if (t === '--no-dry') a.dry = false;
    else if (t === '--only') a.only = parseInt(argv[++i], 10);
    else if (t === '--preset') a.preset = argv[++i];
    else if (!a.script) a.script = t;
  }
  return a;
}

// 파일명에 못 쓰는 문자 제거
function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 나레이션 의미 글자수 → 추정 재생 시간(초). 한국어 약 0.16s/음절 + 기본 1s, 2.2~6.5초 클램프.
function estimateDur(charCount) {
  const d = 1.0 + (charCount || 0) * 0.16;
  return Math.min(6.5, Math.max(2.2, Math.round(d * 100) / 100));
}

// ffmpeg 무음 mp3 생성 (24kHz mono — vrew-builder TTS 메타와 일치)
function makeSilentMp3(durSec, outPath) {
  if (!ffmpegPath) throw new Error('ffmpeg-static 미설치 — npm install ffmpeg-static');
  const args = [
    '-y', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`,
    '-t', String(durSec), '-acodec', 'libmp3lame', '-q:a', '9', outPath,
  ];
  const r = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg 무음 생성 실패 (status=${r.status})`);
  }
}

// 실제 TTS(OmniVoice 등)로 한 편의 sentence 오디오 채우기
async function fillTtsReal(pr, preset, ttsMgr, workDir, log) {
  for (const s of pr.sentences) {
    const out = path.join(workDir, `s${pr.shortsNum}_${s.num}.wav`);
    const res = await ttsMgr.synthesize(s.text, {
      provider: preset.engine,
      refAudioPath: preset.voiceCloneRefAudio || undefined,
      refText: preset.voiceCloneRefText || undefined,
      instruct: preset.instruct || undefined,
      cfgValue: preset.cfgValue,
      inferenceTimesteps: preset.inferenceTimesteps,
      speed: preset.speed,
      language: preset.language,
      seed: preset.seed,
    });
    fs.writeFileSync(out, res.mp3Buffer); // OmniVoice는 wav 버퍼 반환 (vrew-builder가 mp3 변환)
    s.ttsAudioPath = out;
    s.ttsDurationSec = res.durationSec;
    log(`   tts 쇼츠${pr.shortsNum} 컷${s.num}: ${res.durationSec.toFixed(2)}s "${s.text.slice(0, 18)}…"`);
  }
}

async function main() {
  const a = parseArgs(process.argv);
  if (!a.script) {
    console.error('usage: node build-shorts.js "<대본.md>" [--out <dir>] [--dry] [--only N] [--preset 이름]');
    process.exit(1);
  }
  if (!fs.existsSync(a.script)) {
    console.error('대본 파일 없음:', a.script);
    process.exit(1);
  }

  const { fileTitle, meta, projects } = parseCutScriptFile(a.script);
  const base = sanitize(path.basename(a.script).replace(/\.md$/i, ''));
  const outRoot = a.out || path.join(__dirname, 'output', base);
  fs.mkdirSync(outRoot, { recursive: true });
  const workDir = path.join(outRoot, '_work_audio');
  fs.mkdirSync(workDir, { recursive: true });

  // 프리셋 (실제 TTS 모드) — 기본 프리셋 또는 --preset 이름
  let preset = null;
  let ttsMgr = null;
  if (!a.dry) {
    const all = presetStore.loadAll();
    preset = a.preset ? all.find((p) => p.name === a.preset) : presetStore.getDefault();
    if (!preset) { console.error('프리셋 없음:', a.preset || '(default)'); process.exit(1); }
    ttsMgr = getTTS({ logger: (m) => console.log(m) });
    await ttsMgr.start();
    // start()는 omnivoice/supertonic 연결을 await하지 않음 → refreshProvider로 연결 완료를 기다림
    const ok = await ttsMgr.refreshProvider(preset.engine);
    if (!ok) {
      console.error(`TTS 엔진 '${preset.engine}' 사용 불가 — 백엔드 미기동? (--dry 로 무음 검증 가능)`);
      process.exit(1);
    }
  }

  console.log(`\n대본: ${fileTitle}`);
  console.log(`메타: voice="${meta.voice}" aspect=${meta.aspect}`);
  if (preset) console.log(`프리셋: "${preset.name}" (engine=${preset.engine}, voice=${preset.voice}, speed=${preset.speed}, ref=${path.basename(preset.voiceCloneRefAudio || '-')})`);
  console.log(`편수: ${projects.length}  →  출력: ${outRoot}`);
  console.log(a.dry ? '모드: DRY (무음 오디오로 구조 검증)\n' : '모드: REAL (OmniVoice 실제 음성)\n');

  const results = [];
  for (const pr of projects) {
    if (a.only && pr.shortsNum !== a.only) continue;

    // 오디오 채우기
    if (a.dry) {
      for (const s of pr.sentences) {
        const dur = estimateDur(s.charCount);
        const mp3 = path.join(workDir, `s${pr.shortsNum}_${s.num}.mp3`);
        makeSilentMp3(dur, mp3);
        s.ttsAudioPath = mp3;
        s.ttsDurationSec = dur;
      }
    } else {
      await fillTtsReal(pr, preset, ttsMgr, workDir, (m) => console.log(m));
    }

    // 프리셋의 자막 스타일/AI 고지를 .vrew 에 반영 (실제 모드)
    const opts = {
      aspect: pr.aspect || '9:16',
      skipSelfCheck: true,           // 이미지 누락(아직 미연결)을 에러로 막지 않음
      logger: (m) => console.log('   ' + m),
    };
    if (preset) {
      if (preset.captionStyle) opts.captionStyle = preset.captionStyle;
      if (preset.aiNotice && preset.aiNotice.enabled) opts.aiNotice = preset.aiNotice;
      if (preset.disableLongSplit != null) opts.disableLongSplit = preset.disableLongSplit;
    }

    const vrewPath = path.join(outRoot, `쇼츠${pr.shortsNum}.vrew`);
    try {
      const res = await buildVrew({ sentences: pr.sentences, groups: pr.groups, vrewPath, opts });
      console.log(`✓ 쇼츠${pr.shortsNum}: clip=${res.clipCount} image=${res.imageCount} tts=${res.sentenceCount} → ${path.basename(vrewPath)}`);
      results.push(res);
    } catch (e) {
      console.error(`✗ 쇼츠${pr.shortsNum} 실패: ${e.message}`);
    }
  }

  if (ttsMgr) { try { await ttsMgr.stop(); } catch {} }
  console.log(`\n완료: ${results.length}개 .vrew 생성 → ${outRoot}`);
  if (a.dry) console.log('(DRY: 음성은 무음 placeholder. Vrew에서 자막·9:16·타임라인 구조 확인용.)');
}

main().catch((e) => { console.error(e); process.exit(1); });
