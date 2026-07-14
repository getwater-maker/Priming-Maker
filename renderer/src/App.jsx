import React, { useEffect, useRef, useState, useCallback } from 'react';
import api from './lib/ipc.js';
import { splitLines, mLen } from './lib/captions.js';
import BookView from './BookView.jsx';

const media = (p) => 'media://' + encodeURIComponent(p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP_POS_OPTIONS = [0.3, 0.15, 0, -0.15, -0.3]; // 상하위치 select 값 (capFine 으로 미세조정)
// yOffset → {pos, fine} (가장 가까운 select 옵션 + 미세조정)
function decomposeYOffset(yOffset) {
  let best = CAP_POS_OPTIONS[0];
  for (const o of CAP_POS_OPTIONS) if (Math.abs(o - yOffset) < Math.abs(best - yOffset)) best = o;
  return { pos: String(best), fine: Math.round((yOffset - best) / 0.0025) };
}
const yOffsetOf = (cap) => (parseFloat(cap.pos) || 0) + (parseFloat(cap.fine) || 0) * 0.0025;

// 초 → 보기 좋은 시간 ('12.3s' 또는 '1:23'). 0 이하는 '–'.
function fmtSec(s) {
  s = Number(s) || 0;
  if (s <= 0) return '–';
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
}
// 초 → "N분 N초" (1시간 이상이면 "N시간 N분 N초"). 합계 표시용.
function fmtMinSec(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}시간 ${m}분 ${sec}초` : `${m}분 ${sec}초`;
}
function phaseBadge(p, isLf) {
  if (!p) return ['', '-'];
  if (isLf) return ['', p];   // 롱폼: 섹션 제목 그대로 (훅/본론 키워드 축약 안 함 — '본론 진입'이 '본론'으로 잘못 표시되던 문제)
  if (/재훅/.test(p)) return ['b-rehook', '재훅'];
  if (/^훅/.test(p)) return ['b-hook', '훅'];
  if (/본론/.test(p)) return ['b-main', '본론'];
  if (/절정/.test(p)) return ['b-climax', '절정'];
  if (/CTA/i.test(p)) return ['b-cta', 'CTA'];
  return ['', p];
}

const QSTATUS = { idle: '대기', running: '진행중', done: '완료', failed: '실패' };
const ENGINE_META = { genspark: { name: 'Genspark (Nano Banana 2)' }, flow: { name: 'Google Flow' } };

// 스타일 편집 모달의 한 행 — 기본 스타일은 읽기전용(복사만), 사용자 스타일은 이름·프롬프트 수정/삭제.
function StyleRow({ s, index, total, onCopy, onSave, onDelete, onMove }) {
  const [name, setName] = useState(s.name);
  const [prompt, setPrompt] = useState(s.prompt);
  useEffect(() => { setName(s.name); setPrompt(s.prompt); }, [s.id]);
  const dirty = name !== s.name || prompt !== s.prompt;
  return (
    <div style={{ border: '1px solid var(--border,#ddd)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <button className="ghost" title="위로" style={{ padding: '0 5px', lineHeight: 1.1 }} disabled={index === 0} onClick={() => onMove(s.id, 'up')}>▲</button>
          <button className="ghost" title="아래로" style={{ padding: '0 5px', lineHeight: 1.1 }} disabled={index === total - 1} onClick={() => onMove(s.id, 'down')}>▼</button>
        </span>
        {s.isBuiltIn
          ? <b style={{ flex: 1 }}>{s.name} <span className="meta" style={{ fontWeight: 400 }}>(기본 · 읽기전용)</span></b>
          : <input style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="스타일 이름" />}
        <button className="ghost" title="이 스타일의 프롬프트 복사" onClick={() => onCopy(prompt)}>📋 복사</button>
        {!s.isBuiltIn && <button title="저장" disabled={!dirty} onClick={() => onSave(s.id, name, prompt)}>저장</button>}
        {!s.isBuiltIn && <button className="ghost" title="삭제" onClick={() => onDelete(s.id, s.name)}>🗑</button>}
      </div>
      {s.isBuiltIn
        ? <textarea readOnly value={prompt} rows={2} style={{ width: '100%', resize: 'vertical', opacity: 0.85 }} />
        : <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} placeholder="영문 스타일 프롬프트" />}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState('longform'); // 'longform'(주 사용) | 'shorts' | 'playlist'(플리) | 'book'(출판)
  const isLf = mode === 'longform';
  const isPl = mode === 'playlist';
  const isBk = mode === 'book';
  const [dto, setDto] = useState(null);
  const [queue, setQueue] = useState(null); // 현재 모드 작업 큐(적재 대본 목록) — main 의 queueDTO
  const [presets, setPresets] = useState([]);
  const [styles, setStyles] = useState([]);

  // 헤더 컨트롤
  const [presetName, setPresetName] = useState('');
  const [styleId, setStyleId] = useState('chibi');
  const [imgEngine, setImgEngine] = useState('rotate'); // 'rotate'(Flow+Genspark 순환) — 유일 이미지 엔진
  const [aspect, setAspect] = useState('16:9');
  const [videoEngine, setVideoEngine] = useState('grok'); // 'grok' | 'none' — Grok i2v 또는 이미지만
  const [vidFrom, setVidFrom] = useState(1);   // I2V 범위 시작 그룹
  const [vidTo, setVidTo] = useState(1);        // I2V 범위 끝 그룹 (롱폼 기본=도입부 끝)
  const [timings, setTimings] = useState({ tts: 0, image: 0, video: 0, make: 0 }); // 작업 소요시간(초)
  const [flowVideoModel, setFlowVideoModel] = useState('Veo 3.1 - Lite');
  const [flowCount, setFlowCount] = useState('1x');
  const [upscale, setUpscale] = useState(false);

  // 자막/음성 — 초기값은 롱폼 기준(주 사용 모드). 마운트 시 mode-profiles 로 재확정.
  const [capSize, setCapSize] = useState('100');
  const [capPos, setCapPos] = useState('-0.15');
  const [capFine, setCapFine] = useState(10);
  const [capAlign, setCapAlign] = useState('start');
  const [capYAlign, setCapYAlign] = useState('bottom'); // 세로 기준 (middle/bottom/top) — 모드별
  const [capChars, setCapChars] = useState(7);
  const [ttsSpeed, setTtsSpeed] = useState('1.15');
  const [aiNotice, setAiNotice] = useState(false); // 쇼츠 AI 고지: 기본 OFF (롱폼은 항상 표시·필수)
  const [bgmOn, setBgmOn] = useState(false);       // 배경음(BGM, ACE-Step) 삽입 — 기본 OFF (저장된 설정에 값 있으면 존중)
  const [bgmMood, setBgmMood] = useState('');      // BGM 무드 태그(빈값=대본 자동분석)
  const [openEachVrew, setOpenEachVrew] = useState(true); // 큐 순차제작: 대본 완료 때마다 그 .vrew 자동 열기(ON) / 끝에 폴더만 1번(OFF). 기본 ON
  const [modeProfiles, setModeProfiles] = useState(null); // mode-profiles.js (음성배속 등 모드 기본값 출처)
  // 롱폼 분할옵션(도입부/본론/짧은/긴) — 프리셋에서 초기화, capbar 패널에서 조절 시 재분할.
  const [splitOpts, setSplitOpts] = useState({ intro: 3, main: 10, short: 10, long: 20, mode: 'h3' });

  const [ftitle, setFtitle] = useState('');
  const [status, setStatus] = useState('');
  const [autoSavedAt, setAutoSavedAt] = useState(0); // 마지막 자동저장 시각(ms)
  const [appVersion, setAppVersion] = useState(''); // 앱 버전 (타이틀 표시)
  const [gsCool, setGsCool] = useState(null); // Genspark 한도 쿨다운 {until, label} — 재설정 시각(재시작해도 유지)
  const [grokCool, setGrokCool] = useState(null); // Grok(영상) 한도 쿨다운 {until, label}
  const [gsBatch, setGsBatch] = useState(null); // 나노바나나2 배치 상태 {hasJob, job} — 현재 대본의 미회수 배치
  const [comfyOpen, setComfyOpen] = useState(false);
  const [comfyCfg, setComfyCfg] = useState(null); // ComfyUI(z-image) 설정
  const [findOpen, setFindOpen] = useState(false);       // 화면 내 검색 바(Ctrl+F)
  const [findText, setFindText] = useState('');
  const [findRes, setFindRes] = useState({ active: 0, total: 0 });
  const [logText, setLogText] = useState('');
  const [logCollapsed, setLogCollapsed] = useState(true); // 최소화로 시작 — 로그바 클릭 시 펼침

  // 모달/플레이어 상태
  const [chOpen, setChOpen] = useState(false);
  const [ch, setCh] = useState(null);          // 편집 중 프리셋 폼
  const [newChanOpen, setNewChanOpen] = useState(false); // 새 채널 이름 입력 모달
  const [newChanName, setNewChanName] = useState('');
  const [chStyles, setChStyles] = useState([]);
  const [chRefList, setChRefList] = useState([]); // 참조음성 파일 목록
  const [impOpen, setImpOpen] = useState(false);
  const [impText, setImpText] = useState('');
  const [impProvider, setImpProvider] = useState('ollama');
  const [impBusy, setImpBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { kind, src }
  const [playerOpen, setPlayerOpen] = useState(false);
  const [scriptEditOpen, setScriptEditOpen] = useState(false);
  const [scriptText, setScriptText] = useState('');
  const [styleEditOpen, setStyleEditOpen] = useState(false); // 이미지 스타일 편집 모달
  const [newStyle, setNewStyle] = useState({ name: '', prompt: '' }); // 새 스타일 입력 버퍼
  const [dictOpen, setDictOpen] = useState(false);   // 발음사전 모달
  // 🎨 보이스디자인(Qwen3-TTS) 모달
  const [vdOpen, setVdOpen] = useState(false);
  const [vdInstruct, setVdInstruct] = useState('');
  const [vdText, setVdText] = useState('안녕하세요. 오늘은 아주 흥미로운 역사 이야기를 들려드리겠습니다.');
  const [vdStatus, setVdStatus] = useState('');
  const [vdBusy, setVdBusy] = useState(false);
  const [vdWavUrl, setVdWavUrl] = useState('');
  const [vdGenerated, setVdGenerated] = useState(false);
  const [vdFilename, setVdFilename] = useState('');
  const [dictRows, setDictRows] = useState([]);       // [{source, pron, enabled}]
  const [ollamaOpen, setOllamaOpen] = useState(false);
  const [ollama, setOllama] = useState(null);           // { baseUrl, model }
  const [ollamaModels, setOllamaModels] = useState([]); // 서버에 설치된 모델 목록
  const [promptView, setPromptView] = useState(null);   // 그룹 프롬프트 보기 { label, image, video, motion }
  const [flowAccOpen, setFlowAccOpen] = useState(false);
  const [flowAcc, setFlowAcc] = useState(null);          // { dailyCap, accounts:[{id,label,used}] }
  const [imgRotOpen, setImgRotOpen] = useState(false);
  const [imgRot, setImgRot] = useState(null);            // { order:[], enabled:{} } 이미지 순환 설정
  const [giCfg, setGiCfg] = useState(null);              // Nano Banana 2 Lite (Gemini 이미지 API) 설정
  const [giKey, setGiKey] = useState('');                // Gemini API 키(이미지 설정 팝업에서 입력) — secret-store 공용
  const [lora, setLora] = useState(null);                // LoRA 수집 설정 { enabled, dir, trigger, count }
  const [gsAccOpen, setGsAccOpen] = useState(false);
  const [gsAcc, setGsAcc] = useState(null);              // Genspark 멀티계정
  const [grokAccOpen, setGrokAccOpen] = useState(false);
  const [grokAcc, setGrokAcc] = useState(null);          // Grok 멀티계정

  const logRef = useRef(null);
  const previewAudioRef = useRef(null);   // 미리듣기 오디오 1개만 재생(새로 누르면 이전 것 정지)
  function playPreviewUrl(url) {
    try { if (previewAudioRef.current) { previewAudioRef.current.pause(); previewAudioRef.current.currentTime = 0; } } catch {}
    if (!url) return;
    const a = new Audio(url);
    previewAudioRef.current = a;
    a.play().catch(() => {});
  }
  const loaded = !!(dto && ((dto.projects && dto.projects.length) || dto.kind === 'book'));

  const capCharsN = Math.max(2, parseInt(capChars, 10) || 7);
  // 자막 한 줄 글자수 — 쇼츠는 클립글자수, 롱폼은 분할옵션의 '긴 n자'(longLen) 기준.
  const effCap = isLf ? Math.max(2, parseInt(splitOpts.long, 10) || 20) : capCharsN;
  // 제작 진행률(완료/전체) — TTS(문장 audio) · 이미지(group imagePath) · 영상(I2V 그룹 videoPath). PrimingFlow 진행률 패널 이식.
  const prog = (() => {
    let ttsD = 0, ttsT = 0, imgD = 0, imgT = 0, vidD = 0, vidT = 0;
    for (const pr of ((dto && dto.projects) || [])) {
      for (const c of (pr.cuts || [])) {
        const sents = c.sentences || [];
        ttsT += sents.length; ttsD += sents.filter((s) => s.audio).length;
        imgT += 1; if (c.imagePath) imgD += 1;
        if (c.isI2V || c.videoPrompt) { vidT += 1; if (c.videoPath) vidD += 1; }
      }
    }
    return { ttsD, ttsT, imgD, imgT, vidD, vidT };
  })();
  const _clipMaxSec = () => 10.0; // Grok=10초 캡(그룹 TTS≤6→6초·>6→10초 자동)
  const capOverride = useCallback(() => {
    const baseY = parseFloat(capPos) || 0;
    const fine = parseFloat(capFine) || 0;
    return { size: capSize, yOffset: baseY + fine * 0.0025, align: capAlign, yAlign: capYAlign };
  }, [capPos, capFine, capSize, capAlign, capYAlign]);

  const logline = useCallback((t) => {
    setLogText((prev) => prev + t + '\n');
  }, []);

  useEffect(() => {
    api.onLog((line) => logline(line));
    api.onDtoUpdate((d) => { if (d) { setDto(d); if (d.timings) setTimings(d.timings); if (d.queue) setQueue(d.queue); } });
    api.onAutosaved((info) => setAutoSavedAt((info && info.at) || Date.now()));
    api.getAppVersion().then((v) => { if (v) setAppVersion(v); }).catch(() => {});
    loadPresets().then(loadStyles);
    // 시작/재로드 시 큐 복원 — 지난 세션 큐 + 활성 대본 화면 복구
    api.listQueue().then((r) => {
      if (!r) return;
      if (r.queue) setQueue(r.queue);
      if (r.mode) { setMode(r.mode); setAspect(r.mode === 'longform' ? '16:9' : '9:16'); }
      if (r.dto) { setDto(r.dto); setFtitle(r.dto.fileTitle || ''); }
      const m = r.mode || 'longform';
      const it = r.queue && r.queue[m] && r.queue[m].items.find((x) => x.active);
      if (it && it.settings) applySettings(it.settings);
    }).catch(() => {});
    // 모드별 기본 음성배속을 mode-profiles 에서 가져와 현재 모드 기본값으로 세팅
    api.getModeProfiles().then((mp) => {
      if (!mp) return;
      setModeProfiles(mp);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 선택 채널 + 현재 모드의 자막/배속/스타일/분할 설정을 라이브 상태에 로드.
  //   프리셋의 모드별 값(capLong/capShort, speedLong/Short, styleLong/Short, split) 우선, 없으면 mode-profile 기본.
  useEffect(() => {
    if (!presetName) return;
    let cancelled = false;
    api.getPresetDetail(presetName).then((p) => {
      if (cancelled || !p) return;
      const prof = (modeProfiles && modeProfiles[mode]) || {};
      const cap = mode === 'longform' ? p.capLong : p.capShort;
      if (cap) {
        if (cap.size != null) setCapSize(String(cap.size));
        if (cap.align) setCapAlign(cap.align);
        if (cap.yAlign) setCapYAlign(cap.yAlign);
        if (cap.yOffset != null) applyCaptionYOffset(cap.yOffset);
      } else { applyCaptionDefaults(prof); }
      const sp = mode === 'longform' ? p.speedLong : p.speedShort;
      setTtsSpeed(String(sp != null ? sp : (prof.defaultTtsSpeed != null ? prof.defaultTtsSpeed : 1.0)));
      const st = mode === 'longform' ? p.styleLong : p.styleShort;
      setStyleId(st || p.styleId || 'chibi');
      setAiNotice(mode === 'longform'); // AI 고지 기본값: 롱폼 ON · 쇼츠 OFF (사용자가 토글로 변경)
      const sl = p.split || { introSentenceSize: p.introSentenceSize, mainSentenceSize: p.mainSentenceSize, shortLen: p.shortLen, longLen: p.longLen };
      setSplitOpts({ intro: sl.introSentenceSize || 3, main: sl.mainSentenceSize || 10, short: sl.shortLen || 10, long: sl.longLen || 20, mode: sl.splitMode === 'sentence' ? 'sentence' : (sl.splitMode === 'h2' ? 'h2' : 'h3') });
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetName, mode, modeProfiles]);

  // I2V 범위 기본값 — 롱폼=도입부 그룹 끝까지, 쇼츠=처음~끝.
  //   도입부(isIntro)·그룹수가 바뀌면(로드/복원/재분할) 다시 계산 → 도입부 인식이 늦게 채워져도 반영.
  const _cuts0 = (dto && dto.projects && dto.projects[0] && dto.projects[0].cuts) || [];
  const _introSig = isLf ? _cuts0.filter((c) => c.isIntro).map((c) => c.num).join(',') : '';
  const _lastNum = _cuts0.length ? _cuts0[_cuts0.length - 1].num : 0;
  useEffect(() => {
    if (!_cuts0.length) return;
    if (isLf) {
      const introNums = _cuts0.filter((c) => c.isIntro).map((c) => c.num);
      setVidFrom(1); setVidTo(introNums.length ? Math.max(...introNums) : _lastNum);
    } else {
      setVidFrom(1); setVidTo(_lastNum);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto && dto.fileTitle, isLf, _introSig, _lastNum]);

  // 분할옵션 변경 → 즉시 롱폼 재분할 (대본 로드 상태에서만).
  async function changeSplit(key, val) {
    const next = { ...splitOpts, [key]: (key === 'mode' ? val : (parseInt(val, 10) || 0)) };
    setSplitOpts(next);
    if (!loaded || !isLf) return;
    try { const d = await api.resplit({ intro: next.intro, main: next.main, short: next.short, long: next.long, splitMode: next.mode }); if (d) setDto(d); setStatus('재분할 완료'); }
    catch (e) { logline('재분할 오류: ' + e.message); }
  }
  async function runIntroVideo() {
    setStatus('도입부 TTS + 10초 재배치…');
    try { const d = await api.introVideoPrep({ presetName: presetName || null, speed: ttsSpeed || null }); if (d) setDto(d); setStatus('도입부 재배치 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }

  // 모드의 기본 음성배속(mode-profiles). 미로딩 시 1.0 폴백.
  const defaultSpeedFor = (m) => {
    const v = modeProfiles && modeProfiles[m] && modeProfiles[m].defaultTtsSpeed;
    return v != null ? v : 1.0;
  };
  // 목표 yOffset 을 상하위치 select(가장 가까운 옵션) + 미세조정으로 정확히 표현.
  function applyCaptionYOffset(target) {
    let best = CAP_POS_OPTIONS[0];
    for (const o of CAP_POS_OPTIONS) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    setCapPos(String(best));
    setCapFine(Math.round((target - best) / 0.0025));
  }
  // 모드 자막 기본 스타일(위치·정렬·크기)을 UI 컨트롤에 반영.
  function applyCaptionDefaults(prof) {
    if (!prof) return;
    if (prof.captionYOffset != null) applyCaptionYOffset(prof.captionYOffset);
    if (prof.captionYAlign != null) setCapYAlign(prof.captionYAlign);
    if (prof.captionAlign != null) setCapAlign(prof.captionAlign);
    if (prof.captionSize != null) setCapSize(String(prof.captionSize));
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logText, logCollapsed]);


  async function loadPresets() {
    const ps = await api.listPresets();
    setPresets(ps || []);
    if (ps && ps.length && !presetName) setPresetName(ps[0].name);
  }
  async function loadStyles() {
    const ss = await api.listStyles();
    setStyles(ss || []);
  }

  // ── 액션 핸들러 ──────────────────────────────────────────
  // 대본별 생성 설정 묶음(채널·스타일·배속·엔진·영상범위) — 큐 항목마다 개별 저장.
  function currentSettings() {
    return { presetName, styleId, ttsSpeed, imgEngine, videoEngine, vidFrom, vidTo, flowVideoModel, flowCount, aiNotice, bgmOn, bgmMood };
  }
  function applySettings(s) {
    if (!s) return;
    if (s.presetName != null) setPresetName(s.presetName);
    if (s.styleId != null) setStyleId(s.styleId);
    if (s.ttsSpeed != null) setTtsSpeed(s.ttsSpeed);
    // 제거된 엔진(comfy 이미지) → 순환으로 마이그레이션.
    if (s.imgEngine != null) setImgEngine(s.imgEngine === 'comfy' ? 'rotate' : s.imgEngine);
    // 제거된 영상 엔진(flow/comfy/wan)·레거시(grok10) → grok 으로 마이그레이션.
    if (s.videoEngine != null) setVideoEngine(['flow', 'comfy', 'wan', 'grok10'].includes(s.videoEngine) ? 'grok' : s.videoEngine);
    if (s.vidFrom != null) setVidFrom(s.vidFrom);
    if (s.vidTo != null) setVidTo(s.vidTo);
    if (s.flowVideoModel != null) setFlowVideoModel(s.flowVideoModel);
    if (s.flowCount != null) setFlowCount(s.flowCount);
    if (s.aiNotice != null) setAiNotice(!!s.aiNotice);
    if (s.bgmOn != null) setBgmOn(!!s.bgmOn);
    if (s.bgmMood != null) setBgmMood(s.bgmMood || '');
  }
  async function openScript() {
    const r = await api.openScript({ presetName: presetName || null, mode });
    if (!r) return;
    // 대본 형식 자동 판별 → 맞는 탭(롱폼/쇼츠)으로 전환 (잘못된 탭에서 열림 방지)
    const switched = r.mode && r.mode !== mode;
    if (switched) { setMode(r.mode); setAspect(r.mode === 'longform' ? '16:9' : '9:16'); }
    setDto(r.dto); setFtitle(r.dto.fileTitle); if (r.queue) setQueue(r.queue);
    try { await api.setQueueSettings(currentSettings()); } catch (_) {} // 이 대본의 설정을 현재 헤더값으로 캡처
    setStatus(`${r.dto.projects.length}편 로드 · 큐에 추가${switched ? ` · ${r.mode === 'longform' ? '롱폼' : '쇼츠'} 모드로 전환` : ''}`);
  }
  // 큐에서 대본 선택 → 활성화 + 그 대본의 설정을 헤더에 로드
  async function selectQueueItem(id) {
    try {
      const r = await api.selectQueueItem(id);
      if (r.queue) setQueue(r.queue);
      setDto(r.dto || null); setFtitle(r.dto ? (r.dto.fileTitle || '') : '');
      const it = r.queue && r.queue[mode] && r.queue[mode].items.find((x) => x.id === id);
      if (it && it.settings) applySettings(it.settings);
    } catch (e) { logline('대본 선택 오류: ' + e.message); }
  }
  // 큐 전체를 파일로 저장 (다중 작업 세트)
  async function saveQueueFile() {
    try {
      const r = await api.saveQueue();
      if (r && r.ok) setStatus(`💾 큐 저장 완료 — ${r.count}개 대본`);
      else if (r && r.reason === 'empty') setStatus('저장할 큐가 없습니다');
    } catch (e) { logline('큐 저장 오류: ' + e.message); }
  }
  // 저장한 큐를 통째로 불러오기 (현재 큐 교체)
  async function loadQueueFile() {
    try {
      const r = await api.loadQueue();
      if (!r || !r.ok) { if (r && r.reason !== 'cancel') logline('큐 불러오기 실패'); return; }
      if (r.queue) setQueue(r.queue);
      if (r.mode) { setMode(r.mode); setAspect(r.mode === 'longform' ? '16:9' : '9:16'); }
      if (r.dto) { setDto(r.dto); setFtitle(r.dto.fileTitle || ''); }
      const m = r.mode || 'longform';
      const it = r.queue && r.queue[m] && r.queue[m].items.find((x) => x.active);
      if (it && it.settings) applySettings(it.settings);
      setStatus(`📂 큐 불러오기 — ${r.count}개 대본 복구`);
    } catch (e) { logline('큐 불러오기 오류: ' + e.message); }
  }
  // 저장 폴더(saves) 전체삭제 — 확인 팝업 필수
  async function deleteSaves() {
    if (!window.confirm('저장 폴더(saves)의 「작업·큐 저장 파일」을 모두 삭제합니다.\n\n⚠ 되돌릴 수 없습니다.\n(진행 중 대본의 자동 이어받기 데이터는 삭제되지 않습니다.)\n\n정말 모두 삭제할까요?')) return;
    try { const r = await api.clearSaves(); setStatus(`🗑 저장 파일 ${(r && r.count) || 0}개 삭제됨`); }
    catch (e) { logline('전체삭제 오류: ' + e.message); }
  }
  // 큐에서 대본 제거
  async function removeQueueItem(id) {
    try { const r = await api.removeQueueItem(id); if (r.queue) setQueue(r.queue); setDto(r.dto || null); setFtitle(r.dto ? (r.dto.fileTitle || '') : ''); setStatus('대본 제거됨'); }
    catch (e) { logline('대본 제거 오류: ' + e.message); }
  }
  // 작업 소요시간은 백엔드에서 단계별로 측정해 dto-update(d.timings)로 전송 → setTimings 로 표시.
  async function runStt() {
    setStatus('STT 변환 중… (음성·영상 → txt)');
    try {
      const r = await api.sttTranscribe();
      if (!r || r.canceled) { setStatus('STT 취소'); return; }
      const tot = (r.results || []).length;
      const okN = (r.results || []).filter((x) => x.ok).length;
      setStatus(`STT 완료 (${okN}/${tot}) — 원본 폴더에 .txt 생성`);
    } catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function runTts(shortsNum) {
    setStatus('TTS 생성중…');
    try {
      const d = await api.ttsBuild({ shortsNum, dry: false, presetName: presetName || null, speed: ttsSpeed || null, clipMaxSec: _clipMaxSec() });
      setDto(d); setStatus('오디오 완료');
    } catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function deleteTtsAll() {
    if (!window.confirm('이미 만든 TTS 음성 파일과 재활용 캐시를 모두 삭제하고, 화면의 시간기록도 지웁니다.\n(다음에 변환 버튼을 누르면 전부 새로 합성됩니다.)\n\n진행할까요?')) return;
    setStatus('TTS 삭제 중…');
    try { const d = await api.deleteTts(); if (d) setDto(d); setStatus('TTS 삭제 완료'); }
    catch (e) { logline('TTS 삭제 오류: ' + e.message); setStatus('TTS 삭제 실패'); }
  }
  async function runImg(shortsNum) {
    if (!ensurePromptsFilled(shortsNum, { image: 'all', video: 'none' })) return; // 이미지 버튼=이미지 프롬프트만
    setStatus(`이미지 생성중(${imgEngine})…`);
    try { const d = await api.imageBuild({ shortsNum, engine: imgEngine, styleId: styleId || null }); setDto(d); setStatus('이미지 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function runVid(shortsNum) {
    if (!ensurePromptsFilled(shortsNum, { image: 'range', video: 'range' })) return; // 영상=범위 그룹 이미지+i2v
    setStatus(`비디오 생성중(G${vidFrom}~${vidTo})…`);
    try { const d = await api.videoBuild({ shortsNum, fromNum: parseInt(vidFrom, 10) || 1, toNum: parseInt(vidTo, 10) || 1, engine: videoEngine, flowVideoModel, flowCount, imgEngine, styleId: styleId || null }); setDto(d); setStatus('비디오 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function runBulk(shortsNum) {
    setStatus('일괄첨부 폴더 선택…');
    try { const d = await api.bulkAttach({ shortsNum }); setDto(d); setStatus('일괄첨부 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function runMake(shortsNum) {
    const args = {
      shortsNum, engine: imgEngine, presetName: presetName || null, speed: ttsSpeed || null,
      captionStyle: capOverride(), captionMaxChars: effCap, styleId: styleId || null,
      fromNum: parseInt(vidFrom, 10) || 1, toNum: parseInt(vidTo, 10) || 1,
      dry: false, videoEngine, clipMaxSec: _clipMaxSec(), flowVideoModel, flowCount,
      aiNotice, // 양쪽 모드 사용자 선택 (기본값 롱폼 ON / 쇼츠 OFF 는 토글이 보유)
      bgm: { enabled: bgmOn, moodOverride: bgmMood || null }, // 배경음(ACE-Step)
    };
    if (!ensurePromptsFilled(shortsNum, { image: 'all', video: videoEngine === 'none' ? 'none' : 'range' })) return; // 만들기=전체 이미지 + 범위 i2v ('없음'은 i2v 불요)
    setStatus('⚡ 전체 제작중… (TTS+이미지→영상→.vrew)');
    try { const d = await api.makeAll(args); setDto(d); setStatus('전체 제작 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  // ⚡ 만들기(통합) — 큐 대본이 1개면 그것만(.vrew 자동열기 등 기존 동작), 여러 개면 큐 전체 순차 제작.
  async function runMakeOrBatch() {
    try { await api.setQueueSettings(currentSettings(), true); } catch (_) {} // 현재 헤더값을 활성 항목에 반영(채널은 열 때 값 유지)
    const L = (queue && queue.longform && queue.longform.items) || [];
    const Sh = (queue && queue.shorts && queue.shorts.items) || [];
    const total = L.length + Sh.length;
    if (total === 0) { setStatus('대본을 먼저 여세요'); return; }
    if (total === 1) return runMake(null);  // 단일 대본 → makeAll(.vrew·폴더 자동열기)
    return runBatchAll();                    // 여러 대본 → 큐 전체 교차 순차
  }
  // ⚡⚡ 큐 전체 순차 제작 — 교차 순서(L1→S1→L2→S2…), 각 대본은 자기 설정으로.
  async function runBatchAll() {
    const L = (queue && queue.longform && queue.longform.items) || [];
    const Sh = (queue && queue.shorts && queue.shorts.items) || [];
    const plan = [];
    const n = Math.max(L.length, Sh.length);
    for (let i = 0; i < n; i++) {
      if (L[i]) plan.push({ mode: 'longform', id: L[i].id, settings: L[i].settings || null });
      if (Sh[i]) plan.push({ mode: 'shorts', id: Sh[i].id, settings: Sh[i].settings || null });
    }
    if (!plan.length) { setStatus('큐에 대본이 없습니다'); return; }
    if (!ensurePromptsFilled(null, { image: 'all', video: videoEngine === 'none' ? 'none' : 'range' })) return; // 현재 표시 대본 기준 빈 프롬프트 검사 ('없음'은 i2v 불요)
    setStatus(`⚡⚡ 큐 순차 제작중… (${plan.length}개)`);
    try {
      // 비디오·이미지 엔진은 헤더값(이번 실행 공통)으로 전달 — 큐 항목별 stale 값 무시(헤더 '없음'이면 전 대본 영상 없음)
      const r = await api.runBatch({ plan, common: { captionStyle: capOverride(), captionMaxChars: effCap, videoEngine, imgEngine, flowVideoModel, flowCount }, openEach: openEachVrew });
      if (r && r.queue) setQueue(r.queue);
      if (r && r.dto) { setDto(r.dto); setFtitle(r.dto.fileTitle || ''); }
      setStatus('⚡⚡ 큐 제작 완료');
    } catch (e) { logline('큐 제작 오류: ' + e.message); setStatus('큐 제작 오류'); }
  }
  async function runVrew(shortsNum) {
    setStatus('.vrew 내보내는 중…');
    try { const r = await api.exportVrew({ shortsNum, presetName: presetName || null, captionStyle: capOverride(), captionMaxChars: effCap, aiNotice }); setStatus(`.vrew ${r.outs.length}개`); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  // Premiere Pro 임포트용 XML(FCP7 xmeml) — 파일 > 가져오기로 시퀀스가 바로 열림.
  async function runPremiere(shortsNum) {
    setStatus('프리미어 XML 내보내는 중…');
    try { const r = await api.exportPremiere({ shortsNum, captionMaxChars: effCap }); setStatus(r && r.outs && r.outs.length ? `프리미어 XML ${r.outs.length}개 — Premiere 에서 파일>가져오기 (자막=.srt)` : '프리미어 XML 실패 — 로그 확인'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function attachAsset(shortsNum, groupNum) {
    setStatus('이미지/영상 첨부…');
    try { const d = await api.attachAsset({ shortsNum, groupNum }); setDto(d); setStatus('첨부 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function clearAsset(shortsNum, groupNum) {
    try { const d = await api.clearAsset({ shortsNum, groupNum }); setDto(d); setStatus('자산 삭제'); }
    catch (e) { logline('오류: ' + e.message); }
  }
  async function runRegen(shortsNum, groupNum) {
    setStatus(`G${groupNum} 이미지 재생성…`);
    try { const d = await api.regenGroup({ shortsNum, groupNum, styleId: styleId || null, engine: imgEngine }); setDto(d); setStatus('재생성 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  // 그룹 단위 버튼 (PrimingFlow)
  async function runGroupTts(shortsNum, groupNum) {
    setStatus(`G${groupNum} TTS…`);
    try { const d = await api.ttsGroup({ shortsNum, groupNum, presetName: presetName || null, speed: ttsSpeed || null }); setDto(d); setStatus(`G${groupNum} TTS 완료`); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  async function runGroupVid(shortsNum, groupNum) {
    setStatus(`G${groupNum} 비디오…`);
    try { const d = await api.videoGroup({ shortsNum, groupNum, engine: videoEngine, flowVideoModel, flowCount, imgEngine, styleId: styleId || null }); setDto(d); setStatus(`G${groupNum} 비디오 완료`); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  function playFrom(shortsNum, groupNum) {
    if (!dto) return;
    const pr = dto.projects.find((p) => p.shortsNum === shortsNum); if (!pr) return;
    const idx = pr.cuts.findIndex((c) => c.num === groupNum); if (idx < 0) return;
    playProjects([{ ...pr, cuts: pr.cuts.slice(idx) }], false); // 이 그룹부터 끝까지
  }
  async function mergeGroups() {
    if (!dto) { setStatus('대본을 먼저 여세요'); return; }
    setStatus('그룹 합치는 중…');
    try { const d = await api.mergeGroups({ clipMaxSec: _clipMaxSec() }); setDto(d); setStatus('그룹 재구성 완료'); }
    catch (e) { logline('합치기 오류: ' + e.message); setStatus('합치기 실패'); }
  }
  const styleName = () => { const s = styles.find((x) => x.id === styleId); return s ? s.name : ''; };
  async function exportPrompts() {
    if (!dto) { setStatus('대본을 먼저 여세요'); return; }
    try {
      const text = await api.exportPrompts({ styleName: styleName() });
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
      setStatus(ok ? '📤 요청서 클립보드 복사 완료 — 웹 LLM에 붙여넣으세요' : '복사 실패');
    } catch (e) { logline('내보내기 오류: ' + e.message); }
  }
  // ✍ 프롬프트작성 — 빈 그룹의 이미지+i2v 프롬프트를 GPU(Ollama)로 채움.
  //   GPU 미연결(다른 PC·출장 등)이면 → 요청서를 클립보드에 복사하고 '붙여넣기' 창을 열어
  //   아무 LLM(챗GPT/클로드/제미나이…)에 붙여넣어 답을 받아 등록하는 수동 흐름으로 자동 전환.
  async function runMakePrompts() {
    if (!dto) { setStatus('대본을 먼저 여세요'); return; }
    setImpBusy(true); setStatus('✍ 빈 프롬프트 자동작성 중… (GPU Ollama)');
    try {
      const d = await api.generatePromptsApi({ provider: 'ollama', styleName: styleName(), fromNum: parseInt(vidFrom, 10) || 1, toNum: parseInt(vidTo, 10) || 1 });
      setDto(d); setStatus('✍ 빈 프롬프트 작성 완료');
    } catch (e) {
      logline('프롬프트작성(GPU Ollama) 실패: ' + e.message);
      // GPU 미연결 → 복사·붙여넣기 방식으로 자동 전환 (요청서를 클립보드에 복사 + 붙여넣기 창 열기)
      let copied = false;
      try {
        const text = await api.exportPrompts({ styleName: styleName() });
        try { await navigator.clipboard.writeText(text); copied = true; } catch (_) {}
      } catch (_) {}
      setImpText('');
      setImpOpen(true);
      setStatus('GPU(Ollama) 미연결 — 복사·붙여넣기 방식으로 전환');
      alert(
        'GPU(Ollama)에 연결할 수 없습니다.\n'
        + (copied ? '요청서를 클립보드에 복사해 두었습니다.\n' : '※ 자동 복사 실패 — 붙여넣기 창의 [📤 요청서 복사] 버튼을 누르세요.\n')
        + '\n[복사·붙여넣기로 프롬프트 만들기]\n'
        + '① 챗GPT·클로드·제미나이 등 아무 LLM에 붙여넣어 답을 받으세요.\n'
        + '② 받은 답 전체를 붙여넣기 창에 넣고 [붙여넣은 텍스트 적용]을 누르세요.'
      );
    }
    finally { setImpBusy(false); }
  }
  // 그룹 분할 — 10초 초과 그룹을 2개로(균형). 두 그룹 프롬프트 초기화.
  async function splitGroup(shortsNum, groupNum) {
    try { const d = await api.splitGroup({ shortsNum, groupNum }); setDto(d); setStatus('✂ 그룹 분할 — 두 그룹 프롬프트 초기화됨. ✍프롬프트작성으로 채우세요'); }
    catch (e) { logline('분할 오류: ' + e.message); alert('분할 실패:\n' + e.message); }
  }
  // 제작 전 검사 — 빈 프롬프트 있으면 목록 팝업 + 진행 차단. (shortsNum=null → 전체)
  //   opts.image/video = 'all'|'range'|'none' — 어느 그룹에 그 프롬프트가 필요한지.
  //   i2v 는 '영상 범위(vidFrom~vidTo)' 그룹만 필요(롱폼=도입부만). 범위 밖은 영상 안 만드니 i2v 불요.
  function ensurePromptsFilled(shortsNum, opts = {}) {
    if (!dto) return false;
    const image = opts.image || 'all';
    const video = opts.video || 'range';
    const vf = parseInt(vidFrom, 10) || 1, vt = parseInt(vidTo, 10) || 1;
    const lo = Math.min(vf, vt), hi = Math.max(vf, vt);
    const inRange = (n) => n >= lo && n <= hi;
    const projs = dto.projects.filter((p) => shortsNum == null || p.shortsNum === shortsNum);
    const missing = [];
    for (const p of projs) {
      for (const c of p.cuts) {
        const needImg = image === 'all' || (image === 'range' && inRange(c.num));
        const needVid = video === 'all' || (video === 'range' && inRange(c.num));
        // 이미 이미지/영상이 첨부돼 있으면(hasVisual) 프롬프트가 없어도 생성 불필요 — 실제 생성 로직(hasVisual)과 기준을 맞춤.
        const hasVisual = !!(c.imagePath || c.videoPath);
        const hasImgSource = hasVisual || (c.imagePrompt && c.imagePrompt.trim()); // 이미지 or 이미지프롬프트
        const noImg = needImg && !hasVisual && (!c.imagePrompt || !c.imagePrompt.trim());
        // i2v 는 '이미지→영상'이라 이미지(또는 이미지프롬프트)만 있으면 videoPrompt 없어도 기본 모션으로 생성됨(선택 사항).
        //   → 이미지 소스가 아예 없을 때만 경고(그건 애초에 이미지 경고로 이미 잡힘).
        const noVid = needVid && !c.videoPath && !hasImgSource;
        if (noImg || noVid) missing.push(`${p.title} G${c.num}: ${[noImg ? '이미지' : null, noVid ? 'i2v' : null].filter(Boolean).join('·')} 없음`);
      }
    }
    if (missing.length) {
      alert(`프롬프트가 비어 있어 진행할 수 없습니다.\n✍ 프롬프트작성 버튼으로 채운 뒤 다시 시도하세요.\n\n빈 그룹 ${missing.length}개:\n` + missing.slice(0, 20).join('\n') + (missing.length > 20 ? `\n…외 ${missing.length - 20}개` : ''));
      setStatus(`⛔ 빈 프롬프트 ${missing.length}개 — 진행 안 함`);
      return false;
    }
    return true;
  }
  async function applyImport() {
    if (!impText.trim()) { setStatus('붙여넣은 텍스트가 없습니다'); return; }
    setStatus('가져오기 적용 중…');
    try { const d = await api.importPrompts({ text: impText }); setDto(d); setImpOpen(false); setStatus('가져오기 완료'); }
    catch (e) { logline('가져오기 오류: ' + e.message); setStatus('가져오기 실패'); }
  }
  async function importViaApi() {
    setStatus(`🤖 ${impProvider} API로 프롬프트 작성 중…`); setImpBusy(true);
    try { const d = await api.generatePromptsApi({ provider: impProvider, styleName: styleName() }); setDto(d); setImpOpen(false); setStatus('API 자동작성 완료'); }
    catch (e) { logline('API 오류: ' + e.message); setStatus('API 실패'); alert('API 호출 실패:\n' + e.message); }
    finally { setImpBusy(false); }
  }
  async function resetProject() {
    const r = await api.resetProject();
    if (r && r.queue) setQueue(r.queue);
    setDto(null); setFtitle(''); setStatus('초기화됨 — 현재 모드 큐 비움');
  }
  async function saveProject() {
    try { const r = await api.saveProject(); setStatus('프로젝트 저장됨'); logline('저장: ' + r.file); }
    catch (e) { logline('오류: ' + e.message); }
  }
  async function loadProject() {
    const r = await api.loadProject(); if (!r) return;
    if (r.mode && r.mode !== mode) { setMode(r.mode); setAspect(r.mode === 'longform' ? '16:9' : '9:16'); }
    setDto(r.dto); setFtitle(r.dto.fileTitle); if (r.queue) setQueue(r.queue);
    try { await api.setQueueSettings(currentSettings()); } catch (_) {} // 불러온 항목 설정 캡처
    setStatus(`${r.dto.projects.length}편 불러옴`);
  }
  // ── 이미지 스타일 편집 ─────────────────────────────
  async function refreshStyles() { try { const ss = await api.listStyles(); setStyles(ss || []); return ss || []; } catch { return []; } }
  async function copyStylePrompt(p) {
    try { await navigator.clipboard.writeText(p || ''); }
    catch (_) { try { const ta = document.createElement('textarea'); ta.value = p || ''; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (__) {} }
    setStatus('스타일 프롬프트 복사됨');
  }
  async function addStyle() {
    const name = (newStyle.name || '').trim(), prompt = (newStyle.prompt || '').trim();
    if (!name || !prompt) { setStatus('스타일 이름과 프롬프트를 모두 입력하세요'); return; }
    const r = await api.addStyle({ name, prompt });
    if (r) { setNewStyle({ name: '', prompt: '' }); await refreshStyles(); setStatus(`스타일 「${name}」 추가됨`); }
    else setStatus('스타일 추가 실패');
  }
  async function saveStyle(id, name, prompt) {
    const r = await api.updateStyle({ id, name: (name || '').trim(), prompt: (prompt || '').trim() });
    if (r) { await refreshStyles(); setStatus('스타일 저장됨'); } else setStatus('스타일 저장 실패');
  }
  async function deleteStyle(id, name) {
    if (!window.confirm(`스타일 「${name}」 삭제할까요?`)) return;
    const ok = await api.removeStyle(id);
    if (ok) { if (styleId === id) setStyleId(''); await refreshStyles(); setStatus('스타일 삭제됨'); }
    else setStatus('스타일 삭제 실패');
  }
  async function moveStyle(id, direction) { const ok = await api.moveStyle({ id, direction }); if (ok) await refreshStyles(); }
  // ── 발음사전(TTS 교정) ─────────────────────────────
  async function openDict() { try { const d = await api.dictList(); setDictRows(Array.isArray(d) ? d : []); setDictOpen(true); } catch (e) { logline('발음사전 읽기 오류: ' + e.message); } }
  async function saveDict() {
    const clean = dictRows.map((r) => ({ source: (r.source || '').trim(), pron: (r.pron || '').trim(), enabled: r.enabled !== false })).filter((r) => r.source && r.pron);
    const r = await api.dictSave(clean);
    if (r) { setDictRows(r); setDictOpen(false); setStatus('발음사전 저장됨 — 다음 TTS 변환부터 적용'); } else setStatus('발음사전 저장 실패');
  }
  function addDictRow() { setDictRows((rs) => [...rs, { source: '', pron: '', enabled: true }]); }
  function setDictRow(i, patch) { setDictRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function delDictRow(i) { setDictRows((rs) => rs.filter((_, j) => j !== i)); }
  function showPrompt(shortsNum, c, label) {
    // 편집 대상 = 대본 이미지/비디오 프롬프트(raw). 스타일은 생성 시 앞에 자동으로 붙는다(stylePfx 는 안내용).
    const st = styles.find((x) => x.id === styleId);
    const stylePfx = st && st.prompt ? st.prompt + ', ' : '';
    setPromptView({
      label, shortsNum, groupNum: c.num,
      styleName: st ? st.name : '없음', stylePfx,
      image: c.imagePrompt || '',   // 대본 이미지 프롬프트(편집)
      video: c.videoPrompt || '',   // 대본 비디오 프롬프트(편집)
      motion: c.motionNote || '',
    });
  }
  // 수정한 프롬프트 저장(+선택적으로 이미지/비디오 재생성). regen: 'image' | 'video' | null(저장만)
  async function savePromptView(regen) {
    if (!promptView) return;
    const { shortsNum, groupNum, image, video } = promptView;
    try { const d = await api.setGroupPrompt({ shortsNum, groupNum, imagePrompt: image, videoPrompt: video }); if (d) setDto(d); setStatus('프롬프트 저장됨'); }
    catch (e) { logline('프롬프트 저장 오류: ' + e.message); return; }
    if (regen === 'image') { setPromptView(null); await runRegen(shortsNum, groupNum); }
    else if (regen === 'video') { setPromptView(null); await runGroupVid(shortsNum, groupNum); }
  }
  async function openFlowAcc() {
    try { const d = await api.getFlowAccounts(); setFlowAcc(d || { dailyCap: 45, accounts: [] }); setFlowAccOpen(true); }
    catch (e) { logline('Flow 계정 읽기 오류: ' + e.message); }
  }
  // 이미지 순환 설정
  async function openImgRotation() {
    try {
      const c = await api.getImageRotation(); setImgRot(c || { order: ['genspark', 'flow'], enabled: { genspark: true, flow: true }, flowImageModel: 'Nano Banana 2' });
      try { setLora(await api.getLoraCollect()); } catch (_) {}
      try { setGiCfg(await api.getGeminiImageConfig()); } catch (_) {}
      try { setGiKey(await api.getGeminiKey() || ''); } catch (_) {}
      setImgRotOpen(true);
    } catch (e) { logline('순환 설정 읽기 오류: ' + e.message); }
  }
  async function saveGiCfg(patch) { try { setGiCfg(await api.setGeminiImageConfig(patch)); } catch (e) { logline('나노바나나 설정 오류: ' + e.message); } }
  async function saveGiKey(k) { try { await api.setGeminiKey(k || ''); setGiKey(k || ''); setStatus('Gemini API 키 저장됨'); } catch (e) { logline('Gemini 키 저장 오류: ' + e.message); } }
  async function saveLora(patch) { try { setLora(await api.setLoraCollect(patch)); } catch (e) { logline('LoRA 설정 오류: ' + e.message); } }
  async function pickLoraDir() { try { const r = await api.pickLoraDir(); if (r) setLora(r); } catch (e) { logline(e.message); } }
  async function saveImgRot(next) { setImgRot(next); try { await api.setImageRotation(next); } catch (e) { logline('순환 저장 오류: ' + e.message); } }
  function toggleRotEngine(id) { const en = { ...(imgRot.enabled || {}) }; en[id] = en[id] === false; saveImgRot({ ...imgRot, enabled: en }); }
  function moveRotEngine(id, dir) {
    const order = [...(imgRot.order || [])]; const i = order.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]]; saveImgRot({ ...imgRot, order });
  }
  // Genspark 멀티계정
  async function openGsAcc() { try { setGsAcc(await api.getGensparkAccounts()); setGsAccOpen(true); } catch (e) { logline('Genspark 계정 오류: ' + e.message); } }
  async function addGsAcc() { try { setGsAcc(await api.addGensparkAccount('')); } catch (e) { logline(e.message); } }
  async function removeGsAcc(id) { try { setGsAcc(await api.removeGensparkAccount(id)); } catch (e) { logline(e.message); } }
  async function renameGsAcc(id, label) { try { setGsAcc(await api.renameGensparkAccount(id, label)); } catch (e) { logline(e.message); } }
  async function changeGsCap(n) { try { setGsAcc(await api.setGensparkCap(n)); } catch (e) { logline(e.message); } }
  async function gsLogin(id) { setStatus('Genspark 로그인 창 여는 중…'); try { const r = await api.gensparkLogin(id); setStatus(r.ok ? '✓ Genspark 로그인 완료' : 'Genspark 로그인 실패: ' + (r.error || '')); } catch (e) { setStatus('Genspark 로그인 오류'); } }
  // Grok 멀티계정
  async function openGrokAcc() { try { setGrokAcc(await api.getGrokAccounts()); setGrokAccOpen(true); } catch (e) { logline('Grok 계정 오류: ' + e.message); } }
  async function addGrokAcc() { try { setGrokAcc(await api.addGrokAccount('')); } catch (e) { logline(e.message); } }
  async function removeGrokAcc(id) { try { setGrokAcc(await api.removeGrokAccount(id)); } catch (e) { logline(e.message); } }
  async function renameGrokAcc(id, label) { try { setGrokAcc(await api.renameGrokAccount(id, label)); } catch (e) { logline(e.message); } }
  async function changeGrokCap(n) { try { setGrokAcc(await api.setGrokCap(n)); } catch (e) { logline(e.message); } }
  async function grokLogin(id) { setStatus('Grok(X) 로그인 창 여는 중…'); try { const r = await api.grokLogin(id); setStatus(r.ok ? '✓ Grok 로그인 완료' : 'Grok 로그인 실패: ' + (r.error || '')); } catch (e) { setStatus('Grok 로그인 오류'); } }
  async function addFlowAcc() {
    try { setFlowAcc(await api.addFlowAccount('')); } catch (e) { logline('추가 오류: ' + e.message); }
  }
  async function removeFlowAcc(id) {
    try { setFlowAcc(await api.removeFlowAccount(id)); } catch (e) { logline('삭제 오류: ' + e.message); }
  }
  async function renameFlowAcc(id, label) { try { setFlowAcc(await api.renameFlowAccount(id, label)); } catch (e) { logline(e.message); } }
  async function changeFlowCap(n) {
    try { setFlowAcc(await api.setFlowCap(n)); } catch (e) { logline('한도 오류: ' + e.message); }
  }
  async function flowLogin(id) {
    setStatus('Flow 로그인 창 여는 중… 크롬에서 로그인하세요');
    try { const r = await api.flowLogin(id); setStatus(r.ok ? '✓ Flow 로그인 완료' : 'Flow 로그인 실패: ' + (r.error || '')); }
    catch (e) { logline('Flow 로그인 오류: ' + e.message); setStatus('Flow 로그인 오류'); }
  }
  async function openOllama() {
    try {
      const c = await api.getOllamaConfig(); setOllama(c || {}); setOllamaOpen(true);
      api.listOllamaModels().then((m) => setOllamaModels(m || [])).catch(() => {});
    } catch (e) { logline('Ollama 설정 읽기 오류: ' + e.message); }
  }
  async function saveOllama() {
    try { await api.setOllamaConfig(ollama); setOllamaOpen(false); setStatus('Ollama 설정 저장됨'); }
    catch (e) { logline('저장 오류: ' + e.message); }
  }
  async function testOllamaConn() {
    setStatus('Ollama 연결 테스트…');
    try {
      await api.setOllamaConfig(ollama); // 입력값으로 테스트
      const r = await api.testOllama();
      setOllamaModels(r.models || []);
      if (!r.ok) { setStatus(`✗ 연결 실패 (${r.baseUrl}) — ${r.error || ''}`); return; }
      setStatus(r.hasModel ? `✓ 연결 OK — '${ollama.model}' 설치됨 (모델 ${r.models.length}개)` : `✓ 연결 OK — ⚠ '${ollama.model}' 미설치 (모델 ${r.models.length}개)`);
    } catch (e) { logline('테스트 오류: ' + e.message); setStatus('테스트 오류'); }
  }
  async function openScriptEdit() {
    if (!loaded) { setStatus('대본을 먼저 여세요'); return; }
    try { const t = await api.getScriptText(); setScriptText(t || ''); setScriptEditOpen(true); }
    catch (e) { logline('대본 읽기 오류: ' + e.message); }
  }
  async function applyScriptEdit() {
    setStatus('대본 수정 적용 중…');
    try { const d = await api.applyScriptText({ text: scriptText }); if (d) { setDto(d); setFtitle(d.fileTitle || ftitle); } setScriptEditOpen(false); setStatus('대본 수정 적용 완료'); }
    catch (e) { logline('대본 수정 오류: ' + e.message); setStatus('오류'); }
  }
  async function changeAspect(v) {
    setAspect(v);
    try { const d = await api.setAspect(v); if (d) setDto(d); setStatus('비율 ' + v); }
    catch (e) { logline('오류: ' + e.message); }
  }
  function abort() { api.abort(); setStatus('중단 요청됨'); }

  function updateTitleField(shortsNum, field, rawValue) {
    let v = rawValue;
    if (typeof rawValue !== 'boolean' && /(Size|Op|Round|StrokeW)$/.test(field)) v = Number(rawValue);
    setDto((d) => d ? ({ ...d, projects: d.projects.map((p) => p.shortsNum === shortsNum ? { ...p, [field]: v } : p) }) : d);
    api.setTitle({ shortsNum, field, value: v }).catch(() => {});
  }

  // ── 채널 설정 편집 ──
  // Electron 렌더러는 window.prompt 를 지원하지 않으므로(조용히 null) 이름 입력은 별도 모달로 받는다.
  function addChannel() { setNewChanName(''); setNewChanOpen(true); }
  async function createChannel() {
    const name = (newChanName || '').trim();
    if (!name) { setStatus('채널 이름을 입력하세요'); return; }
    try {
      const ps = await api.addPreset({ name, fromName: presetName || null });
      setPresets(ps || []); setPresetName(name);
      setNewChanOpen(false);
      setStatus(`채널 "${name}" 추가됨 — 세부 설정을 편집하세요`);
      await openChannelEditor(name);   // 바로 편집창 열기
    } catch (e) { alert('채널 추가 실패:\n' + e.message); }
  }
  async function deleteChannel() {
    if (!ch || !ch.name) return;
    if (!window.confirm(`채널 "${ch.name}" 을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      const ps = await api.removePreset({ name: ch.name });
      setChOpen(false); setPresets(ps || []);
      if (ps && ps.length) setPresetName(ps[0].name);
      setStatus(`채널 "${ch.name}" 삭제됨`);
    } catch (e) { alert('채널 삭제 실패:\n' + e.message); }
  }
  async function openChannelEditor(nameArg) {
    // ⚙ 버튼 onClick 은 이벤트 객체를 넘기므로, 문자열일 때만 인자 이름으로 사용.
    const useName = (typeof nameArg === 'string' && nameArg) ? nameArg : presetName;
    if (!useName) { logline('채널을 먼저 선택하세요'); return; }
    const p = await api.getPresetDetail(useName);
    if (!p) { logline('채널 정보를 찾을 수 없습니다'); return; }
    const ss = await api.listStyles();
    setChStyles(ss || []);
    try { setChRefList(await api.listRefAudio() || []); } catch (_) { setChRefList([]); }
    const lf = (modeProfiles && modeProfiles.longform) || {};
    const sh = (modeProfiles && modeProfiles.shorts) || {};
    // 저장된 모드별 캡션 or mode-profile 기본값 → {size, align, yAlign, pos, fine}
    const mkCap = (saved, prof) => {
      const yOff = saved && saved.yOffset != null ? saved.yOffset : (prof.captionYOffset != null ? prof.captionYOffset : 0);
      const d = decomposeYOffset(yOff);
      return {
        size: String(saved && saved.size != null ? saved.size : (prof.captionSize || 100)),
        align: (saved && saved.align) || prof.captionAlign || 'center',
        yAlign: (saved && saved.yAlign) || prof.captionYAlign || 'middle',
        pos: d.pos, fine: d.fine,
      };
    };
    const sl = p.split || { introSentenceSize: p.introSentenceSize, mainSentenceSize: p.mainSentenceSize, shortLen: p.shortLen, longLen: p.longLen };
    setCh({
      name: p.name || '', engine: p.engine || 'omnivoice', startMode: p.startMode || 'longform', voice: p.voice || '',
      voiceCloneRefAudio: p.voiceCloneRefAudio || '', voiceCloneRefText: p.voiceCloneRefText || '',
      scriptFolder: p.scriptFolder || '', seed: p.seed != null ? p.seed : '',
      aiNotice: !!(p.aiNotice && p.aiNotice.enabled),
      presetPrompt: p.presetPrompt || '', language: p.language || 'ko',
      silenceSec: p.silenceSec != null ? p.silenceSec : 0,
      cfgValue: p.cfgValue != null ? p.cfgValue : 2,
      // 모드별
      capLong: mkCap(p.capLong, lf), capShort: mkCap(p.capShort, sh),
      speedLong: p.speedLong != null ? p.speedLong : (lf.defaultTtsSpeed != null ? lf.defaultTtsSpeed : 1.15),
      speedShort: p.speedShort != null ? p.speedShort : (sh.defaultTtsSpeed != null ? sh.defaultTtsSpeed : 1.25),
      styleLong: p.styleLong || p.styleId || 'chibi', styleShort: p.styleShort || p.styleId || 'chibi',
      outLong: p.outLong || p.outputFolder || '', outShort: p.outShort || p.outputFolder || '',
      split: { intro: sl.introSentenceSize || 3, main: sl.mainSentenceSize || 10, short: sl.shortLen || 10, long: sl.longLen || 20, mode: sl.splitMode === 'sentence' ? 'sentence' : (sl.splitMode === 'h2' ? 'h2' : 'h3') },
      _raw: p,
    });
    setChOpen(true);
  }
  // 채널(프리셋) 선택 시 그 채널이 지정한 시작 화면(startMode)으로 전환.
  async function switchModeForChannel(name) {
    setPresetName(name);
    try {
      const p = await api.getPresetDetail(name);
      const sm = (p && p.startMode) || 'longform';
      setMode(sm);
      setAspect(sm === 'shorts' ? '9:16' : '16:9');
    } catch {}
  }
  // 모달 내 참조음성 미리듣기
  async function playRef(p) {
    if (!p) return;
    try { const url = await api.readAudio(p); playPreviewUrl(url); }
    catch (e) { logline('미리듣기 실패: ' + e.message); }
  }
  // ── 🎨 보이스디자인 (Qwen3-TTS 온디맨드 서버) ─────────────────────────────
  async function openVoiceDesign() {
    setVdOpen(true); setVdWavUrl(''); setVdGenerated(false); setVdFilename(''); setVdBusy(true); setVdStatus('설치 확인 중…');
    try {
      const st = await api.qwenDesignStatus();
      if (!st || !st.installed) { setVdStatus('⚠ 설치 안 됨 — qwen-design 폴더의 "1_최초설치.bat" 를 먼저 실행하세요.'); setVdBusy(false); return; }
      setVdStatus('서버 준비 중… (첫 실행은 모델 로딩으로 수 분 소요)');
      const r = await api.qwenDesignStart();
      if (r && r.ok) setVdStatus('준비 완료 — 목소리 설명을 입력하고 생성하세요.');
      else setVdStatus('⚠ 서버 준비 실패: ' + ((r && r.error) || '알 수 없음'));
    } catch (e) { setVdStatus('오류: ' + e.message); }
    setVdBusy(false);
  }
  async function vdGenerate() {
    if (!vdInstruct.trim()) { setVdStatus('목소리 설명을 먼저 입력하세요.'); return; }
    setVdBusy(true); setVdStatus('목소리 생성 중… (수 초)');
    try {
      const r = await api.qwenDesignGenerate({ instruct: vdInstruct, text: vdText || undefined });
      if (r && r.ok) {
        const url = await api.readAudio(r.tempPath);
        setVdWavUrl(url || ''); setVdGenerated(true);
        playPreviewUrl(url);
        setVdStatus('생성 완료 — 들어보고, 마음에 들면 아래에 파일명을 입력해 저장하세요. (안 들면 설명을 바꿔 다시 생성)');
      } else setVdStatus('⚠ 생성 실패: ' + ((r && r.error) || '알 수 없음'));
    } catch (e) { setVdStatus('오류: ' + e.message); }
    setVdBusy(false);
  }
  async function vdSave() {
    const fn = (vdFilename || '').trim();
    if (!fn) { setVdStatus('저장할 파일명을 입력하세요.'); return; }
    if (!vdGenerated) { setVdStatus('먼저 목소리를 생성하세요.'); return; }
    setVdBusy(true); setVdStatus('저장 중…');
    try {
      const r = await api.qwenDesignSave({ filename: fn });
      if (r && r.ok) {
        try { const list = await api.listRefAudio(); setChRefList(Array.isArray(list) ? list : []); } catch {}
        setCh((c) => ({ ...c, voiceCloneRefAudio: r.path, voiceCloneRefText: vdText }));
        setVdFilename('');
        setVdStatus(`✔ 저장됨: ${r.name} — 참조음성 목록에 추가 + 이 채널에 지정했습니다. (채널편집 창에서 “저장”을 눌러야 최종 반영)`);
      } else setVdStatus('⚠ 저장 실패: ' + ((r && r.error) || '알 수 없음'));
    } catch (e) { setVdStatus('오류: ' + e.message); }
    setVdBusy(false);
  }
  async function closeVoiceDesign() {
    setVdOpen(false);
    try { await api.qwenDesignStop(); } catch {}
  }
  // Supertonic 음성 미리듣기 — 백엔드로 짧은 샘플을 즉석 합성해 재생.
  async function previewSupertonicVoice() {
    const v = /^[MF][1-5]$/.test(ch && ch.voice) ? ch.voice : 'M1';
    try {
      setStatus(`Supertonic ${v} 미리듣기 합성 중…`);
      const r = await api.previewSupertonic({ voice: v, language: (ch && ch.language) || 'ko' });
      if (r && r.dataUrl) { playPreviewUrl(r.dataUrl); setStatus(''); }
      else { logline('미리듣기 실패: ' + ((r && r.error) || '알 수 없음')); setStatus('미리듣기 실패'); }
    } catch (e) { logline('미리듣기 오류: ' + e.message); setStatus('미리듣기 실패'); }
  }
  async function saveChannel() {
    if (!ch) return;
    const numOr = (v, d) => (v !== '' && v != null && !isNaN(Number(v)) ? Number(v) : d);
    const capToStyle = (c) => ({ size: String(c.size), align: c.align, yAlign: c.yAlign, yOffset: yOffsetOf(c) });
    const patch = {
      engine: ch.engine || 'omnivoice',
      startMode: ch.startMode || 'longform',              // 이 채널 선택 시 시작할 화면(모드)
      voice: ch.voice || '',                              // Supertonic 사전정의 음성(M1~F5) 등 — 저장
      voiceCloneRefAudio: (ch.voiceCloneRefAudio || '').trim(),
      voiceCloneRefText: (ch.voiceCloneRefText || '').trim(),
      scriptFolder: (ch.scriptFolder || '').trim(),       // 대본폴더 공유
      presetPrompt: ch.presetPrompt || '',
      language: ch.language || 'ko',
      silenceSec: numOr(ch.silenceSec, 0),
      cfgValue: numOr(ch.cfgValue, 2),
      // 모드별 — 캡션/배속/스타일/출력
      capLong: capToStyle(ch.capLong), capShort: capToStyle(ch.capShort),
      speedLong: numOr(ch.speedLong, 1.15), speedShort: numOr(ch.speedShort, 1.25),
      styleLong: ch.styleLong, styleShort: ch.styleShort,
      outLong: (ch.outLong || '').trim(), outShort: (ch.outShort || '').trim(),
      // 분할옵션(롱폼)
      split: { introSentenceSize: numOr(ch.split.intro, 3), mainSentenceSize: numOr(ch.split.main, 10), shortLen: numOr(ch.split.short, 10), longLen: numOr(ch.split.long, 20), splitMode: ch.split.mode === 'h2' ? 'h2' : (ch.split.mode === 'sentence' ? 'sentence' : 'h3') },
      aiNotice: { ...((ch._raw && ch._raw.aiNotice) || {}), enabled: !!ch.aiNotice },
    };
    if (ch.seed !== '' && ch.seed != null) patch.seed = parseInt(ch.seed, 10);
    try {
      await api.savePreset({ name: ch.name, patch });
      await loadPresets(); setPresetName(ch.name); await loadStyles();
      setChOpen(false); setStatus('채널 설정 저장됨');
    } catch (e) { logline('저장 오류: ' + e.message); }
  }
  async function pickRef() { const f = await api.pickFile({ filters: [{ name: '음성', extensions: ['wav', 'mp3', 'flac', 'm4a'] }] }); if (f) setCh((c) => ({ ...c, voiceCloneRefAudio: f })); }
  async function pickOutLong() { const d = await api.pickDir(); if (d) setCh((c) => ({ ...c, outLong: d })); }
  async function pickOutShort() { const d = await api.pickDir(); if (d) setCh((c) => ({ ...c, outShort: d })); }
  async function pickScript() { const d = await api.pickDir(); if (d) setCh((c) => ({ ...c, scriptFolder: d })); }
  function setSplitField(k, v) { setCh((cur) => ({ ...cur, split: { ...cur.split, [k]: v } })); }
  // 모달 본문자막 한 컬럼(모드별). withSplit=true 면 분할옵션도 포함(롱폼).
  function capColumn(key, label, withSplit) {
    const c = ch[key];
    const set = (patch) => setCh((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }));
    return (
      <div className="col">
        <h4>{label}</h4>
        <div className="crow"><span className="l">크기</span><select value={c.size} onChange={(e) => set({ size: e.target.value })}>{['25', '50', '75', '90', '100', '110', '125', '150', '200', '250', '300'].map((v) => <option key={v}>{v}</option>)}</select>
          <span className="l">정렬</span><select value={c.align} onChange={(e) => set({ align: e.target.value })}><option value="center">가운데</option><option value="start">왼쪽</option></select></div>
        <div className="crow tri"><span className="l">세로</span><select value={c.yAlign} onChange={(e) => set({ yAlign: e.target.value })}><option value="middle">가운데</option><option value="bottom">아래</option><option value="top">위</option></select>
          <span className="l">위치</span><select value={c.pos} onChange={(e) => set({ pos: e.target.value })}><option value="0.3">아래</option><option value="0.15">약간↓</option><option value="0">가운데</option><option value="-0.15">약간↑</option><option value="-0.3">위</option></select>
          <span className="l">미세</span><input className="n" type="number" value={c.fine} step="10" onChange={(e) => set({ fine: e.target.value })} /></div>
        {withSplit && (
          <>
            <div className="crow" style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 6 }}><span className="l" style={{ color: 'var(--hook)' }}>✂ 분할</span><span className="meta">대본 분할 기준</span></div>
            <div className="crow"><span className="l">방식</span><select value={ch.split.mode === 'sentence' ? 'sentence' : (ch.split.mode === 'h2' ? 'h2' : 'h3')} onChange={(e) => setSplitField('mode', e.target.value)}><option value="h3">H3 섹션 단위</option><option value="h2">H2 섹션 단위</option><option value="sentence">문장 단위</option></select>
              <span className="meta">{ch.split.mode === 'sentence' ? '도입부/본론을 문장수로' : ch.split.mode === 'h2' ? 'H2 1개=그룹 1개 (H3 모두 묶음)' : 'H3 1개=그룹 1개'}</span></div>
            {ch.split.mode === 'sentence' && (
              <div className="crow"><span className="l">도입부</span><input className="n" type="number" value={ch.split.intro} onChange={(e) => setSplitField('intro', e.target.value)} />
                <span className="l">본론</span><input className="n" type="number" value={ch.split.main} onChange={(e) => setSplitField('main', e.target.value)} /></div>
            )}
            <div className="crow"><span className="l">짧은</span><input className="n" type="number" value={ch.split.short} onChange={(e) => setSplitField('short', e.target.value)} />
              <span className="l">긴</span><input className="n" type="number" value={ch.split.long} onChange={(e) => setSplitField('long', e.target.value)} /></div>
          </>
        )}
      </div>
    );
  }

  // ── 미리보기 재생 플레이어 (imperative, refs) ──
  const stageVisualRef = useRef(null);
  const stageCapRef = useRef(null);
  const stageTitleRef = useRef(null);
  const playerInfoRef = useRef(null);
  const playAbortRef = useRef(false);
  const curAudioRef = useRef(null);

  function applyCaptionStyle() {
    const cap = capOverride(); const cs = stageCapRef.current; if (!cs) return;
    if (cap.yAlign === 'bottom') {
      // 아래 기준: 하단 여백 8% + 위로 이동(yOffset 음수). 예: -0.125 → 하단 20.5%.
      const bottomPct = Math.max(2, Math.min(90, 8 + (-cap.yOffset) * 100));
      cs.style.bottom = bottomPct + '%'; cs.style.top = 'auto'; cs.style.transform = 'none';
    } else if (cap.yAlign === 'top') {
      const topPct = Math.max(2, Math.min(90, 8 + cap.yOffset * 100));
      cs.style.top = topPct + '%'; cs.style.bottom = 'auto'; cs.style.transform = 'none';
    } else {
      const topPct = Math.max(6, Math.min(94, 50 + cap.yOffset * 50)); // 가운데 기준
      cs.style.top = topPct + '%'; cs.style.bottom = 'auto'; cs.style.transform = 'translateY(-50%)';
    }
    cs.style.textAlign = cap.align === 'center' ? 'center' : 'left';
    cs.style.fontSize = Math.round((parseFloat(cap.size) || 90) / 90 * 18) + 'px';
  }
  function setVisual(c) {
    const v = stageVisualRef.current; if (!v) return;
    if (c.videoPath) v.innerHTML = `<video src="${media(c.videoPath)}" autoplay muted loop playsinline></video>`;
    else if (c.imagePath) {
      // 그룹마다 다른 켄번스 변형(vrew 와 동일 분포: (n*7+3)%12) → 단조롭지 않게.
      const kbIdx = ((Number(c.num) || 0) * 7 + 3) % 12;
      v.innerHTML = `<img class="kb kb${kbIdx}" src="${media(c.imagePath)}">`;
      const im = v.querySelector('img.kb'); if (im) { im.style.animation = 'none'; void im.offsetWidth; im.style.animation = ''; }
    } else v.innerHTML = `<div style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#998">이미지나 비디오가 없음</div>`;
  }
  function setStageTitle(pr) {
    const el = stageTitleRef.current; if (!el) return;
    // 제목 세로 위치 — .vrew 와 동일: line1 y = 0.035 + yShift(9:16=0.05). 즉 쇼츠 8.5% / 롱폼 3.5%.
    el.style.top = ((0.035 + (isLf ? 0 : 0.05)) * 100).toFixed(1) + '%';
    const l1 = pr.titleLine1 != null ? pr.titleLine1 : (pr.hookCaption || ''); const l2 = pr.titleLine2 || '';
    const esc = (t) => String(t).replace(/</g, '&lt;');
    const mk = (txt, size, color, align) => txt ? `<div style="font-size:${Math.round((size || 110) / 90 * 18)}px;color:${color || '#fff'};text-align:${align || 'center'};line-height:1.32">${esc(txt)}</div>` : '';
    el.innerHTML = mk(l1, pr.t1Size || 120, pr.t1Color || '#ffffff', pr.t1Align || 'center')
      + mk(l2, pr.t2Size || 120, pr.t2Color || '#ffe08a', pr.t2Align || 'center');
  }
  async function stepCaptions(clips, durMs) {
    const total = clips.reduce((a, c) => a + Math.max(1, mLen(c)), 0) || 1;
    for (const cl of clips) {
      if (playAbortRef.current) return;
      if (stageCapRef.current) stageCapRef.current.textContent = cl;
      await wait(Math.max(250, durMs * (Math.max(1, mLen(cl)) / total)));
    }
  }
  async function playCut(c, info) {
    setVisual(c); if (playerInfoRef.current) playerInfoRef.current.textContent = info;
    const N = effCap;
    const sents = (c.sentences && c.sentences.length) ? c.sentences : [{ text: '', audio: null, dur: c.groupDurationSec || 2.5 }];
    for (const s of sents) {
      if (playAbortRef.current) return;
      if (curAudioRef.current) { try { curAudioRef.current.pause(); } catch (_) {} curAudioRef.current = null; }
      const clips = splitLines(s.text || '', N); const dur = s.dur || 2.5;
      if (s.audio) {
        try {
          const url = await api.readAudio(s.audio);
          if (url) { const a = new Audio(url); curAudioRef.current = a; await a.play(); }
          else logline('미리듣기: 오디오 파일을 읽지 못함 (' + s.audio + ')');
        } catch (e) { logline('미리듣기 오디오 실패: ' + e.message); }
      }
      if (playAbortRef.current) return;
      await stepCaptions(clips.length ? clips : [''], dur * 1000);
    }
  }
  async function playProjects(projs, blackBetween) {
    playAbortRef.current = false; setPlayerOpen(true);
    await wait(0); applyCaptionStyle();
    for (let pi = 0; pi < projs.length; pi++) {
      const pr = projs[pi]; setStageTitle(pr);
      for (const c of pr.cuts) { if (playAbortRef.current) return; await playCut(c, `${pr.title} · G${c.num} ${c.phase || ''}`); }
      if (blackBetween && pi < projs.length - 1 && !playAbortRef.current) {
        if (stageVisualRef.current) stageVisualRef.current.innerHTML = '';
        if (stageCapRef.current) stageCapRef.current.textContent = '';
        if (stageTitleRef.current) stageTitleRef.current.innerHTML = '';
        if (playerInfoRef.current) playerInfoRef.current.textContent = '— 다음 영상 —';
        await wait(1000);
      }
    }
    stopStageVideo(); // 마지막 그룹 영상 무한반복 방지 — 시퀀스 끝나면 정지
    if (!playAbortRef.current && playerInfoRef.current) playerInfoRef.current.textContent = '재생 완료';
  }
  // 스테이지의 영상 정지 (loop 무한반복 차단)
  function stopStageVideo() {
    const v = stageVisualRef.current && stageVisualRef.current.querySelector('video');
    if (v) { try { v.pause(); } catch (_) {} }
  }
  function playShorts(shortsNum) {
    if (!dto) return;
    const projs = dto.projects.filter((p) => shortsNum == null || p.shortsNum === shortsNum);
    if (projs.length) playProjects(projs, shortsNum == null);
  }
  function playGroup(shortsNum, groupNum) {
    if (!dto) return;
    const pr = dto.projects.find((p) => p.shortsNum === shortsNum); if (!pr) return;
    const c = pr.cuts.find((x) => x.num === groupNum); if (!c) return;
    playAbortRef.current = false; setPlayerOpen(true);
    (async () => { await wait(0); applyCaptionStyle(); setStageTitle(pr); await playCut(c, `${pr.title} · G${c.num}`); stopStageVideo(); if (!playAbortRef.current && playerInfoRef.current) playerInfoRef.current.textContent = '재생 완료'; })();
  }
  function stopPlayer() {
    playAbortRef.current = true;
    if (curAudioRef.current) { try { curAudioRef.current.pause(); } catch (_) {} curAudioRef.current = null; }
    if (stageVisualRef.current) stageVisualRef.current.innerHTML = '';
    if (stageCapRef.current) stageCapRef.current.textContent = '';
    if (stageTitleRef.current) stageTitleRef.current.innerHTML = '';
    setPlayerOpen(false);
  }
  // 팝업/모달 닫기 = 바깥 클릭이 아니라 ESC 또는 취소·닫기 버튼으로만 (실수 클릭에 입력 유실 방지).
  //   여러 개가 겹쳐 떠 있어도 최상단(가장 나중에 연) 하나만 닫는다.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (preview) { setPreview(null); return; }
      if (playerOpen) { stopPlayer(); return; }
      if (promptView) { setPromptView(null); return; }
      if (impOpen) { setImpOpen(false); return; }
      if (scriptEditOpen) { setScriptEditOpen(false); return; }
      if (grokAccOpen) { setGrokAccOpen(false); return; }
      if (gsAccOpen) { setGsAccOpen(false); return; }
      if (imgRotOpen) { setImgRotOpen(false); return; }
      if (flowAccOpen) { setFlowAccOpen(false); return; }
      if (ollamaOpen) { setOllamaOpen(false); return; }
      if (vdOpen) { closeVoiceDesign(); return; }
      if (dictOpen) { setDictOpen(false); return; }
      if (styleEditOpen) { setStyleEditOpen(false); return; }
      if (chOpen) { setChOpen(false); return; }
      if (newChanOpen) { setNewChanOpen(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, playerOpen, promptView, impOpen, scriptEditOpen, grokAccOpen, gsAccOpen, imgRotOpen, flowAccOpen, ollamaOpen, vdOpen, dictOpen, styleEditOpen, chOpen, newChanOpen]);
  // 자막 옵션 변경 시 재생 중이면 즉시 반영
  useEffect(() => { if (playerOpen) applyCaptionStyle(); /* eslint-disable-next-line */ }, [capPos, capFine, capAlign, capSize, capYAlign, playerOpen]);
  // Genspark 한도 쿨다운(재설정 시각) — 마운트 시 + 60초마다 조회. 저장값(json)을 읽으므로 앱 재시작해도 유지.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.gensparkCooldown().then((r) => { if (alive) setGsCool(r); }).catch(() => {});
      api.grokCooldown().then((r) => { if (alive) setGrokCool(r); }).catch(() => {});
    };
    tick(); const iv = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  // 화면 내 검색(Ctrl+F) — 모든 모드 공통. Electron find-in-page 로 렌더 텍스트 찾기·이동.
  useEffect(() => {
    api.onFindResult((r) => setFindRes(r || { active: 0, total: 0 }));
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault(); setFindOpen(true);
        setTimeout(() => { const el = document.getElementById('find-input'); if (el) { el.focus(); el.select(); } }, 30);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  function runFind(text, findNext, forward) {
    setFindText(text);
    if (!text) { api.findStop(); setFindRes({ active: 0, total: 0 }); return; }
    api.findInPage({ text, findNext: !!findNext, forward: forward !== false });
  }
  function closeFind() { api.findStop(); setFindOpen(false); setFindRes({ active: 0, total: 0 }); }
  // 나노바나나2 배치 — 현재 대본에 미회수 배치가 있는지 조회(엔진=gemini·대본 바뀔 때)
  const refreshBatch = () => { api.geminiBatchStatus().then(setGsBatch).catch(() => {}); };
  useEffect(() => { if (imgEngine === 'gemini') refreshBatch(); else setGsBatch(null); /* eslint-disable-next-line */ }, [imgEngine, ftitle]);
  async function openComfy() {
    try {
      const c = (await api.getComfyImageConfig()) || {};
      // 마이그레이션: 목록이 비었는데 기존 단일 workflowPath 가 있으면 목록 첫 항목으로 편입
      if ((!c.workflows || !c.workflows.length) && c.workflowPath) {
        c.workflows = [{ name: (c.workflowPath.split(/[\\/]/).pop() || '워크플로').replace(/\.json$/i, ''), path: c.workflowPath }];
      }
      setComfyCfg(c); setComfyOpen(true);
    } catch (e) { logline('ComfyUI 설정 읽기 오류: ' + e.message); }
  }
  async function saveComfyCfg(patch) {
    try { const c = await api.setComfyImageConfig(patch); setComfyCfg(c); } catch (e) { logline('ComfyUI 설정 저장 오류: ' + e.message); }
  }
  async function pickComfyWf() {
    try {
      const r = await api.pickComfyWorkflow();
      if (!r || !r.path) return;
      const guess = (r.path.split(/[\\/]/).pop() || '워크플로').replace(/\.json$/i, '');
      const name = (window.prompt('이 워크플로 이름 (예: z-image, Krea2)', guess) || guess).trim();
      const list = Array.isArray(comfyCfg.workflows) ? comfyCfg.workflows.slice() : [];
      const i = list.findIndex((w) => w.path === r.path);
      if (i >= 0) list[i] = { name, path: r.path }; else list.push({ name, path: r.path });
      await saveComfyCfg({ workflows: list, workflowPath: r.path });
    } catch (e) { logline('워크플로 추가 오류: ' + e.message); }
  }
  async function removeComfyWf() {
    const list = (comfyCfg.workflows || []).filter((w) => w.path !== comfyCfg.workflowPath);
    await saveComfyCfg({ workflows: list, workflowPath: list[0] ? list[0].path : '' });
  }
  async function testComfy() {
    setStatus('ComfyUI 연결 확인 중…');
    try { const r = await api.testComfyImage(); setStatus(r && r.ok ? `✓ ComfyUI 연결 OK (${r.baseUrl})` : `✗ ComfyUI 연결 실패${r && r.error ? ': ' + r.error : ''}`); }
    catch (e) { logline('연결 테스트 오류: ' + e.message); }
  }
  async function submitBatch() {
    setStatus('🌙 배치 제출 중…');
    try {
      const r = await api.geminiBatchSubmit({ styleId: styleId || null });
      if (r && r.ok) { setStatus(`🌙 배치 제출 완료 — ${r.count}장 (몇 시간 뒤 📥 회수)`); refreshBatch(); }
      else setStatus('배치 제출 실패: ' + ((r && r.error) || ''));
    } catch (e) { logline('배치 제출 오류: ' + e.message); }
  }
  async function retrieveBatch() {
    setStatus('📥 배치 회수 확인 중…');
    try {
      const r = await api.geminiBatchRetrieve();
      if (!r || !r.ok) { setStatus('배치 회수: ' + ((r && r.error) || '실패')); return; }
      if (!r.done) { setStatus(`⏳ 배치 진행 중 (${r.state}) — 잠시 뒤 다시 회수`); return; }
      if (r.dto) { setDto(r.dto); setFtitle(r.dto.fileTitle || ''); }
      setStatus(`📥 배치 회수 완료 — ${r.saved || 0}장 저장`); refreshBatch();
    } catch (e) { logline('배치 회수 오류: ' + e.message); }
  }
  // 헤더 생성설정 변경 → 현재 활성 큐 항목에 저장(디바운스). 대본별 개별 설정 보존.
  useEffect(() => {
    const aid = queue && queue[mode] ? queue[mode].activeId : null;
    if (!aid) return;
    const t = setTimeout(() => { api.setQueueSettings(currentSettings(), true).catch(() => {}); }, 300); // keepChannel: 채널은 열 때 값 유지(다음 대본용 채널 선택이 이 항목을 오염시키지 않게)
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetName, styleId, ttsSpeed, imgEngine, videoEngine, vidFrom, vidTo, flowVideoModel, flowCount, aiNotice, bgmOn, bgmMood]);

  async function copyLog() {
    try { await navigator.clipboard.writeText(logText || ''); setStatus('로그 복사됨'); }
    catch (e) { logline('복사 실패: ' + e.message); }
  }

  // 롱폼 분할바 — 카드 헤더(TTS 버튼 앞)로 이동. App 상태(splitOpts/changeSplit)를 쓰므로 여기서 만들어 Cards 로 전달.
  const splitBar = isLf ? (
    <span className="splitbar" title="값 변경 시 자동 재분할 (TTS/이미지 초기화됨)">
      <span className="lab">✂ 분할</span>
      <select title="분할 방식 — H3 섹션 / H2 섹션(그 아래 H3 모두 묶음) / 문장 단위" value={splitOpts.mode} onChange={(e) => changeSplit('mode', e.target.value)}><option value="h3">H3</option><option value="h2">H2</option><option value="sentence">문장</option></select>
      {splitOpts.mode === 'sentence' && (<>
        도입부 <input type="number" value={splitOpts.intro} onChange={(e) => changeSplit('intro', e.target.value)} />
        본론 <input type="number" value={splitOpts.main} onChange={(e) => changeSplit('main', e.target.value)} />
      </>)}
      짧은 <input type="number" value={splitOpts.short} onChange={(e) => changeSplit('short', e.target.value)} />
      긴 <input type="number" value={splitOpts.long} onChange={(e) => changeSplit('long', e.target.value)} />
      {splitOpts.mode === 'sentence' && <button className="ghost introvid" disabled={!loaded} title="도입부 문장만 TTS 후 10초 기준으로 도입부 그룹 재배치" onClick={runIntroVideo}>🎬 도입부 TTS+10초 재배치</button>}
    </span>
  ) : null;

  // ── 렌더 ─────────────────────────────────────────────────
  return (
    <>
      {findOpen && (
        <div style={{ position: 'fixed', top: 8, right: 16, zIndex: 9999, display: 'flex', gap: 6, alignItems: 'center', background: 'var(--card, #fff)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', boxShadow: '0 3px 12px rgba(0,0,0,.18)' }}>
          <input id="find-input" value={findText} placeholder="화면에서 검색… (Enter 다음 / Shift+Enter 이전)" style={{ width: 240 }}
            onChange={(e) => runFind(e.target.value, false)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runFind(findText, true, !e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } }} />
          <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 44, textAlign: 'center' }}>{findText ? `${findRes.total ? findRes.active : 0}/${findRes.total}` : ''}</span>
          <button className="ghost" title="이전 (Shift+Enter)" style={{ padding: '2px 8px' }} onClick={() => runFind(findText, true, false)}>▲</button>
          <button className="ghost" title="다음 (Enter)" style={{ padding: '2px 8px' }} onClick={() => runFind(findText, true, true)}>▼</button>
          <button className="ghost" title="닫기 (Esc)" style={{ padding: '2px 8px' }} onClick={closeFind}>✕</button>
        </div>
      )}
      <div className="topsticky">
      <header>
        {/* 상단 행 — 대본·프로젝트 관리 (열기·수정·저장·불러오기·초기화 한 줄로) */}
        <div className="hrow">
          <div className="hleft">
            <h1>🎬 Priming{appVersion ? <span className="ver">v{appVersion}</span> : null}</h1>
            <button className="ghost" title="화면에서 검색 (Ctrl+F) — 대본·문장·곡·원고 등 현재 화면의 글자를 찾아 이동" style={{ padding: '4px 8px' }} onClick={() => { setFindOpen(true); setTimeout(() => { const el = document.getElementById('find-input'); if (el) { el.focus(); el.select(); } }, 30); }}>🔍</button>
            <span className="modetoggle">
              <button className={mode === 'longform' ? 'active' : ''} onClick={() => switchMode('longform')}>롱폼</button>
              <button className={mode === 'shorts' ? 'active' : ''} onClick={() => switchMode('shorts')}>쇼츠</button>
              <button className={mode === 'playlist' ? 'active' : ''} onClick={() => switchMode('playlist')}>🎵 플리</button>
              <button className={mode === 'book' ? 'active' : ''} onClick={() => switchMode('book')}>📖 출판</button>
            </span>
            <select title="채널(프리셋) — 고르면 그 채널의 시작 화면으로 전환" value={presetName} onChange={(e) => switchModeForChannel(e.target.value)}>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <button className="ghost" title="채널(프리셋) 설정 편집" style={{ padding: '6px 9px' }} onClick={openChannelEditor}>⚙</button>
            <button className="ghost" title="새 채널 추가 (현재 채널 설정을 복사해서 시작)" style={{ padding: '6px 9px' }} onClick={addChannel}>＋ 채널</button>
            {!isPl && !isBk && (<>
              <span className="hgroup">
                <span className="glabel">대본</span>
                <button onClick={openScript}>📂 열기</button>
                <button className="ghost" disabled={!loaded} title="대본 내용 수정 → 재파싱(원본 .md 갱신)" onClick={openScriptEdit}>✏ 수정</button>
                <button className="ghost" title="음성·영상 파일을 텍스트로 변환(STT) → 원본과 같은 폴더에 같은 이름 .txt 생성 (OmniVoice Whisper)" onClick={runStt}>🎧 STT</button>
              </span>
              <span className="hgroup">
                <span className="glabel">저장·불러오기</span>
                <button className="ghost" disabled={!loaded} title="현재 대본 작업을 파일로 저장 (saves 폴더에 '작업_제목_날짜.smproj.json'). 자동저장도 항상 켜져 있음" onClick={saveProject}>💾 작업저장</button>
                <button className="ghost" title="저장한 작업 파일 불러오기 (saves 폴더)" onClick={loadProject}>📂 작업열기</button>
                <button className="ghost" title="현재 작업 큐 전체(대본 목록·채널·설정)를 파일로 저장 (saves 폴더에 '큐_날짜.pmqueue.json')" onClick={saveQueueFile}>💾 큐저장</button>
                <button className="ghost" title="저장한 큐를 통째로 불러오기 — 대본 목록 복구 + 각 대본 작업물 이어짐 (saves 폴더)" onClick={loadQueueFile}>📂 큐열기</button>
                <button className="ghost" style={{ color: '#c0392b' }} title="저장 폴더(saves)의 작업·큐 파일을 모두 삭제 (확인 팝업 있음). 진행 중 대본의 자동 이어받기 데이터는 삭제되지 않습니다." onClick={deleteSaves}>🗑 전체삭제</button>
                <button className="ghost" title="새 작업 — 현재 화면 비우기" onClick={resetProject}>🆕 초기화</button>
              </span>
            </>)}
            {isPl && <button onClick={openPlaylist}>🎵 플리 스펙 열기</button>}
            {isPl && <button className="ghost" title="새 작업 — 현재 화면 비우기" onClick={resetProject}>🆕 초기화</button>}
            {isBk && (<>
              <button onClick={openBook}>📖 원고 열기</button>
              <button className="ghost" title="원고를 어떻게 작성하는지 규약 설명이 담긴 샘플 .md 저장 — 복사해서 내용만 바꾸면 바로 책이 됩니다" onClick={async () => { try { const r = await api.bookSaveGuide(); if (r) setStatus('가이드 저장: ' + r.path); } catch (e) { logline(e.message); } }}>📄 작성 가이드</button>
              <button className="ghost" disabled={!loaded} title="원고 내용 수정 → 재파싱(원본 .md 갱신)" onClick={openScriptEdit}>✏ 수정</button>
              <button className="ghost" title="새 작업 — 현재 화면 비우기" onClick={resetProject}>🆕 초기화</button>
            </>)}
            {loaded && (
              <span className="autosave-ind" title="작업은 자동으로 수시 저장됩니다. 같은 대본을 다시 열면 이어서 작업할 수 있어요.">
                {autoSavedAt ? `✓ 자동저장 ${new Date(autoSavedAt).toLocaleTimeString()}` : '자동저장 켜짐'}
              </span>
            )}
            {gsCool && gsCool.until > 0 && (
              <span title={`Genspark 이미지가 5시간 한도에 도달했습니다. ${gsCool.label} 이후 자동으로 다시 시도합니다. 그 전까지는 Genspark 에 접속하지 않고 Flow 등 다른 엔진으로 생성합니다. 앱을 껐다 켜도 이 시각은 유지됩니다.`}
                style={{ marginLeft: 8, padding: '3px 9px', borderRadius: 6, background: '#fde8e8', color: '#a3352b', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                ⏸ Genspark 재설정 {gsCool.label}
              </span>
            )}
            {grokCool && grokCool.until > 0 && (
              <span title={`Grok 영상이 한도에 도달했습니다. ${grokCool.label} 이후 재설정됩니다. 그 전까지는 영상 생성을 건너뛰고 이미지만 만듭니다(헛되이 브라우저를 띄우지 않음). 앱을 껐다 켜도 이 시각은 유지됩니다.`}
                style={{ marginLeft: 8, padding: '3px 9px', borderRadius: 6, background: '#e8eefd', color: '#2b45a3', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                ⏸ Grok 재설정 {grokCool.label}
              </span>
            )}
          </div>
        </div>
        {/* 제작 파이프라인 행 — 작업 순서대로 ①음성 → ②이미지 → ③비디오 → ④완성 그룹 */}
        {!isPl && !isBk && (
        <div className="hrow" style={{ justifyContent: 'flex-start' }}>
          <span className="hgroup">
            <span className="glabel">① 음성</span>
            <span title="음성 배속 (합성 1.0 → atempo 변환)">배속 <input type="number" value={ttsSpeed} step="0.05" min="0.5" max="2" style={{ width: 52 }} onChange={(e) => setTtsSpeed(e.target.value)} /></span>
            <button disabled={!loaded} title="대본 전체 음성 합성 (이미 있는 문장은 건너뜀)" onClick={() => runTts(null)}>🎤 TTS</button>
            <button className="ghost" disabled={!loaded} title="이미 만든 음성 파일·재활용 캐시를 삭제하고 화면의 시간기록도 지웁니다 (다음 변환은 전부 새로 합성)" onClick={deleteTtsAll}>🗑 삭제</button>
            <button className="ghost" title="발음사전 — TTS가 잘못 읽는 단어를 발음대로 교정(자막은 대본 그대로)" onClick={openDict}>📖 발음사전</button>
          </span>
          <span className="hgroup">
            <span className="glabel">② 이미지</span>
            <button className="ghost" disabled={!loaded || impBusy} title="각 그룹 내용을 분석해 이미지 프롬프트를 자동 작성·적용 (Ollama)" onClick={runMakePrompts}>{impBusy ? '⏳ 작성중…' : '✍ 프롬프트'}</button>
            <button className="ghost" disabled={!loaded} title="Ollama 서버·모델 설정 / 웹 LLM 답변 붙여넣기(고급)" onClick={openOllama}>⚙</button>
            <select title="이미지 스타일" value={styleId} onChange={(e) => setStyleId(e.target.value)}>
              <option value="">스타일 없음</option>
              {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="ghost" title="이미지 스타일 편집(추가·수정·삭제·프롬프트 복사)" onClick={() => setStyleEditOpen(true)}>✎</button>
            <select title="이미지 생성 방식 — 순환(무료 브라우저) / 유료(나노바나나2 API) / ComfyUI(z-image 로컬·클라우드)" value={imgEngine} onChange={(e) => setImgEngine(e.target.value)}>
              <option value="rotate">순환(무료)</option>
              <option value="gemini">유료(나노바나나2)</option>
              <option value="comfy">ComfyUI(z-image)</option>
            </select>
            <button className="ghost" title="이미지 순환 순서·계정 · 나노바나나 키/모델 설정" onClick={openImgRotation}>⚙</button>
            {imgEngine === 'comfy' && <button className="ghost" title="ComfyUI 설정 — 로컬/클라우드 주소·API키·z-image 워크플로" onClick={openComfy}>⚙ ComfyUI</button>}
            <button disabled={!loaded} title="프롬프트 있는 그룹의 이미지 생성 (이미 있는 그룹은 건너뜀)" onClick={() => runImg(null)}>🖼 이미지</button>
            {imgEngine === 'gemini' && (<>
              <button className="ghost" disabled={!loaded} title="나노바나나2 Lite 배치 제출 — 표준가의 50%로 이미지 생성을 예약합니다. 결과는 몇 시간 뒤(최대 24h)에 나오며 「📥 배치회수」로 가져옵니다. 앱을 껐다 켜도 유지됩니다." onClick={submitBatch}>🌙 배치제출</button>
              <button className="ghost" disabled={!loaded} title="제출한 배치 결과를 회수합니다. 완료됐으면 이미지를 가져와 매핑, 아직이면 진행 상태를 알려줍니다." onClick={retrieveBatch}>📥 배치회수{gsBatch && gsBatch.hasJob ? ' ●' : ''}</button>
            </>)}
          </span>
          <span className="hgroup">
            <span className="glabel">③ 비디오</span>
            <select title="i2v 비디오 엔진" value={videoEngine} onChange={(e) => setVideoEngine(e.target.value)}>
              <option value="grok">Grok</option><option value="none">없음 (이미지만)</option>
            </select>
            {videoEngine === 'grok' && <button className="ghost" title="Grok(X) 멀티계정 등록·로그인·한도" onClick={openGrokAcc}>⚙ 계정</button>}
            {videoEngine === 'none'
              ? <span className="meta" title="비디오 없이 이미지만으로 .vrew 생성 (켄번스)">이미지만(켄번스)</span>
              : (<>
                  <span title="영상으로 만들 그룹 범위 (N번~N번). 롱폼 기본=도입부 그룹만">범위 <input type="number" min="1" style={{ width: 44 }} value={vidFrom} onChange={(e) => setVidFrom(e.target.value)} />~<input type="number" min="1" style={{ width: 44 }} value={vidTo} onChange={(e) => setVidTo(e.target.value)} /></span>
                  <button disabled={!loaded} title={`G${vidFrom}~G${vidTo} 그룹을 i2v 비디오로 변환 (이미지 있는 것만)`} onClick={() => runVid(null)}>🎬 비디오</button>
                </>)}
          </span>
          <span className="hgroup" style={{ marginLeft: 'auto' }}>
            <span className="glabel">④ 완성</span>
            <button className="ghost" disabled={!loaded} title="모든 편을 이어서 미리보기 재생" onClick={() => playShorts(null)}>▶ 미리보기</button>
            {(() => { const qc = (queue && queue.longform ? queue.longform.items.length : 0) + (queue && queue.shorts ? queue.shorts.items.length : 0); return (<>
              <button className="cta" disabled={qc < 1} title={qc > 1 ? `큐 ${qc}개 대본을 교차 순서(롱1→쇼1→롱2→쇼2…)로 순차 제작` : '현재 대본 TTS+이미지 → 영상 → .vrew → 폴더열기'} onClick={runMakeOrBatch}>⚡ 만들기{qc > 1 ? ` (${qc})` : ''}</button>
              {qc > 1 && <label className="chk" title="체크: 대본이 완료될 때마다 그 .vrew 를 순차적으로 자동 열기(단건과 동일). 해제: 창 폭주 방지를 위해 열지 않고 큐가 끝나면 출력폴더만 1번 열기" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={openEachVrew} onChange={(e) => setOpenEachVrew(e.target.checked)} />순차 열기</label>}
            </>); })()}
            <button className="ghost stop" title="진행 중인 작업 중단" onClick={abort}>■ 중단</button>
            <button disabled={!loaded} title=".vrew 만 다시 내보내기 (이미 만든 음성·이미지 사용)" onClick={() => runVrew(null)}>💾 .vrew</button>
            <button className="ghost" disabled={!loaded} onClick={() => api.openFolder()}>📁 출력폴더</button>
          </span>
        </div>
        )}
        {isPl && (
        <div className="hrow">
          <div className="hright">
            <span className="meta" style={{ marginRight: 'auto' }}>{dto && dto.kind === 'playlist' ? `${dto.tracks.length}곡` : '플리 스펙(.md)을 여세요 — 클로드가 채팅에서 만들어 줍니다'}</span>
            <span className="hgroup">
              <span className="glabel">배경</span>
              <select title="배경 이미지 생성 방식" value={imgEngine} onChange={(e) => setImgEngine(e.target.value)}>
                <option value="rotate">이미지: 순환(무료)</option>
                <option value="gemini">이미지: 유료(나노바나나2)</option>
                <option value="comfy">이미지: ComfyUI(z-image)</option>
              </select>
              <select title="배경 영상 — Grok 심리스 반복 영상 또는 이미지 고정" value={videoEngine} onChange={(e) => setVideoEngine(e.target.value)}>
                <option value="grok">영상: Grok(심리스)</option>
                <option value="none">영상: 없음(이미지 고정)</option>
              </select>
              <button className="ghost" title="이미지 순환 순서·계정 · 나노바나나 키/모델 설정" onClick={openImgRotation}>⚙</button>
            </span>
            <span className="hgroup">
              <span className="glabel">완성</span>
              <button className="cta" disabled={!(dto && dto.kind === 'playlist' && dto.tracks.length)} title="음악(ACE-Step) + 배경(이미지→심리스 반복 영상) + 곡 제목 자막 → .vrew 까지 한 번에. Vrew 에서 마무리·내보내기" onClick={runMakePlaylistVideo}>🎬 만들기</button>
              <button className="ghost stop" title="진행 중인 생성 중단" onClick={abort}>■ 중단</button>
              <button className="ghost" disabled={!(dto && dto.kind === 'playlist')} onClick={() => api.openFolder()}>📁 출력폴더</button>
            </span>
          </div>
        </div>
        )}
      </header>

      {/* 분할/합치기 바 — 스크롤 내려도 항상 보이도록 topsticky(고정) 안. (플리·출판 모드 제외) */}
      {!isPl && !isBk && <div id="capbar">
        <span className="grow" />
        {splitBar}
        {!isLf && <button className="ghost" title="TTS 후 캡 미만 그룹들을 한 그룹으로 합치기" onClick={mergeGroups}>🔗 합치기</button>}
        <label className="chk" title="AI 고지 자막 — 체크 시 .vrew 에 삽입. 기본값: 롱폼 표시 · 쇼츠 미표시 (언제든 변경 가능)" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={aiNotice} onChange={(e) => setAiNotice(e.target.checked)} />AI 고지</label>
        <label className="chk" title="배경음(BGM, ACE-Step) — 체크 시 ⚡만들기에서 대본 분위기에 맞는 음악을 생성해 나레이션 아래 낮은 볼륨으로 .vrew 에 삽입" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={bgmOn} onChange={(e) => setBgmOn(e.target.checked)} />🎵 BGM</label>
        {bgmOn && <input type="text" value={bgmMood} onChange={(e) => setBgmMood(e.target.value)} placeholder="무드(빈값=대본 자동)" title="ACE-Step 스타일 태그. 비우면 대본 분석으로 자동 생성. 예: calm, cinematic, ambient piano, instrumental" style={{ width: 180 }} />}
        <span className="hdiv" />
        <span className="worktimes" title="진행률(완료/전체) · 괄호=마지막 작업 소요시간">
          ⏱ TTS {prog.ttsD}/{prog.ttsT} ({fmtSec(timings.tts)}) · 이미지 {prog.imgD}/{prog.imgT} ({fmtSec(timings.image)}) · 영상 {prog.vidD}/{prog.vidT} ({fmtSec(timings.video)}) · <b>합계 {fmtSec(timings.tts + timings.image + timings.video)}</b>
          {timings.make > 0 && <> · ⚡전체 {fmtSec(timings.make)}</>}
        </span>
      </div>}
      </div>

      <div id="body">
        <main>
          {isPl ? (
            <PlaylistView dto={dto} onMakeOne={(num) => runMakePlaylist(num)}
              onPreview={(src) => setPreview({ kind: 'audio', src })}
              onPreviewMedia={(kind, src) => setPreview({ kind, src })}
              onAttachBg={attachPlBg} onClearBg={clearPlBg} />
          ) : isBk ? (
            <BookView dto={dto} setDto={setDto} setStatus={setStatus} logline={logline} />
          ) : (<>
          {queue && queue[mode] && queue[mode].items.length > 0 && (
            <div className="qstrip">
              <span className="qlabel">{isLf ? '롱폼' : '쇼츠'} 큐 ({queue[mode].items.length})</span>
              {queue[mode].items.map((it) => (
                <div key={it.id}
                  className={'qchip' + (it.active ? ' active' : '') + (it.status && it.status !== 'idle' ? ' s-' + it.status : '')}
                  title={it.file || it.title}
                  onClick={() => { if (!it.active) selectQueueItem(it.id); }}>
                  <span className="qttl">{it.title}</span>
                  <span className="qmeta">{it.projects}편{it.status && it.status !== 'idle' ? ' · ' + (QSTATUS[it.status] || it.status) : ''}</span>
                  <button className="qx" title="큐에서 제거" onClick={(e) => { e.stopPropagation(); removeQueueItem(it.id); }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <Cards dto={dto} isLf={isLf} capCharsN={effCap} bgmOn={bgmOn}
            onTts={runTts} onImg={runImg} onVid={runVid} onBulk={runBulk}
            onPlayShorts={playShorts} onPlayGroup={playGroup} onRegen={runRegen}
            onMake={runMake} onVrew={runVrew} onPremiere={runPremiere} onAttach={attachAsset} onClear={clearAsset}
            onTitleField={updateTitleField} onPreview={(kind, src) => setPreview({ kind, src })}
            onPlayFrom={playFrom} onGroupTts={runGroupTts} onGroupVid={runGroupVid} onShowPrompt={showPrompt} onSplit={splitGroup} />
          </>)}
        </main>
        <aside id="logwrap" className={logCollapsed ? 'collapsed' : ''}>
          <div id="logbar" onClick={(e) => { if (e.target.tagName === 'BUTTON') return; setLogCollapsed((v) => !v); }}>
            <b>로그</b> <span id="status">{status ? '· ' + status : ''}</span>
            <button className="ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={copyLog}>📋 복사</button>
            <button className="ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setLogText('')}>지우기</button>
          </div>
          <div id="log" ref={logRef}>{logText}</div>
        </aside>
      </div>

      {preview && (
        <div id="preview" className="show" onClick={(e) => { if (e.target.classList.contains('close')) setPreview(null); }}>
          <button className="close">✕</button>
          <div id="previewBody">
            {preview.kind === 'vid'
              ? <video src={preview.src} controls autoPlay loop />
              : preview.kind === 'audio'
                ? <audio src={preview.src} controls autoPlay style={{ width: 480 }} />
                : <img src={preview.src} alt="" />}
          </div>
        </div>
      )}

      <div id="player" className={playerOpen ? 'show' : ''}>
        <div id="stage" className={isLf ? 'lf' : ''}>
          <div id="stageVisual" ref={stageVisualRef} />
          <div id="stageTitle" ref={stageTitleRef} />
          <div id="stageCap" ref={stageCapRef} />
        </div>
        <div id="playerBar"><span id="playerInfo" ref={playerInfoRef} /><button className="ghost" onClick={stopPlayer}>■ 닫기</button></div>
      </div>

      {newChanOpen && (
        <div className="modal-bg show">
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <h3>＋ 새 채널 추가</h3>
            <div className="meta" style={{ marginBottom: 8 }}>현재 채널 <b>「{presetName || '-'}」</b>의 설정을 복사해 새 채널을 만듭니다. 만든 뒤 편집창에서 세부 설정을 바꾸세요.</div>
            <input autoFocus placeholder="새 채널 이름" style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px' }}
              value={newChanName} onChange={(e) => setNewChanName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createChannel(); }} />
            <div className="mbtns"><button onClick={createChannel}>만들기</button><button className="ghost" onClick={() => setNewChanOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {chOpen && ch && (
        <div className="modal-bg show">
          <div className="modal-card wide">
            <h3>⚙ 채널(프리셋) 편집 — {ch.name}</h3>
            <div className="frow"><label>시작 화면</label>
              <select style={{ flex: '0 0 220px', padding: 6 }} value={ch.startMode || 'longform'} onChange={(e) => setCh({ ...ch, startMode: e.target.value })}>
                <option value="longform">롱폼 (16:9)</option>
                <option value="shorts">쇼츠 (9:16)</option>
                <option value="playlist">🎵 플리 (음악)</option>
                <option value="book">📖 출판</option>
              </select>
              <span className="meta">이 채널을 고르면 이 화면으로 시작합니다 (음성 엔진은 OmniVoice 기본)</span>
            </div>
            {ch.engine === 'supertonic' ? (
              /* Supertonic — 사전 정의 음성만 선택(참조음성·복제·시드·Clone강도 미적용) */
              <div className="frow"><label>목소리</label>
                <select style={{ flex: '0 0 220px', padding: 6 }} value={/^[MF][1-5]$/.test(ch.voice) ? ch.voice : 'M1'} onChange={(e) => setCh({ ...ch, voice: e.target.value })}>
                  {['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].map((v) => <option key={v} value={v}>{(/^M/.test(v) ? '♂ 남성 ' : '♀ 여성 ') + v} (Supertonic-3)</option>)}
                </select>
                <button className="ghost" style={{ flex: '0 0 auto' }} title="이 목소리 미리듣기 (짧은 샘플 합성)" onClick={previewSupertonicVoice}>▶</button>
                <span className="mini">언어</span><select value={ch.language} onChange={(e) => setCh({ ...ch, language: e.target.value })}><option value="ko">한국어</option><option value="en">English</option></select>
                <span className="mini">문장무음</span><input className="nbox" type="number" step="0.1" style={{ width: 66 }} value={ch.silenceSec} onChange={(e) => setCh({ ...ch, silenceSec: e.target.value })} /><span className="meta">초 · CPU 로컬</span></div>
            ) : (
              <>
                <div className="frow"><label>목소리</label><input readOnly title="참조음성 파일명" value={(ch.voiceCloneRefAudio || '').split(/[\\/]/).pop() || ch.voice} style={{ flex: '0 0 170px' }} />
                  <span className="mini">언어</span><select value={ch.language} onChange={(e) => setCh({ ...ch, language: e.target.value })}><option value="ko">한국어</option><option value="en">English</option></select>
                  <span className="mini">시드</span><input className="nbox" type="number" style={{ width: 90, flex: '0 0 auto' }} value={ch.seed} onChange={(e) => setCh({ ...ch, seed: e.target.value })} /></div>
                <div className="frow"><label>참조음성</label>
                  <select style={{ flex: 1, padding: 6 }} value={ch.voiceCloneRefAudio} onChange={(e) => setCh({ ...ch, voiceCloneRefAudio: e.target.value })}>
                    {chRefList.every((r) => r.path !== ch.voiceCloneRefAudio) && ch.voiceCloneRefAudio ? <option value={ch.voiceCloneRefAudio}>{(ch.voiceCloneRefAudio || '').split(/[\\/]/).pop()}</option> : null}
                    {chRefList.map((r) => <option key={r.path} value={r.path}>{r.name}</option>)}
                  </select>
                  <button className="ghost" style={{ flex: '0 0 auto' }} title="미리듣기" onClick={() => playRef(ch.voiceCloneRefAudio)}>▶</button>
                  <button className="ghost" style={{ flex: '0 0 auto' }} title="참조음성 폴더 열기 (같은 이름의 .txt 가 참조텍스트로 쓰입니다)" onClick={() => api.openRefFolder(ch.voiceCloneRefAudio || '')}>찾기</button>
                  <button className="ghost" style={{ flex: '0 0 auto' }} title="텍스트 설명으로 새 목소리 만들기 (Qwen3-TTS 보이스디자인)" onClick={openVoiceDesign}>🎨 디자인</button></div>
              </>
            )}
            <div className="frow"><label>사전설정</label><textarea rows="2" placeholder="예: 30대 한국 남성, 회색 양복, 따뜻한 조명 (모든 이미지 공통)" value={ch.presetPrompt} onChange={(e) => setCh({ ...ch, presetPrompt: e.target.value })} /></div>
            {ch.engine !== 'supertonic' && (
              <div className="frow"><label>Clone강도</label><input className="nbox" type="number" step="0.1" value={ch.cfgValue} onChange={(e) => setCh({ ...ch, cfgValue: e.target.value })} />
                <span className="mini">문장무음</span><input className="nbox" type="number" step="0.1" value={ch.silenceSec} onChange={(e) => setCh({ ...ch, silenceSec: e.target.value })} /><span className="meta">초</span></div>
            )}

            <div className="subhead">📝 본문 자막 (롱폼 / 쇼츠)</div>
            <div className="twocol">{capColumn('capLong', '롱폼 16:9', true)}{capColumn('capShort', '쇼츠 9:16', false)}</div>

            <div className="subhead">🔊 음성 배속 · 🎨 이미지 스타일</div>
            <div className="twocol">
              <div className="col"><h4>롱폼 16:9</h4>
                <div className="crow tri"><span className="l">배속</span><input className="n" style={{ flex: '0 0 62px', width: 62 }} type="number" step="0.05" min="0.5" max="2" value={ch.speedLong} onChange={(e) => setCh({ ...ch, speedLong: e.target.value })} />
                  <span className="l">스타일</span><select value={ch.styleLong} onChange={(e) => setCh({ ...ch, styleLong: e.target.value })}>{chStyles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              </div>
              <div className="col"><h4>쇼츠 9:16</h4>
                <div className="crow tri"><span className="l">배속</span><input className="n" style={{ flex: '0 0 62px', width: 62 }} type="number" step="0.05" min="0.5" max="2" value={ch.speedShort} onChange={(e) => setCh({ ...ch, speedShort: e.target.value })} />
                  <span className="l">스타일</span><select value={ch.styleShort} onChange={(e) => setCh({ ...ch, styleShort: e.target.value })}>{chStyles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              </div>
            </div>

            <div className="subhead">📁 폴더 · 기타</div>
            <div className="frow"><label>대본 폴더</label><input placeholder="롱폼·쇼츠 공유" value={ch.scriptFolder} onChange={(e) => setCh({ ...ch, scriptFolder: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={pickScript}>찾기</button></div>
            <div className="frow"><label>롱폼 출력</label><input placeholder="롱폼 .vrew 출력 폴더" value={ch.outLong} onChange={(e) => setCh({ ...ch, outLong: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={pickOutLong}>찾기</button></div>
            <div className="frow"><label>쇼츠 출력</label><input placeholder="쇼츠 .vrew 출력 폴더" value={ch.outShort} onChange={(e) => setCh({ ...ch, outShort: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={pickOutShort}>찾기</button></div>
            <div className="frow chk"><label>AI 고지</label><input type="checkbox" style={{ flex: '0 0 auto', width: 'auto' }} checked={ch.aiNotice} onChange={(e) => setCh({ ...ch, aiNotice: e.target.checked })} /> <span className="meta">실제 표시는 작업바의 <b>'AI 고지'</b> 토글로 결정 — 기본값 <b>롱폼 표시 · 쇼츠 미표시</b> (언제든 변경)</span></div>
            <div className="mbtns"><button onClick={saveChannel}>저장</button><button className="ghost" title="이 채널 삭제" style={{ color: '#c0392b' }} onClick={deleteChannel}>🗑 채널 삭제</button><span style={{ flex: 1 }} /><button className="ghost" onClick={() => setChOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {styleEditOpen && (
        <div className="modal-bg show">
          <div className="modal-card wide" style={{ maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
            <h3>🎨 이미지 스타일 편집</h3>
            <div className="meta" style={{ marginBottom: 8 }}>기본 스타일은 <b>읽기전용</b>(프롬프트 복사만 가능). 사용자 스타일은 이름·프롬프트 수정·삭제·순서변경 가능. 최종 이미지 프롬프트 = <b>선택한 스타일 + 대본 프롬프트</b>.</div>
            <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>
              {styles.map((s, i) => (
                <StyleRow key={s.id} s={s} index={i} total={styles.length}
                  onCopy={copyStylePrompt} onSave={saveStyle} onDelete={deleteStyle} onMove={moveStyle} />
              ))}
            </div>
            <div style={{ borderTop: '1px solid var(--border,#ddd)', paddingTop: 8, marginTop: 4 }}>
              <div className="subhead">➕ 새 스타일 추가</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input style={{ flex: '0 0 180px' }} placeholder="이름 (예: 나만의 수묵화)" value={newStyle.name} onChange={(e) => setNewStyle({ ...newStyle, name: e.target.value })} />
                <input style={{ flex: 1 }} placeholder="영문 스타일 프롬프트" value={newStyle.prompt} onChange={(e) => setNewStyle({ ...newStyle, prompt: e.target.value })} />
                <button onClick={addStyle}>추가</button>
              </div>
            </div>
            <div className="mbtns"><button className="ghost" onClick={() => setStyleEditOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}
      {dictOpen && (
        <div className="modal-bg show">
          <div className="modal-card wide" style={{ maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
            <h3>📖 발음사전 (TTS 교정)</h3>
            <div className="meta" style={{ marginBottom: 8 }}>TTS가 잘못 읽는 단어를 <b>발음대로</b> 교정합니다. <b>자막·대본은 그대로</b>이고 <b>음성 합성에만</b> 적용됩니다.
              예) 대본표기 <b>정약용</b> → 발음표기 <b>정냐굥</b> 으로 등록하면, 자막엔 "정약용"이 뜨고 음성만 "정냐굥"으로 읽습니다.</div>
            <div style={{ display: 'flex', gap: 6, fontSize: 12, fontWeight: 600, padding: '0 4px 4px' }}>
              <span style={{ flex: '0 0 30px' }}>사용</span><span style={{ flex: 1 }}>대본 표기 (자막에 나오는 말)</span><span style={{ flex: 1 }}>발음 표기 (TTS가 읽을 말)</span><span style={{ flex: '0 0 30px' }} />
            </div>
            <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>
              {dictRows.length === 0 && <div className="meta" style={{ padding: 8 }}>등록된 단어가 없습니다. 아래 「＋ 추가」로 시작하세요.</div>}
              {dictRows.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <input type="checkbox" style={{ flex: '0 0 30px', width: 'auto' }} checked={r.enabled !== false} onChange={(e) => setDictRow(i, { enabled: e.target.checked })} title="이 교정 사용/해제" />
                  <input style={{ flex: 1 }} placeholder="예: 정약용" value={r.source || ''} onChange={(e) => setDictRow(i, { source: e.target.value })} />
                  <span>→</span>
                  <input style={{ flex: 1 }} placeholder="예: 정냐굥" value={r.pron || ''} onChange={(e) => setDictRow(i, { pron: e.target.value })} />
                  <button className="ghost" title="삭제" style={{ flex: '0 0 auto' }} onClick={() => delDictRow(i)}>🗑</button>
                </div>
              ))}
            </div>
            <div style={{ borderTop: '1px solid var(--border,#ddd)', paddingTop: 8, marginTop: 4 }}>
              <button className="ghost" onClick={addDictRow}>＋ 추가</button>
              <span className="meta" style={{ marginLeft: 8 }}>저장 후 <b>TTS를 다시 변환</b>해야 반영됩니다.</span>
            </div>
            <div className="mbtns"><button onClick={saveDict}>저장</button><button className="ghost" onClick={() => setDictOpen(false)}>취소</button></div>
          </div>
        </div>
      )}
      {vdOpen && (
        <div className="modal-bg show">
          <div className="modal-card wide">
            <h3>🎨 보이스디자인 — 텍스트 설명으로 새 목소리</h3>
            <p className="meta" style={{ margin: '0 0 12px' }}>목소리를 글로 설명 → <b>생성</b>해서 들어보고 → 마음에 들면 <b>파일명을 입력해 저장</b>하면 참조음성 목록에 추가돼 어느 채널에서든 쓸 수 있습니다. (창을 닫으면 디자인 서버는 자동으로 꺼집니다)</p>
            <div className="frow" style={{ alignItems: 'flex-start' }}><label>목소리 설명</label>
              <textarea rows="3" placeholder="예: 60대 한국인 남성 내레이터. 중저음이고 차분하며 신뢰감 있는 목소리. 역사 다큐멘터리 톤." value={vdInstruct} onChange={(e) => setVdInstruct(e.target.value)} /></div>
            <div className="frow" style={{ alignItems: 'flex-start' }}><label title="자유롭게 바꿀 수 있습니다. 이 문장이 그대로 저장되는 .txt(참조텍스트)가 됩니다">미리들을 문장</label>
              <textarea rows="2" placeholder="이 문장을 그 목소리로 읽어 미리듣기 합니다 (자유 수정 가능)" value={vdText} onChange={(e) => setVdText(e.target.value)} /></div>
            <div className="frow"><label></label>
              <button onClick={vdGenerate} disabled={vdBusy}>🎨 목소리 생성</button>
              {vdWavUrl ? <button className="ghost" onClick={() => playPreviewUrl(vdWavUrl)}>▶ 다시 듣기</button> : null}
              <button className="ghost" style={{ marginLeft: 'auto' }} title="참조음성이 저장되는 폴더 열기" onClick={() => api.openRefFolder('')}>📂 참조음성 폴더</button>
            </div>
            {vdWavUrl ? <div className="frow"><label></label><audio controls src={vdWavUrl} style={{ flex: 1 }} /></div> : null}
            {vdGenerated ? (
              <div className="frow"><label>파일명</label>
                <input placeholder="예: 고전서재_내레이터" value={vdFilename} onChange={(e) => setVdFilename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') vdSave(); }} style={{ flex: 1 }} />
                <button onClick={vdSave} disabled={vdBusy} title="이 목소리를 참조음성 목록에 추가 (.wav + 같은이름.txt 생성)">💾 저장</button>
              </div>
            ) : null}
            <div className="meta" style={{ minHeight: 22, whiteSpace: 'pre-wrap', color: vdStatus.startsWith('⚠') ? '#c0392b' : undefined }}>{vdBusy ? '⏳ ' : ''}{vdStatus}</div>
            <div className="mbtns"><button className="ghost" onClick={closeVoiceDesign}>닫기</button></div>
          </div>
        </div>
      )}
      {ollamaOpen && ollama && (
        <div className="modal-bg show">
          <div className="modal-card">
            <h3>⚙ Ollama LLM 설정 (프롬프트 자동작성)</h3>
            <div className="meta" style={{ marginBottom: 8 }}>GPU PC 의 Ollama 로 그룹 내용에 맞는 이미지 프롬프트를 <b>무료·자동</b> 생성합니다. 다른 PC/외부에선 <b>서버 주소</b>만 GPU PC 의 LAN/Tailscale IP 로 바꾸세요.</div>
            <div className="frow"><label>서버 주소</label><input placeholder="http://127.0.0.1:11434" value={ollama.baseUrl || ''} onChange={(e) => setOllama({ ...ollama, baseUrl: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={testOllamaConn}>연결테스트</button></div>
            <div className="frow"><label>모델</label>
              <input placeholder="gemma4:latest" value={ollama.model || ''} onChange={(e) => setOllama({ ...ollama, model: e.target.value })} list="ollama-models" />
              <datalist id="ollama-models">{ollamaModels.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            {ollamaModels.length > 0 && <div className="meta">설치된 모델: {ollamaModels.join(', ')}</div>}
            <div className="meta">💡 RTX3060(12GB): <b>gemma4:latest</b>(e4b ≈9.6GB) 권장 — VRAM에 다 올라가 빠름. <b>gemma4:26b</b>(17GB)는 오프로딩되어 느립니다.</div>
            <div className="frow" style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 8 }}>
              <span className="meta" style={{ flex: 1 }}>고급: Ollama 대신 웹 LLM(claude.ai 등) 답변을 직접 붙여넣어 적용</span>
              <button className="ghost" style={{ flex: '0 0 auto' }} disabled={!loaded} onClick={() => { setOllamaOpen(false); setImpText(''); setImpOpen(true); }}>📥 직접 붙여넣기</button>
            </div>
            <div className="mbtns"><button onClick={saveOllama}>저장</button><button className="ghost" onClick={() => setOllamaOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {flowAccOpen && flowAcc && (
        <div className="modal-bg show">
          <div className="modal-card">
            <h3>⚙ Flow 멀티계정</h3>
            <div className="meta" style={{ marginBottom: 8 }}>계정마다 <b>🔑 로그인</b>으로 한 번씩 로그인하세요(쿠키 저장). 생성 시 <b>오늘 한도 안 찬 계정</b>부터 사용하고, 한도에 도달하면 다음 계정으로 넘어갑니다.</div>
            <div className="frow"><label>일일 한도</label><input className="n" type="number" style={{ width: 70 }} value={flowAcc.dailyCap} onChange={(e) => changeFlowCap(e.target.value)} /><span className="meta">계정당 하루 생성 상한 (사람 같은 보수적 사용 권장)</span></div>
            <div style={{ margin: '8px 0' }}>
              {flowAcc.accounts.map((a) => (
                <div key={a.id} className="frow" style={{ alignItems: 'center' }}>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input defaultValue={a.label} onBlur={(e) => renameFlowAcc(a.id, e.target.value)} title="이름 수정 후 다른 곳 클릭" style={{ flex: '0 0 120px', fontWeight: 700 }} />
                    <span className="meta">(오늘 {a.used}/{flowAcc.dailyCap})</span>
                  </span>
                  <button className="ghost" style={{ flex: '0 0 auto' }} onClick={() => flowLogin(a.id)}>🔑 로그인</button>
                  {a.id !== 'default' && <button className="ghost" style={{ flex: '0 0 auto' }} title="계정 삭제" onClick={() => removeFlowAcc(a.id)}>✕</button>}
                </div>
              ))}
            </div>
            <div className="meta">⚠ 여러 계정으로 한도를 우회하는 것은 Flow 약관 위반·정지 위험이 있습니다. 계정당 보수적으로 사용하세요.</div>
            <div className="mbtns"><button onClick={addFlowAcc}>+ 계정 추가</button><button className="ghost" onClick={() => setFlowAccOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {comfyOpen && comfyCfg && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setComfyOpen(false); }}>
          <div className="modal-card">
            <h3>⚙ ComfyUI 이미지 (z-image · Krea2 등 · 로컬/클라우드)</h3>
            <div className="meta" style={{ marginBottom: 8 }}>ComfyUI 에서 워크플로를 <b>「저장(API 포맷)」</b>한 JSON 을 <b>＋추가</b>로 여러 개 등록하고, 드롭다운으로 골라 쓰세요(z-image·Krea2 등). 헤더 이미지 방식을 <b>ComfyUI(z-image)</b>로 고르면 선택된 워크플로로 이미지를 만듭니다.</div>
            <div className="frow"><label>주소</label>
              <input style={{ flex: 1 }} value={comfyCfg.baseUrl || ''} placeholder="http://127.0.0.1:8188"
                onChange={(e) => setComfyCfg({ ...comfyCfg, baseUrl: e.target.value })} onBlur={() => saveComfyCfg({ baseUrl: (comfyCfg.baseUrl || '').trim() })} /></div>
            <div className="frow">
              <label className="chk" style={{ display: 'flex', gap: 4, alignItems: 'center', width: 'auto' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!comfyCfg.cloud} onChange={(e) => { const v = e.target.checked; setComfyCfg({ ...comfyCfg, cloud: v }); saveComfyCfg({ cloud: v }); }} /> 클라우드(comfy.org)
              </label>
              {comfyCfg.cloud && <input type="password" style={{ flex: 1 }} placeholder="🔑 X-API-Key (Standard+ 구독)" value={comfyCfg.apiKey || ''}
                onChange={(e) => setComfyCfg({ ...comfyCfg, apiKey: e.target.value })} onBlur={() => saveComfyCfg({ apiKey: (comfyCfg.apiKey || '').trim() })} />}
            </div>
            <div className="frow"><label>워크플로</label>
              <select style={{ flex: 1 }} value={comfyCfg.workflowPath || ''} title={comfyCfg.workflowPath || ''} onChange={(e) => saveComfyCfg({ workflowPath: e.target.value })}>
                {(!comfyCfg.workflows || !comfyCfg.workflows.length) && <option value="">— 없음 (＋추가로 z-image·Krea2 등록) —</option>}
                {(comfyCfg.workflows || []).map((w) => <option key={w.path} value={w.path}>{w.name}</option>)}
              </select>
              <button className="ghost" title="ComfyUI '저장(API 포맷)' JSON 추가 (이름 지정)" onClick={pickComfyWf}>＋ 추가</button>
              <button className="ghost" title="선택된 워크플로를 목록에서 제거" disabled={!comfyCfg.workflowPath} onClick={removeComfyWf}>🗑</button></div>
            <div className="frow"><label>프롬프트 노드</label>
              <input style={{ flex: 1 }} value={comfyCfg.promptNodeId || ''} placeholder="빈값=자동(CLIPTextEncode). 프롬프트가 안 들어가면 노드ID 지정"
                onChange={(e) => setComfyCfg({ ...comfyCfg, promptNodeId: e.target.value })} onBlur={() => saveComfyCfg({ promptNodeId: (comfyCfg.promptNodeId || '').trim() })} /></div>
            <div className="frow"><label>타임아웃(초)</label>
              <input type="number" style={{ width: 90 }} value={comfyCfg.timeoutSec || 300}
                onChange={(e) => setComfyCfg({ ...comfyCfg, timeoutSec: e.target.value })} onBlur={() => saveComfyCfg({ timeoutSec: parseInt(comfyCfg.timeoutSec, 10) || 300 })} />
              <label className="chk" style={{ display: 'flex', gap: 4, alignItems: 'center', width: 'auto' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={comfyCfg.sendDims !== false} onChange={(e) => { const v = e.target.checked; setComfyCfg({ ...comfyCfg, sendDims: v }); saveComfyCfg({ sendDims: v }); }} /> 비율에 맞춰 해상도 주입
              </label></div>
            <div className="meta" style={{ marginTop: 4 }}>클라우드는 <b>주소 cloud.comfy.org + API키 + 유료구독(Standard+)</b>이 필요합니다. 로컬은 내 PC ComfyUI에 z-image 모델(z_image·qwen_3_4b·ae)이 설치돼 있어야 합니다.</div>
            <div className="mbtns" style={{ marginTop: 10 }}>
              <button onClick={testComfy}>🔌 연결 테스트</button>
              <span style={{ flex: 1 }} />
              <button className="ghost" onClick={() => setComfyOpen(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}
      {imgRotOpen && imgRot && (
        <div className="modal-bg show">
          <div className="modal-card">
            <h3>⚙ 이미지 설정 (순환 · 나노바나나2 Lite)</h3>
            {giCfg ? (
              <div style={{ background: '#fbf6ee', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', margin: '0 0 10px' }}>
                <div className="frow" style={{ flexWrap: 'wrap' }}>
                  <label style={{ width: 'auto', fontWeight: 700, color: 'var(--hook)' }}>🍌 유료 나노바나나2 Lite</label>
                  <input type="password" placeholder="🔑 Gemini API 키" value={giKey} style={{ flex: 1, minWidth: 180 }}
                    onChange={(e) => setGiKey(e.target.value)} onBlur={() => saveGiKey(giKey.trim())} />
                </div>
                <div className="frow" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                  <label style={{ width: 'auto' }}>모델</label>
                  <input style={{ flex: 1, minWidth: 200 }} value={giCfg.model || ''} placeholder="gemini-3.1-flash-lite-image"
                    onChange={(e) => setGiCfg({ ...giCfg, model: e.target.value })} onBlur={() => saveGiCfg({ model: (giCfg.model || '').trim() })} />
                  <label className="chk" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={giCfg.sendAspect !== false} onChange={(e) => saveGiCfg({ sendAspect: e.target.checked })} />비율 전송
                  </label>
                </div>
                <div className="meta" style={{ marginTop: 4 }}>헤더에서 <b>「이미지: 유료」</b>를 고르면 이 키로 나노바나나가 이미지를 만듭니다(유료, ~$0.034/장). 모델명이 안 맞으면(404) 여기서 고치고, 비율 오류면 「비율 전송」을 끄세요.</div>
              </div>
            ) : null}
            <div className="meta" style={{ marginBottom: 8 }}>위에서부터 순서대로 시도하고, 한 엔진이 <b>한도</b>(Genspark가 보내는 휴식/한도 메시지, Flow 계정한도)에 걸리면 <b>다음 엔진</b>이 남은 이미지를 이어 만듭니다. 체크 해제 시 순환에서 제외. (유료 나노바나나는 순환과 별개 — 헤더에서 선택)</div>
            <div style={{ margin: '8px 0' }}>
              {(imgRot.order || []).map((id, i) => (
                <div key={id} className="frow" style={{ alignItems: 'center', gap: 4 }}>
                  <button className="ghost" style={{ flex: '0 0 auto', padding: '2px 7px' }} disabled={i === 0} onClick={() => moveRotEngine(id, -1)}>↑</button>
                  <button className="ghost" style={{ flex: '0 0 auto', padding: '2px 7px' }} disabled={i === imgRot.order.length - 1} onClick={() => moveRotEngine(id, 1)}>↓</button>
                  <label style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={imgRot.enabled ? imgRot.enabled[id] !== false : true} onChange={() => toggleRotEngine(id)} />
                    <b>{i + 1}. {ENGINE_META[id] ? ENGINE_META[id].name : id}</b>
                  </label>
                  {id === 'flow' && (
                    <select style={{ flex: '0 0 auto', width: 'auto' }} value={imgRot.flowImageModel || 'Nano Banana 2'}
                      title="Flow 이미지 생성 모델 — Lite는 더 빠르고 저렴한 경량 모델(2026-06-30 출시). Flow 화면에 옵션이 없으면 자동으로 기본 모델 유지."
                      onChange={(e) => saveImgRot({ ...imgRot, flowImageModel: e.target.value })}>
                      <option value="Nano Banana 2">Nano Banana 2</option>
                      <option value="Nano Banana 2 Lite">Nano Banana 2 Lite (빠름·저렴)</option>
                    </select>
                  )}
                  {id === 'flow' && <button className="ghost" style={{ flex: '0 0 auto' }} onClick={() => { setImgRotOpen(false); openFlowAcc(); }}>🔑 Flow 계정</button>}
                  {id === 'genspark' && <button className="ghost" style={{ flex: '0 0 auto' }} onClick={() => { setImgRotOpen(false); openGsAcc(); }}>🔑 Genspark 계정</button>}
                </div>
              ))}
            </div>
            <div className="meta">⚠ 여러 계정/엔진으로 한도를 우회하는 것은 각 서비스 약관 위반·정지 위험이 있습니다. 보수적으로.</div>
            {lora && (
              <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 8 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 700 }}>
                  <input type="checkbox" checked={lora.enabled !== false} onChange={(e) => saveLora({ enabled: e.target.checked })} />
                  📦 LoRA 학습용 이미지 수집 <span className="meta">(Genspark/Flow만 · 누적 {lora.count || 0}장)</span>
                </label>
                <div className="meta" style={{ marginTop: 4 }}>한국사 이미지를 모아 → 나중에 LoRA 학습용.</div>
                <div className="frow" style={{ marginTop: 4 }}>
                  <label>트리거</label>
                  <input style={{ width: 110 }} value={lora.trigger || 'joseon'} onChange={(e) => setLora({ ...lora, trigger: e.target.value })} onBlur={(e) => saveLora({ trigger: e.target.value })} />
                  <span className="meta" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lora.dir}>📁 {lora.dir}</span>
                </div>
                <div className="mbtns" style={{ marginTop: 4 }}>
                  <button className="ghost" onClick={pickLoraDir}>폴더 변경</button>
                  <button className="ghost" onClick={() => api.openLoraFolder()}>📂 데이터셋 열기</button>
                </div>
              </div>
            )}
            <div className="mbtns"><button className="ghost" onClick={() => setImgRotOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {gsAccOpen && gsAcc && (
        <div className="modal-bg show">
          <div className="modal-card">
            <h3>⚙ Genspark 멀티계정</h3>
            <div className="meta" style={{ marginBottom: 8 }}>계정마다 <b>🔑 로그인</b>으로 한 번씩 로그인(쿠키 저장). 생성 시 한도 안 찬 계정부터, 한도 도달 시 다음 계정으로.</div>
            <div className="frow"><label>일일 한도</label><input className="n" type="number" min="0" style={{ width: 70 }} value={gsAcc.dailyCap} onChange={(e) => changeGsCap(e.target.value)} /><span className="meta">계정당 하루 생성 상한 · <b>0 = 무제한</b> (Genspark 자체 한도 메시지로만 Flow 전환)</span></div>
            <div style={{ margin: '8px 0' }}>
              {gsAcc.accounts.map((a) => (
                <div key={a.id} className="frow" style={{ alignItems: 'center' }}>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input defaultValue={a.label} onBlur={(e) => renameGsAcc(a.id, e.target.value)} title="이름 수정 후 다른 곳 클릭" style={{ flex: '0 0 120px', fontWeight: 700 }} />
                    <span className="meta">(오늘 {a.used}/{gsAcc.dailyCap > 0 ? gsAcc.dailyCap : '무제한'})</span>
                  </span>
                  <button className="ghost" style={{ flex: '0 0 auto' }} onClick={() => gsLogin(a.id)}>🔑 로그인</button>
                  {a.id !== 'default' && <button className="ghost" style={{ flex: '0 0 auto' }} title="계정 삭제" onClick={() => removeGsAcc(a.id)}>✕</button>}
                </div>
              ))}
            </div>
            <div className="meta">⚠ 약관 위반·정지 위험. 계정당 보수적으로.</div>
            <div className="mbtns"><button onClick={addGsAcc}>+ 계정 추가</button><button className="ghost" onClick={() => setGsAccOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {grokAccOpen && grokAcc && (
        <div className="modal-bg show">
          <div className="modal-card">
            <h3>⚙ Grok(X) 멀티계정 — 영상</h3>
            <div className="meta" style={{ marginBottom: 8 }}>Grok 영상 생성용 X(트위터) 계정. <b>🔑 로그인</b>으로 한 번씩 로그인(쿠키 저장).</div>
            <div className="frow"><label>일일 한도</label><input className="n" type="number" style={{ width: 70 }} value={grokAcc.dailyCap} onChange={(e) => changeGrokCap(e.target.value)} /><span className="meta">계정당 하루 생성 상한</span></div>
            <div style={{ margin: '8px 0' }}>
              {grokAcc.accounts.map((a) => (
                <div key={a.id} className="frow" style={{ alignItems: 'center' }}>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input defaultValue={a.label} onBlur={(e) => renameGrokAcc(a.id, e.target.value)} title="이름 수정 후 다른 곳 클릭" style={{ flex: '0 0 120px', fontWeight: 700 }} />
                    <span className="meta">(오늘 {a.used}/{grokAcc.dailyCap})</span>
                  </span>
                  <button className="ghost" style={{ flex: '0 0 auto' }} onClick={() => grokLogin(a.id)}>🔑 로그인</button>
                  {a.id !== 'default' && <button className="ghost" style={{ flex: '0 0 auto' }} title="계정 삭제" onClick={() => removeGrokAcc(a.id)}>✕</button>}
                </div>
              ))}
            </div>
            <div className="meta">⚠ 약관 위반·정지 위험. 보수적으로.</div>
            <div className="mbtns"><button onClick={addGrokAcc}>+ 계정 추가</button><button className="ghost" onClick={() => setGrokAccOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {scriptEditOpen && (
        <div className="modal-bg show">
          <div className="modal-card" style={{ width: 820, maxWidth: '94vw' }}>
            <h3>✏ 대본 수정</h3>
            <div className="meta" style={{ marginBottom: 8 }}>대본 내용을 수정하고 [적용]하면 재파싱됩니다(원본 .md 파일도 갱신). ⚠ 기존 TTS/이미지는 초기화됩니다.</div>
            <textarea rows="22" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.5 }} value={scriptText} onChange={(e) => setScriptText(e.target.value)} />
            <div className="mbtns"><button onClick={applyScriptEdit}>적용</button><button className="ghost" onClick={() => setScriptEditOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {impOpen && (
        <div className="modal-bg show">
          <div className="modal-card" style={{ maxWidth: 680 }}>
            <h3>📥 복사·붙여넣기로 프롬프트 만들기</h3>
            <div className="meta" style={{ marginBottom: 8 }}>GPU(Ollama)에 연결되면 <b>✍ 프롬프트작성</b>이 자동으로 처리합니다. <b>GPU가 꺼져 있거나 출장(원격)·다른 PC라 연결이 안 될 때</b>는 이 방법을 쓰세요: ① <b>📤 요청서 복사</b> → 챗GPT·클로드·제미나이 등 <b>아무 LLM</b>에 붙여넣기 → ② 받은 답변 전체를 아래에 붙여넣고 [적용].</div>
            <div style={{ marginBottom: 6 }}><button className="ghost" disabled={!loaded} title="현재 모드(롱폼/쇼츠)에 맞는 요청서를 클립보드에 복사" onClick={exportPrompts}>📤 요청서 복사</button></div>
            <textarea rows="12" placeholder="여기에 웹 LLM 답변(## [1-1] … 이미지: …)을 붙여넣으세요" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={impText} onChange={(e) => setImpText(e.target.value)} />
            <div className="mbtns"><button onClick={applyImport}>붙여넣은 텍스트 적용</button><button className="ghost" onClick={() => setImpOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {promptView && (
        <div className="modal-bg show">
          <div className="modal-card" style={{ maxWidth: 620 }}>
            <h3>📝 {promptView.label} — 프롬프트 수정</h3>
            <div className="meta" style={{ marginBottom: 6 }}>대본 프롬프트를 직접 고쳐 이미지·비디오를 다시 만들 수 있습니다. 수정 후 아래 <b>생성</b> 버튼을 누르면 이 그룹만 새로 생성됩니다.</div>
            {/* 🖼 이미지 프롬프트 (편집) */}
            <div className="meta" style={{ marginBottom: 4 }}>🖼️ 이미지 프롬프트 <span style={{ fontWeight: 400 }}>— 생성 시 앞에 <b>스타일 「{promptView.styleName}」</b> 이 자동으로 붙습니다</span></div>
            <textarea rows="6" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={promptView.image} onChange={(e) => setPromptView({ ...promptView, image: e.target.value })} placeholder="영문 이미지 프롬프트" />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
              <button className="ghost" onClick={() => { try { navigator.clipboard.writeText((promptView.stylePfx || '') + promptView.image); } catch (_) {} setStatus('이미지 프롬프트 복사됨(스타일 포함)'); }}>📋 복사</button>
              <button disabled={!loaded} title="이 프롬프트를 저장하고 이 그룹 이미지를 새로 생성" onClick={() => savePromptView('image')}>🖼 이미지 생성</button>
            </div>
            {/* 🎬 비디오 프롬프트 (편집) */}
            <div className="meta" style={{ margin: '10px 0 4px' }}>🎬 영상(I2V) 프롬프트 <span style={{ fontWeight: 400 }}>— 모션만 (스타일은 원본 이미지가 이미 가짐)</span></div>
            <textarea rows="3" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={promptView.video} onChange={(e) => setPromptView({ ...promptView, video: e.target.value })} placeholder="영문 모션 프롬프트 (비우면 기본 모션)" />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
              <button className="ghost" onClick={() => { try { navigator.clipboard.writeText(promptView.video); } catch (_) {} setStatus('영상 프롬프트 복사됨'); }}>📋 복사</button>
              <button disabled={!loaded} title="이 프롬프트를 저장하고 이 그룹 비디오를 새로 생성 (이미지 있어야 함)" onClick={() => savePromptView('video')}>🎬 비디오 생성</button>
            </div>
            {promptView.motion ? <div className="meta" style={{ marginTop: 6 }}>🎞 모션 노트: {promptView.motion}</div> : null}
            <div className="mbtns"><button onClick={() => savePromptView(null)}>💾 저장만</button><button className="ghost" onClick={() => setPromptView(null)}>닫기</button></div>
          </div>
        </div>
      )}
    </>
  );

  async function switchMode(m) {
    if (m === mode) return;
    setMode(m);
    setAspect(m === 'shorts' ? '9:16' : '16:9');
    // 모드별 보관된 대본으로 전환 (없으면 빈 화면). 롱폼/쇼츠/플리 대본은 독립.
    try { const r = await api.setMode({ mode: m }); if (r && r.queue) setQueue(r.queue); setDto(r ? r.dto : null); setFtitle(r && r.dto ? (r.dto.fileTitle || '') : ''); }
    catch (e) { logline('모드 전환 오류: ' + e.message); }
  }

  // 출판 원고(.md) 열기 — book-parser 로 파싱해 출판 큐에 적재.
  async function openBook() {
    try {
      const r = await api.openBookScript({ presetName: presetName || null });
      if (!r) return;
      if (r.mode) setMode(r.mode);
      setDto(r.dto); if (r.queue) setQueue(r.queue);
      setFtitle(r.dto ? (r.dto.fileTitle || '') : '');
      setStatus('출판 원고 로드');
    } catch (e) { logline('원고 열기 오류: ' + e.message); }
  }
  // 플리 스펙(.md) 열기 — 클로드가 채팅에서 만든 곡 목록 파일.
  async function openPlaylist() {
    try {
      const r = await api.openPlaylistSpec({ presetName: presetName || null });
      if (!r) return;
      if (r.mode) setMode(r.mode);
      setDto(r.dto); if (r.queue) setQueue(r.queue);
      setFtitle(r.dto ? (r.dto.fileTitle || '') : '');
      setStatus(`플리 로드 · ${r.dto && r.dto.tracks ? r.dto.tracks.length : 0}곡`);
    } catch (e) { logline('플리 열기 오류: ' + e.message); }
  }
  // 플리 음악 생성 — num=null 전체, 숫자=그 곡만 재생성.
  async function runMakePlaylist(num) {
    try {
      setStatus(num ? `${num}번 곡 생성 중…` : '음악 전체 생성 중…');
      const d = await api.makePlaylist({ num: num || null });
      if (d) setDto(d);
      setStatus('음악 생성 완료');
    } catch (e) { logline('음악 생성 오류: ' + e.message); }
  }
  // 플리 배경(무한루프 영상) + 곡제목 자막 → .vrew 생성 (음악 mp3 가 있어야 함).
  async function runMakePlaylistVideo() {
    try {
      setStatus('만들기 진행 중… (음악 + 배경 + .vrew)');
      const d = await api.makePlaylistVideo({ imgEngine, videoEngine });
      if (d) setDto(d);
      setStatus('만들기 완료');
    } catch (e) { logline('만들기 오류: ' + e.message); }
  }
  // 플리 배경 이미지/영상 첨부·삭제 (전 곡 공통 배경).
  async function attachPlBg() {
    try { const d = await api.playlistAttachBg(); if (d) setDto(d); setStatus('배경 첨부'); } catch (e) { logline('배경 첨부 오류: ' + e.message); }
  }
  async function clearPlBg() {
    try { const d = await api.playlistClearBg(); if (d) setDto(d); setStatus('배경 삭제'); } catch (e) { logline('배경 삭제 오류: ' + e.message); }
  }
}

// ── 플리(ACE-Step 음악) 화면 ──────────────────────────────
const PL_STATUS = { idle: '대기', generating: '생성중…', done: '완료', fail: '실패' };
function PlaylistView({ dto, onMakeOne, onPreview, onPreviewMedia, onAttachBg, onClearBg }) {
  if (!dto || dto.kind !== 'playlist' || !dto.tracks.length) {
    return (
      <div className="plempty">
        <h2>🎵 플리 — AI 음악(ACE-Step)</h2>
        <p>상단 <b>「🎵 플리 스펙 열기」</b>로 곡 목록(.md)을 불러오세요.</p>
        <p className="meta">스펙은 <b>클로드가 이 채팅에서</b> 채널 컨셉에 맞춰 자동으로 만들어 줍니다. 생성은 로컬 ComfyUI(ACE-Step) API로 자동 실행되어 출력폴더에 저장됩니다.</p>
      </div>
    );
  }
  return (
    <div className="plwrap">
      <div className="plhead">
        <h2>🎵 {dto.fileTitle}</h2>
        {dto.concept ? <span className="meta">{dto.concept}</span> : null}
        <span className="meta">· {dto.tracks.length}곡</span>
      </div>
      {/* 배경(왼쪽 고정) + 곡 리스트(오른쪽) — 리스트만 스크롤되고 배경은 화면에 남음 */}
      <div className="plmain" style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <div className="plbg" style={{ flex: '0 0 auto', width: 452, position: 'sticky', top: 8 }}>
          <div className="lab" style={{ fontWeight: 600, marginBottom: 6 }}>🎬 배경 (전 곡 공통)</div>
          <Thumb c={{ videoPath: dto.bgVideoPath, imagePath: dto.bgImagePath }} isLf={true}
            onAttach={onAttachBg} onClear={onClearBg} onPreview={onPreviewMedia || onPreview} />
          <div className="meta" style={{ marginTop: 6, fontSize: 12, lineHeight: 1.45 }}>
            클릭해 이미지/영상 첨부(＋) · 삭제(✕). 첨부하면 그걸 배경으로, 비우면 배경 프롬프트로 자동 생성(심리스 반복 영상).
          </div>
        </div>
        <div className="pltracks" style={{ flex: 1, minWidth: 0 }}>
        {dto.tracks.map((t) => (
          <div key={t.num} className={'pltrack s-' + t.status}>
            <div className="plnum">{String(t.num).padStart(2, '0')}</div>
            <div className="plbody">
              <div className="pltitle">{t.title}
                <span className="pllen">{t.durationSec || 180}s</span>
                <span className={'plstatus s-' + t.status}>{PL_STATUS[t.status] || t.status}</span>
              </div>
              <div className="pltags" title={t.tags}>{t.tags || <span className="meta">스타일 태그 없음</span>}</div>
              {t.lyrics
                ? <div className="pllyrics" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>🎤 {t.lyrics}</div>
                : <div className="pllyrics meta">연주곡 (보컬 없음)</div>}
              {t.error ? <div className="plerr">✗ {t.error}</div> : null}
              {t.audioPath ? <audio controls preload="none" src={media(t.audioPath)} className="plaudio" /> : null}
            </div>
            <div className="plactions">
              <button className="ghost" title="이 곡만 (재)생성" onClick={() => onMakeOne(t.num)}>{t.status === 'done' ? '↻ 다시' : '▶ 생성'}</button>
            </div>
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

// ── 카드 목록 (편별 그룹/컷) ──────────────────────────────
function Cards({ dto, isLf, capCharsN, bgmOn, onTts, onImg, onVid, onBulk, onPlayShorts, onPlayGroup, onRegen, onMake, onVrew, onPremiere, onAttach, onClear, onTitleField, onPreview, onPlayFrom, onGroupTts, onGroupVid, onShowPrompt, onSplit }) {
  // dto.projects 부재 가드 — 출판/플리 dto 가 모드 전환 직후 한 프레임 남아 들어올 수 있음(크래시 방지)
  if (!dto || !dto.projects || !dto.projects.length) {
    return <div id="cards"><div className="empty">대본(.md)을 열면 편별 그룹과 컷이 여기에 표시됩니다.</div></div>;
  }
  return (
    <div id="cards">
      {dto.projects.map((pr) => {
        const total = pr.cuts.reduce((s, c) => s + (c.groupDurationSec || 0), 0);
        const totalGen = pr.cuts.reduce((s, c) => s + (c.groupGenSec || 0), 0);
        const rtf = (total > 0 && totalGen > 0) ? (totalGen / total) : null;
        let capN = 0;
        return (
          <div className="card" key={pr.shortsNum}>
            <h2>🎞 {dto.mode === 'longform'
              ? (dto.fileTitle || pr.title)
              : <>{dto.fileTitle ? `${dto.fileTitle} | ` : ''}{pr.title}</>} <span className="meta">({pr.aspect} · {pr.cuts.length}컷)</span>
              {total > 0 && <span className="total">합계 {fmtMinSec(total)}{rtf != null && <span className="rtf" title="RTF = TTS 생성시간 ÷ 음성길이 (낮을수록 빠름)">│ RTF {rtf.toFixed(2)}</span>}</span>}
              <span className="cardbtns">
                <button className="ghost" onClick={() => onTts(pr.shortsNum)}>🎤 TTS</button>
                <button className="ghost" onClick={() => onImg(pr.shortsNum)}>🖼 이미지</button>
                <button className="ghost" title="폴더 선택 → 파일명 숫자로 그룹 자동첨부" onClick={() => onBulk(pr.shortsNum)}>📎 일괄첨부</button>
                <button className="ghost" onClick={() => onVid(pr.shortsNum)}>🎬 비디오</button>
                <button className="ghost" onClick={() => onPlayShorts(pr.shortsNum)}>▶ 미리보기</button>
                <button className="ghost" onClick={() => onMake(pr.shortsNum)}>⚡ 만들기</button>
                <button onClick={() => onVrew(pr.shortsNum)}>💾 .vrew</button>
                <button className="ghost" title="Premiere Pro 임포트용 XML 시퀀스 생성 — 파일 > 가져오기로 열면 클립·TTS가 배치된 시퀀스가 바로 열립니다 (자막은 .srt 캡션 가져오기)" onClick={() => onPremiere(pr.shortsNum)}>🎞 프리미어</button>
              </span>
            </h2>
            {!isLf && <TitleEditor pr={pr} onTitleField={onTitleField} />}
            <div className={'cuts-grid' + (isLf ? ' lf' : '')}>
              {pr.cuts.map((c, ci) => {
                const ph = phaseBadge(c.phase, isLf);
                const bgmText = pr.bgmUsed || pr.bgmMood || ''; // 실제 사용/대본 지정 BGM 프롬프트
                const lineEls = [];
                (c.sentences || []).forEach((s) => {
                  for (const t of splitLines(s.text, capCharsN)) {
                    capN += 1;
                    lineEls.push(<div className="sent" key={capN}><span className="lineno">{String(capN).padStart(2, '0')} |</span>{t}</div>);
                  }
                });
                return (
                  <div className={'cut' + (isLf ? ' lf' : '')} key={c.num}>
                    <Thumb c={c} isLf={isLf} onAttach={() => onAttach(pr.shortsNum, c.num)} onClear={() => onClear(pr.shortsNum, c.num)} onPreview={onPreview} />
                    <div>
                      <div className={'narr' + (c.isIntro ? ' intro' : '')}>
                        <div className="narr-top">
                          <span className="num">G{c.num}</span>
                          <div className="narr-btns">
                            {c.groupDurationSec ? <span className={'dur' + (c.groupDurationSec > 10 ? ' over' : '')}>▶ {c.groupDurationSec.toFixed(1)}s</span> : null}
                            {c.groupDurationSec > 10 && (c.sentences && c.sentences.length >= 2) &&
                              <button className="gprev split" title={`${c.groupDurationSec.toFixed(1)}초 — 10초 초과. 2개 그룹으로 분할(프롬프트 초기화)`} onClick={() => onSplit(pr.shortsNum, c.num)}>✂ 분할</button>}
                            <button className="gprev" title="첨부 이미지 재생성" onClick={() => onRegen(pr.shortsNum, c.num)}>🔄</button>
                            <button className="gprev" title="이 그룹 미리듣기" onClick={() => onPlayGroup(pr.shortsNum, c.num)}>▶</button>
                            <button className="gprev" title="여기부터 재생" onClick={() => onPlayFrom(pr.shortsNum, c.num)}>⏭</button>
                            <button className="gprev" title="이 그룹만 TTS 변환" onClick={() => onGroupTts(pr.shortsNum, c.num)}>🎤</button>
                            <button className="gprev" title="이 그룹만 비디오 변환" onClick={() => onGroupVid(pr.shortsNum, c.num)}>🎬</button>
                            <button className="gprev" title="이 그룹 프롬프트 보기·수정" onClick={() => onShowPrompt(pr.shortsNum, c, `${pr.title} · G${c.num}`)}>📝</button>
                          </div>
                        </div>
                        <div className="narr-text"><span className={'badge ' + ph[0]}>{ph[1]}</span></div>
                        {ci === 0 && bgmOn && (
                          <div className="bgm-line" title="배경음악(BGM) 프롬프트 — 대본 `> 🎵 배경음악:` 또는 자동분석 결과" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12 }}>
                            <span>🎵 BGM:</span>
                            <span style={{ flex: 1, opacity: bgmText ? 1 : 0.6, wordBreak: 'break-word' }}>{bgmText || '자동 (대본 분석 — 만들기 후 표시)'}</span>
                            {bgmText && <button className="gprev" title="BGM 프롬프트 복사" onClick={() => { try { navigator.clipboard.writeText(bgmText); } catch (_) {} }}>📋</button>}
                          </div>
                        )}
                      </div>
                      <div className="sents">{lineEls}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Thumb({ c, isLf, onAttach, onClear, onPreview }) {
  const cls = isLf ? ' lf' : '';
  const clearBtn = <button className="thumbx" title="첨부 삭제" onClick={(e) => { e.stopPropagation(); onClear(); }}>✕</button>;
  const genOv = (txt) => <div className="genoverlay"><div className="spin" /><div>{txt}</div></div>;
  if (c.videoPath) {
    return (
      <div className={'thumbwrap' + cls}>
        <video className={'thumb' + cls} src={media(c.videoPath)} muted loop playsInline preload="metadata" />
        <button className="vidplay" title="재생 / 정지" onClick={(e) => { const v = e.currentTarget.parentElement.querySelector('video'); if (!v) return; if (v.paused) { v.play(); e.currentTarget.classList.add('playing'); } else { v.pause(); e.currentTarget.classList.remove('playing'); } }}>▶</button>
        <span className="playbadge">🎬 영상</span>{clearBtn}
      </div>
    );
  }
  if (c.imagePath) {
    return (
      <div className={'thumbwrap' + cls}>
        <img className={'thumb' + cls} src={media(c.imagePath)} title="클릭: 미리보기" onClick={() => onPreview('img', media(c.imagePath))} alt="" />
        {c.videoStatus === 'generating' ? genOv('🎬 영상 변환 중…') : null}{clearBtn}
      </div>
    );
  }
  if (c.imageStatus === 'generating') {
    return <div className={'thumbwrap' + cls}><div className={'thumb none gen' + cls} />{genOv('🖼 이미지 생성 중…')}</div>;
  }
  return <div className={'thumb none' + cls} title="클릭: 이미지/영상 첨부" onClick={onAttach}>＋</div>;
}

function TitleEditor({ pr, onTitleField }) {
  const sn = pr.shortsNum;
  const l1 = pr.titleLine1 != null ? pr.titleLine1 : (pr.hookCaption || '');
  const l2 = pr.titleLine2 || '';
  const alignSel = (field, val) => (
    <select className="tf tal" value={val || 'center'} onChange={(e) => onTitleField(sn, field, e.target.value)}>
      <option value="center">가운데</option><option value="left">왼쪽</option><option value="right">오른쪽</option>
    </select>
  );
  return (
    <div className="titlebox">
      <div className="trow"><span className="tlbl">1줄</span>
        <input className="tf tline" value={l1} placeholder="제목 1줄(상단 고정)" onChange={(e) => onTitleField(sn, 'titleLine1', e.target.value)} />
        <input className="tf tsz" type="number" value={pr.t1Size || 120} step="5" title="크기" onChange={(e) => onTitleField(sn, 't1Size', e.target.value)} />
        <input className="tf tcol" type="color" value={pr.t1Color || '#ffffff'} title="색상" onChange={(e) => onTitleField(sn, 't1Color', e.target.value)} />
        {alignSel('t1Align', pr.t1Align)}</div>
      <div className="trow"><span className="tlbl">2줄</span>
        <input className="tf tline" value={l2} placeholder="제목 2줄(선택)" onChange={(e) => onTitleField(sn, 'titleLine2', e.target.value)} />
        <input className="tf tsz" type="number" value={pr.t2Size || 120} step="5" title="크기" onChange={(e) => onTitleField(sn, 't2Size', e.target.value)} />
        <input className="tf tcol" type="color" value={pr.t2Color || '#ffe08a'} title="색상" onChange={(e) => onTitleField(sn, 't2Color', e.target.value)} />
        {alignSel('t2Align', pr.t2Align)}</div>
      <div className="trow"><span className="tlbl">배경</span>
        <label className="bgchk"><input type="checkbox" checked={!!pr.bgEnabled} onChange={(e) => onTitleField(sn, 'bgEnabled', e.target.checked)} /> 도형</label>
        <span className="bgseg">채우기 <input className="tf tcol" type="color" value={pr.bgFill || '#000000'} onChange={(e) => onTitleField(sn, 'bgFill', e.target.value)} />
          <input className="tf" type="number" value={pr.bgFillOp != null ? pr.bgFillOp : 50} title="불투명도%" style={{ width: 46 }} onChange={(e) => onTitleField(sn, 'bgFillOp', e.target.value)} />%</span>
        <span className="bgseg">테두리 <input className="tf tcol" type="color" value={pr.bgStroke || '#000000'} onChange={(e) => onTitleField(sn, 'bgStroke', e.target.value)} />
          <input className="tf" type="number" value={pr.bgStrokeOp != null ? pr.bgStrokeOp : 0} title="불투명도%" style={{ width: 42 }} onChange={(e) => onTitleField(sn, 'bgStrokeOp', e.target.value)} />%
          <input className="tf" type="number" value={pr.bgStrokeW || 0} title="두께" style={{ width: 42 }} onChange={(e) => onTitleField(sn, 'bgStrokeW', e.target.value)} /></span>
        <span className="bgseg">모서리 <input className="tf" type="number" value={pr.bgRound || 0} title="둥글게%" style={{ width: 42 }} onChange={(e) => onTitleField(sn, 'bgRound', e.target.value)} />%</span>
        <label className="bgchk"><input type="checkbox" checked={!!pr.bgDashed} onChange={(e) => onTitleField(sn, 'bgDashed', e.target.checked)} /> 점선</label></div>
    </div>
  );
}
