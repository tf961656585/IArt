import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type {
  CustomGenerationModel,
  FamilyTemplateParameterDescriptor,
  ProviderConnection,
} from '@iart/contracts';
import type { HubApiClient } from '../../../client/types';
import type { GenerationModelFormPayload } from './GenerationModelForm';
import {
  GenerationModelEditDialog,
  type GenerationModelEditPayload,
} from './GenerationModelEditDialog';
import {
  describeErrorWithReason,
  isConflictError,
  type ProviderNotice,
} from './useProviderConnectionData';

/**
 * 生成模型的管理切片（自 ProviderSection 拆出的职责单元）：
 * 生成模型的添加提交、「修改」弹层的开关与保存、生成族模型行「删除模型」的确认受理与执行、
 * 以及「修改」弹层本体的渲染（`generationModelEditDialog`）。
 *
 * 「添加模型」入口 2026-09-26 界面收敛进合并弹窗（AddModelDialog）：本切片把「自定义接口的
 * 模型」区块的绑定（模板装载 + 提交）装配出去（`generationCustomFormFor`）——2026-09-26 起
 * 协议归属模型级，记录自带 `family_adapter_id`，每条连接的生成侧入口都带这个区块。
 *
 * 依赖全部显式注入（api、自建生成模型清单、reload、页面提示与弹层失败态、确认状态、
 * `run`、添加前置条件判据），不另建第二套错误处理：提示与失败口径与对话侧同走
 * `setNotice` + `run` + `describeErrorWithReason`。
 */

/**
 * 确认弹层的生成变体（自 ProviderSection 的 `ConfirmTarget` 移入）：
 * 删除一个自建生成模型前要确认的影响面描述。记录归属创建它的连接，删除影响面只有
 * 「模型本身消失」一种，不再有跨连接接入计数。
 */
export type ConfirmDeleteGenerationModelTarget = {
  kind: 'delete-custom-generation-model';
  modelId: string;
};

/** ProviderSection 的写入执行器 `run`（注入），此处只沿用、不重新定义。 */
type RunWrite = (
  action: () => Promise<void>,
  successText: string,
  fallback: string,
  notFoundText?: string,
) => Promise<{ failure: string | null }>;

