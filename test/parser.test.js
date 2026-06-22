/**
 * cut-script-parser 단위 검증 (순수 node, 외부 의존 없음).
 *   node test/parser.test.js
 * 폴더 내 실제 역사 대본 .md 들을 파싱해 구조 불변식을 단언한다.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { parseCutScript, parseCutScriptFile } = require('../core/cut-script-parser');

const SCRIPT_DIR = 'G:\\내 드라이브\\비디오\\01_유튜브채널\\02_한득수\\02_역사\\## 역사대본\\2026_06\\01_역사이야기\\02_쇼츠대본';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// ── 1) 합성 입력으로 핵심 매핑 단언 (파일 없이도 도는 회귀 테스트) ──
const SAMPLE = [
  '# [샘플] 제목  (쇼츠 대본 · 3개)',
  '',
  '> 목소리: 중후한 남성, OmniVoice · 9:16 · 업로드 분산',
  '',
  '## 쇼츠 1',
  '- 훅 자막(첫 프레임): 훅 문구 A',
  '- 컷 리스트 (설명 ...):',
  '  ① (훅) 첫 번째 나레이션입니다.',
  '     `9:16 vertical, scene: first prompt, no watermark`',
  '  ② (본론) 두 번째 나레이션입니다.',
  '     `9:16 vertical, scene: second prompt, no watermark`',
  '',
  '## 쇼츠 2',
  '- 훅 자막(첫 프레임): 훅 문구 B',
  '- 컷 리스트:',
  '  ① (훅) 두번째편 첫 나레이션.',
  '     `9:16 vertical, scene: b1, no watermark`',
].join('\n');

const r = parseCutScript(SAMPLE);
ok(r.projects.length === 2, 'sample: project 2개');
ok(r.meta.aspect === '9:16', 'sample: aspect 9:16');
ok(/중후한 남성/.test(r.meta.voice), 'sample: voice 추출');
const p1 = r.projects[0];
ok(p1.title === '쇼츠 1', 'sample: title 쇼츠 1');
ok(p1.aspect === '9:16', 'sample: project aspect 9:16');
ok(p1.hookCaption === '훅 문구 A', 'sample: hookCaption');
ok(p1.sentences.length === 2 && p1.groups.length === 2, 'sample: 컷 2개 → s2/g2');
ok(p1.sentences[0].text === '첫 번째 나레이션입니다.', 'sample: 나레이션 텍스트');
ok(p1.groups[0].imagePrompt === '9:16 vertical, scene: first prompt, no watermark', 'sample: imagePrompt 그대로');
ok(p1.groups[0].phase === '훅' && p1.groups[1].phase === '본론', 'sample: phase 매핑');
ok(p1.groups[0].sentenceIds[0] === p1.sentences[0].id, 'sample: group↔sentence 연결');

// ── 2) 실제 대본 파일들 (있으면) 구조 단언 ──
let files = [];
try {
  files = fs.readdirSync(SCRIPT_DIR).filter((f) => f.toLowerCase().endsWith('.md'));
} catch (e) {
  console.log('  (실제 대본 폴더 접근 불가 — 합성 테스트만 수행):', e.message);
}

for (const f of files) {
  const full = path.join(SCRIPT_DIR, f);
  const res = parseCutScriptFile(full);
  ok(res.projects.length >= 1, `${f}: project ≥1 (=${res.projects.length})`);
  ok(res.meta.aspect === '9:16', `${f}: aspect 9:16`);
  res.projects.forEach((pr, idx) => {
    ok(pr.groups.length > 0, `${f} 쇼츠${idx + 1}: 그룹 ≥1`);
    // 신규(그룹): 그룹당 문장 여러 개 → 문장 수 ≥ 그룹 수. 구(컷): 문장 수 == 그룹 수.
    ok(pr.sentences.length >= pr.groups.length, `${f} 쇼츠${idx + 1}: 문장≥그룹 (${pr.sentences.length}≥${pr.groups.length})`);
    pr.groups.forEach((g, gi) => {
      const sents = pr.getSentencesOfGroup(g);
      ok(sents.length >= 1 && sents.every((s) => s.text && s.text.length > 0), `${f} 쇼츠${idx + 1} 그룹${gi + 1}: 문장 존재`);
      // prose(줄글) 형식은 이미지 프롬프트가 없음 — 내보내기/가져오기로 생성하므로 단언 생략
      if (res.format !== 'prose') {
        ok(g.imagePrompt && g.imagePrompt.length > 10, `${f} 쇼츠${idx + 1} 그룹${gi + 1}: imagePrompt 존재`);
      }
      // 신규형식이면 I2V 그룹은 videoPrompt 보유해야 함
      if (res.format === 'grouped' && g.isI2V) {
        ok(g.videoPrompt && g.videoPrompt.length > 10, `${f} 쇼츠${idx + 1} 그룹${gi + 1}: I2V videoPrompt 존재`);
      }
    });
  });
  console.log(`  ✓ ${f} [${res.format}] — projects=${res.projects.length}, 그룹=${res.projects.map((p) => p.groups.length).join('/')}, 문장=${res.projects.map((p) => p.sentences.length).join('/')}`);
}

console.log(`\n✅ PASS — 단언 ${pass}개 통과 (실제 파일 ${files.length}개 검사)`);
