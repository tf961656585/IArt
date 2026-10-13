'use client';

import { memo, useState } from 'react';
import type { JSX } from 'react';
import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';
import { AssetPreviewDialog } from './AssetPreviewDialog';

/**
 * Agent 回复的 markdown 渲染（会话历史消息与流式增量共用）。
 *
 * 底座 streamdown（仓库既有依赖，为流式 LLM 输出设计）：globals.css 已 @source 扫描其类名、
 * `@custom-variant dark` 已指向应用主题 class，代码块双主题随应用深浅色走。
 * 面板形态覆盖：mermaid 控件关闭（窄面板不承载图渲染操作），代码/表格复制保留；
 * 静态历史用 `mode="static"`，流式增量用 `mode="streaming"`（未闭合块写到一半也稳定呈现）。
 *
 * 排版约束（批次 C）：正文 13px/1.6、标题固定 14px semibold、表格外包滚动容器 + 1px 边框 +
 * 圆角 + 表头 bg-secondary/40、代码块 max-h-72 内滚且滚动链不外溢、引用块左 2px border + muted、
 * 正文内图片块级满宽 + max-h-320 + contain。约束以选择器挂在渲染容器上（组件内单点，
 * 不进 globals.css——那是全局门禁文件），颜色走令牌工具类而非 CSS 里的裸 var()。
 *
 * 正文内图片：走 streamdown 的 `components.img` 扩展点渲染成可聚焦的预览触发器（点击 / Enter /
 * 空格开资产预览）——比在容器上做事件委托多一条键盘通路，也让图片只有一个交互语义。
 */

// 模块级常量：Streamdown 的 memo 按 controls / components 引用比较，内联对象会每次破坏命中。
const STREAMDOWN_CONTROLS = { mermaid: false } as const;

/** 正文内图片的可访问预览触发器（图片来自消息正文，无字幕/下载语义）。 */
const MarkdownImage = ({ src, alt }: JSX.IntrinsicElements['img']): JSX.Element | null => {
  const [previewOpen, setPreviewOpen] = useState(false);
  if (typeof src !== 'string' || src === '') return null;
  const name = alt !== undefined && alt !== '' ? alt : '图片';
  return (
    <>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label={`预览 ${name}`}
        data-testid="agent-markdown-image-trigger"
        className="block w-full cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 本地媒体（local-media 作用域地址），无优化管线可接 */}
        <img
          src={src}
          alt={alt ?? ''}
          className="block h-auto max-h-80 w-full rounded-lg object-contain"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </button>
      <AssetPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        mediaType="image"
        previewUrl={src}
        name={name}
      />
    </>
  );
};

const STREAMDOWN_COMPONENTS = { img: MarkdownImage } as const;

/**
 * markdown 元素约束（单点定义）。选择器建立在 streamdown 的 `data-streamdown` 标记上
 * （heading-* / table-* / code-block-body / blockquote），不依赖其内部类名。
 */
const MARKDOWN_ELEMENT_CLASSES = cn(
  // 正文 13px / 1.6；首尾块不留外距（容器已有留白）
  'text-[13px] leading-[1.6] break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  // 标题固定 14px semibold（右栏窄，标题只作层级分隔，不随层级放大）
  '[&_[data-streamdown^=heading]]:text-sm [&_[data-streamdown^=heading]]:font-semibold',
  // 表格：外包滚动容器 + 1px 边框 + 圆角；表头 bg-secondary/40；表体去掉自带边框
  '[&_[data-streamdown=table-wrapper]>div:last-child]:overflow-x-auto',
  '[&_[data-streamdown=table-wrapper]>div:last-child]:rounded-md',
  '[&_[data-streamdown=table-wrapper]>div:last-child]:border',
  '[&_[data-streamdown=table]]:border-0',
  '[&_[data-streamdown=table-header]]:bg-secondary/40',
  // 代码块：max-h-72 内滚 + 滚动链不外溢（滚到底不带动外层会话流）
  '[&_[data-streamdown=code-block-body]]:max-h-72',
  '[&_[data-streamdown=code-block-body]]:overflow-auto',
  '[&_[data-streamdown=code-block-body]]:overscroll-contain',
  // 引用块：左 2px border + muted
  '[&_[data-streamdown=blockquote]]:border-l-2',
  '[&_[data-streamdown=blockquote]]:text-muted-foreground',
);

export const AgentMessageMarkdown = memo(
  ({
    text,
    streaming = false,
    className,
  }: {
    text: string;
    streaming?: boolean;
    className?: string;
  }) => (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      controls={STREAMDOWN_CONTROLS}
      components={STREAMDOWN_COMPONENTS}
      className={cn(MARKDOWN_ELEMENT_CLASSES, className)}
    >
      {text}
    </Streamdown>
  ),
  (prev, next) => prev.text === next.text && prev.streaming === next.streaming,
);

AgentMessageMarkdown.displayName = 'AgentMessageMarkdown';

export default AgentMessageMarkdown;
