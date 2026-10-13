import type { ModelAssetFormalResourceType } from './formal-resource-crud';

export interface ModelAssetRealtimeResourceSummary {
  resource_type: ModelAssetFormalResourceType;
  resource_id: string;
  code: string | undefined;
}

export const MODEL_ASSET_REALTIME_SCOPE_TYPE = Object.freeze({
  RESOURCE_LIST: 'resource_list',
  RESOURCE_DETAIL: 'resource_detail',
});

export type ModelAssetRealtimeScopeType =
  (typeof MODEL_ASSET_REALTIME_SCOPE_TYPE)[keyof typeof MODEL_ASSET_REALTIME_SCOPE_TYPE];

export const MODEL_ASSET_REALTIME_EVENT_TYPE = Object.freeze({
  RESOURCE_LIST_INIT: 'model_asset_resource_list_init',
  RESOURCE_CHANGED: 'model_asset_resource_changed',
  RESOURCE_DELETED: 'model_asset_resource_deleted',
});

export interface ModelAssetResourceListInitEvent {
  type: typeof MODEL_ASSET_REALTIME_EVENT_TYPE.RESOURCE_LIST_INIT;
  scope_type: 'resource_list';
  resource_type: ModelAssetFormalResourceType;
  items: ModelAssetRealtimeResourceSummary[];
  emitted_at: string;
}

export interface ModelAssetResourceChangedEvent {
  type: typeof MODEL_ASSET_REALTIME_EVENT_TYPE.RESOURCE_CHANGED;
  scope_type: ModelAssetRealtimeScopeType;
  resource_type: ModelAssetFormalResourceType;
  resource: ModelAssetRealtimeResourceSummary;
  emitted_at: string;
}

export interface ModelAssetResourceDeletedEvent {
  type: typeof MODEL_ASSET_REALTIME_EVENT_TYPE.RESOURCE_DELETED;
  scope_type: ModelAssetRealtimeScopeType;
  resource_type: ModelAssetFormalResourceType;
  resource_id: string;
  emitted_at: string;
}

export type ModelAssetRealtimeEvent =
  | ModelAssetResourceListInitEvent
  | ModelAssetResourceChangedEvent
  | ModelAssetResourceDeletedEvent;
