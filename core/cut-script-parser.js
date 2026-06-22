/**
 * cut-script-parser.js — "역사이야기" 쇼츠 대본(.md) 파서 (2형식 자동 감지)
 *
 * ▸ 신규(그룹) 형식 — 권장. 그룹당 이미지 1장 + 문장 여러 개 + (선택)I2V 영상 프롬프트:
 *     ## 쇼츠 1
 *     - 훅 자막(첫 프레임): ...
 *     **🎬 그룹 1 ｜훅 (이미지 → 비디오)**
 *     - 음성/자막:
 *       - 문장 1
 *       - 문장 2
 *     - 🖼️ 이미지: `image prompt`
 *     - 🎬 → 비디오(I2V): `i2v video prompt`        ← 🎬 그룹(훅·절정)만
 *     **🎞️ 그룹 2 ｜본론 (이미지 + 모션)**
 *     - 음성/자막: ...
 *     - 🖼️ 이미지: `image prompt`
 *     - 🎞️ 모션: slow zoom-in + 좌→우 팬           ← 켄번스 힌트(영상 아님)
 *
 * ▸ 줄글(prose) 형식 — 신규. 이미지 프롬프트 없음(내보내기/가져오기로 생성):
 *     ## 쇼츠 1
 *     제목:
 *     제목 1줄
 *     제목 2줄
 *     [훅]                  ← 대괄호 = 그룹(phase)
 *     문장1
 *     문장2
 *     [본론 심화]
 *     ★CTA: …               ← 별표 라벨도 그룹 헤더
 *
 * ▸ 구(컷) 형식 — 하위호환. 컷=문장=그룹 1:1:1:
 *     ① (훅) 나레이션
 *        `image prompt`
 *        🎬 `video/motion prompt`   ← (선택) 있으면 Grok 영상에 이 프롬프트 사용(없으면 기본값)
 *        🎞 모션 힌트               ← (선택) videoPrompt 없을 때 폴백·켄번스 설명
 *
 * 데이터 매핑(공통): 그룹 → Group(imagePrompt/videoPrompt/phase/mode), 문장 → Sentence.
 *   ## 쇼츠 N → Project (aspect '9:16'). 한 파일 → Project 여러 개.
 */

const fs = require('fs');
const {
  Sentence, Group, Project, makeSentenceIder, finalizeGroupIds, countMeaningful,
} = require('./project-model');

// 한 나레이션 줄/컷을 문장 단위로 분리 (긴 런온 문장이 8초 그룹을 넘기는 것 방지).
//   1) 마침표·물음표·느낌표(. ? ! 。)로 문장 분리 (종결부호 유지)
//   2) 그래도 maxChars(유효 글자수) 넘으면 쉼표(,) 절 단위로 그리디 분리
// 반환: 문장 문자열 배열. (TTS 전에 분리 → 각 문장이 별도 음성으로 합성, 오디오 자르기 불필요)
function splitNarration(text, maxChars = 28) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return [];
  const sentences = raw.match(/[^.!?。]+[.!?。]+|[^.!?。]+$/g) || [raw];
  const out = [];
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    if (countMeaningful(s) <= maxChars) { out.push(s); continue; }
    // 너무 긴 단일 문장 → 쉼표 뒤에서 절 단위로 묶기
    const parts = s.split(/(?<=,)\s*/);
    let cur = '';
    for (const p of parts) {
      if (cur && countMeaningful(cur + p) > maxChars) { out.push(cur.trim()); cur = p; }
      else cur += p;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length ? out : [raw];
}

const H2_SHORTS_RE = /^##\s*쇼츠\s*(\d+)\s*(.*)$/;
const H1_RE = /^#\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const HOOK_RE = /^\s*-\s*훅\s*자막\s*\(\s*첫\s*프레임\s*\)\s*:\s*(.+?)\s*$/;

