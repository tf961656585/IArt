import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@iart/ui';
import type { InterfaceRecipe } from '@iart/contracts';
import type { HubApiClient } from '../../../client/types';
import { formatTime } from '../../../client/utils/time';
import { ConfirmDialog } from './ConfirmDialog';
import { InterfaceRecipeDialog, type InterfaceRecipeFormPayload } from './InterfaceRecipeForm';
import { InfoHint } from './InfoHint';
import { interfaceFormatLabel, useInterfaceFormatOptions } from './useInterfaceFormatOptions';
import {
  describeError,
  describeErrorWithReason,
  type ProviderNotice,
} from './useProviderConnectionData';

/**
 * 接口配方的公共库（`docs/custom-providers/接口配方-design.md` §8.1）。
 *
 * 落点判断：Hub 信息架构（`docs/hub/hub-information-architecture.md` §3.1/§7.4）没有为配方
 * 规定归置位置，而配方是「服务商与模型」分区里唯一会改变生成语义的配置层——它决定任务什么时候
 * 算完成、产物从哪里取。因此放在同一分区页内、服务商主从面板之后，作为**独立区块**：
 * 配方不是服务商的属性（全局公共库，跨连接共享），不并入某个服务商的详情，也不另立设置分区。
 *
 * 列表只显示用户判断「该改哪一份」需要的信息：名称、绑定的接口格式、最后修改时间。
 * 删除确认说明真实影响面：引用它的模型在投影期回落内置默认判定，已提交任务用执行快照不受影响。
 */

/**
 * 配方列表里「绑定哪个接口格式」的展示名与可绑定清单都来自接口格式实体
 * （`useInterfaceFormatOptions`）：2026-10-27 生成侧内置适配器退场后，这里不再有第二份名称清单。
 */

type RecipeDialogTarget =
  | { kind: 'create' }
  | { kind: 'edit'; recipe: InterfaceRecipe }
  | null;

export function InterfaceRecipeSection({
  recipes,
  unavailable,
  api,
  reload,
  setNotice,
}: {
  recipes: InterfaceRecipe[];
  unavailable: boolean;
  api: HubApiClient;
  reload: () => Promise<void>;
  setNotice: Dispatch<SetStateAction<ProviderNotice | null>>;
}) {
  const [dialogTarget, setDialogTarget] = useState<RecipeDialogTarget>(null);
  const [dialogFailure, setDialogFailure] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InterfaceRecipe | null>(null);
  /** 可绑定的接口格式（含用户自建）与列表展示名：唯一来源是接口格式实体。 */
  const formatOptions = useInterfaceFormatOptions(api);

  const openCreate = (): void => {
    setDialogFailure(null);
    setDialogTarget({ kind: 'create' });
  };

  const openEdit = (recipe: InterfaceRecipe): void => {
    setDialogFailure(null);
    setDialogTarget({ kind: 'edit', recipe });
  };

  const submitRecipe = async (payload: InterfaceRecipeFormPayload): Promise<boolean> => {
    try {
      if (payload.mode === 'create') {
        const created = await api.createInterfaceRecipe(payload.create);
        setNotice({ tone: 'success', text: `已创建配方「${created.recipe.name}」` });
      } else {
        const updated = await api.updateInterfaceRecipe(payload.recipeId, payload.update);
        setNotice({ tone: 'success', text: `已保存配方「${updated.recipe.name}」` });
      }
      setDialogFailure(null);
      await reload();
      return true;
    } catch (error: unknown) {
      const text = describeErrorWithReason(
        error,
        '没能保存配方，请重试',
        '这份配方已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
      );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
  };

  const confirmDelete = async (recipe: InterfaceRecipe): Promise<void> => {
    try {
      await api.deleteInterfaceRecipe(recipe.recipe_id);
      setNotice({ tone: 'success', text: `已删除配方「${recipe.name}」` });
      await reload();
    } catch (error: unknown) {
      setNotice({
        tone: 'error',
        text: describeError(
          error,
          '没能删除配方，请重试',
          `「${recipe.name}」已经不在了，点「刷新」看最新状态`,
        ),
      });
    }
  };

  return (
    <div className="flex flex-col gap-2" data-interface-recipes>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">接口配方</h2>
        <InfoHint
          text="配方决定任务什么时候算完成、产物从哪里取。这里建的配方对所有服务商可用。"
          subject="接口配方"
        />
        <span className="text-2xs text-muted-foreground">{`${recipes.length} 个配方`}</span>
        <div className="ml-auto flex items-center gap-2">
          {unavailable ? (
            <Button size="2xs" variant="ghost" onClick={() => void reload()}>
              刷新
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={openCreate}>
            新建配方
          </Button>
        </div>
      </div>

      {unavailable ? (
        <p className="text-xs text-muted-foreground">暂时读不到配方列表，点「刷新」再试。</p>
      ) : recipes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          还没有接口配方。新建一个，用来决定任务什么时候算完成、产物从哪里取。
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>接口格式</TableHead>
                <TableHead>最后修改</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipes.map((recipe) => (
                <TableRow key={recipe.recipe_id}>
                  <TableCell className="font-medium">{recipe.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {interfaceFormatLabel(recipe.family_adapter_id, formatOptions)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatTime(recipe.updated_at)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="2xs"
                        aria-label={`修改配方「${recipe.name}」`}
                        onClick={() => openEdit(recipe)}
                      >
                        修改
                      </Button>
                      <Button
                        type="button"
                        variant="ghost-destructive"
                        size="2xs"
                        aria-label={`删除配方「${recipe.name}」`}
                        onClick={() => setDeleteTarget(recipe)}
                      >
                        删除配方
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialogTarget === null ? null : (
        <InterfaceRecipeDialog
          initial={dialogTarget.kind === 'edit' ? dialogTarget.recipe : null}
          api={{
            discoverPaths: (sample) => api.discoverInterfaceRecipePaths(sample),
            dryRun: (body) => api.dryRunInterfaceRecipe(body),
          }}
          familyOptions={formatOptions}
          failureText={dialogFailure}
          onSubmit={submitRecipe}
          onClose={() => {
            setDialogFailure(null);
            setDialogTarget(null);
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`删除配方「${deleteTarget?.name ?? ''}」？`}
        message="删除后，正在引用它的模型会改用内置默认判定；已经提交的任务不受影响。"
        confirmLabel="删除配方"
        danger
        onResolve={(confirmed) => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (confirmed && target !== null) void confirmDelete(target);
        }}
      />
    </div>
  );
}
