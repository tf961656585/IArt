import * as z from 'zod';

import { CliCanvasSelectionSchema } from './cli-canvas-contract';

/**
 * CLI 画布场景图契约（`canvas.inspect` 只读命令与 `canvas.geometry.get` 代理只读命令）。
 *
 * 职责边界（行数预算拆分先例同 cli-canvas-contract / cli-asset-import-contract）：
 * - `canvas.inspect` 是 B 命令面的整张画布场景图：节点几何、容器派生框、未落画布资产、
 *   视口与选中态。几何默认由持久化数据离线派生（fidelity=derived），项目画布窗口打开时
 *   可合并窗口内精确几何（fidelity=exact）。
 * - `canvas.geometry.get` 是 C 代理执行通道的只读查询：画布窗口直读 store 现值返回节点尺寸、
 *   容器派生框、视口与选中态；不映射 action、不进撤销栈、不产生任何写入。
 *
 * 单一事实源：几何公式（媒体展示尺寸 / 音频节点尺寸 / 容器渲染框）由
 * `@iart/utils/canvas-geometry` 承载；本文件只承载跨边界 DTO 形状。
 */

/** 画布坐标点（任意有限数值）。 */
export const CliCanvasInspectPointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type CliCanvasInspectPoint = z.infer<typeof CliCanvasInspectPointSchema>;

/** 画布尺寸（宽高，px）。 */
export const CliCanvasInspectSizeSchema = z
  .object({
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type CliCanvasInspectSize = z.infer<typeof CliCanvasInspectSizeSchema>;

/** 带左上角坐标的包围盒：x/y 即节点 position，width/height 即节点 size。 */
export const CliCanvasInspectBBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type CliCanvasInspectBBox = z.infer<typeof CliCanvasInspectBBoxSchema>;

/**
 * 画布视口（React Flow 视口现值）。
 *
 * 基础形状供 `canvas.geometry.get` 的几何快照复用（只承载平移与缩放）；
 * `canvas.inspect` 结果用下方的带尺寸变体，两者不复制字段。
 */
export const CliCanvasInspectViewportSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    zoom: z.number(),
  })
  .strict();
export type CliCanvasInspectViewport = z.infer<typeof CliCanvasInspectViewportSchema>;

/**
 * `canvas.inspect` 结果的视口：在平移/缩放之外回报画布容器像素尺寸。
 * 画布窗口未打开或未上报尺寸时为 null（不伪造）。
 */
export const CliCanvasInspectSceneViewportSchema = CliCanvasInspectViewportSchema.extend({
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
}).strict();
export type CliCanvasInspectSceneViewport = z.infer<typeof CliCanvasInspectSceneViewportSchema>;

/**
 * 节点引用的资产投影（身份 join：节点 data.assetId → 媒体资产表 + 生成来源索引）。
 * 无资产引用、或资产不在项目库时节点 asset 为 null（缺省不伪造）。
 */
export const CliCanvasInspectNodeAssetSchema = z
  .object({
    asset_id: z.string().min(1),
    /** 媒体类型原样（image / video / audio / 其他）。 */
    media_type: z.string().min(1),
    /** 原始像素宽；不可得为 null。 */
    width: z.number().nullable(),
    /** 原始像素高；不可得为 null。 */
    height: z.number().nullable(),
    file_name: z.string().min(1).nullable(),
    /** 资产来源批次（资产节点 payload 的 sourceBatchId）；不可得为 null。 */
    batch_id: z.string().min(1).nullable(),
    /** 产出该资产的任务标识；非生成产物为 null。 */
    task_id: z.string().min(1).nullable(),
    /** 产出该资产的模型标识；非生成产物为 null。 */
    model_id: z.string().min(1).nullable(),
    /**
     * 提示词摘要：缺省 compact 截断 200 字符（超长追加省略号）；`--full` 不截断；
     * `--prompt-limit N` 指定截断长度（0 = 不输出）。无提示词为 null。
     */
    prompt_preview: z.string().nullable(),
    /** 资产创建时间（ISO 8601）；不可得为 null。 */
    created_at: z.string().nullable(),
    /** 本地媒体文件绝对路径；无本地文件承载为 null。 */
    local_file_path: z.string().min(1).nullable(),
  })
  .strict();
export type CliCanvasInspectNodeAsset = z.infer<typeof CliCanvasInspectNodeAssetSchema>;

