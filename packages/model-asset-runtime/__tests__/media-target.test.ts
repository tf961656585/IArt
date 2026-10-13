import { describe, it, expect } from "vitest";

import {
  validateMediaTargetRuleSet,
  collectMediaTargetsFromValueRule,
  collectMediaTargetRules,
  collectPublicUrlFieldTargets,
  valueRuleUsesMediaTransform,
} from "../src/media-target";

const makeMultipartFileRule = (): Record<string, unknown> => ({
  "body.image": {
    kind: "field",
    field_key: "image",
    media_target: "multipart_file",
    transforms: ["allUploadFiles"],
  },
});

const makePublicUrlRule = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  "body.image": {
    kind: "field",
    field_key: "image",
    media_target: "public_url",
    transforms: ["extractUrls"],
    ...extra,
  },
});

describe("validateMediaTargetRuleSet: multipart_file 校验", () => {
  it("payload_format=multipart 静态声明时通过", () => {
    const rules = makeMultipartFileRule();
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "multipart",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).not.toThrow();
  });

  it("payload_format=json 静态声明且无 payload_format_rule 时抛错", () => {
    const rules = makeMultipartFileRule();
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_multipart_file_payload_format_invalid/);
  });

  it("payload_format_rule truthy 分支包含 multipart 时通过", () => {
    const rules = makeMultipartFileRule();
    const payloadFormatRule = {
      kind: "when",
      condition: { op: "truthy", field: "image" },
      truthy: { kind: "literal", value: "multipart" },
      falsy: { kind: "literal", value: "json" },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).not.toThrow();
  });

  it("payload_format_rule truthy 分支不含 multipart 时抛错", () => {
    const rules = makeMultipartFileRule();
    const payloadFormatRule = {
      kind: "when",
      condition: { op: "truthy", field: "image" },
      truthy: { kind: "literal", value: "json" },
      falsy: { kind: "literal", value: "json" },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_multipart_file_payload_format_invalid/);
  });

  it("payload_format_rule truthy 通过嵌套 when 包含 multipart 时通过", () => {
    const rules = makeMultipartFileRule();
    // 嵌套 when：truthy 自身是另一个 when，其 truthy 包含 multipart
    const payloadFormatRule = {
      kind: "when",
      condition: { op: "truthy", field: "image" },
      truthy: {
        kind: "when",
        condition: { op: "eq", field: "mode", value: "edit" },
        truthy: { kind: "literal", value: "multipart" },
        falsy: { kind: "literal", value: "json" },
      },
      falsy: { kind: "literal", value: "json" },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).not.toThrow();
  });
});

describe("validateMediaTargetRuleSet: public_url 校验", () => {
  it("public_url 缺 url_input_upload_mode 时抛错", () => {
    const rules = makePublicUrlRule();
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: "cloudflare_image_public_url",
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_public_url_upload_mode_missing/);
  });

  it("public_url 缺 target_type 时抛错", () => {
    const rules = makePublicUrlRule();
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: "public_relay",
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_public_url_target_type_missing/);
  });

  it("public_url 完整声明时通过", () => {
    const rules = makePublicUrlRule();
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: "public_relay",
        urlInputUploadTargetType: "cloudflare_image_public_url",
        preRequests: undefined,
      }),
    ).not.toThrow();
  });
});

describe("validateMediaTargetRuleSet: input_uploads 保留字段", () => {
  it("body.input_uploads 抛错", () => {
    const rules: Record<string, unknown> = {
      "body.input_uploads": { kind: "literal", value: [] },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_input_uploads_reserved/);
  });

  it("body.foo.input_uploads 抛错", () => {
    const rules: Record<string, unknown> = {
      "body.foo.input_uploads": { kind: "literal", value: [] },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_input_uploads_reserved/);
  });
});

describe("validateMediaTargetRuleSet: media_target_missing", () => {
  it("使用媒体 transform 但未声明 media_target 时抛错", () => {
    const rules: Record<string, unknown> = {
      "body.image": {
        kind: "field",
        field_key: "image",
        transforms: ["allUploadFiles"],
        // 缺 media_target
      },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_media_target_missing/);
  });
});

describe("validateMediaTargetRuleSet: multipart_file target path 校验", () => {
  it("multipart_file 在非 body.* 路径时抛错", () => {
    const rules: Record<string, unknown> = {
      "headers.image": {
        kind: "field",
        field_key: "image",
        media_target: "multipart_file",
        transforms: ["allUploadFiles"],
      },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "multipart",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_multipart_file_target_invalid/);
  });
});

