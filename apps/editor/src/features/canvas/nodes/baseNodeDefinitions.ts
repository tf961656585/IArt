import type { NodeSize } from "../types/node";
import type { NodeDefinition } from "./registry";
import { MATERIAL_NODE_TYPE_LABEL } from "./materialNodeContent";
import { taskNodeDefinition } from "./task/taskNodeFactory";
import { assetNodeDefinition } from "./asset/assetNodeFactory";
import { agentNodeDefinition } from "./agent/agentNodeFactory";


/** 非 model 节点的公共 undefined 字段 */
const _baseOptionalFields = {
  defaultSize: undefined as NodeSize | undefined,
  sizeStrategy: undefined as NodeDefinition["sizeStrategy"],
  modelId: undefined as string | undefined,
  providerId: undefined as string | undefined,
  groupId: undefined as string | undefined,
  bundle: undefined as NodeDefinition["bundle"],
  palette: undefined as NodeDefinition["palette"],
  companions: undefined as NodeDefinition["companions"],
  variantGroup: undefined as NodeDefinition["variantGroup"],
} as const;

// 注册基础节点（画板模式：无全局开始/结束节点）
// 说明（2026-08-25 素材/文本节点退役裁定）：
// - textInput（文本素材/文本输入节点）已退役，从定义中移除；存量文本节点由
//   legacy 渲染与加载归一化兜底（无存量项目，无迁移需求）。
// - 素材节点（imageInput/videoInput/audioInput）只经正式导入链创建（拖入画布、
//   工具派生、角色坞），不提供空建。palette 不可见：画布内快速添加入口与其
//   候选集已随本批退役。
export const baseNodeDefinitions: NodeDefinition[] = [
  {
    ..._baseOptionalFields,
    type: "imageInput",
    label: MATERIAL_NODE_TYPE_LABEL.imageInput,
    description: "上传的图片，可作为参考素材",
    category: "input",
    icon: "image",
    defaultData: {
      label: MATERIAL_NODE_TYPE_LABEL.imageInput,
      imageUrl: null,
      imageMeta: null,
    },
    palette: { visible: false },
    deletable: true,
    copyable: true,
    color: "#10b981",
    executable: false,
    defaultSize: { width: 240, height: 180 },
    sizeStrategy: { mode: "layoutModel" },
  },
  {
    ..._baseOptionalFields,
    type: "videoInput",
    label: MATERIAL_NODE_TYPE_LABEL.videoInput,
    description: "上传的视频素材",
    category: "input",
    icon: "video",
    defaultData: {
      label: MATERIAL_NODE_TYPE_LABEL.videoInput,
      videoUrl: null,
      videoMeta: null,
      valueSource: undefined,
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
    },
    palette: { visible: false },
    deletable: true,
    copyable: true,
    color: "#f59e0b",
    executable: false,
    defaultSize: { width: 240, height: 160 },
    sizeStrategy: { mode: "layoutModel" },
  },
  {
    ..._baseOptionalFields,
    type: "audioInput",
    label: MATERIAL_NODE_TYPE_LABEL.audioInput,
    description: "上传的音频素材，可分段编辑",
    category: "input",
    icon: "music",
    defaultData: {
      label: MATERIAL_NODE_TYPE_LABEL.audioInput,
      audioUrl: null,
      valueSource: undefined,
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      duration: 0,
      segments: [],
      segmentModeEnabled: false,
    },
    palette: { visible: false },
    deletable: true,
    copyable: true,
    color: "#8b5cf6",
    executable: true,
    defaultSize: { width: 240, height: 160 },
    sizeStrategy: { mode: "layoutModel" },
  },
  {
    ..._baseOptionalFields,
    type: "group",
    label: "节点组",
    description: "把多个节点收在一起，方便整体移动和整理",
    category: "utility",
    icon: "group",
    // 组节点不出现在节点面板/快捷添加候选列表，只能通过多选右键"添加组"创建
    palette: { visible: false },
    // 折叠态与初始态默认尺寸；展开态尺寸由成员 bbox 衍生（渲染层计算）
    defaultSize: { width: 220, height: 56 },
    defaultData: {
      label: "节点组",
      name: "",
      collapsed: false,
    },
    deletable: true,
    copyable: false,
    color: "#64748b",
    executable: false,
  },
  taskNodeDefinition,
  assetNodeDefinition,
  agentNodeDefinition,
];
