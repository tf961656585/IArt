declare module 'better-sqlite3' {
  interface BetterSqlite3Database {
    prepare(sql: string): unknown;
    exec(sql: string): unknown;
    pragma(pragma: string): unknown;
    close(): void;
  }
  type BetterSqlite3Constructor = new (...args: unknown[]) => BetterSqlite3Database;
  const Database: BetterSqlite3Constructor;
  export default Database;
}

declare global {
  let __IARTS_DATA_ROOT: string | undefined;
  let IS_REACT_ACT_ENVIRONMENT: boolean | undefined;

  interface Window {
    __IART_LOCAL_API_BASE__?: string;
  }
}

export {};

declare module 'busboy' {
  import type { IncomingHttpHeaders } from 'node:http';
  import type { Writable } from 'node:stream';

  export interface BusboyFileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  export interface BusboyFileStream {
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'limit', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    resume(): void;
  }

  export interface BusboyConfig {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
    limits?: {
      files?: number;
      fileSize?: number;
    };
  }

  export interface BusboyInstance extends Writable {
    on(event: 'file', listener: (name: string, file: BusboyFileStream, info: BusboyFileInfo) => void): this;
    on(event: 'field', listener: (name: string, value: string) => void): this;
    on(event: 'finish' | 'filesLimit' | 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export default function busboy(config: BusboyConfig): BusboyInstance;
}
