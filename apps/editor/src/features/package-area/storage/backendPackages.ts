/**
 * Package Management Backend 封装 — Renderer 侧包管理 IPC 调用层
 *
 * 包管理（执行打包产物：项目路径 packages/ 下的自描述包文件夹）的
 * create / list / rename / delete / reveal IPC 封装。
 * Editor 只消费 create（打包区面板「执行打包」）；其余通道归 Hub 包管理消费。
 * 边界用 contracts result schema 严格 parse（项目规范「IPC 边界用 Zod parse 不用 as」）。
 */

import {
  PACKAGE_IPC_CHANNELS,
  PackagesCreateParamsSchema,
  PackagesCreateResultSchema,
  PackagesListParamsSchema,
  PackagesListResultSchema,
  PackagesRenameParamsSchema,
  PackagesRenameResultSchema,
  PackagesDeleteParamsSchema,
  PackagesDeleteResultSchema,
  PackagesRevealParamsSchema,
  PackagesRevealResultSchema,
  type PackagesCreateResult,
  type PackagesListResult,
  type PackagesRenameResult,
  type PackagesDeleteResult,
  type PackagesRevealResult,
} from "@iart/contracts";

const getPackagesBridge = (): Record<
  string,
  (args: unknown | undefined) => Promise<unknown>
> | null => {
  if (typeof window === "undefined") return null;
  return (window.electron !== null && window.electron !== undefined ? window.electron.packages : undefined) ?? null;
};

const invokePackageChannel = async <T>(
  channel: string,
  schema: { parse(value: unknown): unknown },
  args: unknown,
): Promise<T> => {
  const bridge = getPackagesBridge();
  if (!bridge || typeof bridge[channel] !== "function") {
    throw new Error(`Packages IPC channel "${channel}" 不可用`);
  }
  return schema.parse(await bridge[channel](args)) as T;
};

export const createPackage = async (
  projectPath: string,
  name: string,
  assetIds: string[],
): Promise<PackagesCreateResult> => {
  const params = PackagesCreateParamsSchema.parse({ projectPath, name, assetIds });
  return invokePackageChannel<PackagesCreateResult>(
    PACKAGE_IPC_CHANNELS.CREATE_PACKAGE,
    PackagesCreateResultSchema,
    params,
  );
};

export const listPackages = async (projectPath: string): Promise<PackagesListResult> => {
  const params = PackagesListParamsSchema.parse({ projectPath });
  return invokePackageChannel<PackagesListResult>(
    PACKAGE_IPC_CHANNELS.LIST_PACKAGES,
    PackagesListResultSchema,
    params,
  );
};

export const renamePackage = async (
  projectPath: string,
  packageId: string,
  name: string,
): Promise<PackagesRenameResult> => {
  const params = PackagesRenameParamsSchema.parse({ projectPath, packageId, name });
  return invokePackageChannel<PackagesRenameResult>(
    PACKAGE_IPC_CHANNELS.RENAME_PACKAGE,
    PackagesRenameResultSchema,
    params,
  );
};

export const deletePackage = async (
  projectPath: string,
  packageId: string,
): Promise<PackagesDeleteResult> => {
  const params = PackagesDeleteParamsSchema.parse({ projectPath, packageId });
  return invokePackageChannel<PackagesDeleteResult>(
    PACKAGE_IPC_CHANNELS.DELETE_PACKAGE,
    PackagesDeleteResultSchema,
    params,
  );
};

export const revealPackage = async (
  projectPath: string,
  packageId: string,
): Promise<PackagesRevealResult> => {
  const params = PackagesRevealParamsSchema.parse({ projectPath, packageId });
  return invokePackageChannel<PackagesRevealResult>(
    PACKAGE_IPC_CHANNELS.REVEAL_PACKAGE,
    PackagesRevealResultSchema,
    params,
  );
};
