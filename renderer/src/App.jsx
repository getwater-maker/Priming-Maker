import React, { useEffect, useRef, useState, useCallback } from 'react';
import api from './lib/ipc.js';
import { splitLines, mLen } from './lib/captions.js';

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
const ENGINE_META = { genspark: { name: 'Genspark (Nano Banana 2)' }, flow: { name: 'Google Flow' }, comfy: { name: 'ComfyUI (SDXL)' } };

export default function App() {
  const [mode, setMode] = useState('longform'); // 'longform'(주 사용) | 'shorts'
  const isLf = mode === 'longform';
  const [dto, setDto] = useState(null);
  const [queue, setQueue] = useState(null); // 현재 모드 작업 큐(적재 대본 목록) — main 의 queueDTO
  const [presets, setPresets] = useState([]);
  const [styles, setStyles] = useState([]);

  // 헤더 컨트롤
  const [presetName, setPresetName] = useState('');
  const [styleId, setStyleId] = useState('chibi');
  const [imgEngine, setImgEngine] = useState('rotate'); // 'rotate'(Flow+Genspark 순환) | 'comfy'
  const [aspect, setAspect] = useState('16:9');
  const [videoEngine, setVideoEngine] = useState('grok');
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
  const [modeProfiles, setModeProfiles] = useState(null); // mode-profiles.js (음성배속 등 모드 기본값 출처)
  // 롱폼 분할옵션(도입부/본론/짧은/긴) — 프리셋에서 초기화, capbar 패널에서 조절 시 재분할.
  const [splitOpts, setSplitOpts] = useState({ intro: 3, main: 10, short: 10, long: 20, mode: 'h3' });

  const [ftitle, setFtitle] = useState('');
  const [status, setStatus] = useState('');
  const [autoSavedAt, setAutoSavedAt] = useState(0); // 마지막 자동저장 시각(ms)
  const [appVersion, setAppVersion] = useState(''); // 앱 버전 (타이틀 표시)
  const [logText, setLogText] = useState('');
  const [logCollapsed, setLogCollapsed] = useState(true); // 최소화로 시작 — 로그바 클릭 시 펼침

  // 모달/플레이어 상태
  const [chOpen, setChOpen] = useState(false);
  const [ch, setCh] = useState(null);          // 편집 중 프리셋 폼
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
  const [comfyOpen, setComfyOpen] = useState(false);
  const [comfy, setComfy] = useState(null);
  const [ollamaOpen, setOllamaOpen] = useState(false);
  const [ollama, setOllama] = useState(null);           // { baseUrl, model }
  const [ollamaModels, setOllamaModels] = useState([]); // 서버에 설치된 모델 목록
  const [promptView, setPromptView] = useState(null);   // 그룹 프롬프트 보기 { label, image, video, motion }
  const [flowAccOpen, setFlowAccOpen] = useState(false);
  const [flowAcc, setFlowAcc] = useState(null);          // { dailyCap, accounts:[{id,label,used}] }
  const [imgRotOpen, setImgRotOpen] = useState(false);
  const [imgRot, setImgRot] = useState(null);            // { order:[], enabled:{} } 이미지 순환 설정
  const [lora, setLora] = useState(null);                // LoRA 수집 설정 { enabled, dir, trigger, count }
  const [gsAccOpen, setGsAccOpen] = useState(false);
  const [gsAcc, setGsAcc] = useState(null);              // Genspark 멀티계정
  const [grokAccOpen, setGrokAccOpen] = useState(false);
  const [grokAcc, setGrokAcc] = useState(null);          // Grok 멀티계정

  const logRef = useRef(null);
  const loaded = !!(dto && dto.projects && dto.projects.length);

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
  const _clipMaxSec = () => (videoEngine === 'flow' ? 8.0 : videoEngine === 'comfy' ? 8.0 : 10.0); // Grok=10초 캡(그룹 TTS≤6→6초·>6→10초 자동)
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
      setSplitOpts({ intro: sl.introSentenceSize || 3, main: sl.mainSentenceSize || 10, short: sl.shortLen || 10, long: sl.longLen || 20, mode: sl.splitMode === 'sentence' ? 'sentence' : 'h3' });
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
  }, [logText]);


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
    return { presetName, styleId, ttsSpeed, imgEngine, videoEngine, vidFrom, vidTo, flowVideoModel, flowCount, aiNotice };
  }
  function applySettings(s) {
    if (!s) return;
    if (s.presetName != null) setPresetName(s.presetName);
    if (s.styleId != null) setStyleId(s.styleId);
    if (s.ttsSpeed != null) setTtsSpeed(s.ttsSpeed);
    if (s.imgEngine != null) setImgEngine(s.imgEngine);
    if (s.videoEngine != null) setVideoEngine(s.videoEngine === 'grok10' ? 'grok' : s.videoEngine); // 레거시 grok10 → grok(자동)
    if (s.vidFrom != null) setVidFrom(s.vidFrom);
    if (s.vidTo != null) setVidTo(s.vidTo);
    if (s.flowVideoModel != null) setFlowVideoModel(s.flowVideoModel);
    if (s.flowCount != null) setFlowCount(s.flowCount);
    if (s.aiNotice != null) setAiNotice(!!s.aiNotice);
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
  // 큐에서 대본 제거
  async function removeQueueItem(id) {
    try { const r = await api.removeQueueItem(id); if (r.queue) setQueue(r.queue); setDto(r.dto || null); setFtitle(r.dto ? (r.dto.fileTitle || '') : ''); setStatus('대본 제거됨'); }
    catch (e) { logline('대본 제거 오류: ' + e.message); }
  }
  // 작업 소요시간은 백엔드에서 단계별로 측정해 dto-update(d.timings)로 전송 → setTimings 로 표시.
  async function runTts(shortsNum) {
    setStatus('TTS 생성중…');
    try {
      const d = await api.ttsBuild({ shortsNum, dry: false, presetName: presetName || null, speed: ttsSpeed || null, clipMaxSec: _clipMaxSec() });
      setDto(d); setStatus('오디오 완료');
    } catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
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
    };
    if (!ensurePromptsFilled(shortsNum, { image: 'all', video: 'range' })) return; // 만들기=전체 이미지 + 범위 i2v
    setStatus('⚡ 전체 제작중… (TTS+이미지→영상→.vrew)');
    try { const d = await api.makeAll(args); setDto(d); setStatus('전체 제작 완료'); }
    catch (e) { logline('오류: ' + e.message); setStatus('오류'); }
  }
  // ⚡ 만들기(통합) — 큐 대본이 1개면 그것만(.vrew 자동열기 등 기존 동작), 여러 개면 큐 전체 순차 제작.
  async function runMakeOrBatch() {
    try { await api.setQueueSettings(currentSettings()); } catch (_) {} // 현재 헤더값을 활성 항목에 반영
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
    if (!ensurePromptsFilled(null, { image: 'all', video: 'range' })) return; // 현재 표시 대본 기준 빈 프롬프트 검사
    const order = plan.map((p) => (p.mode === 'longform' ? '롱' : '쇼')).join(' → ');
    if (!window.confirm(`큐 ${plan.length}개 대본을 순차 제작합니다.\n순서: ${order}\n(각 대본은 자기 설정으로, GPU 한 대라 한 번에 하나씩)\n계속할까요?`)) return;
    setStatus(`⚡⚡ 큐 순차 제작중… (${plan.length}개)`);
    try {
      const r = await api.runBatch({ plan, common: { captionStyle: capOverride(), captionMaxChars: effCap } });
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
    try { const d = await api.regenGroup({ shortsNum, groupNum, styleId: styleId || null }); setDto(d); setStatus('재생성 완료'); }
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
  // ✍ 프롬프트작성 — 프롬프트가 비어있는 그룹의 이미지+i2v 프롬프트만 채움 (Ollama, 미도달 시 Gemini 폴백).
  async function runMakePrompts() {
    if (!dto) { setStatus('대본을 먼저 여세요'); return; }
    setImpBusy(true); setStatus('✍ 빈 프롬프트 자동작성 중… (Ollama)');
    try {
      const d = await api.generatePromptsApi({ provider: 'ollama', styleName: styleName(), fromNum: parseInt(vidFrom, 10) || 1, toNum: parseInt(vidTo, 10) || 1 });
      setDto(d); setStatus('✍ 빈 프롬프트 작성 완료');
    } catch (e) { logline('프롬프트작성 오류: ' + e.message); setStatus('프롬프트작성 실패 — ⚙에서 Ollama 확인'); alert('프롬프트 작성 실패:\n' + e.message); }
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
        const noImg = needImg && (!c.imagePrompt || !c.imagePrompt.trim());
        const noVid = needVid && (!c.videoPrompt || !c.videoPrompt.trim());
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
  async function openComfy() {
    try { const c = await api.getComfyConfig(); setComfy(c || {}); setComfyOpen(true); }
    catch (e) { logline('Comfy 설정 읽기 오류: ' + e.message); }
  }
  async function saveComfy() {
    try { await api.setComfyConfig(comfy); setComfyOpen(false); setStatus('ComfyUI 설정 저장됨'); }
    catch (e) { logline('저장 오류: ' + e.message); }
  }
  async function testComfyConn() {
    setStatus('ComfyUI 연결 테스트…');
    try { const r = await api.testComfy(); setStatus(r.ok ? `✓ 연결 OK (${r.baseUrl})` : `✗ 연결 실패 (${r.baseUrl})`); }
    catch (e) { logline('테스트 오류: ' + e.message); setStatus('테스트 오류'); }
  }
  async function pickWorkflow() { const f = await api.pickFile({ filters: [{ name: 'ComfyUI 워크플로(API json)', extensions: ['json'] }] }); if (f) setComfy((c) => ({ ...c, workflowPath: f })); }
  function showPrompt(c, label) {
    // 실제 생성에 쓰이는 최종 이미지 프롬프트 = 선택한 스타일 + 대본 프롬프트.
    const st = styles.find((x) => x.id === styleId);
    const stylePfx = st && st.prompt ? st.prompt + ', ' : '';
    setPromptView({
      label,
      styleName: st ? st.name : '없음',
      image: c.imagePrompt ? (stylePfx + c.imagePrompt) : '', // 최종(스타일 포함)
      video: c.videoPrompt || '',
      motion: c.motionNote || '',
    });
  }
  async function openFlowAcc() {
    try { const d = await api.getFlowAccounts(); setFlowAcc(d || { dailyCap: 45, accounts: [] }); setFlowAccOpen(true); }
    catch (e) { logline('Flow 계정 읽기 오류: ' + e.message); }
  }
  // 이미지 순환 설정
  async function openImgRotation() {
    try {
      const c = await api.getImageRotation(); setImgRot(c || { order: ['genspark', 'flow'], enabled: { genspark: true, flow: true } });
      try { setLora(await api.getLoraCollect()); } catch (_) {}
      setImgRotOpen(true);
    } catch (e) { logline('순환 설정 읽기 오류: ' + e.message); }
  }
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
  async function openChannelEditor() {
    if (!presetName) { logline('채널을 먼저 선택하세요'); return; }
    const p = await api.getPresetDetail(presetName);
    if (!p) { logline('채널 정보를 찾을 수 없습니다'); return; }
    let gkey = '';
    try { gkey = await api.getGeminiKey(); } catch (_) {}
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
      name: p.name || '', engine: p.engine || 'omnivoice', voice: p.voice || '',
      voiceCloneRefAudio: p.voiceCloneRefAudio || '', voiceCloneRefText: p.voiceCloneRefText || '',
      scriptFolder: p.scriptFolder || '', seed: p.seed != null ? p.seed : '',
      gemini: gkey, aiNotice: !!(p.aiNotice && p.aiNotice.enabled),
      presetPrompt: p.presetPrompt || '', language: p.language || 'ko',
      silenceSec: p.silenceSec != null ? p.silenceSec : 0,
      cfgValue: p.cfgValue != null ? p.cfgValue : 2,
      // 모드별
      capLong: mkCap(p.capLong, lf), capShort: mkCap(p.capShort, sh),
      speedLong: p.speedLong != null ? p.speedLong : (lf.defaultTtsSpeed != null ? lf.defaultTtsSpeed : 1.15),
      speedShort: p.speedShort != null ? p.speedShort : (sh.defaultTtsSpeed != null ? sh.defaultTtsSpeed : 1.25),
      styleLong: p.styleLong || p.styleId || 'chibi', styleShort: p.styleShort || p.styleId || 'chibi',
      outLong: p.outLong || p.outputFolder || '', outShort: p.outShort || p.outputFolder || '',
      split: { intro: sl.introSentenceSize || 3, main: sl.mainSentenceSize || 10, short: sl.shortLen || 10, long: sl.longLen || 20, mode: sl.splitMode === 'sentence' ? 'sentence' : 'h3' },
      _raw: p,
    });
    setChOpen(true);
  }
  // 모달 내 참조음성 미리듣기
  async function playRef(p) {
    if (!p) return;
    try { const url = await api.readAudio(p); if (url) { const a = new Audio(url); a.play().catch(() => {}); } }
    catch (e) { logline('미리듣기 실패: ' + e.message); }
  }
  async function saveChannel() {
    if (!ch) return;
    const numOr = (v, d) => (v !== '' && v != null && !isNaN(Number(v)) ? Number(v) : d);
    const capToStyle = (c) => ({ size: String(c.size), align: c.align, yAlign: c.yAlign, yOffset: yOffsetOf(c) });
    const patch = {
      engine: ch.engine || 'omnivoice',
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
      split: { introSentenceSize: numOr(ch.split.intro, 3), mainSentenceSize: numOr(ch.split.main, 10), shortLen: numOr(ch.split.short, 10), longLen: numOr(ch.split.long, 20), splitMode: ch.split.mode === 'h3' ? 'h3' : 'sentence' },
      aiNotice: { ...((ch._raw && ch._raw.aiNotice) || {}), enabled: !!ch.aiNotice },
    };
    if (ch.seed !== '' && ch.seed != null) patch.seed = parseInt(ch.seed, 10);
    try {
      await api.savePreset({ name: ch.name, patch });
      try { await api.setGeminiKey(ch.gemini); } catch (_) {}
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
            <div className="crow"><span className="l">방식</span><select value={ch.split.mode === 'sentence' ? 'sentence' : 'h3'} onChange={(e) => setSplitField('mode', e.target.value)}><option value="h3">H3 섹션 단위</option><option value="sentence">문장 단위</option></select>
              <span className="meta">{ch.split.mode === 'sentence' ? '도입부/본론을 문장수로' : 'H3 1개=그룹 1개'}</span></div>
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
  // 자막 옵션 변경 시 재생 중이면 즉시 반영
  useEffect(() => { if (playerOpen) applyCaptionStyle(); /* eslint-disable-next-line */ }, [capPos, capFine, capAlign, capSize, capYAlign, playerOpen]);
  // 헤더 생성설정 변경 → 현재 활성 큐 항목에 저장(디바운스). 대본별 개별 설정 보존.
  useEffect(() => {
    const aid = queue && queue[mode] ? queue[mode].activeId : null;
    if (!aid) return;
    const t = setTimeout(() => { api.setQueueSettings(currentSettings()).catch(() => {}); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetName, styleId, ttsSpeed, imgEngine, videoEngine, vidFrom, vidTo, flowVideoModel, flowCount, aiNotice]);

  async function copyLog() {
    try { await navigator.clipboard.writeText(logText || ''); setStatus('로그 복사됨'); }
    catch (e) { logline('복사 실패: ' + e.message); }
  }

  // 롱폼 분할바 — 카드 헤더(TTS 버튼 앞)로 이동. App 상태(splitOpts/changeSplit)를 쓰므로 여기서 만들어 Cards 로 전달.
  const splitBar = isLf ? (
    <span className="splitbar" title="값 변경 시 자동 재분할 (TTS/이미지 초기화됨)">
      <span className="lab">✂ 분할</span>
      <select title="분할 방식 — H3 섹션 단위 / 문장 단위" value={splitOpts.mode} onChange={(e) => changeSplit('mode', e.target.value)}><option value="h3">H3</option><option value="sentence">문장</option></select>
      {splitOpts.mode !== 'h3' && (<>
        도입부 <input type="number" value={splitOpts.intro} onChange={(e) => changeSplit('intro', e.target.value)} />
        본론 <input type="number" value={splitOpts.main} onChange={(e) => changeSplit('main', e.target.value)} />
      </>)}
      짧은 <input type="number" value={splitOpts.short} onChange={(e) => changeSplit('short', e.target.value)} />
      긴 <input type="number" value={splitOpts.long} onChange={(e) => changeSplit('long', e.target.value)} />
      {splitOpts.mode !== 'h3' && <button className="ghost introvid" disabled={!loaded} title="도입부 문장만 TTS 후 10초 기준으로 도입부 그룹 재배치" onClick={runIntroVideo}>🎬 도입부 TTS+10초 재배치</button>}
    </span>
  ) : null;

  // ── 렌더 ─────────────────────────────────────────────────
  return (
    <>
      <div className="topsticky">
      <header>
        {/* 상단 행 — 1영역(좌: 타이틀·모드·채널·대본) | 2영역(우: 배속·TTS·이미지·영상 생성컨트롤) */}
        <div className="hrow">
          <div className="hleft">
            <h1>🎬 Priming{appVersion ? <span className="ver">v{appVersion}</span> : null}</h1>
            <span className="modetoggle">
              <button className={isLf ? 'active' : ''} onClick={() => switchMode('longform')}>롱폼 16:9</button>
              <button className={!isLf ? 'active' : ''} onClick={() => switchMode('shorts')}>쇼츠 9:16</button>
            </span>
            <select title="채널(프리셋)" value={presetName} onChange={(e) => setPresetName(e.target.value)}>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <button className="ghost" title="채널(프리셋) 설정 편집" style={{ padding: '6px 9px' }} onClick={openChannelEditor}>⚙</button>
            <button onClick={openScript}>📂 대본 열기</button>
            <button className="ghost" disabled={!loaded} title="대본 내용 수정 → 재파싱(원본 .md 갱신)" onClick={openScriptEdit}>✏ 대본수정</button>
          </div>
          <div className="hright">
            <span title="음성 배속 (합성 1.0 → atempo 변환)">🎤 배속 <input type="number" value={ttsSpeed} step="0.05" min="0.5" max="2" style={{ width: 52 }} onChange={(e) => setTtsSpeed(e.target.value)} /></span>
            <button className="ghost" disabled={!loaded} onClick={() => runTts(null)}>🎤 TTS</button>
            <span className="hdiv" />
            <select title="이미지 스타일" value={styleId} onChange={(e) => setStyleId(e.target.value)}>
              <option value="">스타일 없음</option>
              {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select title="이미지 생성툴" value={imgEngine === 'comfy' ? 'comfy' : 'rotate'} onChange={(e) => setImgEngine(e.target.value)}>
              <option value="rotate">순환 (Flow+Genspark)</option>
              <option value="comfy">ComfyUI(SDXL)</option>
            </select>
            {imgEngine !== 'comfy' && <button className="ghost" title="순환 엔진/순서·계정 설정" style={{ padding: '6px 9px' }} onClick={openImgRotation}>⚙ 순환</button>}
            {imgEngine === 'comfy' && <button className="ghost" title="ComfyUI 서버·SDXL 설정" style={{ padding: '6px 9px' }} onClick={openComfy}>⚙ Comfy</button>}
            <button className="ghost" disabled={!loaded} onClick={() => runImg(null)}>🖼 이미지</button>
            <span className="hdiv" />
            <select title="i2v 비디오 엔진" value={videoEngine} onChange={(e) => setVideoEngine(e.target.value)}>
              <option value="grok">Grok</option><option value="flow">Flow(8초)</option><option value="comfy">ComfyUI (LTX/Wan)</option>
            </select>
            {videoEngine === 'comfy' && <button className="ghost" title="ComfyUI i2v 설정" style={{ padding: '6px 9px' }} onClick={openComfy}>⚙ Comfy</button>}
            {videoEngine === 'grok' && <button className="ghost" title="Grok(X) 멀티계정 등록·로그인·한도" style={{ padding: '6px 9px' }} onClick={openGrokAcc}>⚙ 계정</button>}
            {videoEngine === 'flow' && (
              <span title="Flow 영상 옵션">
                <select style={{ width: 'auto' }} value={flowVideoModel} onChange={(e) => setFlowVideoModel(e.target.value)}>
                  <option>Veo 3.1 - Lite</option><option>Veo 3.1 - Fast</option><option>Veo 3.1</option>
                </select>
                <select style={{ width: 54 }} value={flowCount} onChange={(e) => setFlowCount(e.target.value)}>
                  <option>1x</option><option>x2</option><option>x3</option><option>x4</option>
                </select>
              </span>
            )}
            <span title="영상으로 만들 그룹 범위 (N번~N번). 롱폼 기본=도입부 그룹만">🎬 <input type="number" min="1" style={{ width: 44 }} value={vidFrom} onChange={(e) => setVidFrom(e.target.value)} />~<input type="number" min="1" style={{ width: 44 }} value={vidTo} onChange={(e) => setVidTo(e.target.value)} /></span>
            <button className="ghost" disabled={!loaded} title={`G${vidFrom}~G${vidTo} 그룹을 i2v 비디오로 변환 (이미지 있는 것만)`} onClick={() => runVid(null)}>비디오</button>
          </div>
        </div>
        {/* 하단 행 — 3영역(좌: 프로젝트 관리) | 4영역(우: 미리보기·만들기·.vrew 등) */}
        <div className="hrow">
          <div className="hleft">
            <button className="ghost" disabled={!loaded} title="수동 저장(자동저장도 항상 켜져 있음)" onClick={saveProject}>💾 작업저장</button>
            <button className="ghost" title="저장한 프로젝트 불러오기" onClick={loadProject}>📂 불러오기</button>
            {loaded && (
              <span className="autosave-ind" title="작업은 자동으로 수시 저장됩니다. 같은 대본을 다시 열면 이어서 작업할 수 있어요.">
                {autoSavedAt ? `✓ 자동저장 ${new Date(autoSavedAt).toLocaleTimeString()}` : '자동저장 켜짐'}
              </span>
            )}
            <button className="ghost" title="새 대본 작업 — 현재 화면 비우기" onClick={resetProject}>🆕 초기화</button>
          </div>
          <div className="hright">
            <button className="ghost" disabled={!loaded || impBusy} title="각 그룹 내용을 분석해 이미지 프롬프트를 자동 작성·적용 (Ollama)" onClick={runMakePrompts}>{impBusy ? '⏳ 작성중…' : '✍ 프롬프트작성'}</button>
            <button className="ghost" disabled={!loaded} title="Ollama 서버·모델 설정 / 웹 LLM 답변 붙여넣기(고급)" style={{ padding: '6px 9px' }} onClick={openOllama}>⚙</button>
            <button className="ghost" disabled={!loaded} title="모든 편을 이어서 미리보기 재생" onClick={() => playShorts(null)}>▶ 미리보기</button>
            {(() => { const qc = (queue && queue.longform ? queue.longform.items.length : 0) + (queue && queue.shorts ? queue.shorts.items.length : 0); return (
              <button disabled={qc < 1} title={qc > 1 ? `큐 ${qc}개 대본을 교차 순서(롱1→쇼1→롱2→쇼2…)로 순차 제작` : '현재 대본 TTS+이미지 → 영상 → .vrew → 폴더열기'} onClick={runMakeOrBatch}>⚡ 만들기{qc > 1 ? ` (${qc})` : ''}</button>
            ); })()}
            <button className="ghost" title="진행 중인 작업 중단" onClick={abort}>■ 중단</button>
            <button disabled={!loaded} onClick={() => runVrew(null)}>💾 .vrew</button>
            <button className="ghost" disabled={!loaded} onClick={() => api.openFolder()}>📁 출력폴더</button>
          </div>
        </div>
      </header>

      {/* 분할/합치기 바 — 스크롤 내려도 항상 보이도록 topsticky(고정) 안. */}
      <div id="capbar">
        <span className="grow" />
        {splitBar}
        {!isLf && <button className="ghost" title="TTS 후 캡 미만 그룹들을 한 그룹으로 합치기" onClick={mergeGroups}>🔗 합치기</button>}
        <label className="chk" title="AI 고지 자막 — 체크 시 .vrew 에 삽입. 기본값: 롱폼 표시 · 쇼츠 미표시 (언제든 변경 가능)" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={aiNotice} onChange={(e) => setAiNotice(e.target.checked)} />AI 고지</label>
        <span className="hdiv" />
        <span className="worktimes" title="진행률(완료/전체) · 괄호=마지막 작업 소요시간">
          ⏱ TTS {prog.ttsD}/{prog.ttsT} ({fmtSec(timings.tts)}) · 이미지 {prog.imgD}/{prog.imgT} ({fmtSec(timings.image)}) · 영상 {prog.vidD}/{prog.vidT} ({fmtSec(timings.video)}) · <b>합계 {fmtSec(timings.tts + timings.image + timings.video)}</b>
          {timings.make > 0 && <> · ⚡전체 {fmtSec(timings.make)}</>}
        </span>
      </div>
      </div>

      <div id="body">
        <main>
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
          <Cards dto={dto} isLf={isLf} capCharsN={effCap}
            onTts={runTts} onImg={runImg} onVid={runVid} onBulk={runBulk}
            onPlayShorts={playShorts} onPlayGroup={playGroup} onRegen={runRegen}
            onMake={runMake} onVrew={runVrew} onAttach={attachAsset} onClear={clearAsset}
            onTitleField={updateTitleField} onPreview={(kind, src) => setPreview({ kind, src })}
            onPlayFrom={playFrom} onGroupTts={runGroupTts} onGroupVid={runGroupVid} onShowPrompt={showPrompt} onSplit={splitGroup} />
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
        <div id="preview" className="show" onClick={(e) => { if (e.target.id === 'preview' || e.target.classList.contains('close')) setPreview(null); }}>
          <button className="close">✕</button>
          <div id="previewBody">
            {preview.kind === 'vid'
              ? <video src={preview.src} controls autoPlay loop />
              : <img src={preview.src} alt="" />}
          </div>
        </div>
      )}

      <div id="player" className={playerOpen ? 'show' : ''} onClick={(e) => { if (e.target.id === 'player') stopPlayer(); }}>
        <div id="stage" className={isLf ? 'lf' : ''}>
          <div id="stageVisual" ref={stageVisualRef} />
          <div id="stageTitle" ref={stageTitleRef} />
          <div id="stageCap" ref={stageCapRef} />
        </div>
        <div id="playerBar"><span id="playerInfo" ref={playerInfoRef} /><button className="ghost" onClick={stopPlayer}>■ 닫기</button></div>
      </div>

      {chOpen && ch && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setChOpen(false); }}>
          <div className="modal-card wide">
            <h3>⚙ 채널(프리셋) 편집 — {ch.name}</h3>
            <div className="frow"><label>엔진</label>
              <span className="engtoggle">
                {[['omnivoice', 'OmniVoice'], ['gemini', 'Gemini'], ['supertonic', 'Supertonic']].map(([v, t]) => (
                  <button key={v} className={ch.engine === v ? 'active' : ''} onClick={() => setCh({ ...ch, engine: v })}>{t}</button>
                ))}
              </span>
            </div>
            <div className="frow"><label>목소리</label><input readOnly title="참조음성 파일명" value={(ch.voiceCloneRefAudio || '').split(/[\\/]/).pop() || ch.voice} style={{ flex: '0 0 170px' }} />
              <span className="mini">언어</span><select value={ch.language} onChange={(e) => setCh({ ...ch, language: e.target.value })}><option value="ko">한국어</option><option value="en">English</option></select>
              <span className="mini">시드</span><input className="nbox" type="number" value={ch.seed} onChange={(e) => setCh({ ...ch, seed: e.target.value })} /></div>
            <div className="frow"><label>참조음성</label>
              <select style={{ flex: 1, padding: 6 }} value={ch.voiceCloneRefAudio} onChange={(e) => setCh({ ...ch, voiceCloneRefAudio: e.target.value })}>
                {chRefList.every((r) => r.path !== ch.voiceCloneRefAudio) && ch.voiceCloneRefAudio ? <option value={ch.voiceCloneRefAudio}>{(ch.voiceCloneRefAudio || '').split(/[\\/]/).pop()}</option> : null}
                {chRefList.map((r) => <option key={r.path} value={r.path}>{r.name}</option>)}
              </select>
              <button className="ghost" style={{ flex: '0 0 auto' }} title="미리듣기" onClick={() => playRef(ch.voiceCloneRefAudio)}>▶</button>
              <button className="ghost" style={{ flex: '0 0 auto' }} onClick={pickRef}>찾기</button></div>
            <div className="frow"><label>참조텍스트</label><textarea rows="2" value={ch.voiceCloneRefText} onChange={(e) => setCh({ ...ch, voiceCloneRefText: e.target.value })} /></div>
            <div className="frow"><label>사전설정</label><textarea rows="2" placeholder="예: 30대 한국 남성, 회색 양복, 따뜻한 조명 (모든 이미지 공통)" value={ch.presetPrompt} onChange={(e) => setCh({ ...ch, presetPrompt: e.target.value })} /></div>
            <div className="frow"><label>Clone강도</label><input className="nbox" type="number" step="0.1" value={ch.cfgValue} onChange={(e) => setCh({ ...ch, cfgValue: e.target.value })} />
              <span className="mini">문장무음</span><input className="nbox" type="number" step="0.1" value={ch.silenceSec} onChange={(e) => setCh({ ...ch, silenceSec: e.target.value })} /><span className="meta">초</span></div>

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
            <div className="frow"><label>Gemini 키</label><input placeholder="제미나이 음성용 API 키" value={ch.gemini} onChange={(e) => setCh({ ...ch, gemini: e.target.value })} /></div>
            <div className="frow chk"><label>AI 고지</label><input type="checkbox" style={{ flex: '0 0 auto', width: 'auto' }} checked={ch.aiNotice} onChange={(e) => setCh({ ...ch, aiNotice: e.target.checked })} /> <span className="meta">실제 표시는 작업바의 <b>'AI 고지'</b> 토글로 결정 — 기본값 <b>롱폼 표시 · 쇼츠 미표시</b> (언제든 변경)</span></div>
            <div className="mbtns"><button onClick={saveChannel}>저장</button><button className="ghost" onClick={() => setChOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {comfyOpen && comfy && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setComfyOpen(false); }}>
          <div className="modal-card">
            <h3>⚙ ComfyUI 설정 (SDXL 이미지 · LTX 영상)</h3>
            <div className="meta" style={{ marginBottom: 8 }}>로컬 PC / RunPod / <b>ComfyUI 클라우드(comfy.org)</b>. 클라우드는 GPU·설치 불필요 — 체크 후 API 키만 넣으면 됩니다.</div>
            <div className="frow"><label>클라우드 모드</label><label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!comfy.cloud} onChange={(e) => setComfy({ ...comfy, cloud: e.target.checked, baseUrl: e.target.checked && /127\.0\.0\.1|localhost/.test(comfy.baseUrl || '') ? 'https://cloud.comfy.org' : comfy.baseUrl })} /><span className="meta">comfy.org 공식 클라우드 사용 (Standard 이상 구독 필요)</span></label></div>
            {comfy.cloud && (
              <div className="frow"><label>API 키</label><input type="password" placeholder="X-API-Key (계정 대시보드에서 발급)" value={comfy.apiKey || ''} onChange={(e) => setComfy({ ...comfy, apiKey: e.target.value })} /></div>
            )}
            <div className="frow"><label>서버 주소</label><input placeholder={comfy.cloud ? 'https://cloud.comfy.org' : 'http://127.0.0.1:8188'} value={comfy.baseUrl} onChange={(e) => setComfy({ ...comfy, baseUrl: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={testComfyConn}>연결테스트</button></div>
            <div className="subhead">🖼 이미지 (SDXL t2i)</div>
            <div className="frow"><label>SDXL 체크포인트</label><input placeholder="dreamshaperXL_sfwLightningDPMSDE.safetensors" value={comfy.imageCheckpoint || ''} onChange={(e) => setComfy({ ...comfy, imageCheckpoint: e.target.value })} /></div>
            <div className="frow"><label>스텝/CFG</label><input className="n" type="number" style={{ width: 60 }} value={comfy.imageSteps} onChange={(e) => setComfy({ ...comfy, imageSteps: e.target.value })} /><input className="n" type="number" step="0.5" style={{ width: 60 }} value={comfy.imageCfg} onChange={(e) => setComfy({ ...comfy, imageCfg: e.target.value })} /><span className="meta">Lightning 기본 8 / 2 (dpmpp_sde·karras)</span></div>
            <div className="frow"><label>네거티브</label><input placeholder="중국·일본·중복 차단" value={comfy.imageNegative || ''} onChange={(e) => setComfy({ ...comfy, imageNegative: e.target.value })} /></div>
            <div className="meta">비우면 내장 SDXL 그래프 사용(native→1080 업스케일). 커스텀 워크플로를 쓰려면 imageWorkflowPath 를 설정파일에 직접 지정하세요.</div>
            <div className="subhead">📹 영상 (i2v · LTX / Wan 등)</div>
            <div className="frow"><label>워크플로</label><input placeholder="ComfyUI '저장(API 포맷)' JSON 경로 (LTX 또는 Wan)" value={comfy.workflowPath} onChange={(e) => setComfy({ ...comfy, workflowPath: e.target.value })} /><button className="ghost" style={{ flex: '0 0 auto' }} onClick={pickWorkflow}>찾기</button></div>
            <div className="frow"><label>이미지 노드</label><input placeholder="비우면 LoadImage 자동탐지" value={comfy.imageNodeId} onChange={(e) => setComfy({ ...comfy, imageNodeId: e.target.value })} /></div>
            <div className="frow"><label>프롬프트 노드</label><input placeholder="비우면 CLIPTextEncode 자동탐지" value={comfy.promptNodeId} onChange={(e) => setComfy({ ...comfy, promptNodeId: e.target.value })} /></div>
            <div className="frow"><label>너비/높이 노드</label><input placeholder="너비 노드ID(비우면 자동)" value={comfy.videoWidthNodeId || ''} onChange={(e) => setComfy({ ...comfy, videoWidthNodeId: e.target.value })} /><input placeholder="높이 노드ID" value={comfy.videoHeightNodeId || ''} onChange={(e) => setComfy({ ...comfy, videoHeightNodeId: e.target.value })} /></div>
            <div className="frow"><label>길이 노드</label><input placeholder="길이/프레임 노드ID(비우면 자동)" value={comfy.videoDurationNodeId || ''} onChange={(e) => setComfy({ ...comfy, videoDurationNodeId: e.target.value })} /></div>
            <div className="frow"><label>fps(프레임 모드)</label><input className="n" type="number" style={{ width: 60 }} value={comfy.videoFps || 0} onChange={(e) => setComfy({ ...comfy, videoFps: e.target.value })} /><span className="meta">0=초 단위(LTX) · Wan은 16 (길이=초×fps, 4n+1 보정)</span></div>
            <div className="frow"><label>최대 길이(초)</label><input className="n" type="number" style={{ width: 60 }} value={comfy.videoMaxSec || 0} onChange={(e) => setComfy({ ...comfy, videoMaxSec: e.target.value })} /><span className="meta">0=캡 없음(TTS 길이 그대로)</span></div>
            <div className="frow"><label>영상 타임아웃(초)</label><input type="number" value={comfy.timeoutSec} onChange={(e) => setComfy({ ...comfy, timeoutSec: e.target.value })} /></div>
            <div className="meta">⚠ 영상 출력은 <b>SaveVideo/VHS(mp4)</b> 노드 필요. Wan은 fps=16 + 길이 노드를 Wan 워크플로의 length 노드로 지정.</div>
            <div className="mbtns"><button onClick={saveComfy}>저장</button><button className="ghost" onClick={() => setComfyOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {ollamaOpen && ollama && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setOllamaOpen(false); }}>
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
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setFlowAccOpen(false); }}>
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

      {imgRotOpen && imgRot && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setImgRotOpen(false); }}>
          <div className="modal-card">
            <h3>⚙ 이미지 순환 설정</h3>
            <div className="meta" style={{ marginBottom: 8 }}>위에서부터 순서대로 시도하고, 한 엔진이 <b>한도</b>(Genspark가 보내는 휴식/한도 메시지, Flow 계정한도)에 걸리면 <b>다음 엔진</b>이 남은 이미지를 이어 만듭니다. 체크 해제 시 순환에서 제외. (ComfyUI는 순환과 별개 단독)</div>
            <div style={{ margin: '8px 0' }}>
              {(imgRot.order || []).map((id, i) => (
                <div key={id} className="frow" style={{ alignItems: 'center', gap: 4 }}>
                  <button className="ghost" style={{ flex: '0 0 auto', padding: '2px 7px' }} disabled={i === 0} onClick={() => moveRotEngine(id, -1)}>↑</button>
                  <button className="ghost" style={{ flex: '0 0 auto', padding: '2px 7px' }} disabled={i === imgRot.order.length - 1} onClick={() => moveRotEngine(id, 1)}>↓</button>
                  <label style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={imgRot.enabled ? imgRot.enabled[id] !== false : true} onChange={() => toggleRotEngine(id)} />
                    <b>{i + 1}. {ENGINE_META[id] ? ENGINE_META[id].name : id}</b>
                  </label>
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
                <div className="meta" style={{ marginTop: 4 }}>한국사 이미지를 모아 → 나중에 LoRA 학습 → SDXL로 한국사 이미지 생성. ComfyUI 결과는 제외.</div>
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
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setGsAccOpen(false); }}>
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
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setGrokAccOpen(false); }}>
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
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setScriptEditOpen(false); }}>
          <div className="modal-card" style={{ width: 820, maxWidth: '94vw' }}>
            <h3>✏ 대본 수정</h3>
            <div className="meta" style={{ marginBottom: 8 }}>대본 내용을 수정하고 [적용]하면 재파싱됩니다(원본 .md 파일도 갱신). ⚠ 기존 TTS/이미지는 초기화됩니다.</div>
            <textarea rows="22" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.5 }} value={scriptText} onChange={(e) => setScriptText(e.target.value)} />
            <div className="mbtns"><button onClick={applyScriptEdit}>적용</button><button className="ghost" onClick={() => setScriptEditOpen(false)}>취소</button></div>
          </div>
        </div>
      )}

      {impOpen && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setImpOpen(false); }}>
          <div className="modal-card" style={{ maxWidth: 680 }}>
            <h3>📥 웹 LLM 답변 붙여넣기 (고급)</h3>
            <div className="meta" style={{ marginBottom: 8 }}>평소엔 <b>✍ 프롬프트작성</b>(Ollama)이면 충분합니다. 더 좋은 결과를 원하면: ① <b>📤 요청서 복사</b> → claude.ai 등에 붙여넣기 → ② 받은 답변을 아래에 붙여넣고 [적용].</div>
            <div style={{ marginBottom: 6 }}><button className="ghost" disabled={!loaded} title="현재 모드(롱폼/쇼츠)에 맞는 요청서를 클립보드에 복사" onClick={exportPrompts}>📤 요청서 복사</button></div>
            <textarea rows="12" placeholder="여기에 웹 LLM 답변(## [1-1] … 이미지: …)을 붙여넣으세요" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={impText} onChange={(e) => setImpText(e.target.value)} />
            <div className="mbtns"><button onClick={applyImport}>붙여넣은 텍스트 적용</button><button className="ghost" onClick={() => setImpOpen(false)}>닫기</button></div>
          </div>
        </div>
      )}

      {promptView && (
        <div className="modal-bg show" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setPromptView(null); }}>
          <div className="modal-card" style={{ maxWidth: 620 }}>
            <h3>📝 {promptView.label} — 이미지 프롬프트</h3>
            {promptView.image ? (
              <>
                <div className="meta" style={{ marginBottom: 4 }}>🖼️ 이미지 프롬프트 <b>(최종 = 스타일 「{promptView.styleName}」 + 대본)</b> — 실제 생성에 쓰이는 그대로</div>
                <textarea readOnly rows="6" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={promptView.image} />
                <div style={{ textAlign: 'right', marginTop: 4 }}><button className="ghost" onClick={() => { try { navigator.clipboard.writeText(promptView.image); } catch (_) {} setStatus('이미지 프롬프트 복사됨'); }}>📋 복사</button></div>
              </>
            ) : (
              <div className="meta" style={{ padding: '12px 0' }}>아직 이미지 프롬프트가 없습니다. <b>✍ 프롬프트작성</b> 또는 🖼 이미지 생성 시 대본 내용에 맞게 자동 생성됩니다.</div>
            )}
            {promptView.video ? (
              <>
                <div className="meta" style={{ margin: '8px 0 4px' }}>🎬 영상(I2V) 프롬프트 <span style={{ fontWeight: 400 }}>— 모션만 (스타일은 원본 이미지가 이미 가지므로 불필요)</span></div>
                <textarea readOnly rows="3" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} value={promptView.video} />
                <div style={{ textAlign: 'right', marginTop: 4 }}><button className="ghost" onClick={() => { try { navigator.clipboard.writeText(promptView.video); } catch (_) {} setStatus('영상 프롬프트 복사됨'); }}>📋 복사</button></div>
              </>
            ) : null}
            {promptView.motion ? <div className="meta" style={{ marginTop: 6 }}>🎞 모션: {promptView.motion}</div> : null}
            <div className="mbtns"><button className="ghost" onClick={() => setPromptView(null)}>닫기</button></div>
          </div>
        </div>
      )}
    </>
  );

  async function switchMode(m) {
    if (m === mode) return;
    setMode(m);
    setAspect(m === 'longform' ? '16:9' : '9:16');
    // 모드별 보관된 대본으로 전환 (없으면 빈 화면). 롱폼/쇼츠 대본은 독립.
    try { const r = await api.setMode({ mode: m }); if (r && r.queue) setQueue(r.queue); setDto(r ? r.dto : null); setFtitle(r && r.dto ? (r.dto.fileTitle || '') : ''); }
    catch (e) { logline('모드 전환 오류: ' + e.message); }
  }
}

