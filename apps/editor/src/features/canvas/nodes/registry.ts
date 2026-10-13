/**
 * 节点注册表
 * - 管理所有可用的节点类型
 * - 提供节点创建、查询功能
 */

import type { GraphNodeType, GraphNode, NodePosition, GraphNodeData, AudioInputNodeData, NodeSize, NodeSizeProposalSource } from '../types/node';
import type { NodeCompanionDeclaration } from '../types/nodeCompanion';
import { augmentNodeDefinitionCompanions } from '../services/nodeCompanion/augmentNodeDefinitionCompanions';
import type { UnknownRecord } from '@/client/utils/typeGuards';

/** 节点分类 */
export type NodeCategory =
  | 'flow'      // 流程控制
  | 'transform' // 处理/转换
  | 'input'     // 数据输入
  | 'utility';  // 工具

/**
 * 节点尺寸策略。
 *
 * 区分节点的渲染尺寸是否会因内容变化偏离 defaultSize 且无 desired producer 就无法自收敛。
 * 取值与校验契约见 docs/runtime/画布节点尺寸管理架构.md「节点尺寸策略分类」与
 * 「sizeStrategy 声明性字段与注册期校验」节。
 *
 * 三种模式：
 * - dynamic：渲染尺寸需 desired 反馈环收敛（如 model 结果区 auto-fit），必须绑定 producer。
 * - static：渲染尺寸稳定收敛到 defaultSize 附近，measured + default 覆盖。
 * - layoutModel：渲染尺寸会随内容变化，但由 Layout Model 对应计算层（如媒体尺寸层）
 *   按纯函数一次性派生，无 desired producer（典型：媒体输入节点按 meta 派生展示尺寸）。
 */
export type SizeStrategy =
  | { mode: 'dynamic'; producer: NodeSizeProposalSource }
  | { mode: 'static' }
  | { mode: 'layoutModel' };

/** 节点定义 */
export interface NodeDefinition {
  /** 节点类型 */
  type: GraphNodeType;
  /** 节点显示名称 */
  label: string;
  /** 节点描述 */
  description: string | undefined | undefined;
  /** 节点分类 */
  category: NodeCategory;
  /** 节点图标 */
  icon: string | undefined | undefined;
  /** 默认数据 */
  defaultData: UnknownRecord;
  /** 默认尺寸（可选）：用于可调尺寸节点 */
  defaultSize: NodeSize | undefined;
  /**
   * 节点尺寸策略声明（OCP 扩展点）。
   *
   * 声明该节点的渲染尺寸是 dynamic（需绑定 desired producer）还是 static
   *（measured + default 即可覆盖）。undefined 等价于 static。
   * 注册期按此字段校验 producer 绑定一致性，见 NodeRegistry.register。
   * 契约见 docs/runtime/画布节点尺寸管理架构.md「sizeStrategy 声明性字段与注册期校验」节。
   */
  sizeStrategy: SizeStrategy | undefined;
  /** 模型 key（仅模型节点） */
  modelId: string | undefined;
  /** provider ID（仅模型节点） */
  providerId: string | undefined;
  /** 模型分组 ID（通常等于 providerId，可用于自定义分组） */
  groupId: string | undefined;
  /** 是否可删除 */
  deletable: boolean | undefined;
  /** 是否可复制 */
  copyable: boolean | undefined;
  /** 节点颜色 */
  color: string | undefined;
  /**
   * 是否为可执行节点（显示执行按钮）
   * - true: 具有实际执行行为的节点
   * - false: 仅作数据承载、无需用户触发执行的节点
   */
  executable: boolean | undefined;

  /**
   * 可选：bundle 导入自描述（OCP 扩展点）
   * - importable: 是否允许被 bundle 导入（默认 true）
   * - sanitizeData: 对“已合并 defaultData + rawData”的结果做进一步净化/归一化
   */
  bundle: {
    importable: boolean | undefined;
    sanitizeData: (data: UnknownRecord, context: { node: UnknownRecord }) => UnknownRecord | undefined;
  } | undefined;

  /**
   * 可选：节点面板展示控制
   * - visible=false: 不在节点面板/快捷添加候选列表中显示（但仍可用于导入/加载迁移）
   */
  palette: {
    visible: boolean | undefined;
  } | undefined;

  /**
   * 可选：Companion 声明（OCP 扩展点）
   * - 通过声明式元信息描述 owner -> companions 的关系
   * - 运行时由 nodeCompanionManager 读取并接入 create/execute/position-sync 等链路
   */
  companions: NodeCompanionDeclaration[] | undefined;

  /**
   * 可选：变体组信息（仅主型号节点携带）
   * - 用于 Inspector 中渲染型号切换下拉
   * - 用于画布节点标题区域展示当前变体 label
   */
  variantGroup: {
    groupKey: string;
    variants: Array<{ modelId: string; label: string; order: number }>;
  } | undefined;
}

export const getNodeDefinitionKey = (definition: NodeDefinition): string =>
  definition.modelId ?? definition.type;