/**
 * 画布场景图节点（非容器节点）。name 为组名以外的显示名（data.label，缺失为空串）；
 * size 只算画布本体尺寸（媒体节点用媒体展示尺寸、音频用音频策略、任务 240×160）；
 * bbox = position + size（左上角）。
 */
export const CliCanvasInspectNodeSchema = z
  .object({
    node_id: z.string().min(1),
    node_type: z.string().min(1),
    name: z.string(),
    position: CliCanvasInspectPointSchema,
    size: CliCanvasInspectSizeSchema,
    bbox: CliCanvasInspectBBoxSchema,
    group_id: z.string().min(1).nullable(),
    asset_id: z.string().min(1).nullable(),
    /**
     * 任务节点取自身的任务标识；资产节点取 `data.sourceTaskId`（产出该资产的任务）；
     * 其他节点为 null。
     */
    task_id: z.string().min(1).nullable(),
    /**
     * 任务节点取 `data.batchId`；资产节点取 `data.sourceBatchId`（生成来源批次）；
     * 其他节点为 null（无生成来源可报）。
     */
    batch_id: z.string().min(1).nullable(),
    /** 节点创建时间（ISO 8601）；持久化记录无创建时间时为 null。 */
    created_at: z.string().nullable().default(null),
    /** 节点提示词预览（compact 摘要；full=true 时由 prompt_limit 决定完整度）；无提示词为 null。 */
    prompt_preview: z.string().nullable().default(null),
    /** 资产节点的原始来源文件名；非资产节点或不可得为 null。 */
    source_file_name: z.string().min(1).nullable().default(null),
    asset: CliCanvasInspectNodeAssetSchema.nullable(),
  })
  .strict();
export type CliCanvasInspectNode = z.infer<typeof CliCanvasInspectNodeSchema>;

/**
 * 容器最近邻（顶层容器两两 Chebyshev 间距的最小者）：node_id 为最近邻容器标识，
 * gap 为两框 Chebyshev 间距（负数表示相交）。只有一个容器时为 null。
 */
export const CliCanvasInspectNearestNeighborSchema = z
  .object({
    node_id: z.string().min(1),
    gap: z.number(),
  })
  .strict();
export type CliCanvasInspectNearestNeighbor = z.infer<typeof CliCanvasInspectNearestNeighborSchema>;

/**
 * 画布容器（组 | Agent 容器）：position/size 为派生渲染框（成员包围盒 + padding + 标题
 * 或折叠卡片），绝不使用持久化的组 position；member_ids 按成员的 groupId 归属统计。
 */
export const CliCanvasInspectContainerSchema = z
  .object({
    group_node_id: z.string().min(1),
    name: z.string(),
    type: z.enum(['group', 'agent_container']),
    member_ids: z.array(z.string().min(1)),
    position: CliCanvasInspectPointSchema,
    size: CliCanvasInspectSizeSchema,
    bbox: CliCanvasInspectBBoxSchema,
    collapsed: z.boolean(),
    /** 顶层容器最近邻（按渲染框 Chebyshev 间距）；非顶层或唯一容器为 null。 */
    nearest_neighbor: CliCanvasInspectNearestNeighborSchema.nullable().default(null),
  })
  .strict();
export type CliCanvasInspectContainer = z.infer<typeof CliCanvasInspectContainerSchema>;

/** 未落画布资产（项目全部媒体资产中未被任何画布节点引用者）。 */
export const CliCanvasInspectUnplacedAssetSchema = z
  .object({
    asset_id: z.string().min(1),
    media_type: z.string().min(1),
    file_name: z.string().min(1).nullable(),
    created_at: z.string().nullable(),
    /**
     * 来源批次（生成来源索引按 assetId 反查）：生成产物给批次标识；
     * 导入素材等无产出来源为 null（CLI-056 回填）。
     */
    batch_id: z.string().min(1).nullable(),
  })
  .strict();
export type CliCanvasInspectUnplacedAsset = z.infer<typeof CliCanvasInspectUnplacedAssetSchema>;

/** 画布注释（独立注释节点或绑定到节点的注释）：位置/尺寸为画布坐标与像素尺寸。 */
export const CliCanvasInspectAnnotationSchema = z
  .object({
    annotation_id: z.string().min(1),
    content: z.string(),
    position: CliCanvasInspectPointSchema,
    size: CliCanvasInspectSizeSchema,
    /** 绑定到的节点标识；独立注释为 null。 */
    bound_to_node_id: z.string().min(1).nullable(),
  })
  .strict();