// ── 카드 목록 (편별 그룹/컷) ──────────────────────────────
function Cards({ dto, isLf, capCharsN, onTts, onImg, onVid, onBulk, onPlayShorts, onPlayGroup, onRegen, onMake, onVrew, onAttach, onClear, onTitleField, onPreview, onPlayFrom, onGroupTts, onGroupVid, onShowPrompt, onSplit }) {
  if (!dto || !dto.projects.length) {
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
            <h2>🎞 {dto.fileTitle ? `${dto.fileTitle} | ` : ''}{pr.title} <span className="meta">({pr.aspect} · {pr.cuts.length}컷)</span>
              {total > 0 && <span className="total">합계 {total.toFixed(1)}초{rtf != null && <span className="rtf" title="RTF = TTS 생성시간 ÷ 음성길이 (낮을수록 빠름)">│ RTF {rtf.toFixed(2)}</span>}</span>}
              <span className="cardbtns">
                <button className="ghost" onClick={() => onTts(pr.shortsNum)}>🎤 TTS</button>
                <button className="ghost" onClick={() => onImg(pr.shortsNum)}>🖼 이미지</button>
                <button className="ghost" title="폴더 선택 → 파일명 숫자로 그룹 자동첨부" onClick={() => onBulk(pr.shortsNum)}>📎 일괄첨부</button>
                <button className="ghost" onClick={() => onVid(pr.shortsNum)}>🎬 영상</button>
                <button className="ghost" onClick={() => onPlayShorts(pr.shortsNum)}>▶ 미리보기</button>
                <button className="ghost" onClick={() => onMake(pr.shortsNum)}>⚡ 만들기</button>
                <button onClick={() => onVrew(pr.shortsNum)}>💾 .vrew</button>
              </span>
            </h2>
            {!isLf && <TitleEditor pr={pr} onTitleField={onTitleField} />}
            <div className={'cuts-grid' + (isLf ? ' lf' : '')}>
              {pr.cuts.map((c) => {
                const ph = phaseBadge(c.phase, isLf);
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
                            <button className="gprev" title="이 그룹 이미지 프롬프트 보기" onClick={() => onShowPrompt(c, `${pr.title} · G${c.num}`)}>📝</button>
                          </div>
                        </div>
                        <div className="narr-text"><span className={'badge ' + ph[0]}>{ph[1]}</span></div>
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
