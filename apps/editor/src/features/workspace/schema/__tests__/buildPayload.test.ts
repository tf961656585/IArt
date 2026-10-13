import { describe, expect, it, vi } from "vitest";
import { buildSchemaPayload } from "../buildPayload";
import type {
  SchemaBuildContext,
  SchemaCondition,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaPayloadDefinition,
} from "../types";
import type { SchemaGenerationPayload } from "@/client/types/generation";
import { compute, fromField, literal, when } from "../types";

const EXPLICIT_TEST_ENDPOINT = "/test/explicit-video-create";

type TestFieldKey = "prompt" | "model" | "images" | "mode" | "extra" | "file" | "shots" | "storyBeats" | "reference";

type TestPayloadDefinitionInput = Omit<SchemaPayloadDefinition<TestFieldKey>, "taskType" | "hooks"> &
  Partial<Pick<SchemaPayloadDefinition<TestFieldKey>, "taskType" | "hooks">>;

const createSchema = (
  payload: TestPayloadDefinitionInput
): SchemaFormDefinition<TestFieldKey> => ({
  meta: { id: "test-schema", version: "1.0.0", modelId: "veo", titleKey: undefined, descriptionKey: undefined, docLinkKey: undefined },
  fields: [] as SchemaFormDefinition<TestFieldKey>["fields"],
  layout: undefined,
  defaults: undefined,
  formValidators: undefined,
  prompt: undefined,
  payload: {
    format: payload.format,
    format_rule: undefined,
    taskType: payload.taskType,
    map: payload.map,
    hooks: payload.hooks,
  },
  responseHandling: undefined,
});

const createValues = (partial: Partial<Record<TestFieldKey, unknown>>): SchemaFormValues<TestFieldKey> =>
  partial as SchemaFormValues<TestFieldKey>;

