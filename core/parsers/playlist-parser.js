'use strict';

/**
 * playlist-parser.js — '플리'(ACE-Step 음악) 스펙(.md) 파서.
 *
 * 클로드가 채팅에서 생성하는 플리 스펙 파일을 앱이 '열기'로 불러와 곡 목록을 만든다.
 * 사용자가 직접 쓰기보다 클로드가 자동 생성 → 사람이 읽기 쉬운 마크다운 형식.
 *
 * 형식:
 *   # 🎵 플리: <플레이리스트/채널 제목>
 *   > 컨셉: <한 줄 설명>            (선택)
 *
 *   ## 01 · <트랙 제목>
 *   - tags: `solo piano, ambient, cinematic, slow, 60 BPM, A minor, instrumental`
 *   - lyrics: (instrumental)        (없거나 (instrumental) 면 보컬 없음)
 *   - length: 180                   (초)
 *
 * 라벨 별칭: tags=스타일, lyrics=가사, length=길이/duration.
 *
 * 결과: { kind:'playlist', fileTitle, concept, tracks:[{num,title,tags,lyrics,durationSec}] }
 */

// `백틱` 안 내용 우선, 없으면 콜론 뒤 전체.
function fieldValue(line) {
  const m = line.match(/`([^`]*)`/);
  if (m) return m[1].trim();
  const c = line.indexOf(':');
  return c >= 0 ? line.slice(c + 1).trim() : line.trim();
}

function isInstrumental(lyrics) {
  const s = (lyrics || '').trim().toLowerCase();
  return !s || /^\(?\s*(instrumental|inst\.?|연주곡|인스트루멘탈|보컬\s*없음|no\s*vocals?)\s*\)?$/.test(s);
}

function parsePlaylistText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let fileTitle = '플레이리스트';
  let concept = '';
  const tracks = [];
  let cur = null;
  let order = 0;

  const pushCur = () => {
    if (!cur) return;
    cur.lyrics = isInstrumental(cur.lyrics) ? '' : cur.lyrics;
    if (!cur.durationSec || cur.durationSec <= 0) cur.durationSec = 180; // 기본 3분
    tracks.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // H1 제목
    let m = line.match(/^#\s+(.*)$/);
    if (m) { fileTitle = m[1].replace(/^🎵\s*/, '').replace(/^플리\s*[:：]\s*/, '').trim() || fileTitle; continue; }
    // 컨셉(> 인용 또는 '컨셉:')
    m = line.match(/^>\s*(?:컨셉|concept)\s*[:：]\s*(.*)$/i) || line.match(/^>\s*(.*)$/);
    if (m && !concept) { concept = m[1].trim(); continue; }
    // 트랙 헤더 ## NN · 제목  (NN 없어도 됨)
    m = line.match(/^##\s+(?:(\d+)\s*[·.\-]\s*)?(.*)$/);
    if (m) {
      pushCur();
      order += 1;
      cur = { num: m[1] ? parseInt(m[1], 10) : order, title: (m[2] || `트랙 ${order}`).trim(), tags: '', lyrics: '', durationSec: 0 };
      continue;
    }
    if (!cur) continue;
    // 필드 — 불릿(- ) 제거 후 라벨 매칭
    const body = line.replace(/^[-*]\s*/, '');
    if (/^(tags|스타일)\s*[:：]/i.test(body)) cur.tags = fieldValue(body);
    else if (/^(lyrics|가사)\s*[:：]/i.test(body)) cur.lyrics = fieldValue(body);
    else if (/^(length|duration|길이)\s*[:：]/i.test(body)) {
      const v = fieldValue(body).match(/\d+/);
      cur.durationSec = v ? parseInt(v[0], 10) : 0;
    }
  }
  pushCur();

  // num 누락/중복 보정 — 순서대로 1..N 재부여(빈값일 때만)
  tracks.forEach((t, i) => { if (!t.num || isNaN(t.num)) t.num = i + 1; });
  return { kind: 'playlist', fileTitle, concept, tracks };
}

module.exports = { parsePlaylistText, isInstrumental };
