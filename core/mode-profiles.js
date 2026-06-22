/**
 * mode-profiles.js — 롱폼/쇼츠 워크플로 차이를 단일 설정 객체로 격리.
 *
 * `if (mode === 'longform')` 분기를 코드 전체에 흩뿌리지 않고 여기서 한 번에 정의한다.
 * pipeline / main 의 함수들이 project.mode 로 프로파일을 조회해 동작을 결정한다.
 *
 *   - shorts:   세로 9:16. cut-script-parser(컷/그룹/줄글) · TTS 8초 그리디 패킹 · 자막 짧게.
 *   - longform: 가로 16:9. sentence-splitter + group-builder · 도입부 50자 캡 · 자막 길게.
 *
 * 두 모드 모두 최종 산출은 .vrew (최종 MP4 렌더는 Vrew 에서 직접 — video-renderer 미사용).
 */

const MODE_PROFILES = {
  shorts: {
    label: '쇼츠',
    defaultAspect: '9:16',
    aspectOptions: ['9:16', '1:1'],
    parser: 'cut-script',                          // core/cut-script-parser
    grouping: { strategy: 'tts-greedy', maxSec: 8.0 },
    captionMaxChars: 8,                            // 자막 한 줄 최대 글자수(기본)
    videoCap: { grok: 6, flow: 8 },               // i2v 영상 클립 길이 캡(초)
    // 음성배속 — 합성은 1.0(정속), atempo 로 1.25배 변환. 쇼츠는 롱폼보다 빠르게.
    defaultTtsSpeed: 1.25,
    // 자막 기본 스타일 — 쇼츠(기존 Shots-maker 값): 가운데 정렬, 약간 아래(0.15), 크기 90.
    captionYAlign: 'middle',       // 세로 기준 ('middle'=가운데 / 'bottom'=아래 / 'top'=위)
    captionYOffset: 0.15,          // 세로 오프셋(Vrew 상하값 = yOffset×400, 예: -0.125→-50)
    captionAlign: 'center',        // 좌우 정렬 ('center'=가운데 / 'start'=왼쪽)
    captionSize: 90,               // 폰트 크기
    presetKind: 'tts-preset',
    vrewPrefix: '쇼츠',
  },
  longform: {
    label: '롱폼',
    defaultAspect: '16:9',
    aspectOptions: ['16:9'],
    parser: 'sentence-splitter',                   // core/parsers/longform-parser (Phase 3 이식)
    grouping: { strategy: 'group-builder', groupSize: 3, introMaxChars: 50 },
    captionMaxChars: 18,
    videoCap: { grok: 6, flow: 8 },
    defaultTtsSpeed: 1.15,                         // 롱폼 음성배속 — 합성 1.0 → atempo 1.15배
    // 자막 기본 스타일 — 롱폼(위치조정.vrew 분석값): 아래 기준 + -50(=-0.125), 왼쪽 정렬, 크기 100, 너비 96%.
    captionYAlign: 'bottom',       // 세로 기준 = 아래 (위치조정.vrew 와 일치)
    captionYOffset: -0.125,        // Vrew 상하값 -50
    captionAlign: 'start',         // 왼쪽 정렬 (좌)
    captionSize: 100,
    presetKind: 'channel',
    vrewPrefix: '롱폼',
  },
};

function normalizeMode(mode) {
  return mode === 'longform' ? 'longform' : 'shorts';
}

function getModeProfile(mode) {
  return MODE_PROFILES[normalizeMode(mode)];
}

module.exports = { MODE_PROFILES, getModeProfile, normalizeMode };
