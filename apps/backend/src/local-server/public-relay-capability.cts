import {
  PUBLIC_RELAY_ERROR_CODE,
  PUBLIC_RELAY_TARGET_TYPE,
  PUBLIC_RELAY_TARGET_TYPES,
  PublicRelayCapabilityRegistrySchema,
  PublicRelayTargetTypeSchema,
  type PublicRelayCapabilityRegistry,
  type PublicRelayTargetType,
} from '@iart/contracts';
import { collectPublicUrlFieldTargets } from '@iart/model-asset-runtime';
import { getBackendConfig } from './config-store.cts';

type PublicRelayTargetConfigMap = {
  readonly [K in PublicRelayTargetType]: {
    readonly endpoint: string | undefined | undefined;
  };
};

type PublicRelayEndpointResolution =
  | { ok: true; targetType: PublicRelayTargetType; endpoint: string }
  | { ok: false; targetType: string; code: string; message: string };

type PublicRelayRequirement = {
  package_id: string;
  model_id: string;
  targetType: string;
};

type PublicRelayCatalogDiagnostic = {
  package_id: string;
  code: string;
  message: string;
  model_id: string | undefined;
};

type RuntimeProjectionLike = {
  package_id: unknown | undefined;
  model_id: unknown | undefined;
  runtime: unknown | undefined;
};

type RuntimeMetaLike = {
  execution_driver: unknown | undefined;
  payload_rules: unknown | undefined;
  supported_modalities: unknown | undefined;
  url_input_upload_mode: unknown | undefined;
  url_input_upload_target_type: unknown | undefined;
};

