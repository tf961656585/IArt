import { describe, it, expect } from 'vitest';
import { extractWithConfig, extractMediaUrls } from '../outputNormalize';
import type { ModelResultExtractor } from '@/features/workspace/modelFormTypes';

const createExtractor = (value: {
  videoPaths: string[] | undefined;
  imagePaths: string[] | undefined;
  textPaths: string[] | undefined;
  excludePaths: string[] | undefined;
}): ModelResultExtractor => value;

const veoExtractor = createExtractor({
  videoPaths: ['detail.upsample_video_url', 'video_url', 'detail.video_url'],
  imagePaths: ['detail.preview_frames', 'gallery'],
  textPaths: undefined,
  excludePaths: ['detail.req.images', 'detail.images'],
});

const seedanceExtractor = createExtractor({
  videoPaths: ['data.content.video_url'],
  imagePaths: ['data.content.cover_url'],
  textPaths: undefined,
  excludePaths: ['data.detail.req.reference_images', 'properties.input.media'],
});

const klingVideoExtractor = createExtractor({
  videoPaths: [
    'data.task_result.videos',
    'task_result.videos',
    'data.task_result.video.url',
    'data.video_url',
    'video_url',
  ],
  imagePaths: ['data.task_result.images', 'task_result.images'],
  textPaths: undefined,
  excludePaths: ['data.task_params.images', 'data.task_params.image_list'],
});

const geminiImageExtractor = createExtractor({
  videoPaths: undefined,
  imagePaths: ['candidates.0.content.parts'],
  textPaths: undefined,
  excludePaths: undefined,
});

const clone = <T>(value: T): T => structuredClone(value);

const VEO_SUCCESS_RESULT = {
  id: 'veo-job-20241107-001',
  provider: 'google',
  status: 'video_generation_completed',
  video_url: 'https://storage.googleapis.com/openai-veo/job-20241107-001/base.mp4',
  detail: {
    upsample_video_url: 'https://storage.googleapis.com/openai-veo/job-20241107-001/upscaled.mp4',
    video_url: 'https://storage.googleapis.com/openai-veo/job-20241107-001/detail.mp4',
    startImageMediaId: 'media-start-123',
    veo3StartImageMediaId: 'media-veo3-456',
    images: [
      {
        url: 'https://inputs.example.com/api/proxy/image/c77931b557b6591e19e6437469209f0c.jpg',
        status: 'completed',
        mediaId: 'media-input-xyz',
      },
    ],
    req: {
      prompt: 'a cinematic shot of neon skyline',
      images: ['https://uploads.example.com/reference/head-frame.png'],
    },
    preview_frames: [
      { url: 'https://cdn.example.com/veo/job-20241107-001/preview-1.png' },
      'https://cdn.example.com/veo/job-20241107-001/preview-2.png',
    ],
  },
  gallery: [
    {
      image_url: 'https://cdn.example.com/veo/job-20241107-001/gallery.png',
    },
  ],
} as const;

const SEEDANCE_SUCCESS_RESULT = {
  request_id: 'seedance-job-20241107-xyz',
  provider: 'bytedance',
  data: {
    content: {
      video_url: 'https://sf1-dycdn-tos.pstatp.com/obj/seedance/job-xyz/video.mp4',
      cover_url: 'https://sf1-dycdn-tos.pstatp.com/obj/seedance/job-xyz/cover.png',
    },
    detail: {
      req: {
        prompt: 'a dancer spinning through fog',
        reference_images: ['https://uploads.example.com/seedance/ref.png'],
      },
    },
  },
  properties: {
    input: {
      media: [{ url: 'https://uploads.example.com/seedance/input.png' }],
    },
  },
} as const;

const LONG_BASE64_IMAGE = 'A'.repeat(120);
const LONG_BASE64_IMAGE_ALT = 'B'.repeat(120);

const KLING_VIDEO_SUCCESS_RESULT = {
  id: 'kling-job-20241107',
  data: {
    task_result: {
      videos: [
        'https://klingcdn.com/task/job-20241107/main.mp4',
        'https://klingcdn.com/task/job-20241107/secondary.mp4',
      ],
      images: ['https://klingcdn.com/task/job-20241107/cover.png'],
    },
    task_params: {
      images: ['https://uploads.example.com/kling/video/reference.png'],
      image_list: ['https://uploads.example.com/kling/video/alt-reference.png'],
    },
  },
  task_result: {
    videos: ['https://klingcdn.com/task/job-20241107/legacy.mp4'],
  },
} as const;

const GEMINI_IMAGE_SUCCESS_RESULT = {
  candidates: [
    {
      content: {
        parts: [
          {
            inline_data: {
              mime_type: 'image/png',
              data: LONG_BASE64_IMAGE,
            },
          },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: LONG_BASE64_IMAGE_ALT,
            },
          },
        ],
      },
    },
  ],
} as const;

const createGenericResult = () => ({
  id: 'generic-task',
  url: 'https://assets.example.com/render.mp4',
  preview: [
    'https://assets.example.com/render-thumb.png',
    'https://assets.example.com/render-alt.png',
  ],
});

