/**
 * 投影夹具的深拷贝助手。
 *
 * 历史：本文件的前身是从包目录读真实包拼投影与本地化束的夹具。2026-10-20 模型能力包退场、
 * 包目录删除后，读盘部分整体删除——投影来源改为 `familyTemplateProjectionFixtures`（族模板 ×
 * 真实投影管线）。这里只保留与数据来源无关的深拷贝助手：测试拿到投影后会就地改写字段，
 * 必须拿到独立副本。
 */

const cloneUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cloneUnknown(item),
      ]),
    );
  }
  return value;
};

export const cloneModelAssetFixtureValue = <T,>(value: T): T =>
  cloneUnknown(value) as T;
