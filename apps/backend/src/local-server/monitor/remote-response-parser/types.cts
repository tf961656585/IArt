interface RemoteResponseParserInput {
  job: unknown;
  body: unknown;
}

interface RemoteResponseParseResult {
  remoteRequestId: string | undefined;
  remoteStatus: string | undefined;
  remoteProgress: number | null | undefined;
  strategy: string | undefined;
}

interface RemoteResponseParserStrategy {
  key: string;
  match: (input: RemoteResponseParserInput) => boolean;
  parse: (input: RemoteResponseParserInput) => RemoteResponseParseResult | null;
}

interface ResetRemoteResponseParserRegistryOptions {
  includeDefaults: boolean | undefined;
}

export type {
  RemoteResponseParseResult,
  RemoteResponseParserInput,
  RemoteResponseParserStrategy,
  ResetRemoteResponseParserRegistryOptions,
};
