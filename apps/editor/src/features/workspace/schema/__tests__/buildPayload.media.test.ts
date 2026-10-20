import { describe, expect, it, vi } from "vitest";
import { loadSchemaFixtureFromProjection } from "@/client/config/__tests__/fixtures/runtimeProjectionFixtures";
import type * as HubFetchModule from "@/client/utils/hubFetch";
import { fetchBlobWithHub } from "@/client/utils/hubFetch";
import { buildSchemaPayload } from "../buildPayload";
import type {
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaPayloadDefinition,
} from "../types";
import { fromField } from "../types";

vi.mock("@/client/utils/hubFetch", async () => {
  const actual = await vi.importActual<typeof HubFetchModule>(
    "@/client/utils/hubFetch",
  );
  return {
    ...actual,
    fetchBlobWithHub: vi.fn(async () => ({
      blob: new Blob(["mock"], { type: "image/png" }),
      mimeType: "image/png",
      response: {} as Response,
    })),
  };
});

type TestFieldKey = "model" | "file" | "reference";

type TestPayloadDefinitionInput = Omit<SchemaPayloadDefinition<TestFieldKey>, "taskType" | "hooks"> &
  Partial<Pick<SchemaPayloadDefinition<TestFieldKey>, "taskType" | "hooks">>;

