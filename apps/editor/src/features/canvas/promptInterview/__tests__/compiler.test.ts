import { describe, it, expect } from 'vitest';
import { compilePrompt } from '../compiler';
import type { PromptInterviewSpecV1 } from '../../types/node';

const buildSpec = (
  overrides: Partial<PromptInterviewSpecV1>,
): PromptInterviewSpecV1 => ({
  subject: undefined,
  action: undefined,
  setting: undefined,
  timeOfDay: undefined,
  style: undefined,
  composition: undefined,
  camera: undefined,
  lighting: undefined,
  colorPalette: undefined,
  materials: undefined,
  mood: undefined,
  motion: undefined,
  constraints: undefined,
  avoid: undefined,
  additionalDetails: undefined,
  ...overrides,
});

describe('promptInterview/compiler', () => {
  it('compiles an image prompt as single paragraph', () => {
    const prompt = compilePrompt({
      mediaType: 'image',
      spec: buildSpec({
        subject: 'a young woman',
        setting: 'in a neon-lit alley',
        style: 'cinematic realism',
        camera: '35mm lens, eye-level',
        lighting: 'soft diffused light',
        avoid: 'text, watermark',
      }),
    });

    expect(prompt).toContain('a young woman');
    expect(prompt).toContain('Avoid:');
    expect(prompt.split(/\r?\n/).length).toBe(1);
  });

  it('includes motion for video', () => {
    const prompt = compilePrompt({
      mediaType: 'video',
      spec: buildSpec({ subject: 'a lone traveler', motion: 'slow dolly-in' }),
    });
    expect(prompt).toContain('slow dolly-in');
  });
});
