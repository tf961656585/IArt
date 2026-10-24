import * as path from "node:path";

import type { CliCanvasGroupSummary, CliCanvasNodeEntry, CliTaskCanvasIdentity } from "@iart/contracts";

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
      ? (raw.data as { assetId?: unknown; taskId?: unknown; name?: unknown; label?: unknown })
      : null;
  // 显示名（spec §5.2 / CLI-057）：组取组名 data.name，其余节点取 data.label；缺失空串。
  const nameField = nodeType === "group" ? data?.name : data?.label;
  const name = typeof nameField === "string" ? nameField : "";
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
  return { node_id: nodeId, node_type: nodeType, name, position: { x, y }, group_id: groupId, asset_id: assetId, task_id: taskId };
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

/**
 * 画布节点载荷 → 组/容器清单条目（spec §5.2 canvas group list / CLI-045）。
 *
 * 容器节点全集 = 节点组（type=group）与 Agent 节点（type=agent，含单节点形态的空容器），
 * 与 Editor 侧 isContainerNode 判定同口径。名称按节点种类取：组 → data.name（未命名为空串）；
 * Agent 容器 → data.label。member_count 按其余节点载荷的 groupId 归属统计（组节点不持有
 * groupId、不参与计数；空容器为 0）。
 *
 * 纯函数、无 IO：载荷缺 id/type 的残缺条目跳过并留痕（条件跳过必须留痕）。
 */
export const projectCanvasGroupSummaries = (payloads: readonly unknown[]): CliCanvasGroupSummary[] => {
  type ContainerRow = { id: string; name: string; type: "group" | "agent_container" };
  const containers: ContainerRow[] = [];
  type MemberRow = { groupId: string };
  const memberRows: MemberRow[] = [];
  for (const payload of payloads) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const raw = payload as { id?: unknown; type?: unknown; groupId?: unknown; data?: unknown };
    const nodeId = typeof raw.id === "string" ? raw.id : "";
    const nodeType = typeof raw.type === "string" ? raw.type : "";
    if (nodeId.length === 0 || nodeType.length === 0) {
      console.debug("[cli-canvas-projection] 组清单：载荷缺 id/type，跳过该节点");
      continue;
    }
    if (nodeType === "group" || nodeType === "agent") {
      const data =
        raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)
          ? (raw.data as { name?: unknown; label?: unknown })
          : null;
      const nameField = nodeType === "group" ? data?.name : data?.label;
      containers.push({
        id: nodeId,
        name: typeof nameField === "string" ? nameField : "",
        type: nodeType === "group" ? "group" : "agent_container",
      });
      continue;
    }
    if (typeof raw.groupId === "string" && raw.groupId.length > 0) {
      memberRows.push({ groupId: raw.groupId });
    }
  }
  const memberCountByGroupId = new Map<string, number>();
  for (const row of memberRows) {
    memberCountByGroupId.set(row.groupId, (memberCountByGroupId.get(row.groupId) ?? 0) + 1);
  }
  return containers.map((container) => ({
    group_node_id: container.id,
    name: container.name,
    type: container.type,
    member_count: memberCountByGroupId.get(container.id) ?? 0,
  }));
};

/**
 * 画布节点载荷 → asset_id → 引用它的画布节点标识列表（spec §5.2 asset list 的
 * `node_ids` / `--on-canvas` 过滤底座，CLI-056）。
 *
 * 引用口径与 canvas nodes list 一致（CLI-017）：资产节点与图片/视频/音频素材节点的
 * data.assetId 都是资产引用，任务节点的占位 assetId 不入列。同一资产可被多个节点引用，
 * 节点顺序按载荷数组序；残缺载荷由 projectCanvasNodePayload 跳过并留痕。
 */
export const buildAssetNodeIndex = (payloads: readonly unknown[]): ReadonlyMap<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const payload of payloads) {
    const entry = projectCanvasNodePayload(payload);
    if (entry === null || entry.asset_id === null) continue;
    const existing = index.get(entry.asset_id);
    if (existing === undefined) {
      index.set(entry.asset_id, [entry.node_id]);
    } else {
      existing.push(entry.node_id);
    }
  }
  return index;
};

/**
 * 画布节点载荷 → task_id → 画布任务投影身份索引（spec §5.4 / CLI-046 join）。
 *
 * task 节点载荷（type=task 且 data.taskId 非空）→ { node_id: 节点 id, group_id: 节点
 * groupId（空缺为 null）}。同一 task_id 出现多个节点属异常持久化：首个命中生效、后续
 * 跳过并留痕（不伪造、不覆盖）。
 */
export const buildTaskCanvasIdentityIndex = (payloads: readonly unknown[]): ReadonlyMap<string, CliTaskCanvasIdentity> => {
  const index = new Map<string, CliTaskCanvasIdentity>();
  for (const payload of payloads) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const raw = payload as { id?: unknown; type?: unknown; groupId?: unknown; data?: unknown };
    const nodeType = typeof raw.type === "string" ? raw.type : "";
    if (nodeType !== "task") continue;
    const nodeId = typeof raw.id === "string" ? raw.id : "";
    const data =
      raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? (raw.data as { taskId?: unknown })
        : null;
    const taskId =
      data !== null && typeof data.taskId === "string" && data.taskId.length > 0 ? data.taskId : null;
    if (nodeId.length === 0 || taskId === null) {
      console.debug("[cli-canvas-projection] 任务身份索引：task 载荷缺 id/taskId，跳过该节点");
      continue;
    }
    if (index.has(taskId)) {
      console.debug("[cli-canvas-projection] 任务身份索引：同一任务标识出现多个节点，保留首个", { taskId });
      continue;
    }
    const groupId = typeof raw.groupId === "string" && raw.groupId.length > 0 ? raw.groupId : null;
    index.set(taskId, { node_id: nodeId, group_id: groupId });
  }
  return index;
};
