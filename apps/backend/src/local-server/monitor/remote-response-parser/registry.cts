import { genericRemoteResponseParser } from './generic.cts';
import type {
  RemoteResponseParseResult,
  RemoteResponseParserInput,
  RemoteResponseParserStrategy,
  ResetRemoteResponseParserRegistryOptions,
} from './types.cts';

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const createRegistry = () => {
  const strategies: RemoteResponseParserStrategy[] = [];

  const register = (strategy: RemoteResponseParserStrategy) => {
    if (!strategy || typeof strategy !== 'object') return;
    const key = normalizeString(strategy.key);
    if (!key) return;
    if (typeof strategy.match !== 'function') return;
    if (typeof strategy.parse !== 'function') return;
    strategies.push(strategy);
  };

  const resolve = ({ job, body }: RemoteResponseParserInput): RemoteResponseParseResult | null => {
    for (const strategy of strategies) {
      try {
        if (!strategy.match({ job, body })) continue;
        const parsed = strategy.parse({ job, body });
        if (!parsed) continue;
        return { ...parsed, strategy: parsed.strategy || normalizeString(strategy.key) };
      } catch {
        // ignore
      }
    }
    return null;
  };

  const clear = () => {
    strategies.length = 0;
  };

  return { register, resolve, clear };
};

const defaultRegistry = createRegistry();
defaultRegistry.register(genericRemoteResponseParser);

const DEFAULT_RESET_REMOTE_RESPONSE_PARSER_REGISTRY_OPTIONS: ResetRemoteResponseParserRegistryOptions = {
  includeDefaults: true,
};

const registerRemoteResponseParser = (strategy: RemoteResponseParserStrategy) => defaultRegistry.register(strategy);

const parseRemoteResponse = ({ job, body }: RemoteResponseParserInput) => defaultRegistry.resolve({ job, body });

const __resetRemoteResponseParserRegistryForTests = (
  options: ResetRemoteResponseParserRegistryOptions = DEFAULT_RESET_REMOTE_RESPONSE_PARSER_REGISTRY_OPTIONS,
) => {
  const includeDefaults = options && typeof options === 'object' ? options.includeDefaults !== false : true;
  defaultRegistry.clear();
  if (includeDefaults) {
    defaultRegistry.register(genericRemoteResponseParser);
  }
};

export {
  registerRemoteResponseParser,
  parseRemoteResponse,
  __resetRemoteResponseParserRegistryForTests,
};
