'use strict';

/**
 * Node http/https 기반 GET 헬퍼.
 * Electron renderer 에서 fetch() 대신 사용하면 Chromium DevTools 콘솔에
 * 빨간 네트워크 에러가 찍히지 않음 (Node 소켓은 Chromium 네트워크 스택 우회).
 *
 * 반환값: { status, ok, json(), text() }  — fetch Response 유사 인터페이스
 * 실패·타임아웃 시: { status: 0, ok: false, error: string }  (절대 throw 안 함)
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: object }} [opts]
 * @returns {Promise<{status:number, ok:boolean, json:()=>Promise<any>, text:()=>Promise<string>, error?:string}>}
 */
function quietGet(url, opts = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) {
      return resolve({ status: 0, ok: false, error: 'invalid url' });
    }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const req = lib.get({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : defaultPort,
      path: (u.pathname || '/') + (u.search || ''),
      headers: opts.headers || {},
      timeout: opts.timeoutMs || 3000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(body.toString('utf-8')),
          text: async () => body.toString('utf-8'),
        });
      });
      res.on('error', e => resolve({ status: 0, ok: false, error: e.message }));
    });

    req.on('error',   e => resolve({ status: 0, ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
  });
}

/**
 * POST + JSON body 헬퍼 — fetch 대용, 콘솔 에러 안 찍힘 (Node 소켓 사용).
 * 429/500 같은 응답도 throw 하지 않고 그대로 status 반환.
 *
 * @param {string} url
 * @param {object} jsonBody
 * @param {{ timeoutMs?: number, headers?: object }} [opts]
 * @returns {Promise<{status:number, ok:boolean, json:()=>Promise<any>, text:()=>Promise<string>, error?:string}>}
 */
function quietPostJson(url, jsonBody, opts = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) {
      return resolve({ status: 0, ok: false, error: 'invalid url' });
    }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const payload = Buffer.from(JSON.stringify(jsonBody || {}), 'utf-8');
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port ? Number(u.port) : defaultPort,
      path: (u.pathname || '/') + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(opts.headers || {}),
      },
      timeout: opts.timeoutMs || 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(body.toString('utf-8')),
          text: async () => body.toString('utf-8'),
        });
      });
      res.on('error', e => resolve({ status: 0, ok: false, error: e.message }));
    });

    req.on('error',   e => resolve({ status: 0, ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = { quietGet, quietPostJson };