const ENV_ENDPOINT_BY_TARGET: { [K in PublicRelayTargetType]: string } = {
  [PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL]:
    'IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT',
  [PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL]:
    'IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT',
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isObjectValue = (value: unknown): value is object =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPayloadRuleMap = (value: unknown): value is object =>
  isObjectValue(value);

const readRuntimeProjection = (value: unknown): RuntimeProjectionLike | null =>
  isObjectValue(value) ? value as RuntimeProjectionLike : null;

const readRuntimeMeta = (value: unknown): RuntimeMetaLike | null =>
  isObjectValue(value) ? value as RuntimeMetaLike : null;

const normalizeTargetType = (value: unknown): PublicRelayTargetType | null => {
  const normalized = normalizeString(value).toLowerCase();
  const parsed = PublicRelayTargetTypeSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
};

const isHttpEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const readEnvEndpointOverride = (targetType: PublicRelayTargetType): string => {
  const envName = ENV_ENDPOINT_BY_TARGET[targetType];
  const value = process.env[envName];
  return normalizeString(value);
};

const readConfiguredEndpoint = (
  targets: PublicRelayTargetConfigMap,
  targetType: PublicRelayTargetType,
): string => {
  const envEndpoint = readEnvEndpointOverride(targetType);
  if (envEndpoint) return envEndpoint;
  return normalizeString((targets[targetType] !== null && targets[targetType] !== undefined ? targets[targetType].endpoint : undefined));
};

const getConfiguredPublicRelayTargets = (): PublicRelayTargetConfigMap =>
  getBackendConfig().publicRelayTargets;

const getPublicRelayTargetAvailability = (
  targetType: unknown,
  targetConfigs: PublicRelayTargetConfigMap = getConfiguredPublicRelayTargets(),
): PublicRelayEndpointResolution => {
  const normalizedTargetType = normalizeTargetType(targetType);
  const targetLabel = normalizeString(targetType) || '(empty)';
  if (!normalizedTargetType) {
    return {
      ok: false,
      targetType: targetLabel,
      code: PUBLIC_RELAY_ERROR_CODE.TARGET_UNSUPPORTED,
      message: `Unsupported public relay targetType: ${targetLabel}`,
    };
  }

  const endpoint = readConfiguredEndpoint(targetConfigs, normalizedTargetType);
  if (!endpoint) {
    return {
      ok: false,
      targetType: normalizedTargetType,
      code: PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING,
      message: `Missing public relay endpoint for targetType: ${normalizedTargetType}`,
    };
  }
  if (!isHttpEndpoint(endpoint)) {
    return {
      ok: false,
      targetType: normalizedTargetType,
      code: PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_INVALID,
      message: `Invalid public relay endpoint for targetType: ${normalizedTargetType}`,
    };
  }
  return {
    ok: true,
    targetType: normalizedTargetType,
    endpoint,
  };
};

const getPublicRelayCapabilityRegistry = (): PublicRelayCapabilityRegistry => {
  const targets = getConfiguredPublicRelayTargets();
  const availableTargets = PUBLIC_RELAY_TARGET_TYPES.flatMap((targetType) => {
    const availability = getPublicRelayTargetAvailability(targetType, targets);
    return availability.ok
      ? [{
        targetType: availability.targetType,
        endpoint: availability.endpoint,
        available: true as const,
      }]
      : [];
  });
  return PublicRelayCapabilityRegistrySchema.parse({ targets: availableTargets });
};

const resolvePublicRelayEndpoint = (targetType: unknown): PublicRelayEndpointResolution =>
  getPublicRelayTargetAvailability(targetType);

const collectPublicRelayRequirementsFromProjection = (
  projection: unknown,
): PublicRelayRequirement[] => {
  const projectionLike = readRuntimeProjection(projection);
  const runtime = readRuntimeMeta((projectionLike !== null && projectionLike !== undefined ? projectionLike.runtime : undefined));
  if (!projectionLike || !runtime) return [];
  const payloadRules = isPayloadRuleMap(runtime.payload_rules)
    ? runtime.payload_rules
    : undefined;
  /* 对话模型已不再由能力包承载，原来那条「chat_streaming + 本地媒体模态要求公网中转」的
     判定随之移除：对话模型（用户自建）固定纯文本、不参与公网中转路由。
     剩下的触发条件是 payload_rules 里的公网 URL 字段（生成族在用）。 */
  const needsPublicRelay =
    payloadRules !== undefined && collectPublicUrlFieldTargets(payloadRules as Record<string, never>).length > 0;
  if (!needsPublicRelay) return [];
  if (normalizeString(runtime.url_input_upload_mode) !== 'public_relay') return [];
  return [{
    package_id: normalizeString(projectionLike.package_id) || '*',
    model_id: normalizeString(projectionLike.model_id),
    targetType: normalizeString(runtime.url_input_upload_target_type),
  }];
};

const toCatalogDiagnostic = (
  requirement: PublicRelayRequirement,
  availability: Extract<PublicRelayEndpointResolution, { ok: false }>,
): PublicRelayCatalogDiagnostic => {
  const suffix = availability.targetType || requirement.targetType || '(empty)';
  const diagnostic: PublicRelayCatalogDiagnostic = {
    package_id: requirement.package_id,
    code: `runtime_model.runtime.${availability.code}:${suffix}`,
    message: availability.message,
    model_id: undefined,
  };
  if (requirement.model_id) {
    diagnostic.model_id = requirement.model_id;
  }
  return diagnostic;
};

const validatePublicRelayRequirementsForCatalog = <T,>(
  projections: T[],
): { projections: T[]; diagnostics: PublicRelayCatalogDiagnostic[] } => {
  const accepted: T[] = [];
  const diagnostics: PublicRelayCatalogDiagnostic[] = [];
  for (const projection of projections) {
    const requirements = collectPublicRelayRequirementsFromProjection(projection);
    const failures = requirements
      .map((requirement) => {
        const availability = getPublicRelayTargetAvailability(requirement.targetType);
        return availability.ok ? null : toCatalogDiagnostic(requirement, availability);
      })
      .filter((item): item is PublicRelayCatalogDiagnostic => item !== null);
    if (failures.length > 0) {
      diagnostics.push(...failures);
      continue;
    }
    accepted.push(projection);
  }
  return { projections: accepted, diagnostics };
};

export {
  collectPublicRelayRequirementsFromProjection,
  getPublicRelayCapabilityRegistry,
  getPublicRelayTargetAvailability,
  resolvePublicRelayEndpoint,
  validatePublicRelayRequirementsForCatalog,
};