// ── 신규(그룹) 형식 ─────────────────────────────────────
// **🎬 그룹 1 ｜훅 (이미지 → 비디오)**  /  **🎞️ 그룹 2 ｜본론 (이미지 + 모션)**
const GROUP_HEADER_RE = /그룹\s*(\d+)\s*[｜|│ǀ]\s*([^(（]+?)\s*[（(]([^)）]+)[)）]/;
const backtick = (t) => { const m = t.match(/`([^`]+)`/); return m ? m[1].trim() : null; };

// ── 구(컷) 형식 ─────────────────────────────────────────
const CUTLIST_HEADER_RE = /^\s*-\s*컷\s*리스트/;
const CUT_RE = /^\s*([①-⑳])\s*(?:\(([^)]*)\))?\s*(.+?)\s*$/;
const PROMPT_LINE_RE = /^\s*`(.+)`\s*$/;

// ── 줄글(prose) 형식 ────────────────────────────────────
// `제목:` 2줄 + `[단계]` 그룹 헤더 + 그 아래 문장들 (이미지 프롬프트 없음 → 내보내기/가져오기로 생성).
const PROSE_BRACKET_RE = /^\s*\[([^\]]+)\]\s*$/;        // [훅], [본론 심화], [재훅 / 방향전환] …
const TITLE_LABEL_RE = /^\s*제목\s*[:：]\s*(.*)$/;

function circledToInt(ch) {
  if (!ch) return null;
  const code = ch.codePointAt(0);
  if (code >= 0x2460 && code <= 0x2473) return code - 0x2460 + 1;
  return null;
}

function parseMeta(rawLine) {
  const raw = (rawLine || '').trim();
  const meta = { raw, voice: null, aspect: '9:16' };
  const vm = raw.match(/목소리\s*:\s*([^·|]+)/);
  if (vm) meta.voice = vm[1].trim();
  if (/16:9/.test(raw)) meta.aspect = '16:9';
  else if (/9:16/.test(raw)) meta.aspect = '9:16';
  return meta;
}

// ── 신규(그룹) 블록 파서 ────────────────────────────────
function parseShortsBlockGrouped(lines) {
  let hookCaption = null;
  const groups = [];
  let cur = null;
  let mode = null; // 'voice' = 음성/자막 하위 문장 수집 중

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    const hm = line.match(HOOK_RE);
    if (hm) { hookCaption = hm[1].trim(); continue; }

    // 그룹 헤더 (줄에 ** 와 '그룹' 포함)
    if (/\*\*/.test(t) && /그룹/.test(t)) {
      const gh = t.match(GROUP_HEADER_RE);
      if (gh) {
        const phase = gh[2].trim();
        const modeText = gh[3].trim();
        cur = {
          num: parseInt(gh[1], 10), phase, modeText,
          isI2V: /비디오|I2V/i.test(modeText),
          sentences: [], imagePrompt: null, videoPrompt: null, motionNote: null,
        };
        groups.push(cur);
        mode = null;
        continue;
      }
    }
    if (!cur) continue;

    // 음성/자막 시작
    if (/^-\s*음성\s*\/\s*자막\s*:/.test(t)) { mode = 'voice'; continue; }
    // 이미지 프롬프트
    if (/^-\s*(?:🖼|이미지\s*:)/.test(t) || (/이미지\s*:/.test(t) && /`/.test(t))) {
      cur.imagePrompt = backtick(t) || cur.imagePrompt; mode = null; continue;
    }
    // I2V 비디오 프롬프트 (🎬 로 시작)
    if (/^-\s*🎬/.test(t) || (/비디오\s*\(?\s*I2V/i.test(t) && /`/.test(t))) {
      const bp = backtick(t);
      if (bp) { cur.videoPrompt = bp; cur.isI2V = true; }
      mode = null; continue;
    }
    // 모션 힌트 (🎞 로 시작) — 영상 아님(켄번스 설명)
    if (/^-\s*🎞/.test(t) || /^-\s*모션\s*:/.test(t)) {
      cur.motionNote = t.replace(/^-\s*🎞[^:]*:\s*/, '').replace(/^-\s*모션\s*:\s*/, '').trim();
      mode = null; continue;
    }
    // 음성/자막 하위 문장
    if (mode === 'voice' && /^-\s+/.test(t)) {
      const txt = t.replace(/^-\s+/, '').trim();
      if (txt) cur.sentences.push(txt);
      continue;
    }
  }

  return { hookCaption, groups };
}

function buildProjectModelGrouped(groupsData) {
  const sid = makeSentenceIder();
  const sentences = [];
  const groups = [];
  groupsData.forEach((gd, gi) => {
    const g = new Group({ num: gd.num || gi + 1, sentenceIds: [] });
    g.imagePrompt = gd.imagePrompt || null;
    g.videoPrompt = gd.videoPrompt || null;
    g.phase = gd.phase || null;
    g.title = gd.phase || null;
    g.mode = gd.isI2V ? 'i2v' : 'motion';
    g.isI2V = !!gd.isI2V;
    g.motionNote = gd.motionNote || null;
    // 문장이 하나도 없으면 빈 그룹 — 스킵(이미지/영상만 있는 비정상 블록 방지)
    const texts = (gd.sentences && gd.sentences.length) ? gd.sentences : [];
    for (const rawText of texts) {
      for (const text of splitNarration(rawText)) { // 런온 줄 → 문장 단위로 분리
        const s = new Sentence({ id: sid(text), num: sentences.length + 1, text });
        s.groupId = g.id;
        g.sentenceIds.push(s.id);
        sentences.push(s);
      }
    }
    groups.push(g);
  });
  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

// ── 구(컷) 블록 파서 ────────────────────────────────────
function parseShortsBlock(lines) {
  let hookCaption = null;
  const cuts = [];
  let collecting = null;
  const stripBackticks = (s) => s.replace(/^\s*`/, '').replace(/`\s*$/, '').trim();

  for (const line of lines) {
    const t = line.trim();
    if (collecting !== null) {
      collecting += '\n' + line;
      if (t.endsWith('`')) {
        if (cuts.length) cuts[cuts.length - 1].imagePrompt = stripBackticks(collecting);
        collecting = null;
      }
      continue;
    }
    if (!t) continue;
    const hm = line.match(HOOK_RE);
    if (hm) { hookCaption = hm[1].trim(); continue; }
    if (CUTLIST_HEADER_RE.test(line)) continue;
    // 🎬 비디오(I2V) 프롬프트 — 컷 이미지 프롬프트 다음 줄. 있으면 Grok 기본 모션 대신 사용.
    //   예) 🎬 `slow push-in on her face, gentle falling snow, cinematic`
    if (/^\s*-?\s*🎬/.test(line)) {
      const bp = backtick(t);
      if (bp && cuts.length) cuts[cuts.length - 1].videoPrompt = bp;
      continue;
    }
    // 🎞 모션 힌트 — 영상이 안 만들어지는 컷의 켄번스 설명 / videoPrompt 없을 때 폴백.
    if (/^\s*-?\s*🎞/.test(line) || /^\s*-?\s*모션\s*[:：]/.test(t)) {
      // '🎞', '🎞️', 선택적 '모션', 선택적 콜론만 제거 — 설명 본문은 보존
      const note = t.replace(/^-?\s*(?:🎞️?)?\s*(?:모션)?\s*[:：]?\s*/, '').replace(/`/g, '').trim();
      if (note && cuts.length) cuts[cuts.length - 1].motionNote = note;
      continue;
    }
    const pm = line.match(PROMPT_LINE_RE);
    if (pm) { if (cuts.length) cuts[cuts.length - 1].imagePrompt = pm[1].trim(); continue; }
    if (t.startsWith('`') && !(t.length > 1 && t.endsWith('`'))) { collecting = line; continue; }
    const cm = line.match(CUT_RE);
    if (cm && circledToInt(cm[1])) {
      cuts.push({ index: circledToInt(cm[1]), phase: (cm[2] || '').trim() || null, narration: (cm[3] || '').trim(), imagePrompt: null, videoPrompt: null, motionNote: null });
      continue;
    }
  }
  return { hookCaption, cuts };
}

function buildProjectModel(cuts) {
  const sid = makeSentenceIder();
  const sentences = [];
  const groups = [];
  cuts.forEach((c, i) => {
    const g = new Group({ num: i + 1, sentenceIds: [] });
    g.imagePrompt = c.imagePrompt || null;
    g.videoPrompt = c.videoPrompt || null;
    g.motionNote = c.motionNote || null;
    g.phase = c.phase || null;
    g.title = c.phase || null;
    // 🎬 비디오 프롬프트가 있거나 훅이면 I2V 그룹으로 표시
    g.isI2V = !!c.videoPrompt || (c.phase === '훅');
    g.mode = g.isI2V ? 'i2v' : 'motion';
    // 컷 나레이션을 문장 단위로 분리(런온 문장 → 여러 문장). 그룹은 그 문장들을 모두 가짐.
    for (const text of splitNarration(c.narration)) {
      const s = new Sentence({ id: sid(text), num: sentences.length + 1, text });
      s.groupId = g.id;
      g.sentenceIds.push(s.id);
      sentences.push(s);
    }
    groups.push(g);
  });
  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

// ── 줄글(prose) 블록 파서 ───────────────────────────────
// `제목:` 다음 줄들 = 제목(최대 2줄). `[단계]` = 그룹(phase). 그 아래 각 줄 = 문장.
// 이미지 프롬프트는 없음(나중에 내보내기/가져오기/API로 생성).
function parseShortsBlockProse(lines) {
  const groups = [];
  let cur = null;
  const titleLines = [];
  let inTitle = false;
  let hookCaption = null;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { inTitle = false; continue; }              // 빈 줄 = 제목 수집 종료

    const hm = raw.match(HOOK_RE);                       // - 훅 자막(첫 프레임): … (있으면)
    if (hm) { hookCaption = hm[1].trim(); inTitle = false; continue; }

    const tm = t.match(TITLE_LABEL_RE);                  // 제목:
    if (tm) { inTitle = true; if (tm[1]) titleLines.push(tm[1].trim()); continue; }

    const bm = t.match(PROSE_BRACKET_RE);                // [단계] = 그룹 헤더
    if (bm) { inTitle = false; cur = { num: groups.length + 1, phase: bm[1].trim(), sentences: [] }; groups.push(cur); continue; }

    // ★CTA: 같은 별표 라벨 = 새 그룹 헤더 (phase=라벨, 같은 줄 뒤 텍스트는 첫 문장)
    if (t.startsWith('★')) {
      const sm = t.match(/^★+\s*([^:：]+?)\s*[:：]\s*(.*)$/);
      const phase = sm ? sm[1].trim() : t.replace(/^★+\s*/, '').trim();
      inTitle = false; cur = { num: groups.length + 1, phase, sentences: [] }; groups.push(cur);
      if (sm && sm[2] && sm[2].trim()) cur.sentences.push(sm[2].trim());
      continue;
    }

    if (inTitle) { titleLines.push(t); continue; }       // 제목 줄
    if (cur) cur.sentences.push(t);                      // 일반 문장 → 현재 그룹
  }

  const titleLine1 = titleLines[0] || null;
  const titleLine2 = titleLines[1] || null;
  if (!hookCaption) hookCaption = [titleLine1, titleLine2].filter(Boolean).join(' ') || null;
  return { titleLine1, titleLine2, hookCaption, groups: groups.filter((g) => g.sentences.length) };
}

// ── 메인 ────────────────────────────────────────────────
function parseCutScript(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // 형식 감지: grouped(음성/자막·**그룹N) / cut(①②③) / prose(제목: + [단계] 줄글).
  const isGrouped = /(^|\n)\s*-\s*음성\s*\/\s*자막\s*:/.test(text) || /\*\*[^\n]*그룹\s*\d/.test(text);
  const hasCut = /(^|\n)\s*[①-⑳]/.test(text);
  const hasProse = /(^|\n)\s*\[[^\n\]]+\]\s*(\n|$)/.test(text) && /(^|\n)\s*제목\s*[:：]/.test(text);
  const format = isGrouped ? 'grouped' : (hasCut ? 'cut' : (hasProse ? 'prose' : 'cut'));

  let fileTitle = '';
  let meta = { raw: '', voice: null, aspect: '9:16' };
  const blocks = [];
  let cur = null;

  for (const line of lines) {
    const h2 = line.match(H2_SHORTS_RE);
    if (h2) { const num = parseInt(h2[1], 10); cur = { num, heading: `쇼츠 ${num}`, lines: [] }; blocks.push(cur); continue; }
    if (!cur) {
      const h1 = line.match(H1_RE);
      if (h1 && !fileTitle) { fileTitle = h1[1].trim(); continue; }
      const bq = line.match(BLOCKQUOTE_RE);
      if (bq && !meta.raw) { meta = parseMeta(bq[1]); continue; }
      continue;
    }
    cur.lines.push(line);
  }

  const projects = blocks.map((blk) => {
    let hookCaption, model, titleLine1 = null, titleLine2 = null;
    if (format === 'grouped') {
      const r = parseShortsBlockGrouped(blk.lines);
      hookCaption = r.hookCaption;
      model = buildProjectModelGrouped(r.groups);
    } else if (format === 'prose') {
      const r = parseShortsBlockProse(blk.lines);
      hookCaption = r.hookCaption; titleLine1 = r.titleLine1; titleLine2 = r.titleLine2;
      model = buildProjectModelGrouped(r.groups); // [단계]=그룹, 그 아래 줄=문장 (다중문장 그룹)
    } else {
      const r = parseShortsBlock(blk.lines);
      hookCaption = r.hookCaption;
      model = buildProjectModel(r.cuts);
    }
    const proj = new Project({ sentences: model.sentences, groups: model.groups });
    proj.aspect = meta.aspect || '9:16';
    proj.title = blk.heading;
    proj.shortsNum = blk.num;
    proj.hookCaption = hookCaption;
    if (titleLine1 != null) proj.titleLine1 = titleLine1;
    if (titleLine2 != null) proj.titleLine2 = titleLine2;
    proj.fileTitle = fileTitle;
    proj.voice = meta.voice;
    proj.format = format;
    proj.bgEnabled = true; // 제목 배경 도형 기본 포함(사용자 요구). 체크 해제로 끌 수 있음.
    return proj;
  });

  return { fileTitle, meta, projects, format };
}

function parseCutScriptFile(filePath) {
  return parseCutScript(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { parseCutScript, parseCutScriptFile, parseShortsBlock, parseShortsBlockGrouped, circledToInt };

// CLI 검증: node core/cut-script-parser.js "<대본.md>"
if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.error('usage: node cut-script-parser.js <script.md>'); process.exit(1); }
  const { fileTitle, meta, projects, format } = parseCutScriptFile(p);
  console.log('format    :', format);
  console.log('fileTitle :', fileTitle);
  console.log('meta      :', JSON.stringify(meta));
  console.log('projects  :', projects.length);
  projects.forEach((pr) => {
    console.log(`\n── ${pr.title} (aspect=${pr.aspect}, hook="${pr.hookCaption}")  문장=${pr.sentences.length} 그룹=${pr.groups.length}`);
    pr.groups.forEach((g) => {
      const sents = pr.getSentencesOfGroup(g);
      console.log(`   그룹${g.num} [${g.phase || '-'}] ${g.isI2V ? '🎬I2V' : '🎞️모션'}  문장 ${sents.length}개`);
      sents.forEach((s) => console.log(`      · ${s.text}`));
      console.log(`      🖼 ${(g.imagePrompt || '(none)').slice(0, 50)}…`);
      if (g.videoPrompt) console.log(`      🎬 ${g.videoPrompt.slice(0, 50)}…`);
      if (g.motionNote) console.log(`      🎞 ${g.motionNote}`);
    });
  });
}
