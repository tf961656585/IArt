import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_RELAY_ERROR_CODE,
  PUBLIC_RELAY_TARGET_TYPE,
} from "@iart/contracts";
import { DEFAULT_BACKEND_CONFIG } from "../constants.cts";
import {
  collectPublicRelayRequirementsFromProjection,
  getPublicRelayTargetAvailability,
  validatePublicRelayRequirementsForCatalog,
} from "../public-relay-capability.cts";

const CLOUDFLARE_ENV = "IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT";
const SELF_HOSTED_ENV = "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT";

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const buildPublicUrlProjection = (targetType: string) => ({
  package_id: `pkg-${targetType}`,
  model_id: `model-${targetType}`,
  runtime: {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: targetType,
    payload_rules: {
      "body.images": {
        kind: "field",
        field_key: "images",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    },
  },
});

void test("PublicRelayCapabilityRegistry: 无 env 且配置为空（未配置）→ TARGET_ENDPOINT_MISSING", (t) => {
  const previousCloudflare = process.env[CLOUDFLARE_ENV];
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  delete process.env[CLOUDFLARE_ENV];
  delete process.env[SELF_HOSTED_ENV];
  t.after(() => {
    restoreEnv(CLOUDFLARE_ENV, previousCloudflare);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHosted);
  });

  // 默认配置即「未配置」：端点一律用户自带（2026-10-12 拍板），不回落任何内置地址。
  const cloudflare = getPublicRelayTargetAvailability(
    PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL,
    DEFAULT_BACKEND_CONFIG.publicRelayTargets,
  );
  const selfHosted = getPublicRelayTargetAvailability(
    PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
    DEFAULT_BACKEND_CONFIG.publicRelayTargets,
  );

  assert.equal(cloudflare.ok, false);
  if (!cloudflare.ok) {
    assert.equal(cloudflare.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING);
  }
  assert.equal(selfHosted.ok, false);
  if (!selfHosted.ok) {
    assert.equal(selfHosted.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING);
  }
});

void test("PublicRelayCapabilityRegistry: exact target 解析，不自动 fallback", (t) => {
  const previousCloudflare = process.env[CLOUDFLARE_ENV];
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  process.env[CLOUDFLARE_ENV] = "not-a-url";
  process.env[SELF_HOSTED_ENV] = "https://relay.example.com/self";
  t.after(() => {
    restoreEnv(CLOUDFLARE_ENV, previousCloudflare);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHosted);
  });

  const cloudflare = getPublicRelayTargetAvailability(
    PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL,
    DEFAULT_BACKEND_CONFIG.publicRelayTargets,
  );
  const selfHosted = getPublicRelayTargetAvailability(
    PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
    DEFAULT_BACKEND_CONFIG.publicRelayTargets,
  );

  assert.equal(cloudflare.ok, false);
  if (!cloudflare.ok) {
    assert.equal(cloudflare.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_INVALID);
  }
  assert.equal(selfHosted.ok, true);
  if (selfHosted.ok) {
    assert.equal(selfHosted.endpoint, "https://relay.example.com/self");
  }
});

void test("PublicRelayCapabilityRegistry: 空 env 不覆盖已配置的端点", (t) => {
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  process.env[SELF_HOSTED_ENV] = "   ";
  t.after(() => restoreEnv(SELF_HOSTED_ENV, previousSelfHosted));

  const configuredTargets = {
    cloudflare_image_public_url: { endpoint: "" },
    self_hosted_image_public_url: { endpoint: "https://relay.example.com/self" },
  };

  const availability = getPublicRelayTargetAvailability(
    PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
    configuredTargets,
  );

  assert.equal(availability.ok, true);
  if (availability.ok) {
    assert.equal(availability.endpoint, "https://relay.example.com/self");
  }
});

void test("PublicRelayCapabilityRegistry: catalog 对账过滤不可用 target", (t) => {
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  process.env[SELF_HOSTED_ENV] = "not-a-url";
  t.after(() => restoreEnv(SELF_HOSTED_ENV, previousSelfHosted));

  const projection = buildPublicUrlProjection(
    PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL,
  );
  const requirements = collectPublicRelayRequirementsFromProjection(projection);
  const validation = validatePublicRelayRequirementsForCatalog([projection]);

  assert.deepEqual(requirements, [{
    package_id: "pkg-self_hosted_image_public_url",
    model_id: "model-self_hosted_image_public_url",
    targetType: "self_hosted_image_public_url",
  }]);
  assert.equal(validation.projections.length, 0);
  assert.equal(validation.diagnostics.length, 1);
  assert.match(
    validation.diagnostics[0]?.code ?? "",
    /runtime_model\.runtime\.public_relay_target_endpoint_invalid:self_hosted_image_public_url/,
  );
});