describe("buildSchemaPayload", () => {
  it("maps literal and field values into JSON payload", async () => {
    const schema = createSchema({
      format: "json",
      format_rule: undefined,
      map: {
        "api.endpoint": literal(EXPLICIT_TEST_ENDPOINT),
        "body.model": fromField<TestFieldKey>("model", undefined, undefined),
        "body.prompt": fromField<TestFieldKey>("prompt", ["trim"], undefined),
        prompt: fromField<TestFieldKey>("prompt", undefined, undefined),
        input: fromField<TestFieldKey>("prompt", ["trim"], undefined),
        "meta.modelId": literal("veo"),
      },
      taskType: undefined,
      hooks: undefined,
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        prompt: "  hello world  ",
        model: "veo3",
      }),
      modelId: "veo",
      runtime: undefined,
    });

    expect(payload.api).toMatchObject({
      endpoint: EXPLICIT_TEST_ENDPOINT,
      contentType: "application/json",
    });
    expect(payload.body).toEqual({
      model: "veo3",
      prompt: "hello world",
    });
    expect(payload.prompt).toBe("  hello world  ");
    expect(payload.input).toBe("hello world");
    expect(payload.meta).toEqual({ modelId: "veo" });
  });

  it("applies transforms and fallbacks", async () => {
    const schema = createSchema({
      format: "json",
      format_rule: undefined,
      map: {
        "body.images": fromField<TestFieldKey>("images", undefined, "public_url"),
        "body.reference": {
          ...fromField<TestFieldKey>("extra", undefined, undefined),
          fallback: literal("fallback"),
        },
      },
      taskType: undefined,
      hooks: undefined,
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        prompt: "mock",
        model: "veo",
        images: [{ id: "a" }],
      }),
      modelId: "veo",
      runtime: {
        url_input_upload_mode: "public_relay",
        url_input_upload_target_type: "cloudflare_image_public_url",
      },
    });

    const body = payload.body as Record<string, unknown>;
    // 媒体 transform 已迁移至后端 payload_rules。前端 extractUrls 透传原始值。
    expect(body["images"]).toEqual([{ id: "a" }]);
    expect(body["reference"]).toBe("fallback");
    // body 中不应再有 input_uploads 字段
    expect(body["input_uploads"]).toBeUndefined();
  });

  it("supports conditions and cached compute expressions", async () => {
    let computeCount = 0;
    const cachedPrompt = compute<TestFieldKey>((ctx) => {
      computeCount += 1;
      const raw = typeof ctx.values.prompt === "string" ? ctx.values.prompt : "";
      return raw.trim();
    }, undefined, undefined, undefined);

    const vea3Condition: SchemaCondition<TestFieldKey> = {
      op: "includes",
      field: "model",
      value: "veo3",
    };

    const schema = createSchema({
      format: undefined,
      format_rule: undefined,
      map: {
        "body.prompt": cachedPrompt,
        "body.aspect_ratio": when<TestFieldKey>(vea3Condition, literal("wide"), literal(null)),
        "meta.cached": cachedPrompt,
      },
      taskType: "video",
      hooks: undefined,
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        prompt: "  cached text  ",
        model: "veo3",
      }),
      modelId: "veo",
      runtime: undefined,
    });

    expect(computeCount).toBe(1);
    expect(payload.body).toEqual({ prompt: "cached text", aspect_ratio: "wide" });
    expect(payload.meta).toEqual({ cached: "cached text" });
    expect(payload.api?.taskType).toBe("video");
  });

  it("runs hooks and propagates runtime state", async () => {
    const beforeHook = vi.fn((ctx: SchemaBuildContext<TestFieldKey>) => {
      ctx.runtime = ctx.runtime ?? {};
      ctx.runtime['flag'] = "ready";
    });

    const afterHook = vi.fn((payload: SchemaGenerationPayload): SchemaGenerationPayload => ({
      ...payload,
      meta: { ...(payload.meta ?? {}), after: "done", _tempTaskId: undefined, _historyId: undefined },
    }));

    const schema = createSchema({
      format: undefined,
      format_rule: undefined,
      map: {
        "meta.before": compute<TestFieldKey>((ctx) => ctx.runtime?.['flag'] ?? null, undefined, undefined, undefined),
      },
      hooks: {
        beforeBuild: beforeHook,
        afterBuild: afterHook,
      },
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        prompt: "hook",
      }),
      modelId: "veo",
      runtime: undefined,
    });

    expect(beforeHook).toHaveBeenCalledOnce();
    expect(afterHook).toHaveBeenCalledOnce();
    expect(payload.meta).toEqual({ before: "ready", after: "done" });
  });

  it("passes media data through without URL conversion when beforeBuild sets public_relay runtime", async () => {
    const schema = createSchema({
      format: undefined,
      format_rule: undefined,
      map: {
        "body.images": fromField<TestFieldKey>("images", undefined, "public_url"),
      },
      hooks: {
        beforeBuild: (ctx) => {
          ctx.runtime = {
            ...(ctx.runtime ?? {}),
            url_input_upload_mode: "public_relay",
            url_input_upload_target_type: "self_hosted_image_public_url",
          };
        },
        afterBuild: undefined,
      },
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        images: [{ id: "runtime-replaced" }],
      }),
      modelId: "veo-3.1-generate-preview",
      runtime: undefined,
    });

    const body = payload.body as Record<string, unknown>;
    // 媒体 transform 已迁移至后端 payload_rules。前端 extractUrls 透传原始值。
    expect(body["images"]).toEqual([{ id: "runtime-replaced" }]);
    // body 中不应再有 input_uploads 字段
    expect(body["input_uploads"]).toBeUndefined();
  });

  it("normalizes shot lists into timeline payloads and scripts", async () => {
    const schema = createSchema({
      format: undefined,
      format_rule: undefined,
      map: {
        "body.timeline": fromField<TestFieldKey>("shots", ["shotListToTimeline"], undefined),
        "body.timelineScript": fromField<TestFieldKey>("shots", ["shotListToTimeline", "timelineToScript"], undefined),
        "body.beats": fromField<TestFieldKey>("storyBeats", ["splitLines", "compactArray"], undefined),
      },
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        shots: [
          { title: "Opening city", description: "Wide skyline", durationSeconds: 4, cameraMotion: "orbit" },
          { title: "Hero close-up", prompt: "Lead shares a line", durationSeconds: 3, cameraMotion: "static" },
        ],
        storyBeats: "beat one\n\nbeat two\n",
      }),
      modelId: "video-runtime-fixture",
      runtime: undefined,
    });

    const body = payload.body as Record<string, unknown>;
    expect(Array.isArray(body['timeline'])).toBe(true);
    const timeline = body['timeline'] as Array<Record<string, unknown>>;
    expect(timeline[0]).toMatchObject({ title: "Opening city", durationSeconds: 4, startAtSeconds: 0 });
    expect(timeline[1]).toMatchObject({ title: "Hero close-up", startAtSeconds: 4 });
    expect(typeof body['timelineScript']).toBe("string");
    expect((body['timelineScript'] as string) ?? "").toContain("1.");
    expect(body['beats']).toEqual(["beat one", "beat two"]);
  });
});
