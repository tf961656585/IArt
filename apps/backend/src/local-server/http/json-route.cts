import type { IncomingMessage, ServerResponse } from 'node:http';

import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';

type HeadersRecord = Record<string, string>;
type RouterResponse = ServerResponse<IncomingMessage>;

const { ERROR_CODES } = constantsModule;
const { readBody, sendError } = httpUtilsModule;

const readJsonBodyOrSendError = async (
  req: IncomingMessage,
  res: RouterResponse,
  corsHeaders: HeadersRecord,
): Promise<unknown | null> => {
  try {
    return JSON.parse((await readBody(req)).toString('utf-8')) as unknown;
  } catch {
    sendError(res, 400, ERROR_CODES.INVALID_JSON, 'Invalid JSON payload', corsHeaders);
    return null;
  }
};

export { readJsonBodyOrSendError };