const createSchema = (
  payload: TestPayloadDefinitionInput,
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

const createValues = (
  partial: Partial<Record<TestFieldKey, unknown>>,
): SchemaFormValues<TestFieldKey> => partial as SchemaFormValues<TestFieldKey>;

const withMockFile = async <T>(
  run: (FileCtor: typeof File) => Promise<T>,
): Promise<T> => {
  const originalFile = (
    globalThis as typeof globalThis & { File?: typeof File }
  ).File;

  class MockFile extends Blob {
    readonly name: string;
    readonly lastModified: number;
    readonly webkitRelativePath = "";

    constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
      super(parts, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  }

  (globalThis as typeof globalThis & { File?: typeof File }).File =
    MockFile as typeof File;

  try {
    return await run(MockFile as typeof File);
  } finally {
    if (originalFile) {
      (globalThis as typeof globalThis & { File?: typeof File }).File =
        originalFile;
    } else {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, "File");
    }
  }
};

describe("buildSchemaPayload media payloads", () => {
  it("writes multipart payloads into FormData", async () => {
    const schema = createSchema({
      format: "multipart",
      format_rule: undefined,
      map: {
        "body.model": fromField<TestFieldKey>("model", undefined, undefined),
        "body.file": {
          kind: "field",
          field: "file",
          mediaTarget: undefined,
          transforms: undefined,
          fallback: undefined,
        },
      },
    });

    const blob = new Blob(["mock"], { type: "text/plain" });
    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        model: "veo-3.1-generate-preview",
        file: blob,
      }),
      modelId: "veo-3.1-generate-preview",
      runtime: undefined,
    });

    expect(payload.body).toBeInstanceOf(FormData);
    const formData = payload.body as FormData;
    expect(formData.get("model")).toBe("veo-3.1-generate-preview");
    expect(formData.get("file")).toBeInstanceOf(Blob);
    expect(payload.api?.contentType).toBeUndefined();
  });

  it("passes raw upload items through for multipart payloads", async () => {
    await withMockFile(async (FileCtor) => {
      const schema = createSchema({
        format: "multipart",
        format_rule: undefined,
        map: {
          "body.input_reference": fromField<TestFieldKey>(
            "reference",
            undefined,
            "multipart_file",
          ),
          "body.attachments": fromField<TestFieldKey>(
            "reference",
            undefined,
            "multipart_file",
          ),
        },
      });

      const first = new FileCtor(["first"], "first.png", { type: "image/png" });
      const second = new FileCtor(["second"], "second.png", {
        type: "image/png",
      });

      const payload = await buildSchemaPayload({
        schema,
        values: createValues({
          reference: [
            { id: "a", file: first },
            { id: "b", file: second },
          ],
        }),
        modelId: "video-runtime-fixture",
        runtime: undefined,
      });

      const body = payload.body as FormData;
      // 媒体 transform 已迁移至后端。前端透传原始 UploadFileItem，
      // FormData 会将对象序列化为 JSON 字符串。
      const primary = body.get("input_reference");
      expect(typeof primary === "string").toBe(true);
      expect((JSON.parse(primary as string) as { id: string }).id).toBe("a");
      const attachments = body.getAll("attachments");
      expect(attachments).toHaveLength(2);
    });
  });

  it("passes URL strings through for multipart payloads without downloading", async () => {
    await withMockFile(async () => {
      const schema = createSchema({
        format: "multipart",
        format_rule: undefined,
        map: {
          "body.attachments": fromField<TestFieldKey>(
            "reference",
            undefined,
            "multipart_file",
          ),
        },
      });

      const payload = await buildSchemaPayload({
        schema,
        values: createValues({
          reference: ["/files/mock.png"],
        }),
        modelId: "veo-3.1-generate-preview",
        runtime: undefined,
      });

      // 媒体 transform 已迁移至后端。前端不再下载文件，直接透传原始值。
      expect(fetchBlobWithHub).not.toHaveBeenCalled();
      const body = payload.body as FormData;
      const attachments = body.getAll("attachments");
      expect(attachments).toHaveLength(1);
      // URL 字符串直接写入 FormData
      expect(attachments[0]).toBe("/files/mock.png");
    });
  });

  it("passes local-media URLs through without downloading", async () => {
    vi.mocked(fetchBlobWithHub).mockClear();

    await withMockFile(async () => {
      const schema = createSchema({
        format: "multipart",
        format_rule: undefined,
        map: {
          "body.input_reference": fromField<TestFieldKey>(
            "reference",
            undefined,
            "multipart_file",
          ),
        },
      });

      const payload = await buildSchemaPayload({
        schema,
        values: createValues({
          reference: ["local-media://demo.png"],
        }),
        modelId: "veo-3.1-generate-preview",
        runtime: undefined,
      });

      // 媒体 transform 已迁移至后端。前端不再下载文件，直接透传原始值。
      expect(fetchBlobWithHub).not.toHaveBeenCalled();
      const body = payload.body as FormData;
      // URL 数组被透传，FormData 会将数组序列化为多个条目
      expect(body.get("input_reference")).toBe("local-media://demo.png");
    });
  });

  it("passes local-media URLs through without throwing when reference is missing", async () => {
    // 媒体 transform 已迁移至后端。前端不再尝试下载和读取文件。
    // 错误检测由后端 payload_rules 执行。
    const schema = createSchema({
      format: "multipart",
      format_rule: undefined,
      map: {
        "body.input_reference": fromField<TestFieldKey>(
          "reference",
          undefined,
          "multipart_file",
        ),
      },
    });

    const payload = await buildSchemaPayload({
      schema,
      values: createValues({
        reference: ["local-media://missing.png"],
      }),
      modelId: "veo-3.1-generate-preview",
      runtime: undefined,
    });

    const body = payload.body as FormData;
    expect(body.get("input_reference")).toBe("local-media://missing.png");
  });

  it("passes values through without extraction", async () => {
    // 媒体 transform 已迁移至后端。前端透传原始值。
    const schema = createSchema({
      format: "multipart",
      format_rule: undefined,
      map: {
        "body.input_reference": fromField<TestFieldKey>("reference",
          undefined,
         "multipart_file"),
      },
    });

    const url = "data:image/png;base64,abc";
    const payload = await buildSchemaPayload({
      schema,
      values: createValues({ reference: url }),
      modelId: "video-runtime-fixture",
      runtime: undefined,
    });

    const body = payload.body as FormData;
    expect(body.get("input_reference")).toBe(url);

    // 数组中的第一个元素被透传
    const payloadFromArray = await buildSchemaPayload({
      schema,
      values: createValues({
        reference: ["   ", url, "https://example.com/other"],
      }),
      modelId: "video-runtime-fixture",
      runtime: undefined,
    });
    const bodyFromArray = payloadFromArray.body as FormData;
    // 数组被整体透传，FormData 会将每个元素写入
    const allValues = bodyFromArray.getAll("input_reference");
    expect(allValues).toHaveLength(3);
    expect(allValues[1]).toBe(url);
  });

  it("passes upload items through without file extraction", async () => {
    await withMockFile(async (FileCtor) => {
      const schema = createSchema({
        format: "multipart",
        format_rule: undefined,
        map: {
          "body.input_reference": fromField<TestFieldKey>("reference",
            undefined,
           "multipart_file"),
        },
      });

      const file = new FileCtor(["first"], "first.png", { type: "image/png" });
      const payload = await buildSchemaPayload({
        schema,
        values: createValues({
          reference: [{ id: "a", file }, "https://example.com/backup.png"],
        }),
        modelId: "video-runtime-fixture",
        runtime: undefined,
      });

      const body = payload.body as FormData;
      // 媒体 transform 已迁移至后端。数组被整体透传。
      // FormData 会将对象序列化为 JSON，字符串直接写入。
      const allValues = body.getAll("input_reference");
      expect(allValues).toHaveLength(2);
      expect(allValues[1]).toBe("https://example.com/backup.png");
    });
  });

  it("builds openai-image 图生图 payload with media data passed through for backend processing", async () => {
    await withMockFile(async (FileCtor) => {
      const first = new FileCtor(["first"], "first.png", { type: "image/png" });
      const second = new FileCtor(["second"], "second.png", {
        type: "image/png",
      });
      const gptImage2EditSchema =
        await loadSchemaFixtureFromProjection("gpt-image-2");

      const payload = await buildSchemaPayload({
        schema: gptImage2EditSchema,
        values: {
          __prompt: "  edit this into a cinematic frame  ",
          size: "2048x1152",
          image: [
            { id: "a", file: first },
            { id: "b", file: second },
          ],
        },
        modelId: "gpt-image-2",
        runtime: undefined,
      });

      expect(payload.api?.endpoint).toBe("/v1/images/edits");
      expect(payload.api?.method).toBe("POST");
      expect(payload.api?.contentType).toBeNull();
      expect(payload.api?.headers).toMatchObject({
        Accept: "application/json",
      });
      expect(payload.body).toBeInstanceOf(FormData);
      const body = payload.body as FormData;
      expect(body.get("model")).toBe("gpt-image-2");
      expect(body.get("prompt")).toBe("edit this into a cinematic frame");
      expect(body.get("size")).toBe("2048x1152");
      // 媒体 transform 已迁移至后端。前端 allUploadFiles 透传原始 UploadFileItem。
      // 后端 payload_rules 将从 media_inputs 中提取 File 并构建 multipart 请求。
      const images = body.getAll("image");
      expect(images).toHaveLength(2);
      // 媒体 transform 已迁移至后端。前端 allUploadFiles 透传原始 UploadFileItem。
      // FormData 会将对象序列化为 JSON 或保持为 Blob。
      images.forEach((item) => {
        const isString = typeof item === "string";
        const isBlob = item instanceof Blob;
        // UploadFileItem 对象被序列化或透传
        expect(isString || isBlob).toBe(true);
        if (isString) {
          expect((JSON.parse(item as string) as { id: string }).id).toBeDefined();
        }
      });
    });
  });

  it("openai-image 双模式形态 image 为空时走文生图路径不报错", async () => {
    // image 字段 required=false：空 image + 有效 prompt 走文生图路径
    // （body.output_format / n 输出，body.image 不输出），不再抛错。
    const gptImage2EditSchema =
      await loadSchemaFixtureFromProjection("gpt-image-2");

    const payload = await buildSchemaPayload({
      schema: gptImage2EditSchema,
      values: {
        __prompt: "text to image",
        size: "auto",
        image: [],
      },
      modelId: "gpt-image-2-edit",
      runtime: undefined,
    });
    // body 应含 prompt（文生图路径有效）
    expect(payload.body).toMatchObject({
      prompt: "text to image",
    });
  });

});
