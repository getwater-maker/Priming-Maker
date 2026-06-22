/**
 * pipeline.js — 대본 → TTS → .vrew 공유 파이프라인 (CLI build-shorts.js + Electron main.js 공용)
 *
 * 권위 있는 데이터(Project/Sentence/Group 인스턴스)는 호출자가 메모리에 보유하고,
 * 이 모듈의 함수들이 그 위에서 동작한다. 렌더러로는 toDTO()로 직렬화해 보낸다.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseCutScriptFile } = require('./cut-script-parser');
const { getModeProfile, normalizeMode } = require('./mode-profiles');
const { splitCaptionLines, meaningfulLen } = require('./caption-splitter');
const TtsCache = require('./tts-cache');
const MediaCache = require('./media-cache');
const { buildVrew } = require('../vrew/vrew-builder');
const presetStore = require('../tts/preset-store');
const { getInstance: getTTS } = require('../tts/tts-manager');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  // Electron asar 패키징 시 app.asar 안 경로는 실행 불가 → app.asar.unpacked 로 보정
  if (ffmpegPath && ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch {}

// ── 파싱 ────────────────────────────────────────────────
// mode 에 따라 파서 분기 (mode-profiles). shorts → cut-script-parser, longform → longform-parser.
//   결과 projects 에 mode 를 태깅해 이후 단계(그룹화/자막/.vrew)가 프로파일을 조회할 수 있게 한다.
function parseScript(scriptPath, mode = 'shorts', thresholds = {}) {
  const m = normalizeMode(mode);
  const profile = getModeProfile(m);
  let result;
  if (profile.parser === 'sentence-splitter') {
    // 롱폼 파서 — preset 분할옵션(thresholds) 적용. 미존재 시 cut-script 로 폴백(에러 대신 안전).
    try {
      const { parseLongformFile } = require('./parsers/longform-parser');
      result = parseLongformFile(scriptPath, thresholds);
    } catch (e) {
      result = parseCutScriptFile(scriptPath);
    }
  } else {
    result = parseCutScriptFile(scriptPath);
  }
  result.mode = m;
  for (const pr of result.projects) pr.mode = m;
  return result; // { fileTitle, meta, mode, projects: Project[] }
}

// 텍스트로부터 파싱 (대본 수정 기능용) — 파일 대신 문자열.
function parseScriptText(text, mode = 'shorts', thresholds = {}) {
  const m = normalizeMode(mode);
  const profile = getModeProfile(m);
  let result;
  if (profile.parser === 'sentence-splitter') {
    const { parseLongform } = require('./parsers/longform-parser');
    result = parseLongform(String(text || ''), '대본', thresholds);
  } else {
    const { parseCutScript } = require('./cut-script-parser');
    result = parseCutScript(String(text || ''));
  }
  result.mode = m;
  for (const pr of result.projects) pr.mode = m;
  return result;
}

/** Project[] → 렌더러용 직렬화 DTO */
function toDTO(parseResult) {
  const { fileTitle, meta, projects } = parseResult;
  const mode = normalizeMode(parseResult.mode || (projects[0] && projects[0].mode));
  const capChars = getModeProfile(mode).captionMaxChars;
  return {
    fileTitle,
    meta,
    mode,
    projects: projects.map((pr) => {
      let capN = 0; // 자막 줄 넘버링 — 그룹을 넘어 편 전체에서 이어짐
      return {
        shortsNum: pr.shortsNum,
        title: pr.title,
        mode: pr.mode || mode,
        aspect: pr.aspect,
        hookCaption: pr.hookCaption,
        titleLine1: pr.titleLine1 != null ? pr.titleLine1 : (pr.hookCaption || ''),
        titleLine2: pr.titleLine2 || '',
        t1Size: pr.t1Size || 120, t1Color: pr.t1Color || '#ffffff', t1Align: pr.t1Align || 'center',
        t2Size: pr.t2Size || 120, t2Color: pr.t2Color || '#ffe08a', t2Align: pr.t2Align || 'center',
        bgEnabled: !!pr.bgEnabled, bgFill: pr.bgFill || '#000000', bgFillOp: pr.bgFillOp != null ? pr.bgFillOp : 50,
        bgStroke: pr.bgStroke || '#000000', bgStrokeOp: pr.bgStrokeOp != null ? pr.bgStrokeOp : 0,
        bgStrokeW: pr.bgStrokeW || 0, bgRound: pr.bgRound || 0, bgDashed: !!pr.bgDashed,
        voice: pr.voice,
        cuts: pr.groups.map((g) => {
          const sents = pr.getSentencesOfGroup(g);
          return {
            num: g.num,
            phase: g.phase || null,
            isIntro: !!g.isIntro,
            mode: g.mode || (g.isI2V ? 'i2v' : 'motion'),
            isI2V: !!g.isI2V,
            sentences: sents.map((s) => ({
              text: s.text || '',
              dur: s.ttsDurationSec || null,
              audio: s.ttsAudioPath || null,
              // 브루 클립 단위(모드별 자막 글자수/쉼표) + 이어지는 넘버링
              lines: splitCaptionLines(s.text || '', capChars).map((t) => ({ n: ++capN, text: t })),
            })),
            groupDurationSec: sents.reduce((a, s) => a + (s.ttsDurationSec || 0), 0) || null,
            groupGenSec: sents.reduce((a, s) => a + (s.ttsGenSec || 0), 0) || null,
            imagePrompt: g.imagePrompt || '',
            videoPrompt: g.videoPrompt || '',
            motionNote: g.motionNote || '',
            imagePath: g.imagePath || null,
            videoPath: g.videoPath || null,
            imageStatus: g.imageStatus || null, // 'generating' | 'done' | 'fail'
            videoStatus: g.videoStatus || null, // 'generating' | 'done' | 'fail'
          };
        }),
      };
    }),
  };
}

