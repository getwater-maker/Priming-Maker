/**
 * LAN 자동 셋팅 — 클라이언트가 같은 네트워크의 OmniVoice 서버를 자동 발견.
 *
 * 운영 모드:
 *   GPU 컴퓨터 = OmniVoice 백엔드 (작업 스케줄러 자동 시동, 9881)
 *   PrimingFlow Electron = 출장/집 노트북 (이쪽이 클라이언트)
 *
 * UDP v2 프로토콜:
 *   요청: "PRIMINGFLOW_DISCOVER?"
 *   응답: "PRIMINGFLOW_HERE_V2:" + JSON({ engines: { omnivoice: {port:9881} } })
 */

'use strict';

const dgram = require('dgram');
const { setProvider } = require('./tts-config');

const DISCOVERY_PORT = 9893;
const OMNIVOICE_PORT = 9881;

/**
 * 클라이언트 모드 — LAN 에 브로드캐스트 후 첫 서버 응답 반환.
 * @returns {{ host: string, engines: object } | null}
 */
function discoverServer(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4' });
    let done = false;

    const finish = (val) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve(val);
    };

    sock.on('message', (msg, rinfo) => {
      const str = String(msg);
      const v2Match = str.match(/^PRIMINGFLOW_HERE_V2:(.+)$/);
      if (v2Match) {
        try {
          const data = JSON.parse(v2Match[1]);
          finish({ host: rinfo.address, engines: data.engines || {} });
          return;
        } catch { /* fall through */ }
      }
    });

    sock.on('error', () => finish(null));

    sock.bind(() => {
      sock.setBroadcast(true);
      const req = Buffer.from('PRIMINGFLOW_DISCOVER?');
      sock.send(req, DISCOVERY_PORT, '255.255.255.255');
      setTimeout(() => finish(null), timeoutMs);
    });
  });
}

/**
 * 앱 시작 시 한 번 호출. 같은 LAN 의 OmniVoice 서버를 발견하면 baseUrl 갱신.
 * 미발견 시 기존 설정(혹은 빈 baseUrl) 그대로 둠 — 사용자가 🖧 서버 모달에서 수동 입력 가능.
 */
async function bootstrapNetwork(logger = () => {}) {
  logger('[Net] OmniVoice 서버 탐색 중...');
  const found = await discoverServer();
  if (found && found.engines && found.engines.omnivoice) {
    const url = `http://${found.host}:${found.engines.omnivoice.port}`;
    setProvider('omnivoice', { baseUrl: url });
    logger(`[Net] OmniVoice 서버 발견: ${url}`);
  } else {
    logger('[Net] OmniVoice 서버 미발견 — 🖧 서버 모달에서 수동 설정 또는 Gemini 사용');
  }
  return 'client';
}

module.exports = { bootstrapNetwork, discoverServer };
