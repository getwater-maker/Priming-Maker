/**
 * 문장 배열 → 그룹 배열
 *
 * 그룹화 규칙:
 *   1. 그룹 크기 N 만큼 정상 문장을 묶음 (단일 groupSize 또는 stages 배열)
 *   2. 짧은 문장 (charCount < shortLen) 은 새 그룹을 시작하지 않고 윗 그룹에 흡수
 *   3. 첫 문장이 짧은 경우 그래도 첫 그룹을 시작 (시드)
 *   4. 긴 문장 (charCount > longLen) 도 정상 처리 (그룹 카운트 1)
 *
 * stages 형식:
 *   [{ fromGroup: 1, toGroup: 6, sentenceSize: 5 }, { fromGroup: 7, toGroup: null, sentenceSize: 10 }]
 *   toGroup === null → 끝까지
 *
 * 예시 (N=3, shortLen=10):
 *   문장 1 (28자) → 그룹 1, count=1
 *   문장 2 (29자) → 그룹 1, count=2
 *   문장 3 (9자, 짧음) → 그룹 1 (흡수), count=2 유지
 *   문장 4 (30자) → 그룹 1, count=3 (가득)
 *   문장 5 (22자) → 그룹 2 (새 그룹), count=1
 *   ...
 */

const { Sentence, Group, makeSentenceIder, finalizeGroupIds } = require('./project-model');
const { splitLongSentenceAlgo } = require('./long-sentence-splitter/algo-splitter');

// 도입부 한 그룹의 총 의미문자 수 상한 — 비디오 클립이 최대 10초까지만 만들어지므로
// 그룹 단위 글자수도 같이 제한해야 분량을 맞출 수 있다.
// thresholds.introMaxChars 로 외부 주입 시 그 값을 우선 사용.
const INTRO_MAX_CHARS_DEFAULT = 50;

// 후처리 단계 — 너무 짧은 도입부 그룹을 이웃과 병합할 때 쓰는 두 임계값.
// INTRO_SHORT_GROUP_CHARS: 이 미만이면 "너무 짧음" → 합류 시도 대상.
// INTRO_MAX_CHARS_SOFT: 합류 후 합산이 이 값 이하일 때만 합침 (50자 한도에 마진 5자).
const INTRO_SHORT_GROUP_CHARS_DEFAULT = 15;
const INTRO_MAX_CHARS_SOFT_DEFAULT = 55;

/**
 * 도입부 그룹의 의미문자 합계.
 */
function _introCharSum(group, sentMap) {
  let sum = 0;
  for (const sid of group.sentenceIds) {
    const s = sentMap.get(sid);
    if (s) sum += (s.charCount || 0);
  }
  return sum;
}

/**
 * 후처리 — 너무 짧은 도입부 그룹을 이웃 도입부 그룹과 병합.
 * - 본론 그룹/도입↔본론 경계는 절대 침범하지 않음.
 * - 앞·뒤 이웃 후보 중 합산이 maxSoft 이하인 후보만 채택, 합산 작은 쪽 우선, 동등 시 뒤.
 * - 한 패스로 처리 — 새 그룹 길이가 다시 짧을 가능성은 거의 없음(짧음 + 짧음 < 15+15 인데 양 이웃이 모두 짧을 확률 낮고 한 번 더 돌려도 같은 알고리즘).
 * @returns {boolean} 변화가 있었는지
 */
