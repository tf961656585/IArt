import path from 'node:path';
import fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const hubRoot = __dirname;

// html 入口位于 src/ 下时，vite 会按相对 root 的路径输出到 dist-static/src/index.html；
// desktop-shell 从 dist-static/index.html 加载 Hub，这里在 closeBundle 阶段把 html
// 平移到 dist-static 根，并把相对资源路径 ../assets/ 改写为 ./assets/。
const flattenIndexHtml = (): Plugin => ({
  name: 'hub-flatten-index-html',
  closeBundle() {
    const distRoot = path.resolve(hubRoot, 'dist-static');
    const nested = path.join(distRoot, 'src', 'index.html');
    const target = path.join(distRoot, 'index.html');
    if (!fs.existsSync(nested)) {
      throw new Error(`未找到 ${nested}，Hub html 输出结构不符合预期。`);
    }
    const html = fs
      .readFileSync(nested, 'utf8')
      .replaceAll('../assets/', './assets/');
    fs.writeFileSync(target, html, 'utf8');
    fs.rmSync(path.dirname(nested), { recursive: true, force: true });
  },
});

export default defineConfig({
  root: hubRoot,
  base: './',
  plugins: [react(), flattenIndexHtml()],
  resolve: {
    alias: [
      // @iart/* workspace 包：正则子路径直指 src + 裸包兜底 index.ts
      {
        find: /^@iart\/contracts\/(.+)$/,
        replacement: path.resolve(hubRoot, '../../packages/contracts/src/$1.ts'),
      },
      {
        find: '@iart/contracts',
        replacement: path.resolve(hubRoot, '../../packages/contracts/src/index.ts'),
      },
      {
        find: /^@iart\/backend-sdk\/(.+)$/,
        replacement: path.resolve(hubRoot, '../../packages/backend-sdk/src/$1.ts'),
      },
      {
        find: '@iart/backend-sdk',
        replacement: path.resolve(hubRoot, '../../packages/backend-sdk/src/index.ts'),
      },
      {
        find: /^@iart\/domain\/(.+)$/,
        replacement: path.resolve(hubRoot, '../../packages/domain/src/$1.ts'),
      },
      {
        find: '@iart/domain',
        replacement: path.resolve(hubRoot, '../../packages/domain/src/index.ts'),
      },
      // @iart/ui 共享组件包
      {
        find: /^@iart\/ui\/(.+)$/,
        replacement: path.resolve(hubRoot, '../../packages/ui/src/$1.tsx'),
      },
      {
        find: '@iart/ui',
        replacement: path.resolve(hubRoot, '../../packages/ui/src/index.ts'),
      },
    ],
  },
  build: {
    outDir: path.resolve(hubRoot, 'dist-static'),
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    rollupOptions: {
      // index.html 位于 src/ 下（root 保持 apps/hub，使 html 内 /src/hub-entry.tsx 可解析）
      input: path.resolve(hubRoot, 'src/index.html'),
    },
  },
});
