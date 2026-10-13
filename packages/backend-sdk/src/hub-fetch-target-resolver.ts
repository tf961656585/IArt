export type HubFetchFormat = 'blob' | 'base64' | undefined;
export interface HubFetchTargetResolver {
  id: string;
  match: (url: string) => boolean;
  resolve: (url: string, opts: { format: HubFetchFormat | undefined }) => string;
}

export interface HubFetchTargetRuntimeOptions {
  isBrowser: () => boolean;
  isLocalRuntime: () => boolean;
  resolveApiEndpoint: (value: string) => string;
  internalPathPrefixes: readonly string[] | undefined;
}

export interface HubFetchTargetRuntime {
  registerHubFetchTargetResolver: (resolver: HubFetchTargetResolver) => void;
  resolveHubFetchTarget: (url: string, opts: { format: HubFetchFormat | undefined } | undefined) => string;
}

export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

export const isLoopbackHttpUrl = (value: string): boolean => {
  if (!isHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

export const buildMediaProxyPath = (url: string, format: HubFetchFormat | undefined): string => {
  const encoded = encodeURIComponent(url);
  return format ? `/api/media-proxy?url=${encoded}&format=${format}` : `/api/media-proxy?url=${encoded}`;
};

export const resolveHubInternalPath = (rawUrl: string, resolveApiEndpoint: (value: string) => string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return rawUrl;

  let pathWithQuery = trimmed;
  if (!trimmed.startsWith('/')) {
    try {
      const url = new URL(trimmed);
      pathWithQuery = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return rawUrl;
    }
  }

  const resolved = resolveApiEndpoint(pathWithQuery);
  return !isHttpUrl(resolved) || isLoopbackHttpUrl(resolved) ? resolved : pathWithQuery;
};

export const createHubFetchTargetRuntime = (
  options: HubFetchTargetRuntimeOptions,
): HubFetchTargetRuntime => {
  const internalPathPrefixes = options.internalPathPrefixes ?? ['/files/', '/api/'];
  const resolvers: HubFetchTargetResolver[] = [];

  const isInternalPathname = (pathname: string): boolean => {
    return internalPathPrefixes.some((prefix) => pathname.startsWith(prefix));
  };

  const hubInternalPathResolver: HubFetchTargetResolver = {
    id: 'hub-internal-path',
    match: (rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return false;

      if (trimmed.startsWith('/')) {
        return isInternalPathname(trimmed);
      }

      try {
        const url = new URL(trimmed);
        return Boolean(url.pathname) && isInternalPathname(url.pathname);
      } catch {
        return false;
      }
    },
    resolve: (rawUrl) => resolveHubInternalPath(rawUrl, options.resolveApiEndpoint),
  };

  const remoteHttpProxyResolver: HubFetchTargetResolver = {
    id: 'hub-remote-http-proxy',
    match: (rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || !isHttpUrl(trimmed) || !options.isLocalRuntime()) {
        return false;
      }
      return !isLoopbackHttpUrl(trimmed);
    },
    resolve: (rawUrl, resolverOptions) => {
      const proxyPath = buildMediaProxyPath(rawUrl, resolverOptions.format);
      const resolved = options.resolveApiEndpoint(proxyPath);
      return !isHttpUrl(resolved) || isLoopbackHttpUrl(resolved) ? resolved : proxyPath;
    },
  };

  const registerHubFetchTargetResolver = (resolver: HubFetchTargetResolver): void => {
    if (!resolver || !resolver.id) return;
    const id = resolver.id.trim();
    if (!id) return;
    const existingIndex = resolvers.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      resolvers.splice(existingIndex, 1, resolver);
    } else {
      resolvers.push(resolver);
    }
  };

  const resolveHubFetchTarget = (url: string, resolverOptions: { format: HubFetchFormat | undefined } | undefined): string => {
    const raw = typeof url === 'string' ? url : String(url ?? '');
    if (!options.isBrowser() || !options.isLocalRuntime()) {
      return raw;
    }

    for (const resolver of resolvers) {
      try {
        if (!resolver.match(raw)) continue;
        return resolver.resolve(raw, { format: (resolverOptions !== null && resolverOptions !== undefined ? resolverOptions.format : undefined) });
      } catch {
        // Resolver errors are non-fatal; fall through to next resolver.
      }
    }

    return raw;
  };

  registerHubFetchTargetResolver(hubInternalPathResolver);
  registerHubFetchTargetResolver(remoteHttpProxyResolver);

  return {
    registerHubFetchTargetResolver,
    resolveHubFetchTarget,
  };
};
