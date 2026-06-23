'use strict';
// Genspark 멀티계정 — ~/.priming-maker/genspark-accounts.json (accounts.js 팩토리)
// defaultCap 0 = 무제한 — Genspark 은 일일 한도를 정확히 알 수 없고, Genspark 가 보내는
//   "휴식/한도" 안내 메시지를 엔진(_detectLimitMessage)이 감지했을 때만 Flow 로 전환한다.
//   따라서 앱 자체 캡으로 미리 막지 않는다. (Flow/Grok 은 45 유지)
module.exports = require('./accounts').makeAccountStore('genspark', 'gs', 0);
