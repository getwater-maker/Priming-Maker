import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 렌더러(React)만 빌드. Electron main/preload 은 별도(소스 그대로 실행).
//   dev:  vite dev server (HMR) → main.js 가 PM_DEV_URL 로드
//   prod: renderer/dist/index.html 정적 파일 → main.js 가 loadFile
export default defineConfig({
  root: 'renderer',
  base: './',                       // file:// 로딩을 위해 상대경로 자산
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
