import {
  normalizeString,
  extractRequestIdFromBody,
  extractBodyStatus,
  extractBodyProgress,
} from './extractors.cts';
import type { RemoteResponseParserStrategy, RemoteResponseParseResult } from './types.cts';

const genericRemoteResponseParser: RemoteResponseParserStrategy = {
  key: 'generic',
  match: ({ body }) => {
    const requestId = extractRequestIdFromBody(body);
    const status = extractBodyStatus(body);
    return Boolean(requestId && status);
  },
  parse: ({ body }) => {
    const remoteRequestId = normalizeString(extractRequestIdFromBody(body));
    const remoteStatus = normalizeString(extractBodyStatus(body)).toLowerCase();
    const remoteProgress = extractBodyProgress(body);
    if (!remoteRequestId || !remoteStatus) return null;
    return {
      remoteRequestId,
      remoteStatus,
      remoteProgress: Number.isFinite(remoteProgress) ? remoteProgress : null,
      strategy: undefined,
    } as RemoteResponseParseResult;
  },
};

export {
  genericRemoteResponseParser,
};
