import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 构建目标：单个 index.html（JS/CSS 全部内联），双击即可用，不需要本地服务。
 * 若某些浏览器对 file:// 有额外限制，运行 start.cmd 起一个本地静态服务兜底。
 */
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
});