function _mergeShortIntroGroups(groups, sentences, opts) {
  const shortLimit = (opts && opts.introShortGroupChars) || INTRO_SHORT_GROUP_CHARS_DEFAULT;
  const maxSoft = (opts && opts.introMaxCharsSoft) || INTRO_MAX_CHARS_SOFT_DEFAULT;
  if (!Array.isArray(groups) || groups.length < 2) return false;
  const sentMap = new Map(sentences.map(s => [s.id, s]));
  let changed = false;
  let i = 0;
  while (i < groups.length) {
    const g = groups[i];
    if (!g.isIntro) { i++; continue; }
    const sum = _introCharSum(g, sentMap);
    if (sum >= shortLimit) { i++; continue; }

    // 앞·뒤 도입부 이웃 찾기
    const prev = (i > 0 && groups[i - 1].isIntro) ? groups[i - 1] : null;
    const next = (i + 1 < groups.length && groups[i + 1].isIntro) ? groups[i + 1] : null;
    const prevTotal = prev ? _introCharSum(prev, sentMap) + sum : Infinity;
    const nextTotal = next ? _introCharSum(next, sentMap) + sum : Infinity;
    const prevOk = prev && prevTotal <= maxSoft;
    const nextOk = next && nextTotal <= maxSoft;

    let target = null;
    let mergeBefore = false; // true면 target 앞쪽에 끼움 (즉 next 에 합류)
    if (prevOk && nextOk) {
      // 합산 작은 쪽 우선, 동등이면 뒤
      if (nextTotal <= prevTotal) { target = next; mergeBefore = true; }
      else                        { target = prev; mergeBefore = false; }
    } else if (prevOk) {
      target = prev; mergeBefore = false;
    } else if (nextOk) {
      target = next; mergeBefore = true;
    }

    if (!target) { i++; continue; }

    // 병합: target.sentenceIds 의 앞/뒤에 g.sentenceIds 를 끼움. sentence.groupId 는 finalizeGroupIds 에서 다시 잡힘.
    if (mergeBefore) target.sentenceIds = [...g.sentenceIds, ...target.sentenceIds];
    else             target.sentenceIds = [...target.sentenceIds, ...g.sentenceIds];
    groups.splice(i, 1);
    changed = true;
    // 인덱스 보정: prev 와 합쳤다면 prev 위치는 그대로(i-1) → 다시 검사 안 함.
    // next 와 합쳤다면 i 위치에 next 가 있음 — 그것도 한 번 더 평가하지는 않음.
    // (짧음 + 짧음이 또 짧을 가능성은 무시할 만큼 낮음)
  }

  if (changed) {
    // 그룹 번호 재발번호 + sentence.groupId 재정합
    groups.forEach((g, idx) => { g.num = idx + 1; });
    finalizeGroupIds(groups, sentences);
  }
  return changed;
}

/**
 * sentence 의 vrewClips 결정 — 긴 문장이면 splitLongSentenceAlgo 로 분할.
 * thresholds.disableLongSplit=true 면 분할 안 함 (한 문장 = 한 sub-clip).
 */
function _buildVrewClips(text, isLong, vrewMaxChars, disableLongSplit) {
  if (!isLong || disableLongSplit) return [{ text: text, weight: 1.0 }];
  return splitLongSentenceAlgo(text, vrewMaxChars);
}

/**
 * 현재 그룹 번호에 해당하는 stage 의 sentenceSize 반환.
 * @param {Array<{fromGroup:number, toGroup:number|null, sentenceSize:number}>} stages
 * @param {number} gNum - 현재 그룹 번호 (1-based)
 */
function _sizeForGroup(stages, gNum) {
  for (const st of stages) {
    const to = st.toGroup == null ? Infinity : st.toGroup;
    if (gNum >= st.fromGroup && gNum <= to) return st.sentenceSize;
  }
  return stages[stages.length - 1].sentenceSize;
}

/**
 * thresholds.stages 또는 thresholds.groupSize 로부터 stages 배열 정규화.
 */
function _normalizeStages(thresholds) {
  if (thresholds.stages && thresholds.stages.length > 0) {
    return thresholds.stages;
  }
  return [{ fromGroup: 1, toGroup: null, sentenceSize: thresholds.groupSize || 3 }];
}

/**
 * @param {string[]} sentenceTexts - splitIntoSentences() 결과
 * @param {{
 *   groupSize?: number,
 *   stages?: Array<{fromGroup:number, toGroup:number|null, sentenceSize:number}>,
 *   shortLen: number,
 *   longLen: number,
 *   vrewMaxChars?: number
 * }} thresholds
 * @returns {{ sentences: Sentence[], groups: Group[] }}
 */
