import React from 'react';

export interface PageContainerProps extends React.PropsWithChildren {
  /** 右上角操作区（按钮、开关等） */
  actions: React.ReactNode | undefined;
  /** 内容区之间的垂直间距（MUI spacing 单位），默认 3 -> 24px */
  spacing: number | undefined;
  /** 是否让主体内容成为可滚动容器（默认 true）。若为 false，则由子内容自行管理滚动。 */
  bodyScrollable: boolean | undefined;
}

/**
 * PageContainer：主内容容器基类
 * - 统一提供页面内容的垂直间距与动作区域
 * - spacing 控制正文内容块的默认间距（默认 24px），可按需调整
 */
export const PageContainer: React.FC<PageContainerProps> = (props) => {
  const { actions, spacing = 3, bodyScrollable = true, children } = props;
  const gapPx = Math.round((Number.isFinite(spacing) ? spacing : 3) * 8);

  return (
    <section className="flex flex-1 min-h-0 flex-col" style={{ gap: gapPx }}>
      {actions && (
        <div className="flex flex-wrap justify-end gap-2 shrink-0">{actions}</div>
      )}
      <div
        className={[
          "flex flex-1 min-h-0 flex-col overflow-x-hidden",
          bodyScrollable ? "overflow-y-auto" : "overflow-y-hidden",
        ].join(" ")}
        style={{
          gap: gapPx,
          // 仅当主体可滚动时才预留底部空间；否则交由子容器自行处理
          paddingBottom: bodyScrollable ? 'var(--prompt-dock-height, 0px)' : 0,
        }}
      >
        {children}
      </div>
    </section>
  );
};
