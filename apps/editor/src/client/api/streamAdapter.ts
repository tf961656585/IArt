import { consumeStreamingResponse } from '../utils/streaming';

export const consumeRequestStream = async <T>(
  response: Response,
  onStream: ((aggregated: string) => void | undefined) | undefined,
): Promise<T> => {
  return (await consumeStreamingResponse(response, onStream ? { onChunk: onStream } : undefined)) as T;
};
