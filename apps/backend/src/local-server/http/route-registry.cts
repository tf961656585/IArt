import type { IncomingMessage, ServerResponse } from 'node:http';

type HeadersRecord = Record<string, string>;

type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse<IncomingMessage>;
  url: URL;
  pathname: string;
  corsHeaders: HeadersRecord;
};

type RouteDefinition = {
  name: string;
  match: (context: RouteContext) => boolean;
  handle: (context: RouteContext) => Promise<void> | void;
};

const runHttpRoutes = async (routes: readonly RouteDefinition[], context: RouteContext) => {
  for (const route of routes) {
    if (!route.match(context)) continue;
    await route.handle(context);
    return true;
  }
  return false;
};

export type { HeadersRecord, RouteContext, RouteDefinition };
export { runHttpRoutes };
