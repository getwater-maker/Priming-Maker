/**
 * Project / Sentence / Group 데이터 모델
 *
 * 사용 흐름:
 *   1. 사용자가 .txt/.md 입력 → splitIntoSentences() → 문장 배열
 *   2. buildGroups(문장 배열, 임계값) → Project 안의 sentences + groups
 *   3. 각 sentence 에 ttsStatus / ttsAudioPath 등이 채워짐 (TTS 변환 후)
 *   4. 각 group 에 imagePath / prompt 등이 채워짐 (이미지 생성 후)
 *   5. .vrew 저장 시 sentences + groups 를 사용
 */

const crypto = require('crypto');

let _seq = 0;
function nextId(prefix) {
  _seq++;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

/**
 * 콘텐츠 해시 기반 안정 id.
 * 같은 content 면 항상 같은 id → 대본 재분할 시 자산(TTS/이미지) 매칭/이전 가능.
 *
 * 같은 텍스트 sentence 가 여러 개 있을 수 있어 외부에서 등장 카운터 관리.
 * → makeSentenceIder() / makeGroupIder() 헬퍼 사용 권장.
 */
function hashId(prefix, content) {
  const h = crypto.createHash('sha256').update(String(content == null ? '' : content), 'utf8').digest('hex').slice(0, 10);
  return `${prefix}_${h}`;
}

/**
 * 같은 빌드 호출 안에서 동일 text 가 N 번째 나오면 `_N` suffix 부여.
 * 첫 등장은 suffix 없음.
 *
 * 사용:
 *   const sid = makeSentenceIder();
 *   const id1 = sid('안녕'); // s_xxx
 *   const id2 = sid('반가워'); // s_yyy
 *   const id3 = sid('안녕'); // s_xxx_2
 */
function makeSentenceIder() {
  const counter = new Map();
  return (text) => {
    const id = hashId('s', text);
    const c = (counter.get(id) || 0) + 1;
    counter.set(id, c);
    return c === 1 ? id : `${id}_${c}`;
  };
}

/**
 * Group id 는 sentenceIds 의 join hash → 같은 sentence 묶음이면 같은 group id.
 * 빌더가 sentenceIds 를 모두 채운 뒤 호출하여 group.id + 각 sentence.groupId 를 갱신.
 */
function finalizeGroupIds(groups, sentences) {
  const sentMap = new Map(sentences.map(s => [s.id, s]));
  const seenGroupIds = new Map(); // 동일 sentenceId 묶음 충돌 시 카운터
  for (const g of groups) {
    let newId = hashId('g', g.sentenceIds.join('|'));
    const c = (seenGroupIds.get(newId) || 0) + 1;
    seenGroupIds.set(newId, c);
    if (c > 1) newId = `${newId}_${c}`;
    if (newId === g.id) continue;
    for (const sid of g.sentenceIds) {
      const s = sentMap.get(sid);
      if (s) s.groupId = newId;
    }
    g.id = newId;
  }
}

/**
 * 유효 글자수 — 한글/영숫자만 카운트.
 * 띄어쓰기·마침표·쉼표·물음표·느낌표·따옴표 등 모두 제외.
 *   "안녕, 반가워!" (8자) → 6 (안/녕/반/가/워)
 *   "Hello world!"   → 10 (Helloworld)
 * 사용처: 짧은/긴 문장 임계값 비교, algo-splitter 의 maxChars 비교
 */
function countMeaningful(text) {
  if (!text) return 0;
  const m = String(text).match(/[가-힣A-Za-z0-9]/g);
  return m ? m.length : 0;
}

class Sentence {
  constructor({ id, num, text }) {
    this.id = id || nextId('s');
    this.num = num;                     // 1부터 시작하는 표시 번호
    this.text = text;
    this.charCount = countMeaningful(text);

    // 임계값 판정 (group-builder 가 채움)
    this.isShort = false;
    this.isLong = false;

    // 도입부 여부 (group-builder 가 마크다운 헤더 "도입" 키워드로 채움)
    this.isIntro = false;

    // 그룹 소속
    this.groupId = null;

    // TTS 결과
    this.ttsStatus = 'idle';            // idle | pending | done | fail
    this.ttsAudioPath = null;
    this.ttsDurationSec = null;
    this.ttsPresetId = null;

    // 긴 문장 vrew 분할 결과 (8단계, 정상은 [{text, durationSec}] 1개)
    this.vrewClips = [];
  }
}

class Group {
  constructor({ id, num, sentenceIds }) {
    this.id = id || nextId('g');
    this.num = num;                     // 1부터 시작하는 표시 번호
    this.title = null;                  // 대괄호 섹션 제목 (없으면 null)
    this.isIntro = false;               // 도입부 그룹 여부 (UI 색상 구분용)
    this.isBracket = false;             // 대괄호 섹션 그룹 — 이미지 프롬프트는 한국어 + 스타일 그대로
    this.sentenceIds = sentenceIds || [];

    // 이미지 (그룹 = 이미지 1장)
    this.imageStatus = 'idle';          // idle | generating | done | fail
    this.imagePath = null;
    this.promptKo = null;
    this.promptEn = null;
    this.imagePrompt = null;            // 외부 AI(클로드) 생성 영어 이미지 프롬프트 (있으면 자동번역 대신 사용)

    // Grok Imagine 비디오 변환 결과 (이미지 → 영상)
    // videoPath 가 있으면 .vrew 가 이미지 대신 비디오 사용 (Ken Burns 대신 진짜 움직임)
    this.videoStatus = 'idle';          // idle | queued | generating | done | fail
    this.videoPath = null;
    this.videoSourceImage = null;       // 비디오의 원본 이미지 경로 (재시도/롤백용)
    this.videoMotionPrompt = null;      // 사용자가 입력한 모션 프롬프트
    this.videoPrompt = null;            // 외부 AI(클로드) 생성 영상 모션 프롬프트 (있으면 최우선)

    // Ken Burns 카메라 효과 (8단계)
    this.kenburns = null;

    // 사용자 선택 (재생성용)
    this.selected = false;
  }
}

class Project {
  constructor({ scriptText, thresholds, sentences, groups }) {
    this.scriptText = scriptText || '';
    this.thresholds = thresholds || { groupSize: 3, shortLen: 10, longLen: 20 };
    this.sentences = sentences || [];
    this.groups = groups || [];

    this.mode = 'shorts';   // 'shorts'(쇼츠 9:16) | 'longform'(롱폼 16:9) — 워크플로 분기 (mode-profiles.js)
    this.aspect = '16:9';   // 영상 비율 — '16:9'(롱폼) | '9:16'(쇼츠). 이미지·렌더·내보내기 공통.
    this.ttsSettings = { defaultPresetId: null };
    this.imgSettings = {};
  }

  get totalSentences() { return this.sentences.length; }
  get totalGroups() { return this.groups.length; }
  get shortCount() { return this.sentences.filter(s => s.isShort).length; }
  get longCount() { return this.sentences.filter(s => s.isLong).length; }

  /** id → Sentence 빠른 검색 */
  getSentenceById(id) {
    return this.sentences.find(s => s.id === id);
  }

  /** id → Group 빠른 검색 */
  getGroupById(id) {
    return this.groups.find(g => g.id === id);
  }

  /** 그룹의 문장들 반환 */
  getSentencesOfGroup(group) {
    return group.sentenceIds.map(id => this.getSentenceById(id)).filter(Boolean);
  }
}

module.exports = { Sentence, Group, Project, countMeaningful, hashId, makeSentenceIder, finalizeGroupIds };
