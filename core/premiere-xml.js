'use strict';

/**
 * premiere-xml.js — Project → Premiere Pro 임포트용 FCP7 XML(xmeml v4) 시퀀스.
 *
 * Premiere Pro(2025 포함)가 「파일 > 가져오기」로 읽는 Final Cut Pro XML 형식.
 * 임포트하면 시퀀스가 바로 열려 렌더(내보내기)까지 즉시 가능:
 *   V1 = 그룹별 비디오(mp4) 또는 이미지 스틸(그룹 TTS 길이만큼)
 *   A1 = 문장별 TTS 오디오(mp3) 순차 배치
 * 자막은 같은 폴더의 .srt 를 Premiere 「캡션 가져오기」로 얹으면 됨(안내 로그).
 *
 * 타임라인 배치는 vrew-builder 와 동일: 문장 TTS 길이 누적(그룹 = 그 그룹 문장들의 합).
 */

const fs = require('fs');
const path = require('path');

const FPS = 30;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// 절대경로 → xmeml pathurl (file://localhost/D%3a/dir/file.mp4)
function pathUrl(abs) {
  const norm = path.resolve(abs).replace(/\\/g, '/');
  const enc = norm.split('/').map((seg, i) =>
    i === 0 && /^[A-Za-z]:$/.test(seg) ? seg.replace(':', '%3a') : encodeURIComponent(seg)
  ).join('/');
  return 'file://localhost/' + enc;
}
const toFrames = (sec) => Math.max(1, Math.round((Number(sec) || 0) * FPS)); // 길이(최소 1프레임)
const posFrames = (sec) => Math.max(0, Math.round((Number(sec) || 0) * FPS)); // 타임라인 위치(0 허용)

// 미디어(mp4) 실측 길이 — ffmpeg. 실패 시 null.
async function mediaDurationSec(p) {
  try {
    const MU = require('./media-utils');
    const info = await MU.getMediaInfo(p);
    return info && info.durationSec > 0 ? info.durationSec : null;
  } catch (_) { return null; }
}

/**
 * @param {object} project  Project (sentences/groups/aspect/title)
 * @param {{ outPath: string, ttsDir?: string, log?: fn }} a
 * @returns {Promise<{success:boolean, xmlPath?:string, error?:string}>}
 */
