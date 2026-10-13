import { describe, expect, it } from 'vitest';
import { extractOrderedMediaOutputs } from '../taskOutputMedia';

describe('extractOrderedMediaOutputs', () => {
  it('按数组顺序提取 image/video/audio', () => {
    const payload = {
      outputs: ['/files/a.png', '/files/b.mp4', '/files/c.mp3'],
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      { mediaType: 'image', url: '/files/a.png', candidates: ['/files/a.png'] },
      { mediaType: 'video', url: '/files/b.mp4', candidates: ['/files/b.mp4'] },
      { mediaType: 'audio', url: '/files/c.mp3', candidates: ['/files/c.mp3'] },
    ]);
  });

  it('跳过 input/inputs 分支', () => {
    const payload = {
      input: { image_url: 'https://inputs.example.com/xxx.png' },
      output: { url: 'https://example.com/out.png' },
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      { mediaType: 'image', url: 'https://example.com/out.png', candidates: ['https://example.com/out.png'] },
    ]);
  });

  it('同一 record 内 b64_json + url 仅产出 1 个 image（base64 优先，url 回退）', () => {
    const b64 = 'QUJD'.repeat(64);
    const payload = {
      data: [
        {
          url: 'https://example.com/out.png',
          b64_json: b64,
        },
      ],
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      {
        mediaType: 'image',
        url: `data:image/png;base64,${b64}`,
        candidates: [`data:image/png;base64,${b64}`, 'https://example.com/out.png'],
      },
    ]);
  });

  it('b64_json 无效时不进入候选，自动回退 url（仍只产出 1 个 image）', () => {
    const payload = {
      data: [
        {
          url: 'https://example.com/out.png',
          b64_json: 'not_base64!!',
        },
      ],
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      { mediaType: 'image', url: 'https://example.com/out.png', candidates: ['https://example.com/out.png'] },
    ]);
  });

  it('支持 Gemini inline_data', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                inline_data: { mime_type: 'audio/mpeg', data: 'QUJD' },
              },
            ],
          },
        },
      ],
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      { mediaType: 'audio', url: 'data:audio/mpeg;base64,QUJD', candidates: ['data:audio/mpeg;base64,QUJD'] },
    ]);
  });

  it('支持 Gemini PCM inlineData MIME', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'QUJD' },
              },
            ],
          },
        },
      ],
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      {
        mediaType: 'audio',
        url: 'data:audio/L16;base64,QUJD',
        candidates: ['data:audio/L16;base64,QUJD'],
      },
    ]);
  });

  it('已有显式音频字段时不再重复扫描 raw 中同一段 Gemini 音频', () => {
    const payload = {
      audio_url: '/files/gemini-tts.wav',
      audios: ['/files/gemini-tts.wav'],
      raw: {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'QUJD' },
                },
              ],
            },
          },
        ],
      },
    };

    expect(extractOrderedMediaOutputs(payload)).toEqual([
      {
        mediaType: 'audio',
        url: '/files/gemini-tts.wav',
        candidates: ['/files/gemini-tts.wav'],
      },
    ]);
  });
});
