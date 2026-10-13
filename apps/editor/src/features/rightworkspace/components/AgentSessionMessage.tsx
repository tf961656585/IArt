'use client';

import { memo } from 'react';
import type { AgentMessageRecord, ChatMessageContent } from '@iart/contracts';
import { cn } from '@/lib/utils';
import { formatBeijingClock } from '@/shared/utils/time';
import { AgentMessageMarkdown } from './AgentMessageMarkdown';
import { MEDIA_PART_LABEL, UserMediaPart } from './AgentSessionMedia';

/**
 * 会话视图中的单条消息（spec docs/agent/02「会话视图与多轮历史」、06「工具提案交互」）。
 *
 * 视觉协议（批次 C）：边框只属于可交互控件；内容分层用填充差 + 留白表达。
 * - 用户消息：右对齐气泡（按内容收缩、右侧贴边），meta 行与气泡同侧；填充底无边框；
 * - Agent 回复：无盒平铺 markdown 左对齐，不印模型名（`model_id` 只在画布节点头部与工具条目出现）；
 * - 工具调用 / 结果条目卡：走工具活动组（`AgentSessionToolActivity`），本文件不做分派；
 * - 多模态 part 的媒体面走媒体统一件（`AgentSessionMedia`，图 / 视频海报 / 音频条 + 预览）；
 * - 只读为主：不提供输入框、不建第二生成入口，工具决裁出口收敛在批量审批面板
 *   （`AgentToolProposalPanel`，spec 05「Confirm 决裁流程」）。
 */

const ROLE_LABEL: Record<AgentMessageRecord['role'], string> = {
  user: '你',
  assistant: 'Agent',
  // 工具结果卡也是 Agent 的产出（工具是 Agent 干的），不向用户暴露「系统」这一层。
  system: 'Agent',
};

const DEGRADED_TEXT = '这条消息暂时没法显示。';

/** 消息 meta 行：角色 · 时间（北京时间，共享工具）；`alignEnd` 与用户气泡同侧右对齐。 */
const MessageMeta = ({
  label,
  createdAt,
  alignEnd = false,
}: {
  label: string;
  createdAt: number;
  alignEnd?: boolean;
}) => (
  <div
    className={cn(
      'flex items-center gap-1 text-[11px] text-muted-foreground',
      alignEnd && 'justify-end',
    )}
  >
    <span className="font-medium text-foreground">{label}</span>
    <span aria-hidden="true">·</span>
    <span>{formatBeijingClock(createdAt)}</span>
  </div>
);

const ChatContent = ({
  content,
  markdown,
}: {
  content: ChatMessageContent;
  markdown: boolean;
}) => {
  if (typeof content === 'string') {
    return markdown ? (
      <AgentMessageMarkdown text={content} />
    ) : (
      <p className="text-[13px] leading-[1.6] whitespace-pre-wrap break-words text-foreground">{content}</p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {content.map((part, index) => (
        <div key={`${part.type}-${index}`}>
          {part.type === 'text' ? (
            markdown ? (
              <AgentMessageMarkdown text={part.text} />
            ) : (
              <p className="text-[13px] leading-[1.6] whitespace-pre-wrap break-words text-foreground">{part.text}</p>
            )
          ) : (
            <UserMediaPart type={part.type} url={part.url} />
          )}
        </div>
      ))}
    </div>
  );
};

/** 消息体渲染（会话流消息与发送留痕投影共用）；工具条目走活动组，不在此分派。 */
export const MessageBody = ({ message }: { message: AgentMessageRecord }) => {
  if (message.body.kind === 'chat') {
    const isUser = message.role === 'user';
    if (isUser) {
      // 用户消息：右对齐气泡（按内容收缩，最多占面板 85%；右下角小圆角指向发送者那一侧）。
      // 外层 items-end 让 meta 行与气泡同侧，留痕投影（也是 role: user）走同一形态。
      return (
        <div className="flex w-full flex-col items-end gap-1">
          <MessageMeta label={ROLE_LABEL.user} createdAt={message.createdAt} alignEnd />
          <div
            className="w-fit max-w-[85%] rounded-2xl rounded-br-md bg-secondary/60 px-3 py-2"
            data-testid="agent-message-user-bubble"
          >
            <ChatContent content={message.body.content} markdown={false} />
          </div>
        </div>
      );
    }
    return (
      <>
        <MessageMeta label={ROLE_LABEL[message.role]} createdAt={message.createdAt} />
        {message.role === 'assistant' ? (
          <div className="min-w-0">
            <ChatContent content={message.body.content} markdown />
          </div>
        ) : (
          <p className="text-[13px] leading-[1.6] break-words text-muted-foreground">
            {typeof message.body.content === 'string'
              ? message.body.content
              : message.body.content.map((part, index) => (
                  <span key={index}>{part.type === 'text' ? part.text : MEDIA_PART_LABEL[part.type]}</span>
                ))}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <MessageMeta label={ROLE_LABEL.system} createdAt={message.createdAt} />
      <p className="text-[13px] text-muted-foreground">{DEGRADED_TEXT}</p>
    </>
  );
};

/** 单条消息（按消息对象引用 memo；长列表项 content-visibility 跳过屏外渲染）。 */
export const AgentSessionMessage = memo(function AgentSessionMessage({
  message,
}: {
  message: AgentMessageRecord;
}) {
  return (
    <article
      className="flex flex-col gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_160px]"
      data-testid="agent-session-message"
      data-role={message.role}
    >
      <MessageBody message={message} />
      {message.body.kind === 'chat' && message.isPartial ? (
        <span className="text-[11px] text-muted-foreground" data-testid="agent-message-partial">
          回复未完成
        </span>
      ) : null}
    </article>
  );
});

export default AgentSessionMessage;
