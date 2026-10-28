import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button, cn, SELECTION_SOFT_COMPACT_CLASSES } from '@iart/ui';
import { Layers, AlertCircle } from 'lucide-react';
import type { InterfaceFormatDetail, InterfaceFormatSummary, InterfaceRecipe } from '@iart/contracts';
import { describeErrorWithReason } from '../provider-connection/useProviderConnectionData';
import { ProviderDataProvider, useProviderData } from '../provider-connection/ProviderDataContext';
import { InterfaceRecipeSection } from '../provider-connection/InterfaceRecipeSection';
import { ProviderNoticeBar } from '../provider-connection/ProviderNoticeBar';
import { StateCard } from '../provider-connection/ProviderDetail';
import { ConfirmDialog } from '../provider-connection/ConfirmDialog';
import { INTERFACE_FORMAT_CREATE_INTENT_KEY, PROVIDER_ADD_MODEL_HINT_KEY } from '../provider-connection/providerHints';
import {
  InterfaceFormatDefinition,
  InterfaceFormatDetailPlaceholder,
} from './InterfaceFormatDetail';
import { InterfaceFormatEditor } from './InterfaceFormatEditor';
import { InterfaceFormatList, InterfaceFormatSearch } from './InterfaceFormatList';
import { InterfaceFormatSamplePanel } from './InterfaceFormatSamplePanel';
import { useInterfaceFormats } from './useInterfaceFormats';

/**
 * 设置页「接口格式」子单元（docs/hub/hub-information-architecture.md §7.9、
 * docs/custom-providers/接口格式旅程-design.md §1）。
 *
 * 页内两个标签共用页面头：
 * - 「接口格式」：三栏工作台（列表 / 定义 / 验证面板）。预设随软件版本分发（只读，可复制为
 *   我的格式），自建格式在这里创建、编辑、删除；验证面板用样本做路径发现。
 * - 「判定配方」：接口配方从服务商页迁入的落点，不新建第二套实现。
 *
 * 三栏各自滚动（`overflow-y-auto` + `min-w-0`），页面本身不再整体滚动：定义栏里的参数表
 * 与路径列表都需要独立视口，混在一条长滚动里会让左栏在阅读定义时被滚出屏幕。
 *
 * 验证面板可折叠：窄窗口下三栏并排会把定义栏压到读不了路径，因此默认按视口宽度收起，
 * 由页面头的按钮展开。
 */

type InterfaceFormatTab = 'formats' | 'recipes';

type EditorState =
  | { mode: 'create'; initial?: { detail: InterfaceFormatDetail; recipe: InterfaceRecipe | null } }
  | { mode: 'edit'; initial: { detail: InterfaceFormatDetail; recipe: InterfaceRecipe | null } };

/**
 * 验证面板默认展开的视口阈值。
 *
 * 算式：视口 − Hub 主侧栏 224 − 设置分区导航 192 − 设置页内距 32 = 可用宽度；
 * 三栏再扣掉列表 288 + 面板 320 + 两道 12px 间隙，剩余才是定义栏。
 * 要让定义栏保住数据面 640px 的下限（visual-design §8.5），可用宽度需 ≥1272，
 * 即视口 ≥1720。达不到时默认收起面板，让「列表 + 定义」先站住；用户仍可手动展开。
 */
const PANEL_AUTO_OPEN_QUERY = '(min-width: 1720px)';

