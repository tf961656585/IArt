import type { CliGenerationWarning, RuntimeMediaAssetView, RuntimeTaskView } from "@iart/contracts";
import { resolveLocalMediaFilePath } from "./cli-canvas-projection.cjs";

/**
 * 任务终态结果投影（spec docs/integrations/CLI与本地Agent集成.md §5.4 / CLI-009 / CLI-050）：
 * 产物资产条目（资产 + 本地媒体文件绝对路径）与生成终态尺寸提示。纯函数集中在此，
 * `task wait` / `generate --wait` 的终态结果共用同一构建出口，不在执行器内复制比较逻辑。
 */

/** 产物资产 → 带本地绝对路径的契约条目；无法定位本地文件的资产跳过并留痕。 */
export const toCliAssetWithLocalPath = (
  projectPath: string,
  asset: RuntimeMediaAssetView,
): { asset: RuntimeMediaAssetView; local_file_path: string } | null => {
  const localFilePath = resolveLocalMediaFilePath(projectPath, asset);
  if (localFilePath === null) return null;
  return { asset, local_file_path: localFilePath };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 请求尺寸字面量（`^\d+x\d+$`，x 大小写不敏感）：规范化小写 x；`auto`/档位值/缺失返回 null。 */
const readSizeLiteral = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^(\d+)[xX](\d+)$/.exec(value);
  if (match === null) return null;
  return `${match[1]}x${match[2]}`;
};

/**
 * 从任务请求中读取请求尺寸（spec §5.4 / CLI-050）：
 * - multipart 摘要形态：`request.body.__formData.fields[]` 中 name=size 的字段（真实提交形态）；
 * - JSON 请求体形态：`request.body.size`。
 * 只认字面量；`auto`、档位值与缺失一律不产生提示（不把呈现属性升级为执行校验）。
 */
const readRequestedImageSize = (request: RuntimeTaskView["request"]): string | null => {
  if (!isPlainRecord(request)) return null;
  const body = request.body;
  if (!isPlainRecord(body)) return null;
  const direct = readSizeLiteral(body.size);
  if (direct !== null) return direct;
  const formData = body.__formData;
  if (!isPlainRecord(formData)) return null;
  const fields = formData.fields;
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (!isPlainRecord(field) || field.name !== "size") continue;
    const literal = readSizeLiteral(field.value);
    if (literal !== null) return literal;
  }
  return null;
};

/** 实际图片产物尺寸集合（去重、字典序）；非图片资产与缺宽高的资产跳过。 */
const collectActualImageSizes = (assets: readonly { asset: RuntimeMediaAssetView }[]): string[] => {
  const sizes = new Set<string>();
  for (const entry of assets) {
    const asset = entry.asset;
    if (asset.mediaType !== "image") continue;
    const width = asset.original.width;
    const height = asset.original.height;
    if (typeof width !== "number" || typeof height !== "number") continue;
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    sizes.add(`${width}x${height}`);
  }
  return [...sizes].sort();
};

/**
 * 生成终态尺寸对照（spec §5.4 / CLI-050）：任务成功但任一实际图片尺寸 ≠ 请求尺寸时，
 * 产出一条信息性 warning。不改变任务状态、ok 与 assets；无图片资产、请求尺寸缺失/
 * 非字面量、全部匹配时返回空数组。
 */
export const buildGenerationWarnings = (
  task: Pick<RuntimeTaskView, "request">,
  assets: readonly { asset: RuntimeMediaAssetView }[],
): CliGenerationWarning[] => {
  const requestedSize = readRequestedImageSize(task.request);
  if (requestedSize === null) return [];
  const actualSizes = collectActualImageSizes(assets);
  if (actualSizes.length === 0) return [];
  if (actualSizes.every((size) => size === requestedSize)) return [];
  return [
    {
      code: "requested_size_not_honored",
      message: `请求尺寸 ${requestedSize}，实际产出 ${actualSizes.join("、")}。生成任务已成功，尺寸以实际产物为准。`,
      requested_size: requestedSize,
      actual_sizes: actualSizes,
    },
  ];
};
