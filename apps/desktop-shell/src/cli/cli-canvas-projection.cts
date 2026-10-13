import * as path from "node:path";

import type { CliCanvasNodeEntry } from "@iart/contracts";

/**
 * 持有资产引用的节点类型全集：资产节点与图片/视频/音频素材节点的 data.assetId
 * 都是资产引用（spec docs/integrations/CLI与本地Agent集成.md §5.2 / CLI-017）。
 * 与 Editor 侧 features/canvas/utils/nodeAssetId.ts 同口径；任务节点的 assetId 是
 * 占位资产身份（成功投影后回填替换），不属于资产引用口径，不入列。
 */
const ASSET_ID_NODE_TYPES: ReadonlySet<string> = new Set([
  "asset",
  "imageInput",
  "videoInput",
  "audioInput",
]);

/**
 * 画布节点投影 → CLI 画布节点条目（spec docs/integrations/CLI与本地Agent集成.md §5.2
 * canvas nodes list：节点标识、类型、位置、组归属、资产/任务引用）。
 *
 * 节点载荷是 Editor 持久化的整节点 JSON（editor-storage-delta 原样写 nodes.payloadJson），
 * 形状事实源在 Editor 画布域（features/canvas/types/node.ts）：id / type / position{x,y} /
 * groupId（空间归属）/ data。引用字段按节点种类收敛：
 * - asset / imageInput / videoInput / audioInput 节点 → data.assetId（资产引用）；
 * - task 节点 → data.taskId（任务引用）；
 * - 其余种类（文本素材/注释/组/Agent 容器）无资产或任务引用 → null。
 *
 * 纯函数、无 IO：形状不满足最低要求（id/type/position）时返回 null 由调用方跳过并留痕。
 */

export const projectCanvasNodePayload = (payload: unknown): CliCanvasNodeEntry | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as {
    id?: unknown;
    type?: unknown;
    position?: unknown;
    groupId?: unknown;
    data?: unknown;
  };
  const nodeId = typeof raw.id === "string" ? raw.id : "";
  const nodeType = typeof raw.type === "string" ? raw.type : "";
  const position =
    raw.position !== null && typeof raw.position === "object"
      ? (raw.position as { x?: unknown; y?: unknown })
      : null;
  const x = position !== null && typeof position.x === "number" && Number.isFinite(position.x) ? position.x : null;
  const y = position !== null && typeof position.y === "number" && Number.isFinite(position.y) ? position.y : null;
  if (nodeId.length === 0 || nodeType.length === 0 || x === null || y === null) {
    console.debug("[cli-canvas-projection] 节点载荷缺 id/type/position，跳过该节点");
    return null;
  }
  const groupId = typeof raw.groupId === "string" && raw.groupId.length > 0 ? raw.groupId : null;
  const data =
    raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? (raw.data as { assetId?: unknown; taskId?: unknown })
      : null;
  const assetId =
    ASSET_ID_NODE_TYPES.has(nodeType) &&
    data !== null &&
    typeof data.assetId === "string" &&
    data.assetId.length > 0
      ? data.assetId
      : null;
  const taskId =
    nodeType === "task" && data !== null && typeof data.taskId === "string" && data.taskId.length > 0
      ? data.taskId
      : null;
  return { node_id: nodeId, node_type: nodeType, position: { x, y }, group_id: groupId, asset_id: assetId, task_id: taskId };
};

/**
 * 资产 → 本地媒体文件绝对路径（spec §5.2 asset get / §5.4 产物资产：供 Agent 直接读取文件内容）。
 *
 * 磁盘布局事实源：editor-storage-local-media 的 importLocalMedia——媒体文件固定写在
 * `<项目目录>/media/<fileKey>`；local-media:// URL 形如 `local-media://<hostname>/<fileKey>`
 * （hostname 为 stableProjectId 或旧 projectRef，不影响路径解析）。fileKey 优先取资产
 * original.fileKey，缺失时从 URL pathname 解析兜底（同一事实源的两个承载位）。
 * 无法定位 fileKey 时返回 null（资产无本地文件承载）。
 */
export const resolveLocalMediaFilePath = (
  projectPath: string,
  asset: { original: { url: string; fileKey?: string | null | undefined } },
): string | null => {
  const fileKey = typeof asset.original.fileKey === "string" && asset.original.fileKey.length > 0
    ? asset.original.fileKey
    : parseFileKeyFromLocalMediaUrl(asset.original.url);
  if (fileKey === null || fileKey.length === 0 || fileKey.includes("..") || fileKey.includes("/") || fileKey.includes("\\")) {
    console.debug("[cli-canvas-projection] 资产无法定位本地文件键，跳过", {
      fileKey: typeof asset.original.fileKey === "string" ? asset.original.fileKey : null,
    });
    return null;
  }
  return joinMediaPath(projectPath, fileKey);
};

const parseFileKeyFromLocalMediaUrl = (url: string): string | null => {
  if (!url.startsWith("local-media://")) return null;
  const pathIndex = url.indexOf("/", "local-media://".length);
  if (pathIndex < 0) return null;
  const raw = url.slice(pathIndex + 1);
  if (raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const joinMediaPath = (projectPath: string, fileKey: string): string => path.join(projectPath, "media", fileKey);
