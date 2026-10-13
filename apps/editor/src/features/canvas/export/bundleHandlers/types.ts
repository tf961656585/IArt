import type JSZip from 'jszip';
import type {
  BundleExportProgressCallback,
  BundleImportProgressCallback,
  BundleManifest,
  BundleProjectDocument,
} from '../bundleTypes';

export type BundleZipWriteOptions = {
  compression: 'DEFLATE' | 'STORE';
  compressionOptions: { level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } | undefined;
};

export type BundleExportHandlerContext = {
  zip: JSZip;
  zipWriteOptions: BundleZipWriteOptions;
  projectDocument: BundleProjectDocument;
  manifest: BundleManifest;
  errors: string[];
  warnings: string[];
  onProgress: BundleExportProgressCallback | undefined;
  signal: AbortSignal | undefined;
};

export type BundleImportHandlerContext = {
  zip: JSZip;
  nodeGraphId: string;
  projectDocument: BundleProjectDocument;
  manifest: BundleManifest;
  errors: string[];
  warnings: string[];
  onProgress: BundleImportProgressCallback | undefined;
  signal: AbortSignal | undefined;
};

export type BundleAssetHandler = {
  id: string;
  export: | ((ctx: BundleExportHandlerContext) => Promise<BundleProjectDocument | void>)
    | ((ctx: BundleExportHandlerContext) => BundleProjectDocument | void) | undefined;
  import: | ((ctx: BundleImportHandlerContext) => Promise<BundleProjectDocument | void>)
    | ((ctx: BundleImportHandlerContext) => BundleProjectDocument | void) | undefined;
};
