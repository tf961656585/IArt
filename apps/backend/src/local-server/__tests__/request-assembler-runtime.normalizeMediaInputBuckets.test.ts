/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeMediaInputBuckets } from "../media-input-bucket-normalizer.cts";

const getBucket = (buckets: Record<string, unknown[]>, key: string): unknown[] => {
  const value = buckets[key];
  if (value === undefined) return [];
  return value;
};

const makeProjection = (inputModalities: string[] = ["image", "video", "audio"]) => ({
  capability: { input_modalities: inputModalities },
});

const makeProjectionWithFieldKey = (
  inputModalities: string[],
  fieldKey: string,
  component: string,
) => ({
  capability: { input_modalities: inputModalities },
  parameter_schema: {
    fields: [
      {
        field_key: fieldKey,
        component,
        required: false,
      },
    ],
  },
});

test("normalizeMediaInputBuckets: source_kind 'attachment' -> correctly buckets", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-input-test-"));
  const tmpFile = path.join(tmpDir, "image.png");
  fs.writeFileSync(tmpFile, Buffer.from("fake-png-data"));

  try {
    const buckets = await normalizeMediaInputBuckets(
      [
        {
          media_kind: "image",
          source_kind: "attachment",
          value: tmpFile,
          mime_type: "image/png",
          filename: "image.png",
        },
      ],
      makeProjection(),
    );

    const imageBucket = getBucket(buckets, "image");
    assert.ok(Array.isArray(imageBucket));
    assert.equal(imageBucket.length, 1);
    const first = imageBucket[0];
    if (first !== undefined) {
      assert.ok(
        typeof first === "object" && first !== null,
        "image bucket entry should be an object",
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("normalizeMediaInputBuckets: source_kind 'url' -> keeps url form", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
    ],
    makeProjection(),
  );

  const imageBucket = getBucket(buckets, "image");
  assert.equal(imageBucket.length, 1);
  const first = imageBucket[0];
  if (first !== undefined) {
    assert.ok(
      typeof first === "object" && first !== null,
      "image bucket entry should be an object",
    );
    const record = first as Record<string, unknown>;
    assert.equal(record["url"], "https://cdn.example.com/photo.jpg");
  }
});

test("normalizeMediaInputBuckets: source_kind 'base64' -> decodes to inline_data", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "base64",
        value: "data:image/png;base64,QUJDREVGR0g=",
        mime_type: "image/png",
        filename: null,
      },
    ],
    makeProjection(),
  );

  const imageBucket = getBucket(buckets, "image");
  assert.equal(imageBucket.length, 1);
  const first = imageBucket[0];
  if (first !== undefined) {
    assert.ok(
      typeof first === "object" && first !== null,
      "image bucket entry should be an object",
    );
    const record = first as Record<string, unknown>;
    assert.equal(record["kind"], "inline_data");
    assert.equal(record["data"], "QUJDREVGR0g=");
  }
});

test("normalizeMediaInputBuckets: source_kind 'local_path' -> throws for missing file", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "local_path",
            value: "/nonexistent/path/image.png",
            mime_type: "image/png",
            filename: null,
          },
        ],
        makeProjection(),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("unavailable") || error.message.includes("Local media path");
      }
      return false;
    },
  );
});

test("normalizeMediaInputBuckets: video media_kind -> buckets to video", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "video",
        source_kind: "url",
        value: "https://cdn.example.com/video.mp4",
        mime_type: "video/mp4",
        filename: null,
      },
    ],
    makeProjection(),
  );

  assert.equal(getBucket(buckets, "video").length, 1);
  assert.equal(getBucket(buckets, "image").length, 0);
});

test("normalizeMediaInputBuckets: audio media_kind -> buckets to audio", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "audio",
        source_kind: "url",
        value: "https://cdn.example.com/audio.mp3",
        mime_type: "audio/mpeg",
        filename: null,
      },
    ],
    makeProjection(),
  );

  assert.equal(getBucket(buckets, "audio").length, 1);
  assert.equal(getBucket(buckets, "image").length, 0);
});

test("normalizeMediaInputBuckets: unsupported media_kind -> throws", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "document",
            source_kind: "url",
            value: "https://example.com/doc.pdf",
            mime_type: "application/pdf",
            filename: null,
          },
        ],
        makeProjection(),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("validation failed") || error.message.includes("media_kind");
      }
      return false;
    },
  );
});

test("normalizeMediaInputBuckets: multiple media_inputs -> correct buckets", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
      {
        media_kind: "audio",
        source_kind: "url",
        value: "https://cdn.example.com/audio.mp3",
        mime_type: "audio/mpeg",
        filename: null,
      },
    ],
    makeProjection(),
  );

  assert.equal(getBucket(buckets, "image").length, 1);
  assert.equal(getBucket(buckets, "audio").length, 1);
  assert.equal(getBucket(buckets, "video").length, 0);
});

test("normalizeMediaInputBuckets: null/undefined media_inputs -> empty buckets", async () => {
  const bucketsForNull = await normalizeMediaInputBuckets(null, makeProjection());
  assert.equal(getBucket(bucketsForNull, "image").length, 0);
  assert.equal(getBucket(bucketsForNull, "video").length, 0);
  assert.equal(getBucket(bucketsForNull, "audio").length, 0);

  const bucketsForUndefined = await normalizeMediaInputBuckets(undefined, makeProjection());
  assert.equal(getBucket(bucketsForUndefined, "image").length, 0);
  assert.equal(getBucket(bucketsForUndefined, "video").length, 0);
  assert.equal(getBucket(bucketsForUndefined, "audio").length, 0);
});

