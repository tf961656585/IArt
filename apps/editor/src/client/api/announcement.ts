import { request } from "@/client/api/client";
import { createBusinessActionId } from "./businessActionRuntime";
import { submitBusinessSyncAction } from "@/client/utils/businessActionSocket";
import { isHubRuntime } from "@/client/utils/hubFetch";
import type { AnnouncementPayload } from '@iart/contracts/announcement';
import {
  EDITOR_BACKEND_ACTION_NAME,
  EDITOR_BACKEND_PROJECT_SCOPE,
} from '@iart/contracts/editor-backend-contract';

export const fetchAnnouncement = async (): Promise<AnnouncementPayload> => {
  if (isHubRuntime()) {
    const result = await submitBusinessSyncAction<AnnouncementPayload>({
      actionId: createBusinessActionId(),
      actionName: EDITOR_BACKEND_ACTION_NAME.WORKERS_PROXY_ANNOUNCEMENT,
      projectPath: EDITOR_BACKEND_PROJECT_SCOPE.WORKSPACE,
      payload: {},
    });
    return result.result;
  }

  return request<AnnouncementPayload>({
    endpoint: "/api/workers-proxy/announcement",
    resolveEndpoint: true,
    includeAuth: false,
    cache: "no-store",
  });
};