/** 验证面板的初始开合：宽窗口默认展开，窄窗口默认收起；视口跨过阈值时跟随。 */
function useSamplePanelOpen(): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState<boolean>(
    () => typeof window.matchMedia === 'function' && window.matchMedia(PANEL_AUTO_OPEN_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(PANEL_AUTO_OPEN_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setOpen(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return [open, setOpen];
}

export function InterfaceFormatPage({
  onSelectSection,
  registerLeaveGuard,
}: {
  /** 切到别的设置子单元（「用此格式添加模型」去服务商页）。 */
  onSelectSection: (id: string) => void;
  /** 把编辑器的「有未保存改动」离开守卫交给设置外壳（左侧分区导航切换时先问它）。 */
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [tab, setTab] = useState<InterfaceFormatTab>('formats');
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useSamplePanelOpen();
  const [editor, setEditor] = useState<EditorState | null>(null);
  /** 打开编辑器时的一句提示（复制后需要补全判定时用）。 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InterfaceFormatSummary | null>(null);
  const [pageNotice, setPageNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [returnToProviders, setReturnToProviders] = useState(false);
  const data = useInterfaceFormats();

  // 从「添加模型」跳来新建：挂载即进编辑器；保存后按意图回服务商页。
  useEffect(() => {
    const intent = window.sessionStorage.getItem(INTERFACE_FORMAT_CREATE_INTENT_KEY);
    if (intent === null) return;
    window.sessionStorage.removeItem(INTERFACE_FORMAT_CREATE_INTENT_KEY);
    setReturnToProviders(intent === 'providers');
    setEditor({ mode: 'create' });
  }, []);

  const selectedSummary = data.selectedId === null
    ? null
    : data.formats.find((item) => item.format_id === data.selectedId) ?? null;

  /** 页签用 roving tabindex（WAI-ARIA APG Tabs）：一个 Tab 停靠点，左右方向键切换。 */
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: InterfaceFormatTab = tab === 'formats' ? 'recipes' : 'formats';
    setTab(next);
    document
      .getElementById(next === 'formats' ? 'interface-formats-tab' : 'interface-recipes-tab')
      ?.focus();
  };

  const openCreate = (): void => {
    setEditorNotice(null);
    setEditor({ mode: 'create' });
  };

  /**
   * 「复制为我的格式」：由服务端整实体克隆（传输 / 参数 / 素材位 / 文案全部照搬），
   * 客户端不拿详情回填再合成一遍。
   *
   * 复制成功但没有可靠派生出判定与结果形态时（`recipe_id` 为 `null`），直接打开编辑器
   * 让用户补全——这时的格式已经有传输设置，只是还没有可用判定。
   */
  const copyFormat = async (formatId: string): Promise<void> => {
    if (copying) return;
    setCopying(true);
    setPageNotice(null);
    try {
      const response = await data.api.copyInterfaceFormat(formatId);
      await data.reload();
      data.select(response.format_id);
      if (response.recipe_id === null) {
        setEditorNotice('已复制传输设置，请补全判定与结果');
        setEditor({ mode: 'edit', initial: { detail: response.detail, recipe: null } });
      } else {
        setEditorNotice(null);
        setPageNotice({
          tone: 'success',
          text: `已复制为「${response.detail.summary.display_name}」`,
        });
      }
    } catch (error: unknown) {
      setPageNotice({ tone: 'error', text: describeErrorWithReason(error, '没能复制这个接口格式，请重试') });
    } finally {
      setCopying(false);
    }
  };

  const openEdit = async (formatId: string): Promise<void> => {
    const detail = data.details.get(formatId);
    if (detail === undefined) return;
    let recipe: InterfaceRecipe | null = null;
    try {
      const list = await data.api.listInterfaceRecipes(undefined);
      recipe = list.recipes.find((item) => item.recipe_id === detail.recipe_id)
        ?? list.recipes.find((item) => item.family_adapter_id === formatId)
        ?? null;
    } catch (error: unknown) {
      // 读不到配方不阻断编辑：传输段仍可改，判定段按空表单重新填。
      console.debug('[interface-format] 读取绑定配方失败，按空判定编辑', {
        formatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    setEditorNotice(null);
    setEditor({ mode: 'edit', initial: { detail, recipe } });
  };

  const handleSaved = async (detail: InterfaceFormatDetail): Promise<void> => {
    setEditor(null);
    setEditorNotice(null);
    if (returnToProviders) {
      setReturnToProviders(false);
      window.sessionStorage.setItem(
        PROVIDER_ADD_MODEL_HINT_KEY,
        `已创建「${detail.summary.display_name}」。在服务商详情里点「添加模型」时选它。`,
      );
      onSelectSection('providers');
      return;
    }
    await data.reload();
    data.select(detail.summary.format_id);
    setPageNotice({ tone: 'success', text: `已保存「${detail.summary.display_name}」` });
  };

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target === null) return;
    try {
      await data.api.deleteInterfaceFormat(target.format_id);
      await data.reload();
      setPageNotice({ tone: 'success', text: `已删除「${target.display_name}」` });
    } catch (error: unknown) {
      setPageNotice({ tone: 'error', text: describeErrorWithReason(error, '没能删除这个接口格式，请重试') });
    }
  };

  const goAddModel = (): void => {
    if (selectedSummary === null) return;
    // 切页即卸载本页，提示随 sessionStorage 过去（服务商页挂载时消费一次）。
    window.sessionStorage.setItem(
      PROVIDER_ADD_MODEL_HINT_KEY,
      `在服务商详情里点「添加模型」时，接口格式选「${selectedSummary.display_name}」。`,
    );
    onSelectSection('providers');
  };

  if (editor !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <InterfaceFormatEditor
          mode={editor.mode}
          {...(editor.initial === undefined ? {} : { initial: editor.initial })}
          api={data.api}
          {...(editorNotice === null ? {} : { notice: editorNotice })}
          onCancel={() => {
            setEditor(null);
            setEditorNotice(null);
          }}
          onSaved={(detail) => void handleSaved(detail)}
          {...(registerLeaveGuard === undefined ? {} : { registerLeaveGuard })}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3" data-page-head>
        <h2 className="text-sm font-semibold">接口格式</h2>
        {data.loadState === 'ready' ? (
          <span className="text-2xs text-muted-foreground">{`${data.formats.length} 个格式`}</span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {tab === 'formats' ? (
            <>
              <InterfaceFormatSearch value={query} onChange={setQuery} />
              <Button type="button" size="sm" onClick={openCreate}>
                新建格式
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void data.reload()}>
                刷新
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={panelOpen}
                onClick={() => setPanelOpen(!panelOpen)}
              >
                样本面板
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {pageNotice === null ? null : (
        <p
          role={pageNotice.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-md border px-3 py-2 text-2xs',
            pageNotice.tone === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {pageNotice.text}
        </p>
      )}

      <div role="tablist" aria-label="接口格式页面标签" className="flex items-center gap-1 border-b border-border">
        <Button
          type="button"
          role="tab"
          id="interface-formats-tab"
          aria-selected={tab === 'formats'}
          aria-controls="interface-formats-panel"
          tabIndex={tab === 'formats' ? 0 : -1}
          onKeyDown={onTabKeyDown}
          variant="ghost"
          size="sm"
          className={cn(tab === 'formats' && SELECTION_SOFT_COMPACT_CLASSES)}
          onClick={() => setTab('formats')}
        >
          接口格式
        </Button>
        <Button
          type="button"
          role="tab"
          id="interface-recipes-tab"
          aria-selected={tab === 'recipes'}
          aria-controls="interface-recipes-panel"
          tabIndex={tab === 'recipes' ? 0 : -1}
          onKeyDown={onTabKeyDown}
          variant="ghost"
          size="sm"
          className={cn(tab === 'recipes' && SELECTION_SOFT_COMPACT_CLASSES)}
          onClick={() => setTab('recipes')}
        >
          判定配方
        </Button>
      </div>

      {/* 第一标签保持挂载（隐藏而非卸载）：切回时列表选中项与滚动位置仍在。 */}
      <div
        id="interface-formats-panel"
        role="tabpanel"
        aria-labelledby="interface-formats-tab"
        className={tab === 'formats' ? 'flex min-h-0 flex-1 gap-3' : 'hidden'}
      >
        {data.loadState === 'loading' && data.formats.length === 0 ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2" aria-hidden="true">
            <div className="h-8 w-40 rounded-md bg-muted/60" />
            <div className="h-40 rounded-md bg-muted/60" />
            <span className="sr-only" role="status">正在读取接口格式</span>
          </div>
        ) : data.loadState === 'error' ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <StateCard
              icon={<AlertCircle className="h-10 w-10" aria-hidden="true" />}
              title="没能读取接口格式"
              description={data.loadError ?? '网络或后端暂时没有响应。已经配置好的内容不会丢失。'}
              action={<Button type="button" size="sm" onClick={() => void data.reload()}>重新读取</Button>}
            />
          </div>
        ) : data.formats.length === 0 ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <StateCard
              icon={<Layers className="h-10 w-10" aria-hidden="true" />}
              title="还没有可用的接口格式"
              description="随软件版本分发的接口格式还没读到。点「刷新」再试。"
              action={<Button type="button" size="sm" onClick={() => void data.reload()}>刷新</Button>}
            />
          </div>
        ) : (
          <>
            <InterfaceFormatList
              formats={data.formats}
              details={data.details}
              selectedId={data.selectedId}
              query={query}
              onSelect={data.select}
            />

            <div className="min-w-0 flex-1 basis-0 overflow-y-auto rounded-md border border-border p-4">
              {data.selectedDetail !== null ? (
                <InterfaceFormatDefinition
                  detail={data.selectedDetail}
                  onAddModel={goAddModel}
                  onShowRecipes={() => setTab('recipes')}
                  onCopy={() => {
                    if (data.selectedId !== null) void copyFormat(data.selectedId);
                  }}
                  copying={copying}
                  onEdit={() => {
                    if (data.selectedId !== null) void openEdit(data.selectedId);
                  }}
                  onDelete={() => {
                    if (selectedSummary !== null) setDeleteTarget(selectedSummary);
                  }}
                />
              ) : data.selectedDetailError !== null ? (
                <InterfaceFormatDetailPlaceholder
                  kind="error"
                  message={data.selectedDetailError}
                  onRetry={() => void data.reloadSelectedDetail()}
                />
              ) : (
                <InterfaceFormatDetailPlaceholder kind="loading" />
              )}
            </div>

            {panelOpen ? (
              <InterfaceFormatSamplePanel
                formatId={data.selectedId}
                formatName={selectedSummary?.display_name ?? null}
                api={data.api}
                onClose={() => setPanelOpen(false)}
              />
            ) : null}
          </>
        )}
      </div>

      {tab === 'recipes' ? (
        <div
          id="interface-recipes-panel"
          role="tabpanel"
          aria-labelledby="interface-recipes-tab"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <RecipeTab />
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget === null ? '' : `删除「${deleteTarget.display_name}」`}
        message={
          deleteTarget === null
            ? ''
            : `删除后，${data.details.get(deleteTarget.format_id)?.used_by_model_count ?? 0} 个正在使用它的模型会显示「接口格式已失效」。已提交的任务不受影响。`
        }
        confirmLabel="删除接口格式"
        danger
        onResolve={(confirmed) => {
          if (confirmed) void confirmDelete();
          else setDeleteTarget(null);
        }}
      />
    </div>
  );
}

/**
 * 「判定配方」标签：配方公共库（全局共享，跨服务商）。
 *
 * 数据来源仍是 `ProviderDataProvider`（配方与刷新在同一次装载里），因此这里只取
 * `interfaceRecipes` / `interfaceRecipesUnavailable` / `reload` / `setNotice` 四项，
 * 与迁移前服务商页调用 `InterfaceRecipeSection` 的 props 完全一致——配方只有一套实现。
 */
function RecipeTab() {
  return (
    <ProviderDataProvider>
      <RecipeTabBody />
    </ProviderDataProvider>
  );
}

function RecipeTabBody() {
  const { api, interfaceRecipes, interfaceRecipesUnavailable, notice, setNotice, reload } = useProviderData();
  return (
    <div className="flex flex-col gap-3">
      <ProviderNoticeBar notice={notice} onDismiss={() => setNotice(null)} />
      <InterfaceRecipeSection
        recipes={interfaceRecipes}
        unavailable={interfaceRecipesUnavailable}
        api={api}
        reload={reload}
        setNotice={setNotice}
      />
    </div>
  );
}
