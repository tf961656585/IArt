'use client';

import { useState } from 'react';
import { IconDots } from '@tabler/icons-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import { updateAgentSessionConfig, useAgentSessionMeta } from '@/features/agent/agentSessionStore';
import type { PromptDockApproval } from '../PromptDock.types';
import { PROMPT_DOCK_THINKING_OFF } from '../PromptDock.types';
import { resolveAgentFormSelection } from '../promptDockAgentSession';
import { describeDeploymentFailure } from '../deploymentFailureText';
import { usePromptDockStore } from '../promptDockStore';

/**
 * Agent 形态次行左侧的配置簇（spec docs/agent/06「agent 形态的输入面」）：模型 / 思考 / 审批三项。
 *
 * 紧凑规格（h-7 px-2 text-xs），行内不换行；dock 窄于 480px（容器查询）时思考与审批
 * 收进「…」溢出菜单，模型保位——次行右端的发送按钮位置不随降级变化。
 *
 * 候选来源：对话模型目录（`GET /api/chat-model-catalog`，Runtime Backend 投影）。
 * 思考档位只列该模型目录条目给的 `thinking_tiers` 加「不思考」——档位可用性由后端按启用关系
 * 与连接协议算好（spec 37「思考档位」），创作面不自行推断、不补默认值。
 * 审批切到自动执行需要显式确认（spec 05「选择与切换」）：连续派发会真实产生费用。
 *
 * 续作既有会话（「使用 agent」）时三项配置以会话为准（spec 03「会话归属」）：模型是会话配置、
 * 不提供更换入口（要继续其他模型需另开 Agent 节点）；思考与审批可改，改动随会话落库。
 */
