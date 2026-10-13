import type { CatalogPreRequestDefinition } from "./model-package-catalog.types.cts";
import * as loggingModule from "./logging.cts";
import { getFetchDispatcher } from "./fetch-dispatcher.cts";
import { readValueByPath } from "./task-engine-polling-utils.cts";

type FetchInitWithDispatcher = RequestInit & { dispatcher: unknown | undefined };

interface PollingParams {
  responseData: unknown;
  preRequest: CatalogPreRequestDefinition;
  resolveEndpoint: (endpoint: string) => string;
}

export const executePreRequestPolling = async (params: PollingParams): Promise<unknown> => {
  const { responseData, preRequest, resolveEndpoint } = params;

  const pollingStrategy = preRequest.polling;
  if (pollingStrategy == null) {
    loggingModule.logDebug("[request-assembler] pre_request has no polling config, using submit response directly", { preRequestId: preRequest.id });
    return responseData;
  }

  const submitIdPath = preRequest.submit_response_id_path || "/id";
  const remoteId = readValueByPath(responseData, submitIdPath, { silent: true, parseJsonString: undefined });
  const remoteIdStr = remoteId != null ? String(remoteId) : null;
  if (remoteIdStr == null) {
    loggingModule.logDebug("[request-assembler] pre_request polling: remote ID not found", { submitIdPath, preRequestId: preRequest.id });
    throw new Error("pre_request polling: remote ID not found at path " + submitIdPath);
  }

  const pollingRequest = pollingStrategy.request;
  const urlTemplate = pollingRequest.url_template;
  if (urlTemplate == null) {
    loggingModule.logDebug("[request-assembler] pre_request polling: url_template missing", { preRequestId: preRequest.id });
    throw new Error("pre_request polling: url_template missing");
  }
  const pollingUrl = resolveEndpoint(
    urlTemplate.replace(/\{(?:id|taskId|requestId|operation_name)\}/g, remoteIdStr),
  );

  const pollingConfig = pollingStrategy.polling;
  const maxAttempts = pollingConfig.maxAttempts || 100;
  const intervalMs = pollingConfig.intervalMs || 3000;
  const successPaths = pollingConfig.successFieldPaths || [];
  const successStatuses = pollingConfig.successStatuses || [];
  const statusPaths = pollingConfig.statusFieldPaths || [];
  const failureStatuses = pollingConfig.failureStatuses || [];

  let pollingSucceeded = false;
  let finalResponseData: unknown = responseData;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const pollingHeaders = new Headers();

    let pollingData: unknown;
    try {
      const pollingResponse = await fetch(pollingUrl, {
        method: pollingRequest.method || "GET",
        headers: pollingHeaders,
        dispatcher: getFetchDispatcher(),
      } as FetchInitWithDispatcher);
      if (!pollingResponse.ok) {
        loggingModule.logDebug("[request-assembler] pre_request polling: HTTP error", { attempt: attempt + 1, status: pollingResponse.status, preRequestId: preRequest.id });
        continue;
      }
      pollingData = await pollingResponse.json();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      loggingModule.logDebug("[request-assembler] pre_request polling: request error", { attempt: attempt + 1, error: errMsg, preRequestId: preRequest.id });
      continue;
    }

    let failed = false;
    for (const statusPath of statusPaths) {
      const statusValue = readValueByPath(pollingData, statusPath, { silent: true, parseJsonString: undefined });
      const statusStr = statusValue != null ? String(statusValue).toLowerCase() : null;
      if (statusStr != null && failureStatuses.some(function (f) { return f.toLowerCase() === statusStr; })) {
        loggingModule.logDebug("[request-assembler] pre_request polling: failure detected", { attempt: attempt + 1, statusPath, statusStr, preRequestId: preRequest.id });
        failed = true;
        break;
      }
    }
    if (failed) {
      throw new Error("pre_request polling failed: status check failed");
    }

    for (const successPath of successPaths) {
      const value = readValueByPath(pollingData, successPath, { silent: true, parseJsonString: undefined });
      const valueStr = value != null ? String(value) : null;
      if (valueStr == null || valueStr === "") continue;
      const statusMatched = successStatuses.length === 0 || statusPaths.some(function (statusPath) {
        const statusValue = readValueByPath(pollingData, statusPath, { silent: true, parseJsonString: undefined });
        const statusStr = statusValue != null ? String(statusValue).toLowerCase() : null;
        return statusStr != null && successStatuses.some(function (s) { return s.toLowerCase() === statusStr; });
      });
      if (statusMatched) {
        loggingModule.logDebug("[request-assembler] pre_request polling: success", { attempt: attempt + 1, successPath, valueStr, preRequestId: preRequest.id });
        finalResponseData = pollingData;
        pollingSucceeded = true;
        break;
      }
    }
    if (pollingSucceeded) break;
  }

  if (!pollingSucceeded) {
    throw new Error("pre_request polling timed out after " + maxAttempts + " attempts");
  }

  return finalResponseData;
};
