// preload.js 가 contextBridge 로 노출한 window.api 래퍼.
// Vite dev server 를 일반 브라우저로 열었을 때(window.api 없음) 크래시 방지용 폴백 포함.
const noop = async () => null;
const api =
  (typeof window !== 'undefined' && window.api)
    ? window.api
    : new Proxy({}, { get: () => noop });

export default api;
