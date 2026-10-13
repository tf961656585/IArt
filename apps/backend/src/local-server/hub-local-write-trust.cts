import type { IncomingMessage } from 'node:http';
import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  HubLocalWriteTokenSchema,
} from '@iart/contracts';

const isLoopbackAddress = (value: unknown) => {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:127.')
  );
};

const readExpectedHubWriteToken = () => {
  const parsed = HubLocalWriteTokenSchema.safeParse(process.env[HUB_LOCAL_WRITE_TOKEN_ENV]);
  return parsed.success ? parsed.data : null;
};

const readHubWriteTokenHeader = (req: IncomingMessage) => {
  const raw = req.headers[HUB_LOCAL_WRITE_TOKEN_HEADER];
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : null;
  }
  return typeof raw === 'string' ? raw : null;
};

const verifyHubLocalWriteTrust = (req: IncomingMessage) => {
  const expectedToken = readExpectedHubWriteToken();
  if (expectedToken === null) {
    return { ok: false as const, reason: 'missing_expected_token' };
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return { ok: false as const, reason: 'non_loopback' };
  }
  const receivedToken = readHubWriteTokenHeader(req);
  if (receivedToken === null) {
    return { ok: false as const, reason: 'missing_token' };
  }
  const parsedToken = HubLocalWriteTokenSchema.safeParse(receivedToken);
  if (!parsedToken.success) {
    return { ok: false as const, reason: 'invalid_token' };
  }
  if (parsedToken.data !== expectedToken) {
    return { ok: false as const, reason: 'token_mismatch' };
  }
  return { ok: true as const };
};

export { verifyHubLocalWriteTrust };