export const isNodeDefinitionPaletteVisible = (definition: NodeDefinition): boolean =>
  (definition.palette !== null && definition.palette !== undefined ? definition.palette.visible : undefined) !== false;

/**
 * 注册期校验节点定义。
 *
 * 契约见 docs/runtime/画布节点尺寸管理架构.md「sizeStrategy 声明性字段与注册期校验」节
 * 注册期校验契约。任一失败则 throw，禁止静默接受不合规定义。throw 风格对齐
 * ModelNodeFactory.reconcileModelNode 的冒号分段格式 `kind:nodeType:detail`。
 *
 * 1. defaultSize 存在性：每个会出现在画布上的节点类型必须定义反映典型渲染尺寸的
 *    defaultSize，禁止静默落到 DEFAULT_NODE_SIZE。
 * 2. sizeStrategy 一致性（dynamic）：声明 dynamic 的节点，producer 必须是合法的
 *    NodeSizeProposalSource（类型已保证，此处做运行期防御性检查）。
 * 3. sizeStrategy 一致性（layoutModel）：声明 layoutModel 的节点，不得携带 producer 字段；
 *    其尺寸由 Layout Model 对应计算层派生，无 desired producer。
 */
export function validateNodeDefinition(definition: NodeDefinition): void {
  const nodeKey = getNodeDefinitionKey(definition);
  if (definition.defaultSize === null || definition.defaultSize === undefined) {
    throw new Error(`node-def:missing-default-size:${nodeKey}`);
  }
  const strategy = definition.sizeStrategy;
  if (strategy !== null && strategy !== undefined && strategy.mode === 'dynamic') {
    const validProducers: ReadonlyArray<NodeSizeProposalSource> = [
      'resultAreaAutoScale',
    ];
    if (!validProducers.includes(strategy.producer)) {
      throw new Error(`node-def:invalid-producer:${nodeKey}:${String(strategy.producer)}`);
    }
  }
  if (strategy !== null && strategy !== undefined && strategy.mode === 'layoutModel') {
    // layoutModel 模式不得携带 producer 字段（类型已保证无该字段，此处做防御性检查）。
    const maybeProducer = (strategy as { producer?: unknown }).producer;
    if (maybeProducer !== undefined && maybeProducer !== null) {
      throw new Error(
        `node-def:layout-model-with-producer:${nodeKey}:${String(maybeProducer)}`,
      );
    }
  }
}

/** 节点注册表 */
class NodeRegistry {
  private definitions: Map<string, NodeDefinition> = new Map();
  private modelDefinitions: Map<string, NodeDefinition> = new Map();

  /** 注册节点定义 */
  register(definition: NodeDefinition): void {
    const normalized = augmentNodeDefinitionCompanions(definition);
    validateNodeDefinition(normalized);
    const key = getNodeDefinitionKey(normalized);
    this.definitions.set(key, normalized);
    if (normalized.type === 'model' && normalized.modelId) {
      this.modelDefinitions.set(normalized.modelId, normalized);
    }
  }

  /** 批量注册节点定义 */
  registerAll(definitions: NodeDefinition[]): void {
    for (const def of definitions) {
      this.register(def);
    }
  }

  /** 获取节点定义 */
  get(key: string): NodeDefinition | undefined {
    return this.definitions.get(key);
  }

  /** 获取模型节点定义 */
  getModelNode(modelId: string): NodeDefinition | undefined {
    return this.modelDefinitions.get(modelId);
  }

  /** 获取所有节点定义 */
  getAll(): NodeDefinition[] {
    return Array.from(this.definitions.values()).filter(isNodeDefinitionPaletteVisible);
  }

  /** 获取所有节点定义（含隐藏 palette 的节点） */
  getAllDefinitions(): NodeDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** 按分类获取节点定义 */
  getByCategory(category: NodeCategory): NodeDefinition[] {
    return this.getAll().filter((def) => def.category === category);
  }

  /** 获取所有模型节点定义 */
  getModelNodes(): NodeDefinition[] {
    return Array.from(this.modelDefinitions.values());
  }

  /** 创建节点实例 */
  createNode(key: string, position: NodePosition, customData: UnknownRecord | undefined): GraphNode | null {
    const definition = this.get(key);
    if (!definition) return null;

    const defaultData = {
      label: definition.label,
      ...definition.defaultData,
      ...customData,
    };

    const data: GraphNodeData =
      definition.type === 'audioInput'
        ? ({ audioUrl: null, ...defaultData } as AudioInputNodeData)
        : (defaultData as GraphNodeData);

    return {
      id: `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: definition.type,
      position,
      data,
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
  }

  /** 检查节点类型是否已注册 */
  has(key: string): boolean {
    return this.definitions.has(key);
  }

  /** 清空注册表 */
  clear(): void {
    this.definitions.clear();
    this.modelDefinitions.clear();
  }
}

/** 全局节点注册表实例 */
export const nodeRegistry = new NodeRegistry();

import { baseNodeDefinitions } from './baseNodeDefinitions';

// 初始化注册基础节点
nodeRegistry.registerAll(baseNodeDefinitions);

export default nodeRegistry;