// ── 프리셋 ──────────────────────────────────────────────
function getPreset(name) {
  const all = presetStore.loadAll();
  return name ? all.find((p) => p.name === name) || null : presetStore.getDefault();
}
function listPresets() {
  return presetStore.loadAll().map((p) => ({ name: p.name, engine: p.engine, isDefault: !!p.isDefault }));
}

// ── TTS 매니저 (연결 완료 보장) ──────────────────────────
async function makeTtsManager(logger, engine) {
  const mgr = getTTS({ logger: logger || (() => {}) });
  await mgr.start();
  // start()는 omnivoice/supertonic 연결을 await하지 않음 → refreshProvider로 완료 대기
  const ok = await mgr.refreshProvider(engine);
  return { mgr, ok };
}

// WAV(정속) → atempo 로 배속 구운 MP3. 피치 유지(atempo). 성공 시 true.
function atempoWavToMp3(wavPath, mp3Path, tempo) {
  if (!ffmpegPath) return false;
  const args = ['-y', '-i', wavPath, '-filter:a', `atempo=${tempo}`,
    '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '24000', '-ac', '1', mp3Path];
  const r = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
  return r.status === 0 && fs.existsSync(mp3Path);
}

// ── 오디오 채우기 ───────────────────────────────────────
// TTS 는 항상 정속(1.0) 합성 → speedFactor(기본 1.15) 만큼 atempo 로 배속 구운 MP3 로 변환.
//   배속이 음성에 직접 반영되므로 Vrew 배속(playbackRate) 불필요. 8초 그룹·.vrew 모두 이 음성 사용.
async function fillTtsList(sentences, preset, ttsMgr, workDir, onLine, abortSignal, speedFactor = 1.15, label = '', onProgress = null) {
  fs.mkdirSync(workDir, { recursive: true });
  const sf = (speedFactor != null && Number(speedFactor) > 0) ? Number(speedFactor) : 1;
  if (sf !== 1 && (!ffmpegPath || !fs.existsSync(ffmpegPath))) {
    if (onLine) onLine(`⚠ ffmpeg 사용 불가 — 배속(${sf}x) 미적용, 정속 WAV 로 진행 (경로: ${ffmpegPath || '없음'})`);
  } else if (sf !== 1 && onLine) {
    onLine(`🔊 음성 배속 ${sf}x 적용 (atempo MP3)`);
  }
  const synthOpts = {
    provider: preset.engine,
    refAudioPath: preset.voiceCloneRefAudio || undefined,
    refText: preset.voiceCloneRefText || undefined,
    instruct: preset.instruct || undefined,
    cfgValue: preset.cfgValue,
    inferenceTimesteps: preset.inferenceTimesteps,
    speed: 1.0,                 // 합성은 항상 정속
    language: preset.language,
    seed: preset.seed,
  };
  for (const s of sentences) {
    if (abortSignal && abortSignal()) { if (onLine) onLine('⏹ TTS 중단'); break; }
    const _genT0 = Date.now(); // 생성 소요시간 측정 (RTF = 생성시간/음성길이)
    // ♻ 캐시 재활용 — 같은 (문장+배속+목소리) 면 재합성 없이 캐시에서 복사.
    const cacheKey = TtsCache.keyFor(s.text, sf, synthOpts);
    const hit = TtsCache.get(cacheKey);
    if (hit) {
      const out = path.join(workDir, `${s.num}.${hit.ext}`);
      try { fs.copyFileSync(hit.file, out); s.ttsAudioPath = out; }
      catch { s.ttsAudioPath = hit.file; }
      s.ttsDurationSec = hit.dur;
      s.ttsGenSec = (Date.now() - _genT0) / 1000;
      if (onLine) onLine(`♻ ${label} 컷${s.num}: ${s.ttsDurationSec.toFixed(2)}s 재활용(캐시)`);
      if (onProgress) { try { onProgress(); } catch {} }
      continue;
    }
    // 일시적 'fetch failed'(서버 블립/네트워크) → 최대 3회 재시도. 그래도 실패면 명확한 에러.
    let res;
    for (let attempt = 1; ; attempt++) {
      try { res = await ttsMgr.synthesize(s.text, synthOpts); break; }
      catch (e) {
        if (abortSignal && abortSignal()) throw e;
        if (attempt >= 3) throw new Error(`TTS 실패(컷${s.num}, 3회 시도): ${e.message}`);
        if (onLine) onLine(`⚠ 컷${s.num} TTS 실패(${attempt}/3) — 재시도: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (sf !== 1) {
      // 정속 WAV → atempo 배속 MP3
      const wavTmp = path.join(workDir, `_raw_${s.num}.wav`);
      fs.writeFileSync(wavTmp, res.mp3Buffer);
      const mp3 = path.join(workDir, `${s.num}.mp3`);
      const ok = atempoWavToMp3(wavTmp, mp3, sf);
      try { fs.unlinkSync(wavTmp); } catch {}
      if (ok) { s.ttsAudioPath = mp3; s.ttsDurationSec = res.durationSec / sf; }
      else { // ffmpeg 실패 폴백: 정속 WAV 그대로
        const wav = path.join(workDir, `${s.num}.wav`); fs.writeFileSync(wav, res.mp3Buffer);
        s.ttsAudioPath = wav; s.ttsDurationSec = res.durationSec;
      }
    } else {
      const out = path.join(workDir, `${s.num}.wav`);
      fs.writeFileSync(out, res.mp3Buffer);
      s.ttsAudioPath = out; s.ttsDurationSec = res.durationSec;
    }
    s.ttsGenSec = (Date.now() - _genT0) / 1000; // 이 문장 생성에 걸린 실시간(초)
    // 캐시에 저장(다음 동일 작업 시 재활용)
    try { TtsCache.put(cacheKey, s.ttsAudioPath, s.ttsDurationSec, path.extname(s.ttsAudioPath).slice(1).toLowerCase() || 'wav'); } catch {}
    if (onLine) onLine(`tts ${label} 컷${s.num}: ${s.ttsDurationSec.toFixed(2)}s${sf !== 1 ? ` (${sf}x)` : ''} · 생성 ${s.ttsGenSec.toFixed(1)}s`);
    // 문장 한 개 변환 완료 → 즉시 화면 갱신(시간 표시). PrimingFlow 처럼 바로바로 진행상황 반영.
    if (onProgress) { try { onProgress(); } catch {} }
  }
}

// 프로젝트 전체 문장 TTS (fillTtsList 래퍼)
async function fillTts(project, preset, ttsMgr, workDir, onLine, abortSignal, speedFactor = 1.15, onProgress = null) {
  const lbl = project.mode === 'longform' ? '롱폼' : `쇼츠${project.shortsNum}`;
  return fillTtsList(project.sentences, preset, ttsMgr, workDir, onLine, abortSignal, speedFactor, lbl, onProgress);
}

function makeSilentMp3(durSec, outPath) {
  if (!ffmpegPath) throw new Error('ffmpeg-static 미설치');
  const args = ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(durSec), '-acodec', 'libmp3lame', '-q:a', '9', outPath];
  const r = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(outPath)) throw new Error('ffmpeg 무음 생성 실패');
}
function fillSilent(project, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  for (const s of project.sentences) {
    const dur = Math.min(6.5, Math.max(2.2, 1.0 + (s.charCount || 0) * 0.16));
    const mp3 = path.join(workDir, `${s.num}.mp3`);
    makeSilentMp3(dur, mp3);
    s.ttsAudioPath = mp3;
    s.ttsDurationSec = dur;
  }
}

// ── .vrew 내보내기 (편별) ───────────────────────────────
async function buildProjectVrew(project, vrewPath, preset, logger, captionMaxChars, playbackRate) {
  const opts = {
    aspect: project.aspect || '9:16',
    skipSelfCheck: true,            // 이미지 미연결 단계에서 누락을 에러로 막지 않음
    captionMaxChars: captionMaxChars || 7,
    playbackRate: (playbackRate != null && Number(playbackRate) > 0) ? Number(playbackRate) : 1, // Vrew 배속 미사용(음성에 이미 배속 반영) — 기본 1
    logger: logger || (() => {}),
  };
  if (preset) {
    if (preset.captionStyle) opts.captionStyle = preset.captionStyle;
    if (preset.aiNotice && preset.aiNotice.enabled) opts.aiNotice = preset.aiNotice;
    if (preset.disableLongSplit != null) opts.disableLongSplit = preset.disableLongSplit;
  }
  // 제목(훅) 상단 고정 — 편별 titleLine1/2 + 줄별 스타일
  const l1 = project.titleLine1 != null ? project.titleLine1 : (project.hookCaption || '');
  const l2 = project.titleLine2 || '';
  if (l1 || l2) {
    opts.title = {
      line1: l1, line2: l2,
      l1: { size: project.t1Size || 120, color: project.t1Color || '#ffffff', align: project.t1Align || 'center' },
      l2: { size: project.t2Size || 120, color: project.t2Color || '#ffe08a', align: project.t2Align || 'center' },
    };
    // 제목 배경 도형
    if (project.bgEnabled) {
      opts.titleBg = {
        enabled: true,
        fillColor: project.bgFill || '#000000',
        fillOpacity: project.bgFillOp != null ? project.bgFillOp : 50,
        borderColor: project.bgStroke || '#000000',
        borderOpacity: project.bgStrokeOp != null ? project.bgStrokeOp : 0,
        borderWidth: project.bgStrokeW || 0,
        cornerRounding: project.bgRound || 0,
        dashed: !!project.bgDashed,
      };
    }
  }
  return buildVrew({ sentences: project.sentences, groups: project.groups, vrewPath, opts });
}

// ── 이미지 생성 ─────────────────────────────────────────
// group.imagePrompt 를 "그대로" 투입. 컷 num → cut{num}.png. 결과를 group.imagePath 에 매핑.
// 모든 이미지 엔진(Genspark/Flow/…) 공통 최종 프롬프트 빌더 — 엔진이 달라도 동일 프롬프트 보장.
//   `<스타일>, <대본 이미지프롬프트>, no text, no watermark`
function buildImagePrompt(stylePrompt, imagePrompt) {
  const style = stylePrompt ? String(stylePrompt).trim().replace(/[,\s]+$/, '') + ', ' : '';
  const body = String(imagePrompt || '').trim().replace(/[,\s]+$/, '');
  return `${style}${body}, no text, no watermark`;
}

// 모더레이션(NSFW) 우회용 프롬프트 순화 — 무기/폭력/유혈/선정 표현을 완화.
//   내용이 다소 바뀌어도 검은 화면보다 낫다(로그로 알림). 한국사 장면(군졸·추격 등)이 자주 걸림.
function softenForModeration(prompt) {
  let p = ' ' + String(prompt || '') + ' ';
  const rules = [
    [/\b(spears?|swords?|blades?|knives?|knife|daggers?|weapons?|arrows?|bows?|guns?|rifles?)\b/gi, 'wooden staff'],
    [/\b(blood|bloody|gore|gory|wounds?|wounded|injur(?:y|ies|ed))\b/gi, ' '],
    [/\b(killing|killed|kills?|murder\w*|slay\w*|stab\w*|attack\w*|fight\w*|battle|combat|violence|violent|assault\w*)\b/gi, 'confront'],
    [/\b(chase|chasing|hunt\w*|pursu\w*|capture|capturing|arrest\w*)\b/gi, 'follow'],
    [/\b(corpse|dead body|death|dying|execution|behead\w*)\b/gi, 'fallen figure'],
    [/\b(naked|nude|nudity|sexy|seductive|erotic|cleavage|lingerie)\b/gi, 'fully clothed'],
    [/\b(torture\w*|whip\w*|beating|beaten|punish\w*)\b/gi, 'scene'],
  ];
  for (const [re, to] of rules) p = p.replace(re, to);
  p = p.replace(/\s{2,}/g, ' ').trim();
  return p + ', wholesome historical illustration, safe for work, no violence, no weapons';
}

async function generateImagesGenspark(project, imagesDir, logger, abortSignal, stylePrompt, onlyNums, onProgress) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const groups = project.groups;
  const idx = groups.map((g, i) => i).filter((i) => groups[i].imagePrompt && groups[i].imagePrompt.trim()
    && !(groups[i].imagePath && fs.existsSync(groups[i].imagePath)) // 이미 있음(캐시 프리필) → 건너뜀
    && (!onlyNums || onlyNums.includes(groups[i].num)));
  if (!idx.length) { (logger || (() => {}))('이미지 프롬프트가 있는 컷이 없음'); return []; }

  // 대상 그룹을 '생성 중'으로 표시 → UI 즉시 반영 (사용자가 진행 상황을 바로 인지)
  idx.forEach((i) => { if (!groups[i].imagePath) groups[i].imageStatus = 'generating'; });
  if (onProgress) { try { onProgress(); } catch {} }

  const log = logger || (() => {});
  // 모든 엔진(Genspark/Flow/…) 공통 최종 프롬프트 — 스타일 앞 + 대본 + no text/no watermark.
  const prompts = idx.map((i) => buildImagePrompt(stylePrompt, groups[i].imagePrompt));
  const outputPaths = idx.map((i) => path.join(imagesDir, `${String(groups[i].num).padStart(2, '0')}.png`));

  const { GensparkEngine } = require('../genspark-engine');
  const eng = new GensparkEngine({ profileId: 'default', logger: log });
  eng._aspectRatio = project.aspect || '9:16'; // 9:16 비율 강제 (config ratio override)

  // Genspark 는 한 번 제출에 최대 6장 → 6개씩 묶어 배치 제출.
  //   배치가 6장 중 일부만 나오면 engine 이 순서 오매칭 방지로 통째 버림 → 여기서 재시도.
  //   1) 배치 1회 → 2) 빠진 컷은 단건(1장)으로 재생성(매핑 안전·막힌 컷 격리). 단건도 MAX_SINGLE_TRY 회.
  const BATCH = 6;
  const MAX_SINGLE_TRY = 2;
  const results = new Array(idx.length);
  let limitReached = false; // 사용 한도/제한 도달 → 순환에서 다음 엔진으로 넘기는 신호
  try {
    for (let start = 0; start < idx.length; start += BATCH) {
      if (abortSignal && abortSignal()) break;
      if (limitReached) break;
      const ps = prompts.slice(start, start + BATCH);
      const ops = outputPaths.slice(start, start + BATCH);
      const saved = new Array(ps.length).fill(null);
      // 저장되는 즉시 그룹에 매핑 → UI 갱신
      const mapSave = (k, p) => {
        const g = groups[idx[start + k]];
        if (g && p) { g.imagePath = p; g.imageStatus = 'done'; if (onProgress) { try { onProgress(); } catch {} } }
      };
      log(`[Genspark] 배치 ${Math.floor(start / BATCH) + 1}: ${ps.length}장 한 번에 제출`);
      const r = await eng.generateImagesBatch({ prompts: ps, outputPaths: ops, abortSignal: abortSignal || (() => false), onSaved: mapSave });
      if (r.some((x) => x && x.limit)) { limitReached = true; log('[Genspark] ⚠ 사용 한도/제한 도달 — 남은 이미지는 순환의 다음 엔진으로'); break; }
      for (let k = 0; k < ps.length; k++) if (r[k] && r[k].path) saved[k] = r[k];

      // 빠진 컷 → 단건 재생성 (6장이 다 나올 때까지)
      const missing = [];
      for (let k = 0; k < ps.length; k++) if (!(saved[k] && saved[k].path)) missing.push(k);
      if (missing.length && !(abortSignal && abortSignal())) {
        log(`[Genspark] ⚠ 배치 미완료 — 빠진 ${missing.length}장을 단건으로 재생성`);
        for (const k of missing) {
          if (abortSignal && abortSignal()) break;
          if (limitReached) break;
          const num = groups[idx[start + k]].num;
          let prevBlocked = false;
          for (let attempt = 1; attempt <= MAX_SINGLE_TRY; attempt++) {
            // 직전이 NSFW 차단이면 프롬프트를 순화해 우회. transient 실패면 원본 그대로 재시도.
            const usePrompt = prevBlocked ? softenForModeration(ps[k]) : ps[k];
            log(`[Genspark] 단건 재생성 G${num} (시도 ${attempt}/${MAX_SINGLE_TRY})${prevBlocked ? ' · 프롬프트 순화' : ''}`);
            const rr = await eng.generateImagesBatch({ prompts: [usePrompt], outputPaths: [ops[k]], abortSignal: abortSignal || (() => false), onSaved: (_kk, p) => mapSave(k, p) });
            if (rr[0] && rr[0].path) { saved[k] = rr[0]; break; }
            if (rr[0] && rr[0].limit) { limitReached = true; break; } // 한도 → 단건 중단
            prevBlocked = !!(rr[0] && rr[0].blocked);
            if (prevBlocked) log(`[Genspark] G${num} NSFW 차단 감지 — 다음 시도는 프롬프트 순화`);
            else if (attempt < MAX_SINGLE_TRY) log(`[Genspark] G${num} 단건 실패 — 재시도`);
          }
          if (!(saved[k] && saved[k].path)) {
            const g = groups[idx[start + k]];
            if (prevBlocked) { g.imageStatus = 'blocked'; log(`[Genspark] ⛔ G${num} 모더레이션(NSFW)으로 막힘 — 순화로도 실패. 프롬프트 수정 또는 다른 엔진(ComfyUI) 필요`); }
            else log(`[Genspark] ✗ G${num} 최종 실패`);
          }
        }
      }
      for (let k = 0; k < ps.length; k++) results[start + k] = saved[k] || { error: '생성 실패(재시도 소진)' };
    }
  } finally {
    try { await eng.stop(); } catch {}
  }

  results.forEach((r, k) => {
    const g = groups[idx[k]];
    if (r && r.path) { g.imagePath = r.path; g.imageStatus = 'done'; }
    else if (g.imageStatus === 'generating') { g.imageStatus = 'fail'; }
  });
  if (onProgress) { try { onProgress(); } catch {} }
  const ok = results.filter((r) => r && r.path).length;
  log(`이미지 ${ok}/${idx.length} 생성 (쇼츠${project.shortsNum})`);
  return { results, ok, total: idx.length, limitReached };
}

// 엔진 분기 (현재 genspark 구현, flow는 main.js에서 win 필요로 별도 처리)
async function generateImages(project, engine, imagesDir, logger, abortSignal) {
  if (engine === 'genspark') return generateImagesGenspark(project, imagesDir, logger, abortSignal);
  throw new Error(`이미지 엔진 '${engine}' 미지원(파이프라인) — flow는 main.js 경로`);
}

// ── 앞에서 N개 그룹 → Grok image-to-video (PrimingFlow 방식: 개수 지정) ──────────
// videoCount 만큼 앞 그룹부터 영상화. 모션 프롬프트 = group.videoPrompt(I2V) || group.motionNote || Grok 기본.
async function generateHookVideosGrok(project, videoDir, logger, abortSignal, videoCount, onProgress, onlyNums, videoDuration) {
  fs.mkdirSync(videoDir, { recursive: true });
  const log = logger || (() => {});
  let targets;
  if (onlyNums && onlyNums.length) {
    targets = project.groups.filter((g) => onlyNums.includes(g.num)); // 지정 그룹만
  } else {
    const N = Math.max(0, parseInt(videoCount, 10) || 0);
    if (!N) { log('비디오 개수 0 — 생성 안 함'); return []; }
    targets = project.groups.slice(0, N); // 앞에서 N개 그룹
  }

  const { GrokEngine } = require('../grok-engine');
  const eng = new GrokEngine({ profileId: 'default', logger: log });
  eng._aspectRatio = project.aspect || '9:16'; // 이미지 비율(9:16/1:1)에 맞춰 영상 생성
  if (videoDuration === '10s' || videoDuration === '6s') eng._videoDuration = videoDuration; // UI 지정 클립 길이

  const results = [];
  try {
    for (const g of targets) {
      if (!g.imagePath || !fs.existsSync(g.imagePath)) {
        log(`그룹${g.num}: 이미지가 없어 영상 건너뜀 (먼저 이미지 생성 필요)`);
        results.push({ num: g.num, success: false, error: 'no image' });
        continue;
      }
      if (g.videoPath && fs.existsSync(g.videoPath)) { results.push({ num: g.num, success: true }); continue; }
      const outputPath = path.join(videoDir, `${String(g.num).padStart(2, '0')}.mp4`);
      const vprompt = g.videoPrompt || g.motionNote || g.videoMotionPrompt || '';
      // ♻ 영상 캐시 재활용 — 같은 (영상프롬프트 + 원본이미지) 면 재생성 안 함.
      const vck = MediaCache.videoKey(vprompt, g.imagePath, project.aspect || '9:16', 'grok');
      const vhit = MediaCache.get(vck);
      if (vhit) {
        try { fs.copyFileSync(vhit.file, outputPath); g.videoPath = outputPath; g.videoSourceImage = g.imagePath; g.videoStatus = 'done'; log(`♻ 그룹${g.num} 영상 재활용(캐시)`); if (onProgress) { try { onProgress(); } catch {} } results.push({ num: g.num, success: true }); continue; } catch {}
      }
      g.videoStatus = 'generating';
      if (onProgress) { try { onProgress(); } catch {} } // '영상 변환 중' 배지 즉시 표시
      const res = await eng.generateVideoFromImage({
        imagePath: g.imagePath,
        prompt: g.videoPrompt || g.motionNote || g.videoMotionPrompt || null, // 없으면 Grok 기본 모션
        outputPath,
        abortSignal: abortSignal || (() => false),
      });
      if (res && res.success && res.videoPath) {
        g.videoPath = res.videoPath;
        g.videoSourceImage = g.imagePath;
        g.videoStatus = 'done';
        MediaCache.put(vck, res.videoPath, 'mp4');
        log(`✓ 그룹${g.num} 영상 생성${res.downgradedTo ? ` (${res.downgradedTo})` : ''}`);
      } else {
        g.videoStatus = 'fail';
        log(`✗ 그룹${g.num} 영상 실패: ${res && res.error}`);
      }
      results.push({ num: g.num, ...res });
      if (onProgress) { try { onProgress(); } catch {} } // 그룹별 영상 완성 시 UI 갱신
    }
  } finally {
    try { await eng.stop(); } catch {}
  }
  return results;
}

// ── 그룹 재구성: 문장 기준 8초 미만 단위 (TTS 후 자동 호출) ──────────────
// 모든 문장을 순서대로 그리디 패킹 — 각 그룹의 TTS 합이 maxSec(8.0)을 넘지 않게.
//   · 큰 그룹(문장 多, >8초)은 쪼개지고, 작은 그룹들은 합쳐짐 → 결과 그룹은 모두 <8.0초.
//   · 단일 문장이 maxSec 를 넘으면(드묾) 그 문장 단독 그룹(쪼갤 수 없음).
//   · 각 새 그룹의 phase/프롬프트는 첫 문장이 속했던 원본 그룹 값을 보존(프롬프트 없으면 null).
function mergeGroupsByTts(project, maxSec = 8.0) {
  const { Group, finalizeGroupIds } = require('./project-model');
  const groups = project.groups;
  if (!groups || !groups.length) return { before: 0, after: 0, merged: 0 };

  // 문장을 그룹 순서대로 평탄화 (원본 그룹의 phase/프롬프트 동반)
  const ordered = [];
  for (const g of groups) {
    for (const s of project.getSentencesOfGroup(g)) {
      ordered.push({ s, phase: g.phase || null, imagePrompt: g.imagePrompt || null, videoPrompt: g.videoPrompt || null, motionNote: g.motionNote || null });
    }
  }
  if (!ordered.length) return { before: groups.length, after: groups.length, merged: 0 };

  // 문장 단위 그리디 패킹 (8초 캡)
  const buckets = [];
  let cur = null, curDur = 0;
  for (const it of ordered) {
    const d = it.s.ttsDurationSec || 0;
    if (cur && (curDur + d) <= maxSec + 1e-6) { cur.push(it); curDur += d; }
    else { cur = [it]; curDur = d; buckets.push(cur); }
  }

  const newGroups = buckets.map((bucket, i) => {
    const first = bucket[0];
    const ng = new Group({ num: i + 1, sentenceIds: bucket.map((it) => it.s.id) });
    ng.phase = first.phase;
    ng.title = first.phase;
    ng.imagePrompt = bucket.map((it) => it.imagePrompt).find((p) => p && p.trim()) || null;
    ng.videoPrompt = bucket.map((it) => it.videoPrompt).find((p) => p && p.trim()) || null;
    ng.motionNote = bucket.map((it) => it.motionNote).find((p) => p && p.trim()) || null;
    ng.isI2V = !!ng.videoPrompt;
    ng.mode = ng.isI2V ? 'i2v' : 'motion';
    return ng;
  });

  project.groups = newGroups;
  finalizeGroupIds(newGroups, project.sentences); // sentence.groupId 재지정 + 안정 id
  return { before: groups.length, after: newGroups.length, merged: groups.length - newGroups.length };
}

// ── SRT 자막 파일 (subtitles 폴더용) ────────────────────
function _fmtSrt(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function writeSrt(project, srtPath, maxChars = 7) {
  fs.mkdirSync(path.dirname(srtPath), { recursive: true });
  let t = 0, idx = 1, out = '';
  for (const g of project.groups) {
    for (const s of project.getSentencesOfGroup(g)) {
      const dur = s.ttsDurationSec || 2.5;
      const clips = splitCaptionLines(s.text, maxChars);
      const totW = clips.reduce((a, c) => a + Math.max(1, meaningfulLen(c)), 0) || 1;
      let acc = t;
      clips.forEach((c, i) => {
        const cd = dur * (Math.max(1, meaningfulLen(c)) / totW);
        const start = acc;
        const end = (i === clips.length - 1) ? t + dur : acc + cd;
        out += `${idx++}\n${_fmtSrt(start)} --> ${_fmtSrt(end)}\n${c}\n\n`;
        acc = end;
      });
      t += dur;
    }
  }
  try { fs.writeFileSync(srtPath, out, 'utf8'); } catch {}
}

// 파일명 안전화
function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = {
  parseScript, parseScriptText, toDTO, getPreset, listPresets,
  makeTtsManager, fillTts, fillTtsList, fillSilent, buildProjectVrew, sanitize,
  generateImages, generateImagesGenspark, generateHookVideosGrok, writeSrt,
  mergeGroupsByTts, buildImagePrompt,
};
