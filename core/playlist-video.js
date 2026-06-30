'use strict';

/**
 * playlist-video.js — '플리'(음악) → 배경 무한루프 영상 + .vrew 조립용 헬퍼.
 *
 *  ① makeBoomerang(src, out)      : LTX 짧은 클립 → 부메랑(정방향+역방향)으로 시작=끝 일치(끊김 제거).
 *  ② loopBoomerangTo(bm, out, sec): 부메랑을 sec 초까지 반복(stream copy, 빠름) → 곡 길이 배경.
 *  ③ buildPlaylistProject(parsed, opts): 트랙 목록 → vrew-builder 가 먹는 Project.
 *       곡 1개 = 그룹 1개(배경 루프 영상) + 문장 1개(곡 제목=자막, 오디오=곡 mp3).
 *
 * 배경은 "끊김이 티 안 나는" 반복 영상이어야 해서 부메랑으로 seamless 를 보장한다.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MU = require('./media-utils');
const { Sentence, Group, Project, makeSentenceIder, finalizeGroupIds } = require('./project-model');

function _ff(args) {
  const bin = MU.getFfmpegPath();
  if (!bin || !fs.existsSync(bin)) return Promise.reject(new Error('ffmpeg-static 바이너리를 찾을 수 없습니다.'));
  return new Promise((resolve, reject) => {
    let err = '';
    const ch = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ch.stderr.on('data', (c) => { err += c.toString(); if (err.length > 16384) err = err.slice(-16384); });
    ch.on('error', (e) => reject(new Error('ffmpeg 실행 실패: ' + e.message)));
    ch.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg 종료 ${code}\n${err.split('\n').slice(-5).join('\n')}`)));
  });
}

// ① 부메랑(정방향+역방향) — 시작=끝 → 반복해도 끊김 없음. 오디오 제거.
async function makeBoomerang(srcMp4, outMp4, logger = () => {}) {
  if (!srcMp4 || !fs.existsSync(srcMp4)) throw new Error('원본 클립 없음: ' + srcMp4);
  logger('🔁 배경 부메랑 생성(끊김 제거)…');
  await _ff(['-y', '-i', srcMp4,
    '-filter_complex', '[0:v]reverse[r];[0:v][r]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', outMp4]);
  if (!fs.existsSync(outMp4)) throw new Error('부메랑 생성 실패');
  return outMp4;
}

// ② 부메랑을 targetSec(+여유 3초) 까지 반복 — stream copy 라 빠르고 화질 손실 없음.
async function loopBoomerangTo(boomerangMp4, outMp4, targetSec) {
  if (!boomerangMp4 || !fs.existsSync(boomerangMp4)) throw new Error('부메랑 없음: ' + boomerangMp4);
  const tgt = Math.max(2, Math.ceil(Number(targetSec) || 60) + 1); // 오디오보다 아주 살짝 길게(끝 검은화면 방지, 잔여 최소화)
  await _ff(['-y', '-stream_loop', '-1', '-i', boomerangMp4, '-t', String(tgt), '-an', '-c', 'copy', outMp4]);
  if (!fs.existsSync(outMp4)) throw new Error('루프 영상 생성 실패');
  return outMp4;
}

// ③ 트랙 목록 → Project. 곡마다 t._bgLoop(곡 길이 배경 루프) 가 있으면 그 그룹 videoPath 로.
function buildPlaylistProject(parsed, opts = {}) {
  const bgImagePath = opts.bgImagePath || null;
  const sid = makeSentenceIder();
  const sentences = [];
  const groups = [];
  for (const t of (parsed.tracks || [])) {
    if (!t.audioPath || !fs.existsSync(t.audioPath)) continue; // 음악 없는 곡은 영상에서 제외
    const title = t.title || `트랙 ${t.num}`;
    const s = new Sentence({ id: sid(title), num: t.num, text: title });
    s.ttsAudioPath = t.audioPath;
    s.ttsDurationSec = t.durationSec || 180;
    s.ttsStatus = 'done';
    sentences.push(s);
    const g = new Group({ num: t.num, sentenceIds: [s.id] });
    g.imagePrompt = 'playlist background';      // 빈값 아님(시각 그룹으로 인식)
    g.imagePath = bgImagePath;                  // 영상 실패 시 이미지 폴백
    const loop = (t._bgLoop && fs.existsSync(t._bgLoop)) ? t._bgLoop : null;
    g.videoPath = loop;
    g.videoStatus = loop ? 'done' : 'idle';
    groups.push(g);
  }
  finalizeGroupIds(groups, sentences);
  const proj = new Project({ sentences, groups });
  proj.mode = 'longform';
  proj.aspect = '16:9';        // 플리 = 유튜브 롱폼 가로
  proj.title = parsed.fileTitle || '플레이리스트';
  proj.shortsNum = 1;
  return proj;
}

module.exports = { makeBoomerang, loopBoomerangTo, buildPlaylistProject };