const noopExtractor = createExtractor({
  videoPaths: ['missing.path'],
  imagePaths: ['also.missing[0]'],
  textPaths: undefined,
  excludePaths: undefined,
});

const multiPathExtractor = createExtractor({
  videoPaths: ['clips[1].url', 'clips[0].url'],
  imagePaths: undefined,
  textPaths: undefined,
  excludePaths: undefined,
});

const imageOnlyExtractor = createExtractor({
  videoPaths: undefined,
  imagePaths: ['media.images[0].url', 'media.images[1]'],
  textPaths: undefined,
  excludePaths: undefined,
});

const ARRAY_RESULT = {
  clips: [{ url: 'https://cdn.example.com/video-clip.mp4' }],
};

const IMAGE_PATH_RESULT = {
  media: {
    images: [
      { url: 'https://cdn.example.com/storyboard/frame-a.png' },
      'https://cdn.example.com/storyboard/frame-b.png',
    ],
  },
  video_url: 'https://cdn.example.com/storyboard/fallback.mp4',
};


describe('extractMediaUrls', () => {
  describe('Gemini inline_data 分支', () => {
    it('mime_type 不是 image/png 时不会重复提取 inline_data', () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: LONG_BASE64_IMAGE,
                  },
                },
              ],
            },
          },
        ],
      };

      const result = extractMediaUrls(mockResponse);
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('仅包含 thoughtSignature 的 part 会被跳过', () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                { thoughtSignature: 'EsO/RQq/v0UB0e......Z' },
                {
                  inline_data: {
                    mime_type: 'image/png',
                    data: LONG_BASE64_IMAGE,
                  },
                },
              ],
            },
          },
        ],
      };

      const result = extractMediaUrls(mockResponse);
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatch(/^data:image\/png;base64,/);
    });

    it('Gemini TTS 的 audio inlineData 不会再被误判成图片', () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: LONG_BASE64_IMAGE,
                  },
                },
              ],
            },
          },
        ],
      };

      const result = extractMediaUrls(mockResponse);
      expect(result.images).toEqual([]);
      expect(result.videos).toEqual([]);
    });
  });

  describe('对象级去重（url + base64 同图不同格式）', () => {
    it('同一对象同时包含 url 与 b64_json 时优先 b64_json，并且不返回 url', () => {
      const payload = {
        data: [
          {
            url: 'https://assets.example.com/a.png',
            b64_json: LONG_BASE64_IMAGE,
          },
          {
            url: 'https://assets.example.com/b.png',
            b64_json: LONG_BASE64_IMAGE_ALT,
          },
        ],
      };

      const result = extractMediaUrls(payload);
      expect(result.images).toEqual([
        `data:image/png;base64,${LONG_BASE64_IMAGE}`,
        `data:image/png;base64,${LONG_BASE64_IMAGE_ALT}`,
      ]);
      expect(result.images).not.toContain('https://assets.example.com/a.png');
      expect(result.images).not.toContain('https://assets.example.com/b.png');
    });

    it('b64_json 无效时回退到 url', () => {
      const payload = {
        data: [
          {
            url: 'https://assets.example.com/a.png',
            b64_json: '[B64_TRUNCATED]',
          },
        ],
      };

      const result = extractMediaUrls(payload);
      expect(result.images).toEqual(['https://assets.example.com/a.png']);
    });

    it('同一对象同时包含 url 与 inline_data 时优先 inline_data', () => {
      const payload = {
        data: [
          {
            url: 'https://assets.example.com/a.png',
            inline_data: {
              mime_type: 'image/png',
              data: LONG_BASE64_IMAGE,
            },
          },
        ],
      };

      const result = extractMediaUrls(payload);
      expect(result.images).toEqual([`data:image/png;base64,${LONG_BASE64_IMAGE}`]);
      expect(result.images).not.toContain('https://assets.example.com/a.png');
    });
  });
});

