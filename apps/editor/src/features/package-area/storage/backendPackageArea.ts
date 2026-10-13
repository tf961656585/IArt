/**
 * Package Area Backend 封装 — Renderer 侧 IPC 调用层
 *
 * 打包区（画布级素材归集工作区）的 read + mutation IPC 封装。
 * 封装层职责：调用 IPC 并用 contracts result schema 校验返回值，
 * 防止未校验数据流入 UI（项目规范「IPC 边界用 Zod parse 不用 as」）。
 *
 * result 统一包装为 { packageArea }，封装层解包后返回裸 PackageAreaView 供 store 消费。
 */

import {
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageReadPackageAreaByGraphIdParamsSchema,
  StorageReadPackageAreaByGraphIdResultSchema,
  PackageAreaMutationRequestSchema,
  PackageAreaMutationResultSchema,
  type PackageAreaMutation,
  type PackageAreaView,
} from "@iart/contracts";
import { ipcInvoke } from "@/features/canvas/storage/backendCore";

export const readPackageAreaByGraphId = async (
  projectPath: string,
  graphId: string,
): Promise<PackageAreaView | null> => {
  if (!projectPath || !graphId) return null;
  const params = StorageReadPackageAreaByGraphIdParamsSchema.parse({ projectPath, graphId });
  const result = StorageReadPackageAreaByGraphIdResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_PACKAGE_AREA_BY_GRAPH_ID, params),
  );
  return result.packageArea;
};

export const applyPackageAreaMutation = async (
  projectPath: string,
  graphId: string,
  mutation: PackageAreaMutation,
): Promise<PackageAreaView | null> => {
  if (!projectPath || !graphId) return null;
  const params = PackageAreaMutationRequestSchema.parse({
    projectPath,
    graphId,
    mutation,
  });
  const result = PackageAreaMutationResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.APPLY_PACKAGE_AREA_MUTATION, params),
  );
  return result.packageArea;
};
