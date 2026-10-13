import * as mediaLocalization from './media-localization/index.cts';

const { getDefaultMediaLocalization } = mediaLocalization as {
  getDefaultMediaLocalization: () => {
    rewriters: {
      rewrite: ((value: unknown, context: object) => unknown) | undefined;
    } | undefined;
  };
};

const isRewriteResult = (value: unknown): value is { value: unknown; changed: boolean } => {
  if (!value || typeof value !== 'object') return false;
  return 'value' in value && 'changed' in value && typeof value.changed === 'boolean';
};

const rewriteProjectFilesUrls = (value: unknown, context = {}) => {
  try {
    const localization = getDefaultMediaLocalization();
    if (localization === undefined || localization === null) return { value, changed: false };
    if (localization.rewriters === undefined || localization.rewriters === null) return { value, changed: false };
    if (localization.rewriters.rewrite === undefined) return { value, changed: false };
    const result = localization.rewriters.rewrite(value, context);
    return isRewriteResult(result) ? result : { value: result, changed: true };
  } catch {
    // ignore
  }
  return { value, changed: false };
};

export {
  rewriteProjectFilesUrls,
};