export type CliCanvasInspectAnnotation = z.infer<typeof CliCanvasInspectAnnotationSchema>;

/**
 * 节点/容器包围盒两两相交报告（只列相交对）：a_id/b_id 按标识升序，overlap 为相交区域尺寸。
 */
export const CliCanvasInspectOverlapSchema = z
  .object({
    a_id: z.string().min(1),
    b_id: z.string().min(1),
    overlap_width: z.number(),
    overlap_height: z.number(),
  })
  .strict();
export type CliCanvasInspectOverlap = z.infer<typeof CliCanvasInspectOverlapSchema>;

/**
 * 顶层容器最小间距（两两 Chebyshev 间距的最小者）：gap 为负数表示两框相交。
 * 不足两个顶层容器时为 null。
 */
export const CliCanvasInspectMinGapSchema = z
  .object({
    a_id: z.string().min(1),
    b_id: z.string().min(1),
    gap: z.number(),
  })
  .strict();
export type CliCanvasInspectMinGap = z.infer<typeof CliCanvasInspectMinGapSchema>;

/**
 * `canvas.inspect` 结果：整张画布场景图。
 * - fidelity=derived：几何由持久化数据离线算出，viewport/selection 为 null；
 * - fidelity=exact：几何由打开着的画布窗口合并而来（每个画布节点与容器都拿到精确几何
 *   才算 exact，否则整体降回 derived）。
 * - annotations / overlaps / min_gap 是诊断辅助面：旧响应缺这些键时按空集合/null 兜底。
 */
export const CliCanvasInspectResultSchema = z
  .object({
    fidelity: z.enum(['exact', 'derived']),
    nodes: z.array(CliCanvasInspectNodeSchema),
    containers: z.array(CliCanvasInspectContainerSchema),
    assets_not_on_canvas: z.array(CliCanvasInspectUnplacedAssetSchema),
    viewport: CliCanvasInspectSceneViewportSchema.nullable(),
    selection: CliCanvasSelectionSchema.nullable(),
    /** 画布注释（`--group` 时只含该容器及后代绑定的注释）。 */
    annotations: z.array(CliCanvasInspectAnnotationSchema).default([]),
    /** 节点/容器包围盒两两相交报告（无相交为空数组）。 */
    overlaps: z.array(CliCanvasInspectOverlapSchema).default([]),
    /** 顶层容器最小间距（Chebyshev，负数=重叠）；不足两个顶层容器为 null。 */
    min_gap: CliCanvasInspectMinGapSchema.nullable().default(null),
  })
  .strict();
export type CliCanvasInspectResult = z.infer<typeof CliCanvasInspectResultSchema>;

/**
 * `canvas.geometry.get` 的几何快照（画布窗口 → 主进程只读回传）：
 * sizes 覆盖全部画布节点（容器为派生尺寸），containers 覆盖全部容器（派生 position+size）。
 * 画布尚未就绪时 sizes/containers 为空记录、viewport/selection 为 null（不伪造）。
 */
export const CliCanvasGeometrySnapshotSchema = z
  .object({
    sizes: z.record(CliCanvasInspectSizeSchema),
    containers: z.record(
      z
        .object({
          position: CliCanvasInspectPointSchema,
          size: CliCanvasInspectSizeSchema,
        })
        .strict(),
    ),
    // 几何快照视口含画布可视区宽高（与 inspect 结果同一变体）；旧响应缺这两键按 null 兜底。
    viewport: CliCanvasInspectSceneViewportSchema.nullable(),
    selection: CliCanvasSelectionSchema.nullable(),
  })
  .strict();
export type CliCanvasGeometrySnapshot = z.infer<typeof CliCanvasGeometrySnapshotSchema>;

/** `canvas.geometry.get` 代理结果：request_id 原样配对 + 几何快照。 */
export const CliCanvasGeometryGetResultSchema = z
  .object({
    command: z.literal('canvas.geometry.get'),
    request_id: z.string().min(1),
    ...CliCanvasGeometrySnapshotSchema.shape,
  })
  .strict();
export type CliCanvasGeometryGetResult = z.infer<typeof CliCanvasGeometryGetResultSchema>;
