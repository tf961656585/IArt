import { describe, it, expect } from 'vitest';
import {
  extractGeminiTextContent,
  normalizeFinalData,
  type NormalizedMediaOutput,
  isNormalizedMediaOutput,
} from '../outputNormalize';

const isMediaOutput = (value: unknown): value is NormalizedMediaOutput => {
  return isNormalizedMediaOutput(value);
};

describe('extractGeminiTextContent', () => {
  it('正常提取非 thought 文本，并过滤 thought:true 的部分', () => {
    const finalData = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Thinking process...', thought: true },
              {
                text: 'Here is the summary...\n\n### Title\nContent here.',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };

    const text = extractGeminiTextContent(finalData);
    expect(text).toBe('Here is the summary...\n\n### Title\nContent here.');
    expect(text).not.toContain('Thinking process...');
  });

  it('处理多个 candidates，将文本按顺序合并', () => {
    const finalData = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'First candidate.' }],
          },
        },
        {
          content: {
            role: 'model',
            parts: [{ text: 'Second candidate.' }],
          },
        },
      ],
    };

    const text = extractGeminiTextContent(finalData);
    expect(text).toBe('First candidate.\nSecond candidate.');
  });

  it('支持嵌套 content 结构中的文本提取', () => {
    const finalData = {
      content: {
        parts: [
          { text: 'Level 1 text.' },
          {
            content: {
              parts: [{ text: 'Level 2 text.' }],
            },
          },
        ],
      },
    };

    const text = extractGeminiTextContent(finalData);
    expect(text).toBe('Level 1 text.\nLevel 2 text.');
  });

  it('空数组或空对象返回 null', () => {
    expect(extractGeminiTextContent({})).toBeNull();
    expect(extractGeminiTextContent([])).toBeNull();
  });

  it('仅 thought parts（含布尔与字符串 true）时回退返回 thought 文本', () => {
    const finalData = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Hidden 1', thought: true },
              { text: 'Hidden 2', thought: 'true' },
            ],
          },
        },
      ],
    };

    const text = extractGeminiTextContent(finalData);
    expect(text).toBe('Hidden 1\nHidden 2');
  });
});

describe('normalizeFinalData - Gemini 与兼容性', () => {
  it('Gemini 纯文本结果：提取非 thought 文本', () => {
    const finalData = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Thinking process...', thought: true },
              {
                text: 'Here is the summary...\n\n### Title\nContent here.',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };

    const result = normalizeFinalData(finalData);
    expect(typeof result).toBe('string');
    expect(result).toBe('Here is the summary...\n\n### Title\nContent here.');
  });

  it('Gemini 文本 + 媒体混合：返回媒体结构且 raw 为文本', () => {
    const base64 = 'a'.repeat(104); // 满足 base64 长度与格式检测
    const finalData = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Summary with image.' },
              {
                inline_data: {
                  data: base64,
                  mime_type: 'image/png',
                },
              },
            ],
          },
        },
      ],
    };

    const result = normalizeFinalData(finalData);
    expect(isMediaOutput(result)).toBe(true);
    if (!isMediaOutput(result)) return;

    expect(result.raw).toBe('Summary with image.');
    expect(result.images && result.images.length).toBeGreaterThan(0);
    expect(result.images?.[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('兼容非 Gemini 模型：直接图片 URL 仍被识别为媒体输出', () => {
    const finalData = {
      url: 'https://example.com/output.png',
    };

    const result = normalizeFinalData(finalData);
    expect(isMediaOutput(result)).toBe(true);
    if (!isMediaOutput(result)) return;

    expect(result.images?.[0]?.url).toBe('https://example.com/output.png');
    expect(result.raw).toEqual(finalData);
  });

});
