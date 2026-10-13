import { GoogleGenAI, type Content, type Part, type ThinkingLevel } from '@google/genai';
import type { ChatAdapter, ChatStreamParams, InternalMessage, ChatMessageContent } from './types.js';
import { assertNoToolsOrThrow } from './types.js';
import { resolveGeminiThinkingLevel } from './thinking-tiers.js';

function inferImageMimeType(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png': return 'image/png';
      case 'webp': return 'image/webp';
      case 'gif': return 'image/gif';
      case 'svg': return 'image/svg+xml';
      default: return 'image/jpeg';
    }
  } catch {
    return 'image/jpeg';
  }
}

function inferAudioMimeType(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop();
    const lower = ext != null ? ext.toLowerCase() : '';
    switch (lower) {
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      case 'm4a': return 'audio/mp4';
      case 'flac': return 'audio/flac';
      case 'aac': return 'audio/aac';
      case 'webm': return 'audio/webm';
      default: return 'audio/mpeg';
    }
  } catch {
    return 'audio/mpeg';
  }
}

function inferVideoMimeType(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop();
    const lower = ext != null ? ext.toLowerCase() : '';
    switch (lower) {
      case 'mp4': return 'video/mp4';
      case 'webm': return 'video/webm';
      case 'avi': return 'video/avi';
      case 'mov': return 'video/quicktime';
      case 'mkv': return 'video/x-matroska';
      case 'flv': return 'video/x-flv';
      case '3gp': return 'video/3gpp';
      default: return 'video/mp4';
    }
  } catch {
    return 'video/mp4';
  }
}

function toGeminiParts(content: ChatMessageContent): Part[] {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  return content.map((part): Part => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image') {
      return { fileData: { mimeType: inferImageMimeType(part.url), fileUri: part.url } };
    }
    if (part.type === 'audio') {
      return { fileData: { mimeType: inferAudioMimeType(part.url), fileUri: part.url } };
    }
    if (part.type === 'video') {
      return { fileData: { mimeType: inferVideoMimeType(part.url), fileUri: part.url } };
    }
    throw new Error(`Unhandled chat part type`);
  });
}

function toGeminiHistory(messages: InternalMessage[]): Content[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: toGeminiParts(msg.content),
    }));
}

export const geminiAdapter: ChatAdapter = {
  async executeStream(params: ChatStreamParams): Promise<void> {
    assertNoToolsOrThrow('gemini', params.tools);
    const ai = new GoogleGenAI({
      apiKey: params.apiConfig.apiKey,
      ...(params.apiConfig.baseUrl
        ? { httpOptions: { baseUrl: params.apiConfig.baseUrl } }
        : {}),
    });

    let lastUserIdx = -1;
    for (let i = params.messages.length - 1; i >= 0; i--) {
      const m = params.messages[i];
      if (m && m.role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) {
      throw new Error('No user message to send');
    }

    const lastUserMsg = params.messages[lastUserIdx];
    if (!lastUserMsg) throw new Error('No user message to send');
    const history = toGeminiHistory(params.messages.slice(0, lastUserIdx));
    const thinkingLevel = resolveGeminiThinkingLevel(params.thinkingTier) as ThinkingLevel | null;

    const chat = ai.chats.create({
      model: params.modelId,
      config: {
        ...(params.systemPrompt != undefined
          ? { systemInstruction: params.systemPrompt }
          : {}),
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        // 思考档位 → thinkingConfig.thinkingLevel（spec 37）；不思考时不发该字段
        ...(thinkingLevel === null
          ? {}
          : { thinkingConfig: { thinkingLevel } }),
        // 最大输出 token → maxOutputTokens（spec 37）；未声明时不发该字段
        ...(params.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: params.maxOutputTokens }),
      },
      history,
    });

    const stream = await chat.sendMessageStream({
      message: toGeminiParts(lastUserMsg.content),
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for await (const chunk of stream) {
      if (params.abortSignal?.aborted) break;
      const text = chunk.text;
      if (text) {
        params.onToken(text);
      }
      if (chunk.usageMetadata) {
        totalInputTokens = chunk.usageMetadata.promptTokenCount ?? totalInputTokens;
        totalOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? totalOutputTokens;
      }
    }

    if (params.abortSignal?.aborted) return;

    if (params.onUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      params.onUsage({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
    }
  },
};
