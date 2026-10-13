import {
  CHAT_WS_MESSAGE_TYPE,
  ChatTemporaryCompleteSchema,
  type ChatTemporaryCompletion,
  type InternalMessage,
} from '@iart/contracts';
import { chatActionSocket } from '@/client/utils/chatActionSocket';
import { SystemPromptStore } from './systemPromptStore';
import {
  buildTextInputAiEditSystemPrompt,
  type TextInputAiEditTemplateId,
} from '../nodes/textInput/textInputAiEditTemplates';

export type TextInputAiEditRequest = {
  modelId: string;
  systemPromptId: string | undefined;
  sourceText: string;
  userInstruction: string;
  templateId: TextInputAiEditTemplateId | undefined;
  onToken: (text: string) => void;
};

export type TextInputAiEditResult = {
  modelId: string;
  content: string;
};

const createRequestId = (): string => {
  try {
    const randomUUID = globalThis.crypto !== undefined ? globalThis.crypto.randomUUID : undefined;
    if (randomUUID !== undefined) return randomUUID.call(globalThis.crypto);
  } catch {
    // fallback below
  }
  return `text_ai_edit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const buildUserContent = (sourceText: string, userInstruction: string): string => {
  const instruction = userInstruction.trim();
  const original = sourceText ?? '';
  const userContent = instruction
    ? `你想怎么改：\n${instruction}\n\n原文：\n${original}`
    : `原文：\n${original}`;
  return `${userContent}\n\n请只输出改写后的最终文本（不要解释/不要输出思考过程）。`;
};

const buildSystemPrompt = async (
  systemPromptId: string | undefined,
  templateId: TextInputAiEditTemplateId | undefined,
): Promise<string> => {
  const sourcePrompt = await SystemPromptStore.resolveSystemPromptText(systemPromptId);
  const aiEditPrompt = buildTextInputAiEditSystemPrompt({ templateId });
  return sourcePrompt !== undefined && sourcePrompt.trim()
    ? [sourcePrompt.trim(), aiEditPrompt].join('\n\n')
    : aiEditPrompt;
};

export async function runTextInputAiEdit(
  request: TextInputAiEditRequest,
): Promise<TextInputAiEditResult> {
  const modelId = request.modelId.trim();
  if (!modelId) {
    throw new Error('请先选择一个可用的模型');
  }

  const systemPrompt = await buildSystemPrompt(request.systemPromptId, request.templateId);
  const userMessage: InternalMessage = {
    messageId: createRequestId(),
    role: 'user',
    content: buildUserContent(request.sourceText, request.userInstruction),
    createdAt: Date.now(),
  };
  const payload: ChatTemporaryCompletion = {
    type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION,
    requestId: createRequestId(),
    modelId,
    systemPrompt,
    messages: [userMessage],
    userParams: {},
  };

  const response = await chatActionSocket.requestTemporaryCompletion(payload, {
    onToken: request.onToken,
  });
  const parsed = ChatTemporaryCompleteSchema.pick({
    message: true,
    usage: true,
  }).parse(response);
  const content = typeof parsed.message.content === 'string'
    ? parsed.message.content.trim()
    : parsed.message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();
  if (!content) {
    throw new Error('模型这次没有返回内容，请重试');
  }
  return { modelId, content };
}
