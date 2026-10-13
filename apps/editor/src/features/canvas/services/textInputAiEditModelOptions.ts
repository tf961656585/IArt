import type { ChatModelDirectoryEntry } from '@iart/contracts';
import type { TextInputAiEditModelOption } from '../components/dialogs/TextInputAiEditDialog';

/**
 * 文本节点「AI 修改」的模型候选。
 *
 * 数据源是**对话模型目录**（`/api/chat-model-catalog`，即用户在主窗口自己添加的对话模型），
 * 与 PromptDock 的 agent 服务行同源；目录由 `promptDockStore` 装载，两处读同一份，不各拉一遍。
 *
 * 这里曾经读的是「已装模型能力包」的投影并按 `chat_streaming` 特征值筛。该口径已随
 * 「对话模型只由用户自建声明」收敛而作废：软件不再内置对话模型，能力包投影里永远筛不出东西，
 * 用户在主窗口配好的模型也进不去那个目录——保留旧口径会让这个弹窗的候选恒为空，
 * 还会把用户指向一个填不满的地方。
 */
export function buildTextInputAiEditModelOptions(
  chatCatalog: ChatModelDirectoryEntry[],
): TextInputAiEditModelOption[] {
  return chatCatalog.map((entry) => ({
    modelId: entry.model_id,
    modelLabel: entry.model_id,
  }));
}
