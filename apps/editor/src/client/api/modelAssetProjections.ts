import { request } from './client';
import {
  MODEL_ASSET_NODE_PROJECTIONS_ROUTE,
  ModelAssetNodeProjectionResponseSchema,
  type ModelAssetNodeProjectionResponse,
} from '@iart/contracts/model-asset-contract';

export const fetchModelAssetNodeProjections = async (): Promise<ModelAssetNodeProjectionResponse | null> => {
  try {
    const payload = await request<ModelAssetNodeProjectionResponse>({
      method: 'GET',
      endpoint: MODEL_ASSET_NODE_PROJECTIONS_ROUTE,
      responseType: 'json',
      includeAuth: false,
      useBackendTask: false,
    });
    if (!payload) {
      console.warn('[model-asset] fetch node projections got empty payload');
      return null;
    }
    const parsed = ModelAssetNodeProjectionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[model-asset] fetch node projections response invalid', parsed.error);
      return null;
    }
    if (parsed.data.success !== true) {
      console.warn('[model-asset] fetch node projections response not successful', parsed.data);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.warn('[model-asset] fetch node projections failed', error);
    return null;
  }
};
