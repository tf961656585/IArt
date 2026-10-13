import type { SaveAsOptions } from 'file-saver';

export type SaveAsFn = (data: Blob | File | string, filename: string | undefined, options: SaveAsOptions | undefined) => void;

const isSaveAsFn = (value: unknown): value is SaveAsFn => typeof value === 'function';

const resolveSaveAs = async (): Promise<SaveAsFn | null> => {
  if (typeof window === 'undefined') return null;
  try {
    const mod = await import('file-saver');
    const defaultExport = (mod as { default: { saveAs: unknown | undefined } | undefined }).default;
    const candidate =
      (mod as { saveAs: unknown | undefined }).saveAs ??
      (defaultExport !== null && defaultExport !== undefined ? defaultExport.saveAs : undefined) ??
      (mod as { default: unknown | undefined }).default ??
      (isSaveAsFn(mod) ? mod : null);
    return isSaveAsFn(candidate) ? candidate : null;
  } catch (error) {
    console.warn('[fileSaver] Failed to load file-saver', error);
    return null;
  }
};

const fallbackSaveAs = (blob: Blob, filename: string): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!document.body) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.style.display = 'none';
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
};

export const triggerBlobDownload = async (
  blob: Blob,
  filename: string,
  options: SaveAsOptions | undefined
): Promise<void> => {
  if (typeof window === 'undefined') return;
  const saveAs = await resolveSaveAs();
  if (saveAs) {
    saveAs(blob, filename, options);
    return;
  }
  fallbackSaveAs(blob, filename);
};