export function PromptDockAgentServiceRow() {
  const chatCatalog = usePromptDockStore((state) => state.chatCatalog);
  const formSelection = usePromptDockStore((state) => state.agentSelection);
  const binding = usePromptDockStore((state) => state.agentBinding);
  const selectAgentModel = usePromptDockStore((state) => state.selectAgentModel);
  const setAgentSelection = usePromptDockStore((state) => state.setAgentSelection);
  const setAgentThinkingTier = usePromptDockStore((state) => state.setAgentThinkingTier);
  const [approvalConfirming, setApprovalConfirming] = useState(false);

  const session = useAgentSessionMeta(binding === null ? null : binding.agentSessionId);
  const isBound = binding !== null && session !== null;
  const selection = resolveAgentFormSelection(binding, session, formSelection);

  const entry: PromptDockChatCatalogEntry | null =
    selection.modelId === null
      ? null
      : chatCatalog.find((item) => item.model_id === selection.modelId) ?? null;
  // 续作会话时该模型的目录条目可能已不在候选里：保留当前档位在列，避免选择器显示空值。
  const thinkingOptions = Array.from(
    new Set([PROMPT_DOCK_THINKING_OFF, ...(entry?.thinking_tiers ?? []), selection.thinkingTier]),
  );
  const deploymentHint = entry !== null && entry.deployment.deployable !== true
    ? describeDeploymentFailure(entry.deployment.failure_code)
    : '';

  const applyThinkingTier = (thinkingTier: string): void => {
    if (isBound) {
      void updateAgentSessionConfig(session.agentSessionId, { thinkingTier });
      return;
    }
    // 走独立动作而不是通用补丁：这条会标记「用户改过档位」，换模型时据此决定要不要套用新模型的默认档位
    setAgentThinkingTier(thinkingTier);
  };

  const applyApproval = (approval: PromptDockApproval): void => {
    if (isBound) {
      void updateAgentSessionConfig(session.agentSessionId, { approvalMode: approval });
      return;
    }
    setAgentSelection({ approval });
  };

  // 审批切换的公共入口（inline 选择器与溢出菜单共用）：自动执行需要先确认（spec 05）。
  const requestApproval = (value: string): void => {
    const approval = value as PromptDockApproval;
    if (approval === 'yolo') {
      setApprovalConfirming(true);
      return;
    }
    applyApproval(approval);
  };

  const thinkingMenu = (tier: string): string => (tier === PROMPT_DOCK_THINKING_OFF ? '不思考' : tier);

  return (
    <div className="dock-form-content flex min-w-0 items-center gap-2" data-testid="promptdock-agent-service-row">
      <span className="text-xs whitespace-nowrap text-muted-foreground">模型</span>
      {isBound ? (
        // 会话的模型在会话创建时定下：这里只显示它，不提供更换入口（spec 03「会话归属」）。
        <span
          className="flex h-7 items-center rounded-lg border border-border bg-secondary px-2 text-xs font-medium text-foreground"
          data-testid="promptdock-agent-model-readonly"
        >
          {selection.modelId}
        </span>
      ) : (
        <Select
          value={selection.modelId ?? ''}
          onValueChange={(modelId) => selectAgentModel(modelId)}
        >
          <SelectTrigger
            size="sm"
            className="h-7 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 text-xs font-medium text-foreground whitespace-nowrap hover:border-input"
            data-testid="promptdock-agent-model"
            aria-label="选择模型"
          >
            {/* 占位只说明「没有可用的模型」；动作指引由前置校验的阻断条承担，不两处说同一件事 */}
            <SelectValue placeholder={chatCatalog.length === 0 ? '还没有可用的模型' : '选择模型'} />
          </SelectTrigger>
          <SelectContent side="top" align="start">
            {chatCatalog.map((item) => (
              <SelectItem key={item.model_id} value={item.model_id}>
                {item.model_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* 宽度够时思考 / 审批平铺；窄容器（<480px）隐藏，收进下方溢出菜单 */}
      <div
        className="hidden items-center gap-2 @min-[480px]:flex"
        data-testid="promptdock-agent-service-inline"
      >
        <div aria-hidden="true" className="h-4 w-px bg-border" />

        <span className="text-xs whitespace-nowrap text-muted-foreground">思考</span>
        <Select
          value={selection.thinkingTier}
          onValueChange={applyThinkingTier}
        >
          <SelectTrigger
            size="sm"
            className="h-7 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 text-xs text-foreground whitespace-nowrap hover:border-input"
            data-testid="promptdock-agent-thinking"
            aria-label="选择思考档位"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top" align="start">
            {thinkingOptions.map((tier) => (
              <SelectItem key={tier} value={tier}>
                {thinkingMenu(tier)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div aria-hidden="true" className="h-4 w-px bg-border" />

        <span className="text-xs whitespace-nowrap text-muted-foreground">审批</span>
        <Select
          value={selection.approval}
          onValueChange={requestApproval}
        >
          <SelectTrigger
            size="sm"
            className="h-7 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 text-xs text-foreground whitespace-nowrap hover:border-input"
            data-testid="promptdock-agent-approval"
            aria-label="选择审批"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top" align="start">
            <SelectItem value="confirm">逐条确认</SelectItem>
            <SelectItem value="yolo">自动执行</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 窄容器降级（<480px）：思考 / 审批收进溢出菜单，模型与右端发送按钮位置不变 */}
      <div className="hidden @max-[479px]:block">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label="思考与审批"
              data-testid="promptdock-agent-more"
            >
              <IconDots size={16} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={6}
            className="z-dock-popover w-48"
          >
            <DropdownMenuLabel>思考</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selection.thinkingTier}
              onValueChange={applyThinkingTier}
            >
              {thinkingOptions.map((tier) => (
                <DropdownMenuRadioItem key={tier} value={tier}>
                  {thinkingMenu(tier)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>审批</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selection.approval}
              onValueChange={requestApproval}
            >
              <DropdownMenuRadioItem value="confirm">逐条确认</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="yolo">自动执行</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {deploymentHint !== '' ? (
        <span
          className="min-w-0 truncate text-[11px] text-muted-foreground"
          title={deploymentHint}
          data-testid="promptdock-agent-deployment-hint"
        >
          {deploymentHint}
        </span>
      ) : null}

      <Dialog open={approvalConfirming} onOpenChange={(next) => { if (!next) setApprovalConfirming(false); }}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>改成自动执行？</DialogTitle>
            <DialogDescription className="text-xs">
              此后每次生成都会直接开始，不再逐条问你，过程中会持续产生费用。想停下时，改回「逐条确认」即可。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setApprovalConfirming(false)}>取消</Button>
            <Button
              type="button"
              onClick={() => {
                applyApproval('yolo');
                setApprovalConfirming(false);
              }}
            >
              改成自动执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
