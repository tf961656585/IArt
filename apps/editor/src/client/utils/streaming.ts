/**
 * 文件作用：统一封装流式响应（SSE/Chunk）的读取逻辑
 * - 提供 readEventStream：逐块读取 ReadableStream 并返回完整文本
 * - 提供 consumeStreamingResponse：根据响应类型自动解析流式/JSON/文本
 */

export interface StreamConsumptionOptions {
  onChunk: (aggregated: string) => void | undefined;
}

export const readEventStream = async (
  stream: ReadableStream<Uint8Array>,
  onChunk: ((aggregated: string) => void | undefined) | undefined
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let aggregated = '';

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      aggregated += decoder.decode(value, { stream: !done });
      if (onChunk) {
        try {
          onChunk(aggregated);
        } catch (error) {
          console.warn('readEventStream onChunk error', error);
        }
      }
    }
    if (done) {
      break;
    }
  }

  const flush = decoder.decode();
  if (flush) {
    aggregated += flush;
    if (onChunk) {
      try {
        onChunk(aggregated);
      } catch (error) {
        console.warn('readEventStream onChunk error', error);
      }
    }
  }

  return aggregated;
};

export const consumeStreamingResponse = async (
  response: Response,
  options: StreamConsumptionOptions | undefined = undefined
): Promise<unknown> => {
  const onChunk = options === undefined ? undefined : options.onChunk;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const isEventStream = contentType.includes('text/event-stream');

  if (isEventStream && response.body) {
    return readEventStream(response.body, onChunk);
  }

  const text = await response.text();
  if (onChunk && text) {
    try {
      onChunk(text);
    } catch (error) {
      console.warn('consumeStreamingResponse onChunk error', error);
    }
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      // ignore parse error and fall back to raw text
    }
  }

  return text;
};

export default consumeStreamingResponse;
