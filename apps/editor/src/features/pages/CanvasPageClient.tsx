'use client';

/**
 * 画板页面客户端组件
 */

import dynamic from 'next/dynamic';

// 动态导入画板编辑器（禁用 SSR，因为 React Flow 依赖 DOM）
const CanvasEditor = dynamic(
  () => import('@/features/canvas/components/CanvasEditor').then((mod) => mod.CanvasEditor),
  { ssr: false, loading: () => <CanvasLoading /> }
);

function CanvasLoading() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-muted-foreground">正在打开画布…</p>
      </div>
    </div>
  );
}

export function CanvasPageClient() {
  return (
    <div className="flex-1 flex flex-col min-h-0 h-full w-full">
      <CanvasEditor />
    </div>
  );
}

export default CanvasPageClient;
