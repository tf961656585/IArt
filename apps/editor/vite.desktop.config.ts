import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const editorRoot = __dirname;

export default defineConfig({
  root: editorRoot,
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@iart\/contracts\/(.+)$/,
        replacement: path.resolve(editorRoot, '../../packages/contracts/src/$1.ts'),
      },
      {
        find: /^@iart\/ui\/(.+)$/,
        replacement: path.resolve(editorRoot, '../../packages/ui/src/$1.tsx'),
      },
      {
        find: '@iart/ui',
        replacement: path.resolve(editorRoot, '../../packages/ui/src/index.ts'),
      },
      {
        find: /^@iart\/backend-sdk\/(.+)$/,
        replacement: path.resolve(editorRoot, '../../packages/backend-sdk/src/$1.ts'),
      },
      {
        find: '@iart/contracts',
        replacement: path.resolve(editorRoot, '../../packages/contracts/src/index.ts'),
      },
      {
        find: '@iart/backend-sdk',
        replacement: path.resolve(editorRoot, '../../packages/backend-sdk/src/index.ts'),
      },
      {
        find: '@iart/domain',
        replacement: path.resolve(editorRoot, '../../packages/domain/src/index.ts'),
      },
      {
        find: /^@iart\/model-asset-runtime\/(.+)$/,
        replacement: path.resolve(editorRoot, '../../packages/model-asset-runtime/src/$1.ts'),
      },
      {
        find: '@iart/model-asset-runtime',
        replacement: path.resolve(editorRoot, '../../packages/model-asset-runtime/src/index.ts'),
      },
      {
        find: '@',
        replacement: path.resolve(editorRoot, 'src'),
      },
    ],
  },
  build: {
    outDir: path.resolve(editorRoot, 'dist-static'),
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
  },
});
