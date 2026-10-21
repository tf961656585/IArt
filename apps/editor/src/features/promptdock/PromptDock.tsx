'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { AgentReferenceAssetBrief, ProjectMediaAssets } from '@iart/contracts';
import { fetchLocalBackendConfig } from '@/client/api/localConfig';
import { fetchChatModelCatalog, fetchExecutableModelCatalog } from '@/client/api/promptDockApi';
import type { PromptDockCatalogEntry, PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { submitAgentPrompt, useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { resolveAgentSubmitFailureText } from '@/features/agent/agentErrorText';
import { openAgentSessionView } from '@/features/rightworkspace/rightWorkspaceStore';
import { Button } from '@iart/ui';
import { focusHubModelProviders } from './hubFocus';
import { usePromptDockStore } from './promptDockStore';
import { createAgentLocalId, resolveAgentFormSelection } from './promptDockAgentSession';
import {
  runGenerationBatchSubmission,
  type ProgrammaticSubmitIntent,
} from './programmaticSubmission';
import { runPromptDockPreflight } from './promptDockPreflight';
import { resolvePromptDockSubmitPrompt } from './promptDockPrompt';
import { resolveParamLabel, type ParamTranslate } from './promptDockParamModel';
import type { PromptDockDraft, PromptDockForm, PromptDockPreflightIssue } from './PromptDock.types';
import { PromptDockFormRow } from './components/PromptDockFormRow';
import { PromptDockAgentServiceRow } from './components/PromptDockAgentServiceRow';
import { PromptDockAgentSessionBar } from './components/PromptDockAgentSessionBar';
import { PromptDockHeader } from './components/PromptDockHeader';
import { PromptDockPromptEditor } from './components/PromptDockPromptEditor';
import { PromptDockReferenceArea } from './components/PromptDockReferenceArea';
import { PromptDockInlineParams } from './components/PromptDockInlineParams';
import { PromptDockFullParamsSheet } from './components/PromptDockFullParamsSheet';
import { PromptDockSubmitRow } from './components/PromptDockSubmitRow';
import { PromptDockTaskCountStepper } from './components/PromptDockTaskCountStepper';

/**
 * PromptDock 创作面（唯一生成入口，spec PromptDock生成主链.md）。
 *
 * 承载：模型选择（只选 model_id，直显不翻译）、prompt 编辑、附件参考区、参数 inline 层
 * （≤4）+ 完整参数 Sheet、固定任务数 N（1..10）、active deployment 可提交性状态、提交按钮。
 *
 * 提交主链（生成式形态）：
 *   draft → 准备 intent → 程序化提交共享核心（programmaticSubmission：前置校验（现场同步，
 *   失败不提交、无持久化副作用）→ POST /api/generation-batches → 受理响应经 contracts schema
 *   parse → 创建 N 个任务节点投影）→ UI 副作用（submitting / 阻断反馈 / toast）。
 *   CLI 提交（iart generate）走同一共享核心（spec docs/integrations/CLI与本地Agent集成.md §6.4）。
 *   草稿按形态收尾：生成式原样保留（spec PD-AC-012：提交不丢弃用户输入）；
 *   agent 形态受理成功即消费——清空 prompt 与参考引用、焦点保留在编辑器（PD-AC-013）。
 *
 * 任务节点投影的创建/更新/终态 morph 由 features/promptdock/projection 统一编排，
 * 创建触发在共享核心内完成，本组件不承载投影与构造细节。
 */

/**
 * agent 形态的引用资产简报（spec 04：Backend 据此拼模型上下文资产清单，工具参数按
 * assetId 引用这里的资产）。只投影引用与展示所需子集；解析不到 URL 的引用跳过
 * （与提交媒体输入同口径，见 programmaticSubmission.buildReferenceMediaInputs）。
 */
const buildReferenceAssetBriefs = (
  draft: PromptDockDraft,
  mediaAssets: Readonly<ProjectMediaAssets>,
): AgentReferenceAssetBrief[] => {
  const briefs: AgentReferenceAssetBrief[] = [];
  for (const ref of draft.references) {
    const asset = mediaAssets[ref.assetId];
    const url = typeof asset?.original?.url === 'string' ? asset.original.url : '';
    if (!url) continue;
    const sourceUrl = typeof asset?.original?.sourceUrl === 'string' ? asset.original.sourceUrl : '';
    const summary = sourceUrl.split('/').pop() ?? '';
    briefs.push({
      assetId: ref.assetId,
      mediaType: ref.mediaType,
      url,
      width: typeof asset?.original?.width === 'number' ? asset.original.width : null,
      height: typeof asset?.original?.height === 'number' ? asset.original.height : null,
      durationMs: typeof asset?.original?.durationMs === 'number' ? asset.original.durationMs : null,
      summary,
    });
  }
  return briefs;
};

/**
 * 模型参数提交投影：draft.arguments 直接作为参数空间提交（构造逻辑下沉在
 * programmaticSubmission 共享核心，界面与 CLI 程序化提交同一构造路径）。
 *
 * prompt 已从模型能力包 parameter_schema 剥离（保留键 `__prompt` 只存在于后端参数合并空间，
 * 由后端 request-assembler 从提交体顶层 prompt/旧 arguments.prompt 归一注入），
 * 草稿 arguments 不再含 prompt，无需在此剥离。
 */

/**
 * 前置校验问题的界面文案：必填参数缺失时用参数界面标签重写 message，
 * 让用户知道是哪个字段要补（preflight 只产出 field，标签解析归 UI 层，
 * 与参数控件同用 resolveParamLabel，见 components/PromptDockParamField.tsx）。
 *
 * 标签取不到时（schema 没给 label，或 label 本身就是字段名）退回 preflight 的兜底句：
 * 界面不印字段名（docs/ui-copy-standard.md「异常对象与内部标识不得直出界面」）。
 */
const describePreflightIssue = (
  issue: PromptDockPreflightIssue,
  entry: PromptDockCatalogEntry | null,
  translate: ParamTranslate,
): string => {
  if (issue.code !== 'required-param-missing' || !issue.field) return issue.message;
  const field = (entry?.parameter_schema.fields ?? []).find(
    (candidate) => candidate.fieldKey === issue.field,
  );
  if (!field) return issue.message;
  const label = resolveParamLabel(translate, field.label, '');
  if (label === '' || label === field.fieldKey) return issue.message;
  return `请补上「${label}」再提交。`;
};

/**
 * 顶带组间分隔符（docs/editor/dock-布局规范.md R3）：
 * 1px 细线，带间距由容器 gap-x-2 独担（禁止 mx 叠加成双重间距），
 * 随其后的语义组条件渲染，禁止行尾悬挂。
 */
function TopBandDivider() {
  return <div aria-hidden="true" className="h-4 w-px flex-none bg-border" />;
}

export function PromptDock() {
  const form = usePromptDockStore((s) => s.form);
  const isAgentForm = form === 'agent';
  const draft = usePromptDockStore((s) => s.draft);
  const catalog = usePromptDockStore((s) => s.catalog);
  const catalogLoaded = usePromptDockStore((s) => s.catalogLoaded);
  const chatCatalog = usePromptDockStore((s) => s.chatCatalog);
  const chatCatalogLoaded = usePromptDockStore((s) => s.chatCatalogLoaded);
  const agentSelection = usePromptDockStore((s) => s.agentSelection);
  const agentBinding = usePromptDockStore((s) => s.agentBinding);
  const submitting = usePromptDockStore((s) => s.submitting);
  const preflightIssues = usePromptDockStore((s) => s.preflightIssues);
  const setCatalog = usePromptDockStore((s) => s.setCatalog);
  const setCatalogLoaded = usePromptDockStore((s) => s.setCatalogLoaded);
  const setChatCatalog = usePromptDockStore((s) => s.setChatCatalog);
  const setChatCatalogLoaded = usePromptDockStore((s) => s.setChatCatalogLoaded);
  const setAgentDefaultModelId = usePromptDockStore((s) => s.setAgentDefaultModelId);
  const setGenerationDefaultModelId = usePromptDockStore((s) => s.setGenerationDefaultModelId);
  const setSubmitting = usePromptDockStore((s) => s.setSubmitting);
  const setPreflightIssues = usePromptDockStore((s) => s.setPreflightIssues);
  const clearConsumedAgentDraft = usePromptDockStore((s) => s.clearConsumedAgentDraft);
  const bindAgentSession = usePromptDockStore((s) => s.bindAgentSession);
  const markAgentSessionCurrent = usePromptDockStore((s) => s.markAgentSessionCurrent);

  const catalogByModelId = useMemo(() => {
    const map = new Map<string, PromptDockCatalogEntry>();
    for (const entry of catalog) map.set(entry.model_id, entry);
    return map;
  }, [catalog]);

  const chatCatalogByModelId = useMemo(() => {
    const map = new Map<string, PromptDockChatCatalogEntry>();
    for (const entry of chatCatalog) map.set(entry.model_id, entry);
    return map;
  }, [chatCatalog]);

  // 当前形态对应的目录条目：agent 形态用对话模型条目，生成式形态用可执行目录条目。
  // 两个目录是不同端点（对话模型不进生成式目录），此处按形态选源，判定口径同源。
  const selectedEntry = isAgentForm
    ? agentSelection.modelId === null
      ? null
      : chatCatalogByModelId.get(agentSelection.modelId) ?? null
    : draft.modelId
      ? catalogByModelId.get(draft.modelId) ?? null
      : null;

  const { t } = useTranslation();
  const translate = useMemo<ParamTranslate>(
    () => (key, fallback) => {
      if (!key) return fallback;
      const resolved = t(key, { defaultValue: fallback });
      return resolved === key ? fallback : resolved;
    },
    [t],
  );

  useEffect(() => {
    if (catalogLoaded) return;
    let active = true;
    void fetchExecutableModelCatalog().then((models) => {
      if (!active) return;
      setCatalog(models);
      setCatalogLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [catalogLoaded, setCatalog, setCatalogLoaded]);

  // 对话模型目录：agent 形态服务行的候选来源（spec 06）。与生成式目录各自独立装载。
  useEffect(() => {
    if (chatCatalogLoaded) return;
    let active = true;
    void fetchChatModelCatalog().then((models) => {
      if (!active) return;
      setChatCatalog(models);
      setChatCatalogLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [chatCatalogLoaded, setChatCatalog, setChatCatalogLoaded]);

  // 默认模型（主窗口「服务商」区域设置的偏好）：读一次即可，它只影响两个形态的初始预选。
  // 读不到按「没设默认」处理——偏好缺失不该阻断创作面。
  useEffect(() => {
    let active = true;
    void fetchLocalBackendConfig()
      .then((payload) => {
        if (!active) return;
        setAgentDefaultModelId(payload.config.agentDefaultModelId ?? null);
        setGenerationDefaultModelId(payload.config.generationDefaultModelId ?? null);
      })
      .catch((error: unknown) => {
        console.debug('[promptdock] 读不到默认模型配置，按没设默认处理', error);
      });
    return () => {
      active = false;
    };
  }, [setAgentDefaultModelId, setGenerationDefaultModelId]);

  const handleSubmit = useCallback(async () => {
    // 重复提交拦截读 store 现值而非本次渲染的快照：同一帧内的第二次点击也必须被挡住。
    if (usePromptDockStore.getState().submitting) return;
    const dockState = usePromptDockStore.getState();
    const currentDraft = dockState.draft;
    const currentForm: PromptDockForm = dockState.form;
    const currentBinding = dockState.agentBinding;
    const boundSession =
      currentBinding === null
        ? null
        : useAgentSessionStore.getState().sessionsById[currentBinding.agentSessionId] ?? null;
    // 绑定会话时形态配置以会话记录为准（spec 03「会话归属」：会话模型不提供更换，思考与审批可改）。
    const currentAgent = resolveAgentFormSelection(
      currentBinding,
      boundSession,
      dockState.agentSelection,
    );
    if (currentForm === 'agent') {
      // agent 形态的目录条目来自对话模型目录（与生成式目录独立，见 chatCatalogByModelId 同源）。
      const agentEntry = currentAgent.modelId === null
        ? null
        : dockState.chatCatalog.find((item) => item.model_id === currentAgent.modelId) ?? null;
      const preflight = runPromptDockPreflight(
        currentDraft,
        agentEntry,
        useCanvasStore.getState().mediaAssets ?? {},
        'agent',
        currentAgent,
      );
      if (!preflight.ok) {
        // 阻断反馈必须点名是哪个字段：必填参数缺失按界面标签定位（resolveParamLabel），
        // 其余问题用 preflight 已定位好的 message。
        const issues = preflight.issues.map((issue) => ({
          code: issue.code,
          message: describePreflightIssue(issue, agentEntry, translate),
          exit: issue.exit,
        }));
        setPreflightIssues(issues);
        for (const issue of issues) {
          toast.error(issue.message);
        }
        return;
      }
      if (currentBinding !== null && boundSession === null) {
        // 会话记录缺失（画布上有节点但没有对应会话数据）：阻断并给出口，
        // 不静默把消息发到另一个 Agent 节点上。
        toast.error('这个会话已经不在了，点「新会话」后可以重新开始。');
        return;
      }
      if (currentAgent.modelId === null) {
        // 前置校验已覆盖模型未选择的情形，这里只作提交体构造前的兜底。
        toast.error('请先选择模型。');
        return;
      }
      // 轮次标识在建提交体之前定下：失败出口按它去重（右侧工作区的会话错误提示是同一个标识）。
      const requestId = createAgentLocalId();
      // 未绑定时新生成会话标识：受理成功后由 Backend 创建对应 Agent 节点。
      const agentSessionId =
        currentBinding === null ? createAgentLocalId() : currentBinding.agentSessionId;
      setSubmitting(true);
      setPreflightIssues(null);
      try {
        const content = resolvePromptDockSubmitPrompt(currentDraft);
        const result = await submitAgentPrompt({
          requestId,
          agentSessionId,
          nodeId: currentBinding === null ? null : currentBinding.nodeId,
          modelId: currentAgent.modelId,
          thinkingTier: currentAgent.thinkingTier,
          approvalMode: currentAgent.approval,
          content,
          referenceAssetIds: currentDraft.references.map((reference) => reference.assetId),
          referenceAssets: buildReferenceAssetBriefs(
            currentDraft,
            useCanvasStore.getState().mediaAssets ?? {},
          ),
        });
        if (currentBinding === null) {
          // 首次提交创建节点后自动打开该会话的会话视图（spec 06「首次提交」的自动聚焦规则）；
          // 并把受理产出的会话写回绑定（复用 bindAgentSession 主抽象）：续发追加到同一
          // Agent 节点，不再自造新会话标识、不再新建节点。result.nodeId 即受理事件里
          // createAgentNodeForAcceptance 创建的画布节点 id；会话记录在受理事件处理中
          // 先于本 promise resolve 入 store，绑定后次行摘要与续作守卫都能读到记录。
          openAgentSessionView(result.agentSessionId);
          bindAgentSession({ nodeId: result.nodeId, agentSessionId: result.agentSessionId });
        }
        // 粘滞（spec 06「选中驱动的进入—还原—粘滞」）：这条消息已被受理，该会话成为
        // 「当前会话」，清除选中驱动进入时记下的待还原快照——此后选择变化不再把用户拽回去。
        // 只挂受理成功这一时机：受理失败/被阻断时不清，否则用户回不到进入前的形态与绑定。
        markAgentSessionCurrent(agentSessionId);
        // 「使用 agent」的续作不自动打开会话视图（显式续作不改变面板开合现状，spec 06
        // 「历史承载与会话视图」）；已绑定时也不重设绑定（binding 原样）。
        // 受理成功即消费（spec PromptDock生成主链.md PD-AC-013）：消息已交由会话承载，
        // 清空 prompt、参考引用与预设快照（唯一 store 清空动作，只挂受理成功这一时机）；
        // 会话视图自动打开已是反馈，退役「消息已发送」toast。输入焦点保留在编辑器
        // 由 PromptDockPromptEditor 的清空转换 effect 兑现（表面 DOM 重建落定后交还焦点）。
        clearConsumedAgentDraft();
      } catch (error) {
        // 失败不自动重试、不清草稿：用户可直接再点发送（参考区与输入文本都还在）。
        // 出口文案只按错误码取（映射见 features/agent/agentErrorText），绝不回落后端原文；
        // 原文进日志。toast 以轮次标识去重：右侧工作区的会话错误提示同 id，覆盖而不叠两条。
        console.warn('[promptDock] agent submit failed', { requestId, error });
        toast.error(resolveAgentSubmitFailureText(error), { id: requestId });
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // 生成式形态：校验→构造→提交→受理回执处理走程序化提交共享核心（programmaticSubmission），
    // 与 CLI 提交同一主链（spec docs/integrations/CLI与本地Agent集成.md §6.4：程序化提交是
    // 创作面提交主链的调用入口）；本组件只保留 UI 副作用（submitting / 阻断反馈 / toast）。
    // 预设 token 随快照传递：失效 token 由共享核心内的前置校验阻断，有效 token 在核心内展开。
    // 用途随引用条目一起传入（设计 §5.2）：参考区是用途的唯一表达位，核心不重判用户已标的值。
    const intent: ProgrammaticSubmitIntent = {
      modelId: currentDraft.modelId,
      prompt: currentDraft.prompt,
      args: currentDraft.arguments,
      refs: currentDraft.references.map((reference) => ({
        assetId: reference.assetId,
        slotId: reference.slotId ?? null,
      })),
      count: currentDraft.taskCount,
      promptPresetSnapshots: currentDraft.promptPresetSnapshots,
      // 界面提交不携带受理幂等键（幂等键是 CLI 提交面语义，spec §5.4 受理幂等键）。
      clientRequestId: undefined,
    };
    setSubmitting(true);
    setPreflightIssues(null);
    try {
      const outcome = await runGenerationBatchSubmission(intent);
      if (!outcome.ok) {
        const failure = outcome.failure;
        if (failure.kind === 'preflight') {
          // 阻断反馈必须点名是哪个字段：必填参数缺失按界面标签定位（resolveParamLabel），
          // 其余问题用 preflight 已定位好的 message。
          const issues = failure.issues.map((issue) => ({
            code: issue.code,
            message: describePreflightIssue(issue, failure.entry, translate),
            exit: issue.exit,
          }));
          setPreflightIssues(issues);
          for (const issue of issues) {
            toast.error(issue.message);
          }
        } else if (failure.kind === 'project-not-ready') {
          toast.error(failure.message);
        } else if (failure.kind === 'group-name-ambiguous') {
          toast.error(
            `画布上有 ${failure.groupIds.length} 个同名组「${failure.groupName}」，无法确定生成任务要放进哪个组。请把其中一些组改成不同组名后再提交。`,
          );
        } else {
          toast.error(failure.reason);
        }
        return;
      }
      // 提交受理后草稿原样保留（spec PromptDock生成主链.md PD-AC-012），
      // 用户可在同一草稿上微调续作；不做任何清空/重置。
      toast.success(`已开始生成 ${outcome.tasks.length} 个任务`);
    } catch (error) {
      // 失败一律给固定出口文案，细节进日志：ZodError / 动态 import 失败等异常原文（英文、JSON）
      // 不得印到界面（docs/ui-copy-standard.md「异常对象与内部标识不得直出界面」）。
      console.warn('[promptDock] submit failed', error);
      toast.error('生成没能开始，请重试。');
    } finally {
      setSubmitting(false);
    }
  }, [
    setPreflightIssues,
    setSubmitting,
    clearConsumedAgentDraft,
    bindAgentSession,
    markAgentSessionCurrent,
    translate,
  ]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-dock px-4 pb-4"
      data-testid="promptdock"
      role="region"
      aria-label="生成入口"
    >
      {/* @container：降级断点按 dock 卡片自身宽度（容器查询）判定，不随窗口整体宽度漂移。
          带结构（docs/editor/dock-布局规范.md R6）：顶带 / 主行 / 次行 + 临时反馈带，
          常驻三带，新增控件先回答进哪个既有带，不得默认新起一行。 */}
      <div className="@container pointer-events-auto mx-auto flex max-w-[720px] flex-col gap-2 rounded-xl border border-border bg-card p-2.5 shadow-lg">
        {/* 顶带（R8 读序：形态锚点 → 上下文组 → 参考组）：单个 flex-wrap 容器承载，
            DOM 顺序 = 信息优先级 = 窄容器折断顺序（R4）。分隔符随其后的组条件渲染（R3），
            agent 未绑定上下文组缺席时分隔符连带缺席，禁止行尾悬挂。
            agent 形态不选生成模型（配置在次行左侧：模型 / 思考 / 审批）；
            已有会话续作时上下文组为该会话摘要 +「新会话」。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <PromptDockFormRow />
          {isAgentForm ? (
            agentBinding === null ? null : (
              <>
                <TopBandDivider />
                <PromptDockAgentSessionBar />
              </>
            )
          ) : (
            <>
              <TopBandDivider />
              <PromptDockHeader
                catalog={catalog}
                selectedModelId={draft.modelId}
                selectedEntry={selectedEntry}
              />
            </>
          )}
          <TopBandDivider />
          <PromptDockReferenceArea entry={selectedEntry} />
        </div>

        {/* 主行：prompt 编辑面占满整行（R1(a) 尺寸耦合，自适应高度，右下角字数计数）；
            回车发送与次行按钮共用 handleSubmit（提交守卫单源，IME 防护在编辑面） */}
        <PromptDockPromptEditor form={form} onSubmit={handleSubmit} />

        {/* 次行（R1(b) 动作耦合）：左侧配置区 + 右端提交按钮。单行纪律 = 提交按钮
            不换行、位置两形态恒定（R4 锚点）；左簇允许内部折行 */}
        <div className="flex items-center justify-between gap-2">
          {isAgentForm ? <PromptDockAgentServiceRow /> : (
            <div className="dock-form-content flex min-w-0 flex-wrap items-center gap-2">
              <PromptDockInlineParams entry={selectedEntry} />
              <PromptDockFullParamsSheet entry={selectedEntry} />
              <div aria-hidden="true" className="h-4 w-px flex-none bg-border" />
              <PromptDockTaskCountStepper />
            </div>
          )}
          <PromptDockSubmitRow
            form={form}
            selectedEntry={selectedEntry}
            submitting={submitting}
            onSubmit={handleSubmit}
          />
        </div>

        {/* 前置校验反馈条（原型 .composer-feedback.block：阻断提交）——
            渲染全部问题（spec「反馈应覆盖全部」），每条一行。 */}
        {preflightIssues !== null && preflightIssues.length > 0 ? (
          <div
            className="flex flex-col gap-0.5 rounded-lg border border-(--st-failed)/40 bg-(--st-failed)/10 px-2.5 py-1.5 text-xs text-(--st-failed-text)"
            data-testid="promptdock-preflight-issues"
            aria-live="polite"
          >
            {preflightIssues.map((issue, index) => (
              <div key={`${String(index)}-${issue.message}`} className="flex items-center justify-between gap-2">
                <p className="text-xs leading-relaxed">{issue.message}</p>
                {issue.exit === 'hub-providers' ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto flex-none p-0 text-xs"
                    onClick={focusHubModelProviders}
                  >
                    {t('promptDock.goFix', '去添加')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default PromptDock;