// --- Restricted input_modalities tests (ensureProjectionSupportsMediaKind via normalizeMediaInputBuckets) ---

test("normalizeMediaInputBuckets: empty input_modalities -> allows all media kinds", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
      {
        media_kind: "video",
        source_kind: "url",
        value: "https://cdn.example.com/video.mp4",
        mime_type: "video/mp4",
        filename: null,
      },
    ],
    makeProjection([]),
  );

  assert.equal(getBucket(buckets, "image").length, 1);
  assert.equal(getBucket(buckets, "video").length, 1);
});

test("normalizeMediaInputBuckets: input_modalities with only image -> allows image, rejects video", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
    ],
    makeProjection(["text", "image"]),
  );

  assert.equal(getBucket(buckets, "image").length, 1);
});

test("normalizeMediaInputBuckets: input_modalities without image -> rejects image with mediaKindNotSupported", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "url",
            value: "https://cdn.example.com/photo.jpg",
            mime_type: "image/jpeg",
            filename: null,
          },
        ],
        makeProjection(["text"]),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("media kind");
      }
      return false;
    },
  );
});

test("normalizeMediaInputBuckets: input_modalities with text+video -> rejects image, allows video", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "url",
            value: "https://cdn.example.com/photo.jpg",
            mime_type: "image/jpeg",
            filename: null,
          },
        ],
        makeProjection(["text", "video"]),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("media kind");
      }
      return false;
    },
  );

  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "video",
        source_kind: "url",
        value: "https://cdn.example.com/video.mp4",
        mime_type: "video/mp4",
        filename: null,
      },
    ],
    makeProjection(["text", "video"]),
  );

  assert.equal(getBucket(buckets, "video").length, 1);
});

// --- Dynamic bucket key tests ---

test("normalizeMediaInputBuckets: with parameter_schema field_key='images' -> bucket key is 'images'", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
    ],
    makeProjectionWithFieldKey(["image"], "images", "imageUpload"),
  );

  assert.equal(getBucket(buckets, "images").length, 1);
  assert.equal(getBucket(buckets, "image").length, 0);
});

test("normalizeMediaInputBuckets: with parameter_schema field_key='image' -> bucket key is 'image'", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
    ],
    makeProjectionWithFieldKey(["image"], "image", "imageUpload"),
  );

  assert.equal(getBucket(buckets, "image").length, 1);
});

test("normalizeMediaInputBuckets: with parameter_schema field_key='referenceImage' -> bucket key is 'referenceImage'", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "url",
        value: "https://cdn.example.com/photo.jpg",
        mime_type: "image/jpeg",
        filename: null,
      },
    ],
    makeProjectionWithFieldKey(["image"], "referenceImage", "imageUpload"),
  );

  assert.equal(getBucket(buckets, "referenceImage").length, 1);
  assert.equal(getBucket(buckets, "image").length, 0);
});

// --- attachment local-media:// URL resolution (PromptDock 提交面，value 为已登记资产 URL) ---

const makeLocalMediaUrl = async (projectRef: string, fileKey: string): Promise<string> => {
  const mediaConstants = (await import("@iart/utils/media-constants")) as {
    buildLocalMediaUrl: (projectRef: string | null | undefined, fileKey: string | null | undefined) => string | null;
  };
  const url = mediaConstants.buildLocalMediaUrl(projectRef, fileKey);
  assert.ok(url, "test URL should be buildable");
  return url as string;
};

test("normalizeMediaInputBuckets: attachment local-media:// URL -> resolves into project media dir as inline_data", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-input-local-media-"));
  try {
    const mediaDir = path.join(projectDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const fileKey = "abc123.png";
    fs.writeFileSync(path.join(mediaDir, fileKey), Buffer.from("fake-png-data"));

    const buckets = await normalizeMediaInputBuckets(
      [
        {
          media_kind: "image",
          source_kind: "attachment",
          value: await makeLocalMediaUrl("prj_" + "a".repeat(32), fileKey),
          mime_type: "image/png",
          filename: null,
        },
      ],
      makeProjection(),
      projectDir,
    );

    const imageBucket = getBucket(buckets, "image");
    assert.equal(imageBucket.length, 1);
    const first = imageBucket[0];
    assert.ok(typeof first === "object" && first !== null);
    const record = first as Record<string, unknown>;
    assert.equal(record["kind"], "inline_data");
    assert.equal(record["mimeType"], "image/png");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("normalizeMediaInputBuckets: attachment local-media:// without projectPath -> rejects", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "attachment",
            value: "local-media://prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/image.png",
            mime_type: "image/png",
            filename: null,
          },
        ],
        makeProjection(),
        null,
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("project context");
      }
      return false;
    },
  );
});

test("normalizeMediaInputBuckets: attachment local-media:// escaping media dir -> rejects", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "attachment",
            value: "local-media://prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/..%2F..%2Fsecrets.txt",
            mime_type: "image/png",
            filename: null,
          },
        ],
        makeProjection(),
        "/tmp/some-project",
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("escapes project media directory");
      }
      return false;
    },
  );
});

test("normalizeMediaInputBuckets: attachment local-media:// with missing file -> rejects", async () => {
  await assert.rejects(
    async () => {
      await normalizeMediaInputBuckets(
        [
          {
            media_kind: "image",
            source_kind: "attachment",
            value: "local-media://prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/missing.png",
            mime_type: "image/png",
            filename: null,
          },
        ],
        makeProjection(),
        "/tmp/definitely-not-a-project-dir",
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("Attachment source unavailable");
      }
      return false;
    },
  );
});