describe('extractWithConfig', () => {
  describe('通用逻辑', () => {
    it('没有配置时回退到 extractMediaUrls', () => {
      const payload = createGenericResult();
      const expected = extractMediaUrls(payload);
      const result = extractWithConfig(payload, undefined);
      expect(result).toEqual(expected);
    });

    it('路径不存在时返回空数组', () => {
      const payload = { data: {} };
      const result = extractWithConfig(payload, noopExtractor);
      expect(result).toEqual({ images: [], videos: [] });
    });

    it('null 或 undefined 结果可以安全处理', () => {
      expect(extractWithConfig(undefined, veoExtractor)).toEqual({ images: [], videos: [] });
      expect(extractWithConfig(null, veoExtractor)).toEqual({ images: [], videos: [] });
    });

    it('数组索引越界时会尝试后续路径', () => {
      const result = extractWithConfig(ARRAY_RESULT, multiPathExtractor);
      expect(result.videos).toEqual(['https://cdn.example.com/video-clip.mp4']);
      expect(result.images).toEqual([]);
    });

    it('仅配置 imagePaths 时能够收集并去重所有命中 URL', () => {
      const result = extractWithConfig(IMAGE_PATH_RESULT, imageOnlyExtractor);
      expect(result.videos).toEqual(['https://cdn.example.com/storyboard/fallback.mp4']);
      expect(result.images).toEqual([
        'https://cdn.example.com/storyboard/frame-a.png',
        'https://cdn.example.com/storyboard/frame-b.png',
      ]);
    });
  });

  describe('VEO 模型', () => {
    it('优先返回 upsample_video_url', () => {
      const result = extractWithConfig(clone(VEO_SUCCESS_RESULT), veoExtractor);
      expect(result.videos).toEqual([
        'https://storage.googleapis.com/openai-veo/job-20241107-001/upscaled.mp4',
      ]);
      expect(result.images).toEqual([
        'https://cdn.example.com/veo/job-20241107-001/preview-1.png',
        'https://cdn.example.com/veo/job-20241107-001/preview-2.png',
        'https://cdn.example.com/veo/job-20241107-001/gallery.png',
      ]);
    });

    it('缺少 upsample 时回退到 video_url', () => {
      const payload = clone(VEO_SUCCESS_RESULT);
      delete (payload.detail as Record<string, unknown>)['upsample_video_url'];
      const result = extractWithConfig(payload, veoExtractor);
      expect(result.videos).toEqual([
        'https://storage.googleapis.com/openai-veo/job-20241107-001/base.mp4',
      ]);
    });

    it('excludePaths 过滤掉 req.images 输入', () => {
      const result = extractWithConfig(clone(VEO_SUCCESS_RESULT), veoExtractor);
      expect(result.images).not.toContain('https://uploads.example.com/reference/head-frame.png');
    });

    it('data.detail.images 中的输入会被排除且不影响输出帧', () => {
      const result = extractWithConfig(clone(VEO_SUCCESS_RESULT), veoExtractor);
      expect(result.videos).toEqual([
        'https://storage.googleapis.com/openai-veo/job-20241107-001/upscaled.mp4',
      ]);
      expect(result.images).toEqual([
        'https://cdn.example.com/veo/job-20241107-001/preview-1.png',
        'https://cdn.example.com/veo/job-20241107-001/preview-2.png',
        'https://cdn.example.com/veo/job-20241107-001/gallery.png',
      ]);
      expect(result.images).not.toContain(
        'https://inputs.example.com/api/proxy/image/c77931b557b6591e19e6437469209f0c.jpg'
      );
    });
  });

  describe('Volcengine / Seedance 模型', () => {
    it('提取 data.content.video_url 并过滤请求体', () => {
      const result = extractWithConfig(clone(SEEDANCE_SUCCESS_RESULT), seedanceExtractor);
      expect(result.videos).toEqual([
        'https://sf1-dycdn-tos.pstatp.com/obj/seedance/job-xyz/video.mp4',
      ]);
      expect(result.images).toEqual([
        'https://sf1-dycdn-tos.pstatp.com/obj/seedance/job-xyz/cover.png',
      ]);
      expect(result.images).not.toContain('https://uploads.example.com/seedance/ref.png');
      expect(result.images).not.toContain('https://uploads.example.com/seedance/input.png');
    });
  });

  describe('Kling 视频模型', () => {
    it('优先使用 data.task_result.videos 列表', () => {
      const result = extractWithConfig(clone(KLING_VIDEO_SUCCESS_RESULT), klingVideoExtractor);
      expect(result.videos).toEqual(['https://klingcdn.com/task/job-20241107/main.mp4']);
      expect(result.videos).not.toContain('https://klingcdn.com/task/job-20241107/legacy.mp4');
      expect(result.images).toEqual(['https://klingcdn.com/task/job-20241107/cover.png']);
    });

    it('缺少数组时回退到 video.url 并过滤 task_params', () => {
      const payload = clone(KLING_VIDEO_SUCCESS_RESULT);
      const taskResult = payload.data.task_result as Record<string, unknown>;
      delete taskResult['videos'];
      taskResult['video'] = {
        url: 'https://klingcdn.com/task/job-20241107/fallback.mp4',
      };
      const legacyTaskResult = payload.task_result as Record<string, unknown>;
      delete legacyTaskResult['videos'];

      const result = extractWithConfig(payload, klingVideoExtractor);
      expect(result.videos).toEqual(['https://klingcdn.com/task/job-20241107/fallback.mp4']);
      expect(result.images).toEqual(['https://klingcdn.com/task/job-20241107/cover.png']);
      expect(result.images).not.toContain('https://uploads.example.com/kling/video/reference.png');
      expect(result.images).not.toContain('https://uploads.example.com/kling/video/alt-reference.png');
    });
  });

  describe('Gemini 图像模型', () => {
    it('提取 candidates.parts inline_data base64', () => {
      const result = extractWithConfig(clone(GEMINI_IMAGE_SUCCESS_RESULT), geminiImageExtractor);
      expect(result.images).toEqual([
        `data:image/png;base64,${LONG_BASE64_IMAGE}`,
        `data:image/jpeg;base64,${LONG_BASE64_IMAGE_ALT}`,
      ]);
      expect(result.videos).toEqual([]);
    });
  });
});
