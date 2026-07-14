// core/gemini-batch-store.js
// 제출한 Gemini 이미지 배치 job 기록 — ~/.shots-maker/gemini-batches.json (앱 재시작해도 유지).
//   job = { batchName, scriptPath, outRoot, title, model, items:[{key,shortsNum,groupNum}],
//           styleId, count, state, submittedAt, collected, collectedAt, saved }
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.shots-maker', 'gemini-batches.json');

function load() { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return (j && Array.isArray(j.jobs)) ? j : { jobs: [] }; } catch { return { jobs: [] }; } }
function save(d) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); } catch {} }
function list() { return load().jobs; }
function add(job) { const d = load(); d.jobs.push(job); save(d); return job; }
function update(batchName, patch) { const d = load(); d.jobs.forEach((j) => { if (j.batchName === batchName) Object.assign(j, patch); }); save(d); }
function remove(batchName) { const d = load(); d.jobs = d.jobs.filter((j) => j.batchName !== batchName); save(d); }
// 특정 대본의 '아직 회수 안 된' 최신 job
function pendingForScript(scriptPath) {
  return load().jobs.filter((j) => j.scriptPath === scriptPath && !j.collected).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0] || null;
}
module.exports = { list, add, update, remove, pendingForScript, FILE };
