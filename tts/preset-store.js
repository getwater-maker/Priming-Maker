/**
 * 프리셋(채널) CRUD — 컨텐츠 채널 단위의 통합 설정.
 * 위치: ~/.flow-app/tts-presets.json
 *
 * 통합 모델 (2026-05 채널/프리셋 통합):
 *   {
 *     id: 'p_xxx',
 *     name: '내 채널',
 *     // 기본 동작
 *     isDefault: false,           // 좌측 카드 첫 번째 표시
 *     // TTS
 *     engine: 'omnivoice' | 'gemini' | 'supertonic',
 *     voice: 'clone' | 'default' | 'Kore' | 'M1' | 'F1' | ...,
 *     speed: 1.0,
 *     silenceSec: 0.8,            // 문장 사이 무음
 *     // GPU Voice Clone (voxcpm / omnivoice 공통)
 *     voiceCloneRefAudio: '/abs/path.wav',
 *     voiceCloneRefText: '음성에 담긴 대사 그대로',
 *     cfgValue: 2.0,              // omnivoice: guidance_scale, voxcpm: cfg_value
 *     inferenceTimesteps: 32,     // omnivoice: num_step, voxcpm: inference_timesteps
 *     language: 'ko',
 *     seed: 12345,                // 음성 고정 시 채워짐
 *     // 채널 운영 (이미지 생성 / .vrew 저장 시 사용)
 *     outputFolder: 'D:/...',
 *     logoPath: 'D:/.../logo.png',
 *     profileId: 'default',       // Google 계정 프로필
 *     instruct: '사극풍 한국 회화...',
 *     presetPrompt: '30대 한국 남성, ...',  // 메인 "미디어 설정 > 사전 설정" 입력란에 자동 채워질 키워드
 *     styleId: 'k-webtoon',       // 이미지 스타일 (style-store.js 의 BUILT_IN_STYLES 또는 사용자 추가)
 *   }
 *
 * 시드 프리셋: 파일이 처음 생성될 때만 채움.
 *              사용자가 삭제하면 그대로 사라짐 (자동 복원 안 함).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'tts-presets.json');

const SEED_PRESETS = [
  {
    id: 'p_omnivoice_clone',
    name: 'OmniVoice 내 목소리 (Clone)',
    isDefault: true,
    engine: 'omnivoice',
    voice: 'clone',
    speed: 1.0,
    silenceSec: 0.8,
    voiceCloneRefAudio: '',
    voiceCloneRefText: '',
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '',
  },
  {
    id: 'p_omnivoice_design',
    name: 'OmniVoice Voice Design',
    isDefault: false,
    engine: 'omnivoice',
    voice: 'default',
    speed: 1.0,
    silenceSec: 0.8,
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '자연스러운 한국어 여성 목소리',
  },
  {
    id: 'p_gemini_kore',
    name: 'Gemini 자연체',
    isDefault: false,
    engine: 'gemini',
    voice: 'Kore',
    speed: 1.0,
    silenceSec: 0.8,
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '',
  },
  {
    id: 'p_gemini_charon',
    name: 'Gemini 남성',
    isDefault: false,
    engine: 'gemini',
    voice: 'Charon',
    speed: 1.0,
    silenceSec: 0.8,
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '',
  },
  {
    id: 'p_supertonic_ko_f1',
    name: 'Supertonic 여성 (CPU 한국어)',
    isDefault: false,
    engine: 'supertonic',
    voice: 'F1',
    speed: 1.0,
    silenceSec: 0.5,
    language: 'ko',
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '',
  },
  {
    id: 'p_supertonic_ko_m1',
    name: 'Supertonic 남성 (CPU 한국어)',
    isDefault: false,
    engine: 'supertonic',
    voice: 'M1',
    speed: 1.0,
    silenceSec: 0.5,
    language: 'ko',
    outputFolder: '',
    logoPath: '',
    profileId: 'default',
    instruct: '',
  },
];

function loadAll() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      let data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        // 제거된 엔진(voxcpm/msedge/azure) 프리셋은 폐기
        const sizeBefore = data.length;
        data = data.filter(p => p.engine === 'omnivoice' || p.engine === 'gemini' || p.engine === 'supertonic');
        const dropped = sizeBefore - data.length;

        let foundDefault = false;
        for (const p of data) {
          if (p.isDefault) {
            if (foundDefault) p.isDefault = false;
            else foundDefault = true;
          }
          // OmniVoice 프리셋의 잘못된 voiceCloneRefAudio 정규화 (인덱스 문자열 "0", "1" 등)
          if (p.engine === 'omnivoice' && p.voiceCloneRefAudio && !/[/\\]/.test(p.voiceCloneRefAudio)) {
            p.voiceCloneRefAudio = '';
          }
        }
        // OmniVoice 우선화: isDefault 가 하나도 없으면 첫 OmniVoice 프리셋을 기본으로
        if (!foundDefault) {
          const omni = data.find(p => p.engine === 'omnivoice');
          if (omni) {
            omni.isDefault = true;
          }
        }
        // 마이그레이션 결과 디스크 반영
        if (dropped > 0) saveAll(data);
        return _sortByDefault(data);
      }
    }
  } catch (e) {
    console.error('[preset-store] 로드 실패:', e.message);
  }
  saveAll(SEED_PRESETS);
  return _sortByDefault([...SEED_PRESETS]);
}

function _sortByDefault(list) {
  return [...list].sort((a, b) => {
    const da = a.isDefault ? 1 : 0;
    const db = b.isDefault ? 1 : 0;
    return db - da;
  });
}

function saveAll(presets) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(presets, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[preset-store] 저장 실패:', e.message);
    return false;
  }
}

function getById(id) {
  return loadAll().find(p => p.id === id) || null;
}

function add(preset) {
  if (!preset.id) preset.id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const all = loadAll();
  if (preset.isDefault) for (const p of all) p.isDefault = false;
  all.push(preset);
  saveAll(all);
  return preset;
}

function update(id, patch) {
  const all = loadAll();
  const idx = all.findIndex(p => p.id === id);
  if (idx < 0) return null;
  if (patch.isDefault) for (const p of all) p.isDefault = false;
  all[idx] = { ...all[idx], ...patch };
  saveAll(all);
  return all[idx];
}

function remove(id) {
  const all = loadAll();
  const filtered = all.filter(p => p.id !== id);
  saveAll(filtered);
  return true;
}

/**
 * 사용자 지정 순서로 재배열.
 * @param {string[]} idsInOrder — 화면에 보여야 할 순서대로의 프리셋 id 배열
 * 누락된 id 가 있으면 끝에 자동 append (안전장치).
 */
function reorder(idsInOrder) {
  const all = loadAll();
  const byId = new Map(all.map(p => [p.id, p]));
  const reordered = [];
  for (const id of idsInOrder) {
    const p = byId.get(id);
    if (p) { reordered.push(p); byId.delete(id); }
  }
  for (const p of byId.values()) reordered.push(p);
  saveAll(reordered);
  return reordered;
}

/** 프리셋이 즉시 사용 가능한지 */
function isUsable(preset, ttsManager) {
  if (!preset || !preset.engine) return false;
  if (!ttsManager || !ttsManager.isAvailable(preset.engine)) return false;
  if ((preset.engine === 'voxcpm' || preset.engine === 'omnivoice') && preset.voice === 'clone') {
    if (!preset.voiceCloneRefAudio) return false;
  }
  return true;
}

function getDefault() {
  const all = loadAll();
  return all.find(p => p.isDefault) || all[0] || null;
}

module.exports = {
  loadAll, getById, add, update, remove, reorder, isUsable, getDefault,
  SEED_PRESETS, STORE_PATH,
};
