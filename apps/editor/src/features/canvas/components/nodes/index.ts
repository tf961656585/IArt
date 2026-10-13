/**
 * 节点组件导出
 */

import { TextInputNode } from './TextInputNode';
import { ImageInputNode } from './ImageInputNode';
import { VideoInputNode } from './VideoInputNode';
import { AudioInputNode } from './AudioInputNode';
import { GroupNode } from './GroupNode';
import { TaskNode } from './TaskNode';
import { AssetNode } from './AssetNode';
import { AgentNode } from './AgentNode';

export { BaseNodeCard } from './BaseNodeCard';
export { TextInputNode } from './TextInputNode';
export { ImageInputNode } from './ImageInputNode';
export { VideoInputNode } from './VideoInputNode';
export { AudioInputNode } from './AudioInputNode';
export { GroupNode } from './GroupNode';
export { TaskNode } from './TaskNode';
export { AssetNode } from './AssetNode';
export { AgentNode } from './AgentNode';

/** 节点类型映射 */
export const nodeTypes = {
  textInput: TextInputNode,
  imageInput: ImageInputNode,
  videoInput: VideoInputNode,
  audioInput: AudioInputNode,
  task: TaskNode,
  asset: AssetNode,
  agent: AgentNode,
  group: GroupNode,
};
