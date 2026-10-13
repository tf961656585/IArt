/**
 * Package Management IPC Handler Registration
 *
 * 包管理（执行打包产物：项目路径 packages/ 下的自描述包文件夹）的
 * list / create / rename / delete / reveal 五类 IPC handler。
 * IPC 边界使用 Zod schema 严格 parse 入参与出参（项目规范「IPC 边界用 Zod parse 不用 as」）。
 *
 * create 需要项目 db（解析 assetId → 媒体文件），注入 getDbForExistingProject；
 * 其余操作只走文件系统与 shell。
 */

import { ipcMain } from 'electron';
import {
  PACKAGE_IPC_CHANNELS,
  PackagesListParamsSchema,
  PackagesListResultSchema,
  PackagesCreateParamsSchema,
  PackagesCreateResultSchema,
  PackagesRenameParamsSchema,
  PackagesRenameResultSchema,
  PackagesDeleteParamsSchema,
  PackagesDeleteResultSchema,
  PackagesRevealParamsSchema,
  PackagesRevealResultSchema,
} from '@iart/contracts';
import type { SqliteDatabase } from './storage/sqlite-loader.cjs';
import {
  listPackages,
  createPackage,
  renamePackage,
  deletePackage,
  revealPackage,
} from './storage/editor-storage-packages.cjs';

export function registerPackageManagementIpcHandlers(getDb: {
  (projectPath: string): SqliteDatabase | null;
}): void {
  ipcMain.handle(PACKAGE_IPC_CHANNELS.LIST_PACKAGES, (_event, args: unknown) => {
    const params = PackagesListParamsSchema.parse(args);
    return PackagesListResultSchema.parse({ packages: listPackages(params.projectPath) });
  });

  ipcMain.handle(PACKAGE_IPC_CHANNELS.CREATE_PACKAGE, (_event, args: unknown) => {
    const params = PackagesCreateParamsSchema.parse(args);
    const db = getDb(params.projectPath);
    if (!db) {
      throw new Error(`PACKAGE_CREATE_PROJECT_NOT_OPEN: ${params.projectPath}`);
    }
    return PackagesCreateResultSchema.parse(
      createPackage(db, {
        projectPath: params.projectPath,
        name: params.name,
        assetIds: params.assetIds,
      }),
    );
  });

  ipcMain.handle(PACKAGE_IPC_CHANNELS.RENAME_PACKAGE, (_event, args: unknown) => {
    const params = PackagesRenameParamsSchema.parse(args);
    return PackagesRenameResultSchema.parse(
      renamePackage({
        projectPath: params.projectPath,
        packageId: params.packageId,
        name: params.name,
      }),
    );
  });

  ipcMain.handle(PACKAGE_IPC_CHANNELS.DELETE_PACKAGE, async (_event, args: unknown) => {
    const params = PackagesDeleteParamsSchema.parse(args);
    return PackagesDeleteResultSchema.parse(
      await deletePackage({ projectPath: params.projectPath, packageId: params.packageId }),
    );
  });

  ipcMain.handle(PACKAGE_IPC_CHANNELS.REVEAL_PACKAGE, (_event, args: unknown) => {
    const params = PackagesRevealParamsSchema.parse(args);
    return PackagesRevealResultSchema.parse(
      revealPackage({ projectPath: params.projectPath, packageId: params.packageId }),
    );
  });
}