describe("validateMediaTargetRuleSet: multipart_array_naming target 校验", () => {
  it("multipart_array_naming 声明在非 multipart_file target 上抛错", () => {
    const rules: Record<string, unknown> = {
      "body.image": {
        kind: "field",
        field_key: "image",
        media_target: "public_url",
        multipart_array_naming: "indexed",
        transforms: ["extractUrls"],
      },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: "public_relay",
        urlInputUploadTargetType: "cloudflare_image_public_url",
        preRequests: undefined,
      }),
    ).toThrow(/payload_rules_multipart_array_naming_target_invalid/);
  });
});

describe("validateMediaTargetRuleSet: public_relay 缺 public_url target", () => {
  it("声明 public_relay 但 payload_rules 无 public_url target 且无 pre_requests 时抛错", () => {
    const rules: Record<string, unknown> = {
      "body.prompt": { kind: "field", field_key: "prompt", transforms: ["trim"] },
    };
    expect(() =>
      validateMediaTargetRuleSet(rules, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: "public_relay",
        urlInputUploadTargetType: "cloudflare_image_public_url",
        preRequests: undefined,
      }),
    ).toThrow(/url_input_upload_mode_without_public_url_target/);
  });
});

describe("validateMediaTargetRuleSet: 边界场景", () => {
  it("payloadRules 为 undefined 时直接返回不抛错", () => {
    expect(() =>
      validateMediaTargetRuleSet(undefined, {
        payloadFormat: "json",
        payloadFormatRule: undefined,
        urlInputUploadMode: undefined,
        urlInputUploadTargetType: undefined,
        preRequests: undefined,
      }),
    ).not.toThrow();
  });

  it("默认 context（全 undefined）在合法 rules 上不抛错", () => {
    const rules: Record<string, unknown> = {
      "body.prompt": { kind: "field", field_key: "prompt", transforms: ["trim"] },
    };
    expect(() => validateMediaTargetRuleSet(rules)).not.toThrow();
  });
});

describe("辅助函数: collectMediaTargetsFromValueRule", () => {
  it("扁平 rule 上声明 media_target 能被收集", () => {
    const rule = {
      kind: "field",
      field_key: "image",
      media_target: "multipart_file",
      transforms: ["allUploadFiles"],
    };
    const targets = collectMediaTargetsFromValueRule("body.image", rule);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.mediaTarget).toBe("multipart_file");
    expect(targets[0]?.targetPath).toBe("body.image");
  });

  it("嵌套 when 中的 media_target 能被递归收集", () => {
    const rule = {
      kind: "when",
      condition: { op: "truthy", field: "image" },
      truthy: {
        kind: "field",
        field_key: "image",
        media_target: "multipart_file",
        transforms: ["allUploadFiles"],
      },
      falsy: { kind: "literal", value: null },
    };
    const targets = collectMediaTargetsFromValueRule("body.image", rule);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.mediaTarget).toBe("multipart_file");
  });
});

describe("辅助函数: collectMediaTargetRules / collectPublicUrlFieldTargets", () => {
  it("collectMediaTargetRules 聚合多个 target 的 media_target", () => {
    const rules = {
      "body.image": {
        kind: "field",
        field_key: "image",
        media_target: "multipart_file",
        transforms: ["allUploadFiles"],
      },
      "body.reference": {
        kind: "field",
        field_key: "reference",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    };
    const all = collectMediaTargetRules(rules);
    expect(all).toHaveLength(2);
    const publicUrls = collectPublicUrlFieldTargets(rules);
    expect(publicUrls).toHaveLength(1);
    expect(publicUrls[0]?.targetPath).toBe("body.reference");
  });
});

describe("辅助函数: valueRuleUsesMediaTransform", () => {
  it("使用 allUploadFiles 时识别为媒体 transform", () => {
    const rule = {
      kind: "field",
      field_key: "image",
      transforms: ["allUploadFiles"],
    };
    expect(valueRuleUsesMediaTransform(rule)).toBe(true);
  });

  it("使用 trim 时识别为非媒体 transform", () => {
    const rule = {
      kind: "field",
      field_key: "prompt",
      transforms: ["trim"],
    };
    expect(valueRuleUsesMediaTransform(rule)).toBe(false);
  });

  it("使用 build_content_blocks operator 时识别为媒体 transform", () => {
    const rule = {
      kind: "compute",
      operator: "build_content_blocks",
      args: [],
    };
    expect(valueRuleUsesMediaTransform(rule)).toBe(true);
  });
});
