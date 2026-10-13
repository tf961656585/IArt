import * as z from 'zod';

export const PUBLIC_RELAY_TARGET_TYPE = Object.freeze({
  CLOUDFLARE_IMAGE_PUBLIC_URL: 'cloudflare_image_public_url',
  SELF_HOSTED_IMAGE_PUBLIC_URL: 'self_hosted_image_public_url',
});

export const PUBLIC_RELAY_TARGET_TYPES = Object.freeze([
  PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL,
  PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
] as const);

export const PUBLIC_RELAY_DEFAULT_TARGET_TYPE =
  PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL;

export const PUBLIC_RELAY_ERROR_CODE = Object.freeze({
  TARGET_UNSUPPORTED: 'public_relay_target_unsupported',
  TARGET_ENDPOINT_MISSING: 'public_relay_target_endpoint_missing',
  TARGET_ENDPOINT_INVALID: 'public_relay_target_endpoint_invalid',
});

export const PublicRelayTargetTypeSchema = z.enum(PUBLIC_RELAY_TARGET_TYPES);

export type PublicRelayTargetType = z.infer<typeof PublicRelayTargetTypeSchema>;

export const PublicRelayEndpointConfigSchema = z.object({
  targetType: PublicRelayTargetTypeSchema,
  endpoint: z.string().trim().min(1).url(),
});

export type PublicRelayEndpointConfig = z.infer<typeof PublicRelayEndpointConfigSchema>;

/**
 * 用户自带的公共中转端点配置（backend config `publicRelayTargets` 键的形状）。
 * 「不再内置默认端点」（2026-10-12 拍板）：endpoint 为空串 = 该中转类型未配置；
 * 非空必须是合法 http/https URL（写入门 validatePublicRelayTargetsUpdate 拒绝非法值，
 * 读取端 resolvePublicRelayEndpoint 对未配置返回 TARGET_ENDPOINT_MISSING）。
 * 键集合封闭于 PUBLIC_RELAY_TARGET_TYPES；提供该键即整体替换（两个类型都必须给）。
 */
export const PublicRelayTargetEndpointSettingSchema = z.object({
  endpoint: z.string(),
});

export const PublicRelayTargetSettingsSchema = z.object({
  cloudflare_image_public_url: PublicRelayTargetEndpointSettingSchema,
  self_hosted_image_public_url: PublicRelayTargetEndpointSettingSchema,
});

export type PublicRelayTargetSettings = z.infer<typeof PublicRelayTargetSettingsSchema>;

export const PublicRelayCapabilitySchema = z.object({
  targetType: PublicRelayTargetTypeSchema,
  endpoint: z.string().trim().min(1).url(),
  available: z.literal(true),
});

export type PublicRelayCapability = z.infer<typeof PublicRelayCapabilitySchema>;

export const PublicRelayCapabilityRegistrySchema = z.object({
  targets: z.array(PublicRelayCapabilitySchema),
});

export type PublicRelayCapabilityRegistry = z.infer<typeof PublicRelayCapabilityRegistrySchema>;

export const isPublicRelayTargetType = (value: unknown): value is PublicRelayTargetType =>
  PublicRelayTargetTypeSchema.safeParse(value).success;
