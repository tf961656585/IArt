/**
 * Package Area Storage IPC Handler Registration (O 组)
 *
 * 打包区（画布级素材归集工作区）的 read + mutation 两类 IPC handler。
 * IPC 边界使用 Zod schema 严格 parse 入参与出参（项目规范「IPC 边界用 Zod parse 不用 as」）。
 * 与 chat 组（M 组）一致：从 editor-storage-ipc.cts 提取为独立文件。
 */

import { ipcMain } from 'electron';
import {
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageReadPackageAreaByGraphIdParamsSchema,
  StorageReadPackageAreaByGraphIdResultSchema,
  PackageAreaMutationRequestSchema,
  PackageAreaMutationResultSchema,
} from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import { readPackageAreaByGraphId } from './editor-storage-read-model.cjs';
import { applyPackageAreaMutation } from './editor-storage-package-area.cjs';

const CH = EDITOR_STORAGE_IPC_CHANNELS;

/**
 * registerPackageAreaStorageIpcHandlers 需要一个 projectPath → db 的解析函数。
 * 由主 ipc.cts 注入 getDbForExistingProject，避免本模块直接依赖 service-impl 的连接池。
 */
export function registerPackageAreaStorageIpcHandlers(getDb: {
  (projectPath: string): SqliteDatabase | null;
}): void {
  // read handler：读取指定 graphId 的打包区（canonical 排序 + isMissing 判定）
  ipcMain.handle(CH.READ_PACKAGE_AREA_BY_GRAPH_ID, (_event, args: unknown) => {
    const params = StorageReadPackageAreaByGraphIdParamsSchema.parse(args);
    const db = getDb(params.projectPath);
    const packageArea = db
      ? readPackageAreaByGraphId(db, params.graphId)
      : { graphId: params.graphId, entries: [] };
    return StorageReadPackageAreaByGraphIdResultSchema.parse({ packageArea });
  });

  // mutation handler：dispatch 命令式 mutation，返回 canonical 排序后的最新 PackageAreaView
  ipcMain.handle(CH.APPLY_PACKAGE_AREA_MUTATION, (_event, args: unknown) => {
    const params = PackageAreaMutationRequestSchema.parse(args);
    const db = getDb(params.projectPath);
    if (!db) {
      // 项目未打开：无法写入，返回空打包区。
      return PackageAreaMutationResultSchema.parse({
        packageArea: { graphId: params.graphId, entries: [] },
      });
    }
    const packageArea = applyPackageAreaMutation(db, {
      graphId: params.graphId,
      mutation: params.mutation,
    });
    return PackageAreaMutationResultSchema.parse({ packageArea });
  });
}
