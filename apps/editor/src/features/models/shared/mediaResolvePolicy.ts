import type { MediaResolutionError } from "@/features/models/shared/mediaResolutionTypes";
import { formatMediaResolutionErrorsForUser } from "@/features/models/shared/mediaResolutionTypes";

export type MediaResolvePolicyId = "legacy" | "strict";

export interface MediaResolvePolicy {
  id: MediaResolvePolicyId;
  enforce: (result: { errors: MediaResolutionError[] }) => void;
}

const legacyPolicy: MediaResolvePolicy = {
  id: "legacy",
  enforce: () => {
    // Keep backward-compatible behavior: callers may warn/skip.
  },
};

const strictPolicy: MediaResolvePolicy = {
  id: "strict",
  enforce: (result) => {
    if (!result.errors.length) return;
    throw new Error(formatMediaResolutionErrorsForUser(result.errors));
  },
};

const POLICIES: Record<MediaResolvePolicyId, MediaResolvePolicy> = {
  legacy: legacyPolicy,
  strict: strictPolicy,
};

export const enforceMediaResolvePolicy = (
  policyId: MediaResolvePolicyId,
  result: { errors: MediaResolutionError[] }
): void => {
  POLICIES[policyId].enforce(result);
};