function buildGroups(sentenceTexts, thresholds) {
  const { shortLen, longLen } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;
  const stages = _normalizeStages(thresholds);

  // 1단계: Sentence 객체 생성 + 짧은/긴 문장 판정 + vrew 클립 자동 분할 (알고리즘)
  // id 는 콘텐츠 해시 기반 — 같은 text 면 같은 id, 같은 text 가 N 번째면 _N suffix.
  const sid = makeSentenceIder();
  const sentences = sentenceTexts.map((text, i) => {
    const s = new Sentence({ id: sid(text), num: i + 1, text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;

    // 8단계: 긴 문장은 알고리즘 분할로 vrewClips 미리 채움.
    // disableLongSplit=true 면 분할 안 함 (한 문장 = 한 자막 줄).
    s.vrewClips = _buildVrewClips(text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  // 2단계: 그룹화
  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;        // 정상·긴 문장 수 (짧은 문장 제외)

  const startNewGroup = () => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    groups.push(currentGroup);
    currentCount = 0;
  };

  for (const s of sentences) {
    // 첫 그룹은 무조건 시작
    if (!currentGroup) startNewGroup();

    if (s.isShort && currentGroup.sentenceIds.length > 0) {
      // 짧은 문장이고 그룹에 이미 다른 문장 있음 → 흡수
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      // currentCount 유지 — 짧은 문장은 카운트 안 함
    } else {
      // 정상·긴 문장 또는 그룹의 첫 문장
      if (currentCount >= _sizeForGroup(stages, currentGroup.num)) {
        // 그룹 가득 참 → 새 그룹
        startNewGroup();
      }
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      currentCount++;
    }
  }

  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

/**
 * 대괄호 섹션 마커가 있는 대본용 그룹화.
 * 같은 sectionTitle 이 연속하면 하나의 그룹.
 * 그룹 크기(groupSize) 옵션은 무시됨.
 *
 * @param {Array<{text:string, sectionTitle:string|null}>} items
 * @param {{ shortLen: number, longLen: number, vrewMaxChars?: number }} thresholds
 */
function buildGroupsWithSections(items, thresholds) {
  const { shortLen, longLen } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.sectionTitle = item.sectionTitle || null;
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let lastTitle = undefined;

  for (const s of sentences) {
    if (s.sectionTitle !== lastTitle) {
      gNum++;
      currentGroup = new Group({ num: gNum, sentenceIds: [] });
      currentGroup.title = s.sectionTitle;
      groups.push(currentGroup);
      lastTitle = s.sectionTitle;
    }
    currentGroup.sentenceIds.push(s.id);
    s.groupId = currentGroup.id;
  }

  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

/**
 * 도입부/본론 분리 그룹화.
 * - 도입부 sentence 들끼리, 본론 sentence 들끼리 각각 다른 그룹 크기로 묶음.
 * - 도입↔본론 경계는 항상 새 그룹 시작 (같은 그룹에 섞이지 않음).
 *
 * @param {Array<{text:string, isIntro:boolean}>} items - splitIntoSentencesWithIntro() 결과
 * @param {{
 *   shortLen: number,
 *   longLen: number,
 *   introSentenceSize: number,   // 도입부 그룹 크기 (문장 수)
 *   mainSentenceSize: number,    // 본론 그룹 크기 (문장 수)
 *   vrewMaxChars?: number
 * }} thresholds
 * @returns {{ sentences: Sentence[], groups: Group[] }}
 */
function buildGroupsWithIntro(items, thresholds) {
  const { shortLen, longLen, introSentenceSize, mainSentenceSize } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;
  const introMaxChars = thresholds.introMaxChars || INTRO_MAX_CHARS_DEFAULT;

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.isIntro = !!item.isIntro;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;
  let currentIntroChars = 0;    // 도입부 그룹 누적 의미문자 수 (본론은 0 유지)
  let currentMode = null;       // 'intro' | 'main'

  const startNewGroup = (isIntro) => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    currentGroup.isIntro = isIntro;
    groups.push(currentGroup);
    currentCount = 0;
    currentIntroChars = 0;
    currentMode = isIntro ? 'intro' : 'main';
  };

  for (const s of sentences) {
    const targetMode = s.isIntro ? 'intro' : 'main';
    // 모드 변경 시 강제로 새 그룹 시작 (도입↔본론 경계는 절대 같은 그룹 X)
    if (!currentGroup || currentMode !== targetMode) {
      startNewGroup(s.isIntro);
    }
    const groupSize = s.isIntro
      ? (introSentenceSize || 2)
      : (mainSentenceSize || 3);

    // 도입부: 글자수 한도 초과 시 (그룹이 비어있지 않을 때만) 새 그룹 시작.
    // 그룹이 비어있고 단일 문장이 한도를 넘으면 그 문장 단독으로 그룹 형성.
    if (s.isIntro && currentGroup.sentenceIds.length > 0
        && currentIntroChars + s.charCount > introMaxChars) {
      startNewGroup(true);
    }

    if (s.isShort && currentGroup.sentenceIds.length > 0) {
      // 짧은 문장은 흡수
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      if (s.isIntro) currentIntroChars += s.charCount;
    } else {
      if (currentCount >= groupSize) startNewGroup(s.isIntro);
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      currentCount++;
      if (s.isIntro) currentIntroChars += s.charCount;
    }
  }
  finalizeGroupIds(groups, sentences);
  _mergeShortIntroGroups(groups, sentences, thresholds);
  return { sentences, groups };
}

/**
 * 하이브리드 그룹화 — md 영역은 도입/본론 사이즈로, 대괄호 영역은 한 그룹씩.
 *
 * 동작:
 *  - mode='bracket' 문장: 같은 sectionTitle 끼리 한 그룹 (groupSize 무시)
 *  - mode='md' 문장: isIntro 면 introSentenceSize, 아니면 mainSentenceSize 로 그룹화
 *  - 모드 경계 (md→bracket 또는 bracket→md) 또는 대괄호 sectionTitle 변경 → 항상 새 그룹
 *  - 짧은 문장 (md 그룹에서만) 흡수 규칙은 기존 buildGroupsWithIntro 와 동일
 *
 * @param {Array<{text:string, mode:'md'|'bracket', isIntro:boolean, sectionTitle:string|null}>} items
 * @param {{
 *   shortLen: number,
 *   longLen: number,
 *   introSentenceSize: number,
 *   mainSentenceSize: number,
 *   vrewMaxChars?: number
 * }} thresholds
 */
function buildGroupsHybrid(items, thresholds) {
  const { shortLen, longLen, introSentenceSize, mainSentenceSize } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;
  const introMaxChars = thresholds.introMaxChars || INTRO_MAX_CHARS_DEFAULT;
  // 본문 분할방식 — 'h3': H3(섹션) 1개=그룹 1개 / 'sentence'(기본): 문장수로 그룹화.
  //   도입부는 두 방식 공통으로 문장 단위 그룹화(introSentenceSize). 섹션 경계는 sectionChanged 가 처리.
  const splitMode = thresholds.splitMode === 'h3' ? 'h3' : 'sentence';

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.isIntro = !!item.isIntro;
    s.sectionTitle = item.sectionTitle || null;
    s.mode = item.mode;
    s._imagePrompt = item.imagePrompt || null;   // 대본 내 프롬프트(섹션 첫 문장에만) — 그룹이 흡수
    s._videoPrompt = item.videoPrompt || null;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;
  let currentIntroChars = 0;       // md-intro 그룹 누적 의미문자 수
  let currentMode = null;          // 'md-intro' | 'md-main' | 'bracket'
  let currentSectionTitle = null;

  const targetModeOf = (s) => {
    if (s.mode === 'bracket') return 'bracket';
    return s.isIntro ? 'md-intro' : 'md-main';
  };

  const startNewGroup = (s) => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    currentGroup.isIntro = !!s.isIntro;
    currentGroup.isBracket = s.mode === 'bracket';
    currentGroup.title = s.sectionTitle || null;
    groups.push(currentGroup);
    currentCount = 0;
    currentIntroChars = 0;
    currentMode = targetModeOf(s);
    currentSectionTitle = s.sectionTitle || null;
  };

  // 섹션 프롬프트(첫 문장)를 그룹에 흡수 — 그룹 첫 보유 프롬프트 우선.
  const absorbPrompt = (s) => {
    if (s._imagePrompt && !currentGroup.imagePrompt) currentGroup.imagePrompt = s._imagePrompt;
    if (s._videoPrompt && !currentGroup.videoPrompt) { currentGroup.videoPrompt = s._videoPrompt; currentGroup.isI2V = true; }
  };

  for (const s of sentences) {
    const tm = targetModeOf(s);
    const sectionChanged = (s.sectionTitle !== currentSectionTitle);
    // 섹션 경계로 그룹을 끊는 건 h3·대괄호 모드뿐. 문장 모드는 섹션(H3)을 무시하고 문장수로만 묶음.
    const breakOnSection = sectionChanged && (splitMode === 'h3' || s.mode === 'bracket');

    if (!currentGroup || currentMode !== tm || breakOnSection) {
      startNewGroup(s);
    }
    // 문장 모드에서 섹션이 바뀌었지만 그룹은 유지 → 그 섹션의 프롬프트도 현재 그룹이 흡수(첫 프롬프트 우선).
    currentSectionTitle = s.sectionTitle || currentSectionTitle;
    absorbPrompt(s);

    if (s.mode === 'bracket') {
      // 대괄호: 같은 섹션의 모든 문장을 흡수, 사이즈 무시
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
    } else if (splitMode === 'h3') {
      // h3 모드: 도입부·본문 모두 같은 H3 섹션의 모든 문장을 한 그룹에 (사이즈 무시).
      //   섹션이 바뀌면 위의 sectionChanged 가 이미 새 그룹을 시작했음.
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
    } else {
      // md: 도입 N문장 / 본론 M문장 (문장 모드)
      const groupSize = s.isIntro ? (introSentenceSize || 2) : (mainSentenceSize || 3);

      // 도입부: 글자수 한도 초과 시 (그룹이 비어있지 않을 때만) 새 그룹 시작.
      if (s.isIntro && currentGroup.sentenceIds.length > 0
          && currentIntroChars + s.charCount > introMaxChars) {
        startNewGroup(s);
      }

      if (s.isShort && currentGroup.sentenceIds.length > 0) {
        currentGroup.sentenceIds.push(s.id);
        s.groupId = currentGroup.id;
        if (s.isIntro) currentIntroChars += s.charCount;
      } else {
        if (currentCount >= groupSize) startNewGroup(s);
        currentGroup.sentenceIds.push(s.id);
        s.groupId = currentGroup.id;
        currentCount++;
        if (s.isIntro) currentIntroChars += s.charCount;
      }
    }
  }
  finalizeGroupIds(groups, sentences);
  _mergeShortIntroGroups(groups, sentences, thresholds);
  return { sentences, groups };
}

// 도입부 클립 길이 한도 — 10초 (I2V/LTX 최대 생성 길이 = 10초에 맞춤. 2026-06-22 사용자 지정 16→10).
const INTRO_VIDEO_MAX_SEC_DEFAULT = 10;

/**
 * 도입부 그룹을 TTS 실제 재생 시간 기준으로 재배치.
 *
 * 동작:
 *  - 본론 그룹은 순서대로 보존, 도입부 sentence 들만 추출(순서 유지) 후 재묶음.
 *  - 누적 TTS 길이 ≤ maxSec 이 되도록 sentence 순차 합류.
 *  - 단일 sentence 가 maxSec 초과면 단독 그룹 + isOverDuration:true 마크.
 *  - 도입부는 본론 앞에 있다고 가정 (현재 워크플로 동일).
 *
 * @param {{sentences: Array, groups: Array}} project
 * @param {{maxSec?: number}} [opts]
 * @returns {{groups: Array, sentences: Array, overGroupIds: string[]}}
 */
function regroupIntroByTtsDuration(project, opts) {
  const maxSec = (opts && opts.maxSec) || INTRO_VIDEO_MAX_SEC_DEFAULT;
  if (!project || !Array.isArray(project.groups) || !Array.isArray(project.sentences)) {
    return { groups: project ? project.groups : [], sentences: project ? project.sentences : [], overGroupIds: [] };
  }

  const sentMap = new Map(project.sentences.map(s => [s.id, s]));
  // 본론 그룹은 그대로 보존
  const mainGroups = project.groups.filter(g => !g.isIntro);
  // 원래 도입부 그룹들에서 sentence 순서 그대로 추출
  const introSentences = [];
  for (const g of project.groups) {
    if (!g.isIntro) continue;
    for (const sid of g.sentenceIds) {
      const s = sentMap.get(sid);
      if (s) introSentences.push(s);
    }
  }

  // 도입부 sentence 가 없으면 무동작
  if (introSentences.length === 0) {
    return { groups: project.groups, sentences: project.sentences, overGroupIds: [] };
  }

  // 새 도입부 그룹 재구성 — 누적 TTS 길이 기준
  const newIntroGroups = [];
  const overGroupRefs = []; // 16초 초과 그룹 참조 (id 확정 전이라 참조로 보관)
  let currentGroup = null;
  let currentSec = 0;

  const startNewGroup = () => {
    currentGroup = new Group({ num: 0, sentenceIds: [] }); // num 은 finalize 후 재발번호
    currentGroup.isIntro = true;
    currentGroup.isOverDuration = false;
    newIntroGroups.push(currentGroup);
    currentSec = 0;
  };

  for (const s of introSentences) {
    const dur = (typeof s.ttsDurationSec === 'number' && s.ttsDurationSec > 0) ? s.ttsDurationSec : 0;
    // 그룹 비어있지 않고 누적이 한도 초과면 새 그룹 시작
    if (currentGroup && currentGroup.sentenceIds.length > 0 && currentSec + dur > maxSec) {
      startNewGroup();
    }
    if (!currentGroup) startNewGroup();
    currentGroup.sentenceIds.push(s.id);
    s.groupId = currentGroup.id; // finalize 가 다시 잡지만 일관성 유지
    currentSec += dur;
    // 단독 sentence 가 한도 초과 → 그룹 마크
    if (currentGroup.sentenceIds.length === 1 && dur > maxSec) {
      currentGroup.isOverDuration = true;
      overGroupRefs.push(currentGroup);
      // 다음 sentence 는 새 그룹으로 가도록 (이미 한도 채워짐 — currentSec > maxSec 이라 다음 진입에서 분리됨)
    }
  }

  // 도입부 + 본론 순서로 결합 (도입부는 항상 앞)
  const newGroups = [...newIntroGroups, ...mainGroups];
  // 그룹 번호 재발번호
  newGroups.forEach((g, idx) => { g.num = idx + 1; });
  // ID 정합
  finalizeGroupIds(newGroups, project.sentences);

  // 결과 적용 — project 의 groups 배열 자체를 교체 (참조 유지 위해 splice)
  project.groups.length = 0;
  for (const g of newGroups) project.groups.push(g);

  // overGroupIds 는 finalize 후의 id 로 추출
  const overGroupIds = overGroupRefs.map(g => g.id);
  return { groups: project.groups, sentences: project.sentences, overGroupIds };
}

/**
 * 그룹의 ttsDurationSec 합계.
 */
function _groupTtsSec(group, sentMap) {
  let sum = 0;
  for (const sid of group.sentenceIds) {
    const s = sentMap.get(sid);
    if (s && typeof s.ttsDurationSec === 'number') sum += s.ttsDurationSec;
  }
  return sum;
}

/**
 * 주어진 그룹을 바로 위(앞) 그룹과 합치기.
 * - 첫 그룹이거나 위 그룹과 isIntro 가 다르면 거부.
 * - 합치기 후 도입부면 isOverDuration 재평가 (16초 한도).
 * - 자산(imagePath/videoPath/...) 정리는 호출자 책임 (충돌 검사 + 사용자 confirm).
 *
 * @returns {{ok: boolean, reason?: string, newGroupId?: string}}
 */
function mergeGroupWithPrev(project, groupId, opts) {
  const maxSec = (opts && opts.maxSec) || INTRO_VIDEO_MAX_SEC_DEFAULT;
  if (!project || !Array.isArray(project.groups)) return { ok: false, reason: 'no-project' };
  const idx = project.groups.findIndex(g => g.id === groupId);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  if (idx === 0) return { ok: false, reason: 'no-prev' };
  const curr = project.groups[idx];
  const prev = project.groups[idx - 1];
  if (!!curr.isIntro !== !!prev.isIntro) return { ok: false, reason: 'cross-boundary' };

  // 합치기: prev 에 curr.sentenceIds 추가
  prev.sentenceIds = [...prev.sentenceIds, ...curr.sentenceIds];
  // 자산 보존 정책: prev 자산 우선 유지 — caller 가 충돌 시 초기화했어야 함.
  // 그래도 안전 차원에서 curr 의 자산이 prev 에 없을 때만 옮김.
  if (!prev.imagePath && curr.imagePath) prev.imagePath = curr.imagePath;
  if (!prev.videoPath && curr.videoPath) { prev.videoPath = curr.videoPath; prev.videoStatus = curr.videoStatus || prev.videoStatus; }

  // curr 제거
  project.groups.splice(idx, 1);
  // 도입부면 16초 평가
  if (prev.isIntro) {
    const sentMap = new Map(project.sentences.map(s => [s.id, s]));
    prev.isOverDuration = _groupTtsSec(prev, sentMap) > maxSec;
  }
  // 번호 재발번호 + ID 정합
  project.groups.forEach((g, i) => { g.num = i + 1; });
  finalizeGroupIds(project.groups, project.sentences);
  // finalize 가 prev.id 를 바꿨을 수 있음 — 인덱스로 재조회
  const finalPrev = project.groups[idx - 1];
  return { ok: true, newGroupId: finalPrev.id };
}

/**
 * 주어진 그룹을 특정 sentence 위치에서 둘로 분할.
 * - 그 sentence 부터 새 그룹으로 떨어져 나옴.
 * - 그룹의 첫 sentence 에서는 자를 수 없음 (의미 없음 → 거부).
 * - 합치기 후 도입부면 각 그룹의 isOverDuration 재평가.
 * - 자산 처리는 호출자 책임 (분할이면 자산 매핑이 깨지므로 caller 가 초기화 권장).
 *
 * @returns {{ok: boolean, reason?: string, leftGroupId?: string, rightGroupId?: string}}
 */
function splitGroupAt(project, groupId, splitAtSentenceId, opts) {
  const maxSec = (opts && opts.maxSec) || INTRO_VIDEO_MAX_SEC_DEFAULT;
  if (!project || !Array.isArray(project.groups)) return { ok: false, reason: 'no-project' };
  const gIdx = project.groups.findIndex(g => g.id === groupId);
  if (gIdx < 0) return { ok: false, reason: 'not-found' };
  const src = project.groups[gIdx];
  const sIdx = src.sentenceIds.indexOf(splitAtSentenceId);
  if (sIdx < 0) return { ok: false, reason: 'sentence-not-in-group' };
  if (sIdx === 0) return { ok: false, reason: 'invalid-split' };

  // 새 그룹 — splitAt 부터 끝까지
  const newSentenceIds = src.sentenceIds.slice(sIdx);
  const newGroup = new Group({ num: 0, sentenceIds: newSentenceIds });
  newGroup.isIntro = !!src.isIntro;
  if (src.title) newGroup.title = src.title;
  if (src.isBracket) newGroup.isBracket = true;
  // 자산은 새 그룹에 복사하지 않음 (분할이면 어느 쪽에 속해야 할지 모호 → caller 가 정리)

  // 기존 그룹 축소
  src.sentenceIds = src.sentenceIds.slice(0, sIdx);

  // groups 배열에 새 그룹을 src 바로 뒤에 삽입
  project.groups.splice(gIdx + 1, 0, newGroup);

  // 도입부면 각 그룹 16초 평가
  if (src.isIntro || newGroup.isIntro) {
    const sentMap = new Map(project.sentences.map(s => [s.id, s]));
    if (src.isIntro) src.isOverDuration = _groupTtsSec(src, sentMap) > maxSec;
    if (newGroup.isIntro) newGroup.isOverDuration = _groupTtsSec(newGroup, sentMap) > maxSec;
  }

  // 번호 재발번호 + ID 정합
  project.groups.forEach((g, i) => { g.num = i + 1; });
  finalizeGroupIds(project.groups, project.sentences);
  // ID 재발급되었을 수 있으므로 인덱스로 재조회
  const finalLeft = project.groups[gIdx];
  const finalRight = project.groups[gIdx + 1];
  return { ok: true, leftGroupId: finalLeft.id, rightGroupId: finalRight.id };
}

module.exports = {
  buildGroups,
  buildGroupsWithSections,
  buildGroupsWithIntro,
  buildGroupsHybrid,
  regroupIntroByTtsDuration,
  mergeGroupWithPrev,
  splitGroupAt,
};