async function buildPremiereXml(project, a) {
  const log = a.log || (() => {});
  try {
    const vertical = project.aspect === '9:16';
    const square = project.aspect === '1:1';
    const W = vertical ? 1080 : square ? 1080 : 1920;
    const H = vertical ? 1920 : 1080;

    // 문장 오디오 경로 해석 — tts 폴더 정본(`<num>.mp3/wav`) 우선, 없으면 s.ttsAudioPath.
    //   (s.ttsAudioPath 는 캐시/임시 경로일 수 있어 — 프리미어가 프로젝트 하위 tts-N 파일을 물게 한다)
    const resolveAudio = (s) => {
      if (a.ttsDir) {
        for (const ext of ['mp3', 'wav']) {
          const p = path.join(a.ttsDir, `${s.num}.${ext}`);
          if (fs.existsSync(p)) return p;
        }
      }
      if (s.ttsAudioPath && fs.existsSync(s.ttsAudioPath)) return s.ttsAudioPath;
      return null;
    };

    // 그룹별 타임라인 구간 계산 (문장 TTS 누적 — vrew 와 동일)
    let cursor = 0; // 초
    const videoClips = [];
    const audioClips = [];
    const missingAudio = [];
    let fileSeq = 0;
    for (const g of project.groups) {
      const sents = project.getSentencesOfGroup(g);
      const gDur = sents.reduce((acc, s) => acc + (s.ttsDurationSec || 0), 0);
      if (gDur <= 0) continue;
      const gStart = cursor;

      // A1 — 문장 오디오 순차 (파일명 = 실제 tts 파일 그대로, 예 "37.mp3")
      for (const s of sents) {
        const d = s.ttsDurationSec || 0;
        if (d > 0) {
          const ap = resolveAudio(s);
          if (ap) audioClips.push({ id: ++fileSeq, path: ap, name: path.basename(ap), start: cursor, dur: d, mediaDur: d });
          else missingAudio.push(s.num);
        }
        cursor += d;
      }

      // V1 — 비디오(있으면) 또는 이미지 스틸
      const vid = g.videoPath && fs.existsSync(g.videoPath) ? g.videoPath : null;
      const img = g.imagePath && fs.existsSync(g.imagePath) ? g.imagePath : null;
      if (vid) {
        const md = (await mediaDurationSec(vid)) || gDur;
        // 비디오가 그룹(음성)보다 짧으면 **반복 재생(루프)** 으로 그룹 전체를 채움 (예: 음성 14s, 영상 10s → 10+4).
        let off = 0, rep = 0;
        while (off < gDur - 0.05) {
          const vDur = Math.min(md, gDur - off);
          videoClips.push({ id: ++fileSeq, path: vid, name: rep === 0 ? `G${g.num}` : `G${g.num}_loop${rep}`, start: gStart + off, dur: vDur, mediaDur: md, isVideo: true });
          off += vDur; rep += 1;
          if (rep > 50) break; // 안전 상한
        }
      } else if (img) {
        videoClips.push({ id: ++fileSeq, path: img, name: `G${g.num}`, start: gStart, dur: gDur, isVideo: false, kb: g.num });
      }
    }
    // 이미지 실치수 → 화면 꽉 채움 스케일(%). Premiere 는 스틸을 원본 픽셀 그대로 놓으므로
    //   Basic Motion Scale 로 cover 배율을 직접 지정해야 1920×1080 을 가득 채운다.
    let readImageSize = null;
    try { readImageSize = require('../vrew/vrew-builder').readImageSize; } catch {}
    for (const c of videoClips) {
      if (c.isVideo !== false) continue;
      let iw = W, ih = H;
      try { const sz = readImageSize && readImageSize(c.path); if (sz && sz.w && sz.h) { iw = sz.w; ih = sz.h; } } catch {}
      c.imgW = iw; c.imgH = ih;
      c.fillScale = Math.max(W / iw, H / ih) * 100; // cover 배율(%)
    }
    const totalFrames = toFrames(cursor);
    if (!audioClips.length && !videoClips.length) return { success: false, error: 'TTS·이미지가 없어 시퀀스를 만들 수 없습니다 (먼저 생성하세요)' };

    const rate = `<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>`;
    const fileXml = (c) => `<file id="file-${c.id}">
  <name>${esc(path.basename(c.path))}</name>
  <pathurl>${esc(pathUrl(c.path))}</pathurl>
  ${rate}
  ${c.mediaDur ? `<duration>${toFrames(c.mediaDur)}</duration>` : ''}
  <media>${c.isVideo === false ? `<video><samplecharacteristics><width>${c.imgW || W}</width><height>${c.imgH || H}</height></samplecharacteristics></video>`
    : c.isVideo ? `<video><samplecharacteristics><width>${W}</width><height>${H}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio>`
    : '<audio><channelcount>2</channelcount></audio>'}</media>
</file>`;

    // 이미지 스틸용 Basic Motion(Scale) — cover 배율 + 켄번스(그룹 번호 홀짝으로 줌인/줌아웃 교차).
    //   ⚠ 키프레임 <when> 은 클립 상대(0..dur)가 아니라 **시퀀스(타임라인) 절대 프레임** — Premiere 가
    //   0..dur 로 주면 첫 키프레임 값(정지 스케일)만 읽고 애니메이션을 무시한다(실측). <value> = 폴백 정지값.
    const kenBurnsFilter = (c) => {
      if (c.isVideo !== false || !c.fillScale) return '';
      const f0 = posFrames(c.start), f1 = posFrames(c.start + c.dur);
      const s0 = c.fillScale, s1 = c.fillScale * 1.1; // 10% 줌
      const zoomIn = (Number(c.kb) || 0) % 2 === 1;   // G홀수=줌인, G짝수=줌아웃
      const from = (zoomIn ? s0 : s1).toFixed(2), to = (zoomIn ? s1 : s0).toFixed(2);
      return `
  <filter><effect>
    <name>Basic Motion</name><effectid>basic</effectid>
    <effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
    <parameter>
      <parameterid>scale</parameterid><name>Scale</name>
      <valuemin>0</valuemin><valuemax>10000</valuemax>
      <value>${from}</value>
      <keyframe><when>${f0}</when><value>${from}</value></keyframe>
      <keyframe><when>${f1}</when><value>${to}</value></keyframe>
    </parameter>
  </effect></filter>`;
    };

    const vItems = videoClips.map((c) => `<clipitem id="clip-${c.id}">
  <name>${esc(c.name)}</name>
  ${rate}
  <start>${posFrames(c.start)}</start><end>${posFrames(c.start + c.dur)}</end>
  <in>0</in><out>${toFrames(c.dur)}</out>
  ${fileXml(c)}${kenBurnsFilter(c)}
</clipitem>`).join('\n');

    const aItems = audioClips.map((c) => `<clipitem id="clip-${c.id}">
  <name>${esc(c.name)}</name>
  ${rate}
  <start>${posFrames(c.start)}</start><end>${posFrames(c.start + c.dur)}</end>
  <in>0</in><out>${toFrames(c.dur)}</out>
  ${fileXml(c)}
  <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
</clipitem>`).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="seq-1">
  <name>${esc(project.title || project.fileTitle || '시퀀스')}</name>
  <duration>${totalFrames}</duration>
  ${rate}
  <media>
    <video>
      <format><samplecharacteristics>
        ${rate}
        <width>${W}</width><height>${H}</height>
        <pixelaspectratio>square</pixelaspectratio>
        <anamorphic>FALSE</anamorphic>
      </samplecharacteristics></format>
      <track>
${vItems}
      </track>
    </video>
    <audio>
      <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
      <track>
${aItems}
      </track>
    </audio>
  </media>
</sequence>
</xmeml>`;

    fs.mkdirSync(path.dirname(a.outPath), { recursive: true });
    fs.writeFileSync(a.outPath, xml, 'utf8');
    if (missingAudio.length) log(`⚠ 음성 파일을 못 찾은 문장 ${missingAudio.length}개 (컷 ${missingAudio.slice(0, 10).join(',')}${missingAudio.length > 10 ? '…' : ''}) — 그 구간은 무음. 🎤 TTS 재변환 후 다시 내보내세요.`);
    log(`🎬 프리미어 XML — 비디오/이미지 클립 ${videoClips.length}개(이미지=화면 채움+켄번스) · 오디오 ${audioClips.length}개 · ${cursor.toFixed(1)}초 (${W}×${H}@${FPS}fps) → ${path.basename(a.outPath)}`);
    log(`   Premiere: 파일 > 가져오기로 이 XML 열기 → 자막은 같은 폴더 _premiere.srt 를 「캡션 가져오기」로 얹으세요.`);
    return { success: true, xmlPath: a.outPath };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

module.exports = { buildPremiereXml };
