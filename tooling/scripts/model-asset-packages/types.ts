export interface EntryRef {
  model_id?: string;
  relative_path?: string;
}

export interface NodeDefinitionRef {
  relative_path?: string;
}

export interface ResourceRef {
  resource_id?: string;
  media_type?: string;
  relative_path?: string;
}

export interface LocaleRef {
  locale?: string;
  relative_path?: string;
}

export interface SourceManifest {
  package_id?: string;
  engine_version_range?: string;
  entry_model?: EntryRef;
  node_definition?: NodeDefinitionRef;
  resources?: ResourceRef[];
  locales?: LocaleRef[];
  note?: string;
}

export interface SourceManifestSummary {
  packageId: string;
  packageIdByDir: string;
  sourceDir: string;
  manifestPath: string;
  manifest: SourceManifest;
  modelId: string;
}

export interface ValidatedPackage {
  packageId: string;
  sourceDir: string;
  manifestPath: string;
  manifest: SourceManifest;
  modelId: string;
  entryModelPath: string;
  nodeDefinitionPath: string;
  resourcePaths: string[];
  localePaths: string[];
  variantMeta: {
    group_key: string;
    is_default: boolean;
  } | undefined;
}
