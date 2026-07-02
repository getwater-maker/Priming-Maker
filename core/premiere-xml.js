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
const toFrames = (sec) => Math.max(1, Math.round((Number(sec) || 0) * FPS));

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
 * @param {{ outPath: string, log?: fn }} a
 * @returns {Promise<{success:boolean, xmlPath?:string, error?:string}>}
 */
async function buildPremiereXml(project, a) {
  const log = a.log || (() => {});
  try {
    const vertical = project.aspect === '9:16';
    const square = project.aspect === '1:1';
    const W = vertical ? 1080 : square ? 1080 : 1920;
    const H = vertical ? 1920 : 1080;

    // 그룹별 타임라인 구간 계산 (문장 TTS 누적 — vrew 와 동일)
    let cursor = 0; // 초
    const videoClips = [];
    const audioClips = [];
    let fileSeq = 0;
    for (const g of project.groups) {
      const sents = project.getSentencesOfGroup(g);
      const gDur = sents.reduce((acc, s) => acc + (s.ttsDurationSec || 0), 0);
      if (gDur <= 0) continue;
      const gStart = cursor;

      // A1 — 문장 오디오 순차
      for (const s of sents) {
        const d = s.ttsDurationSec || 0;
        if (d > 0 && s.ttsAudioPath && fs.existsSync(s.ttsAudioPath)) {
          audioClips.push({ id: ++fileSeq, path: s.ttsAudioPath, name: `tts_${String(s.num).padStart(3, '0')}`, start: cursor, dur: d, mediaDur: d });
        }
        cursor += d;
      }

      // V1 — 비디오(있으면) 또는 이미지 스틸
      const vid = g.videoPath && fs.existsSync(g.videoPath) ? g.videoPath : null;
      const img = g.imagePath && fs.existsSync(g.imagePath) ? g.imagePath : null;
      if (vid) {
        const md = (await mediaDurationSec(vid)) || gDur;
        // 비디오가 그룹보다 짧으면 남는 구간은 이미지(있으면)로 채움 — 미디어 범위 초과 방지
        const vDur = Math.min(md, gDur);
        videoClips.push({ id: ++fileSeq, path: vid, name: `G${g.num}`, start: gStart, dur: vDur, mediaDur: md, isVideo: true });
        if (vDur < gDur - 0.05 && img) {
          videoClips.push({ id: ++fileSeq, path: img, name: `G${g.num}_img`, start: gStart + vDur, dur: gDur - vDur, isVideo: false });
        }
      } else if (img) {
        videoClips.push({ id: ++fileSeq, path: img, name: `G${g.num}`, start: gStart, dur: gDur, isVideo: false });
      }
    }
    const totalFrames = toFrames(cursor);
    if (!audioClips.length && !videoClips.length) return { success: false, error: 'TTS·이미지가 없어 시퀀스를 만들 수 없습니다 (먼저 생성하세요)' };

    const rate = `<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>`;
    const fileXml = (c) => `<file id="file-${c.id}">
  <name>${esc(path.basename(c.path))}</name>
  <pathurl>${esc(pathUrl(c.path))}</pathurl>
  ${rate}
  ${c.mediaDur ? `<duration>${toFrames(c.mediaDur)}</duration>` : ''}
  <media>${c.isVideo === false ? `<video><samplecharacteristics><width>${W}</width><height>${H}</height></samplecharacteristics></video>`
    : c.isVideo ? `<video><samplecharacteristics><width>${W}</width><height>${H}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio>`
    : '<audio><channelcount>2</channelcount></audio>'}</media>
</file>`;

    const vItems = videoClips.map((c) => `<clipitem id="clip-${c.id}">
  <name>${esc(c.name)}</name>
  ${rate}
  <start>${toFrames(c.start)}</start><end>${toFrames(c.start + c.dur)}</end>
  <in>0</in><out>${toFrames(c.dur)}</out>
  ${fileXml(c)}
</clipitem>`).join('\n');

    const aItems = audioClips.map((c) => `<clipitem id="clip-${c.id}">
  <name>${esc(c.name)}</name>
  ${rate}
  <start>${toFrames(c.start)}</start><end>${toFrames(c.start + c.dur)}</end>
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
    log(`🎬 프리미어 XML — 비디오/이미지 클립 ${videoClips.length}개 · 오디오 ${audioClips.length}개 · ${cursor.toFixed(1)}초 (${W}×${H}@${FPS}fps) → ${path.basename(a.outPath)}`);
    log(`   Premiere: 파일 > 가져오기로 이 XML 열기 → 자막은 같은 폴더 .srt 를 캡션으로 가져오면 됩니다.`);
    return { success: true, xmlPath: a.outPath };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

module.exports = { buildPremiereXml };
