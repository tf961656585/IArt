declare module 'file-saver' {
  export interface SaveAsOptions {
    autoBom?: boolean;
  }

  export function saveAs(data: Blob | File | string, filename?: string, options?: SaveAsOptions): void;
}
