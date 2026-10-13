import mediaFileKeyModule = require('@iart/utils/media-file-key');

const { extractMediaFileKey } = mediaFileKeyModule;

type UrlResolverContext = {
  projectPath: string;
};

type UrlResolverResult = {
  ok: boolean;
  scheme: string | undefined;
  fileKey: string | null | undefined;
  reason: string | undefined;
};

type UrlResolver = (url: string, context: UrlResolverContext) => UrlResolverResult | null;

const createUrlResolverRegistry = () => {
  const resolvers: UrlResolver[] = [];

  const register = (resolver: UrlResolver) => {
    if (!resolver || typeof resolver !== 'function') {
      throw new Error('UrlResolverRegistry.register: resolver must be a function');
    }
    resolvers.push(resolver);
  };

  const resolve = (url: string, context: UrlResolverContext) => {
    for (const resolver of resolvers) {
      try {
        const result = resolver(url, context);
        if (result) {
          return result;
        }
      } catch {
        // ignore resolver errors -> try next
      }
    }
    return null;
  };

  return {
    register,
    resolve,
  };
};

export const createDefaultUrlResolverRegistry = () => {
  const registry = createUrlResolverRegistry();

  // local-media:// resolver
  registry.register((url) => {
    if (url.startsWith('local-media://')) {
      const fileKey = extractMediaFileKey(url);
      if (!fileKey) return null;
      return { ok: true, scheme: 'local-media', fileKey, reason: undefined };
    }
    return null;
  });

  // /files/{key} and /project-media/{ref}/{key} resolver
  registry.register((url) => {
    const fileKey = extractMediaFileKey(url);
    if (!fileKey) return null;
    return { ok: true, scheme: 'files', fileKey, reason: undefined };
  });

  return registry;
};

export { createUrlResolverRegistry };