export function useGenerationModelManagement(options: {
  api: HubApiClient;
  customGenerationModels: CustomGenerationModel[];
  dialogFailure: string | null;
  reload: () => Promise<void>;
  setNotice: Dispatch<SetStateAction<ProviderNotice | null>>;
  setDialogFailure: Dispatch<SetStateAction<string | null>>;
  setConfirm: (target: ConfirmDeleteGenerationModelTarget) => void;
  run: RunWrite;
  attachBlockedReason: (connection: ProviderConnection) => string | null;
}) {
  const {
    api,
    customGenerationModels,
    dialogFailure,
    reload,
    setNotice,
    setDialogFailure,
    setConfirm,
    run,
    attachBlockedReason,
  } = options;

  /** 「修改」弹层的打开目标：整条模型记录（回填素材位勾选与现有参数覆盖） */
  const [editingGenerationModel, setEditingGenerationModel] = useState<CustomGenerationModel | null>(null);

  /**
   * 添加生成模型（spec 03 §6.1「记录即接入」）：一次写入创建自建生成模型记录——
   * 能力属性（接受的素材位、参数覆盖）与接入归属（`connection_id` + `remote_model_id`）同一次落库，
   * active 接入由后端在创建内完成，没有中间态。
   *
   * 失败即整体失败：一次调用没有「已成功的步骤」可留。重名（全局唯一，409）在提交前先按
   * 本连接记录查重拦下最常见的一种，其余确定性拒绝（命名空间护栏等）由后端写成
   * 可操作原因，经 `describeErrorWithReason` 原样透出，不笼统化成一句「请重试」。
   */
  const addGenerationModel = async (
    connection: ProviderConnection,
    payload: GenerationModelFormPayload,
  ): Promise<boolean> => {
    const blocked = attachBlockedReason(connection);
    if (blocked !== null) {
      setNotice({ tone: 'error', text: blocked });
      setDialogFailure(blocked);
      return false;
    }
    // 已经添加到这个服务商：用户的目标已经达成，写入只会撞上重名。
    // 在提交前说清，别让他对着一句「请重试」反复点（重试永远失败）
    const alreadyHere = customGenerationModels.some(
      (item) => item.connection_id === connection.connection_id && item.model_id === payload.modelId,
    );
    if (alreadyHere) {
      const text = `「${payload.modelId}」已经添加到这个服务商了。想改它，关掉这个窗口后在列表里点「修改」。`;
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
    try {
      await api.createCustomGenerationModel({
        model_id: payload.modelId,
        connection_id: connection.connection_id,
        // 远端模型名留空即按模型 ID 请求（契约缺省回落 model_id）
        ...(payload.remoteModelId === null ? {} : { remote_model_id: payload.remoteModelId }),
        // 接口类型随表单选择落库（2026-09-26 起协议归属模型级，不再从连接继承）
        family_adapter_id: payload.familyAdapterId,
        accepted_media_slots: payload.acceptedMediaSlots,
        // 没有自定义任何参数时请求体不带 parameter_overrides：与不带本字段的既有行为完全一致
        ...(payload.parameterOverrides === null ? {} : { parameter_overrides: payload.parameterOverrides }),
      });
      setNotice({ tone: 'success', text: `已添加「${payload.modelId}」` });
      setDialogFailure(null);
      await reload();
      return true;
    } catch (error: unknown) {
      const text = isConflictError(error)
        ? `「${payload.modelId}」这个名字已经有模型在用了，换一个模型 ID 再添加。`
        : describeErrorWithReason(
            error,
            '没能添加模型，请重试',
            '这个服务商已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
          );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
  };

  /** 族模板参数描述的装载（「高级参数自定义」展开时由表单按当前所选接口类型调用）。 */
  const loadParameterTemplate = (familyAdapterId: string): Promise<FamilyTemplateParameterDescriptor> =>
    api.getGenerationFamilyTemplate(familyAdapterId, undefined);

  /**
   * 装配一条连接的「自定义接口的模型」区块（合并弹窗 AddModelDialog 的 customForm）：
   * 返回模板装载与提交的绑定。2026-09-26 起协议归属模型级（记录自带 `family_adapter_id`），
   * 自建表单不再按连接接口类型设限——每条连接的生成侧入口都有这个区块。
   */
  const generationCustomFormFor = (
    connection: ProviderConnection,
  ): {
    loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
    onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
  } => ({
    loadParameterTemplate,
    onSubmit: (payload) => addGenerationModel(connection, payload),
  });

  /**
   * 打开已添加生成模型的「修改」弹层（服务商详情里该模型行上的入口）。
   * 行本身由记录渲染，能点到的入口必然带着记录；这里只负责清掉上一次的失败提示。
   */
  const openEditGenerationModel = (record: CustomGenerationModel): void => {
    setDialogFailure(null);
    setEditingGenerationModel(record);
  };

  /**
   * 保存一个已添加生成模型的修改（修改弹层的「保存」）：`accepted_media_slots` 与
   * `parameter_overrides` 都是整体替换；编辑器回填的就是现有覆盖，未改动的保存等于原样写回。
   *
   * 后端对覆盖做权威校验（设计 §3.5），确定性拒绝的逐条原因经 `describeErrorWithReason`
   * 原样透进弹层，不笼统化成一句「请重试」。
   */
  const updateGenerationModel = async (
    record: CustomGenerationModel,
    payload: GenerationModelEditPayload,
  ): Promise<boolean> => {
    try {
      await api.updateCustomGenerationModel(record.model_id, {
        accepted_media_slots: payload.acceptedMediaSlots,
        parameter_overrides: payload.parameterOverrides,
      });
      setNotice({ tone: 'success', text: `已保存「${record.model_id}」的模型配置` });
      setDialogFailure(null);
      await reload();
      return true;
    } catch (error: unknown) {
      const text = describeErrorWithReason(
        error,
        '没能保存模型配置，请重试',
        `「${record.model_id}」已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。`,
      );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
  };

  /**
   * 删除一个自建生成模型（生成族模型行上的「删除模型」）：删的是记录本身，它的 active 接入
   * 与「当前使用」标记由后端级联清理，模型从模型列表与生成默认选择里消失。
   * 生成侧的配置弹层没有删除入口，删除入口长在模型行上；只有自己添加的模型才渲染它——
   * 已装模型没有记录可删，入口必然 404（spec §7.5：不提供必然失败的入口）。
   */
  const requestDeleteGenerationModel = (modelId: string): void => {
    setConfirm({ kind: 'delete-custom-generation-model', modelId });
  };

  /**
   * 执行确认后的自建生成模型删除（ProviderSection `handleConfirm` 的
   * delete-custom-generation-model 分支）。
   *
   * 入口在模型行上而不是弹层里：失败原因直接走页面提示条，与「删除服务商」同路
   */
  const confirmDeleteGenerationModel = async (target: ConfirmDeleteGenerationModelTarget): Promise<void> => {
    await run(
      () => api.deleteCustomGenerationModel(target.modelId).then(() => undefined),
      `已删除模型「${target.modelId}」`,
      '没能删除模型，请重试',
      `「${target.modelId}」已经不在了，点「刷新」看最新状态`,
    );
  };

  const generationModelEditDialog: ReactNode = editingGenerationModel === null ? null : (
    <GenerationModelEditDialog
      entry={editingGenerationModel}
      // 参数描述按记录自带的接口类型装载（协议归属模型级，记录的族归属不可变）
      loadParameterTemplate={() =>
        api.getGenerationFamilyTemplate(editingGenerationModel.family_adapter_id, undefined)
      }
      // 弹层里的写入失败把原因显示在这里：分区顶部的提示条被遮罩挡住，用户看不到
      failureText={dialogFailure}
      onClose={() => {
        // 关掉弹层即清掉它自己的失败提示，下一次打开是干净的一次交互
        setDialogFailure(null);
        setEditingGenerationModel(null);
      }}
      onSubmit={(payload) => updateGenerationModel(editingGenerationModel, payload)}
    />
  );

  return {
    generationCustomFormFor,
    openEditGenerationModel,
    requestDeleteGenerationModel,
    confirmDeleteGenerationModel,
    generationModelEditDialog,
  };
}
