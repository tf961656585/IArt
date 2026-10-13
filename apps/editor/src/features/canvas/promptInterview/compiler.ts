import type { PromptInterviewMediaType, PromptInterviewSpecV1 } from '@/features/canvas/types/node';

function cleanPart(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function pushIf(parts: string[], value: string): void {
  if (value.trim().length > 0) parts.push(value);
}

export function compilePrompt(params: { mediaType: PromptInterviewMediaType; spec: PromptInterviewSpecV1 }): string {
  const spec = params.spec;
  const subject = cleanPart(spec.subject) || 'a subject';
  const action = cleanPart(spec.action);
  const setting = cleanPart(spec.setting);
  const timeOfDay = cleanPart(spec.timeOfDay);
  const mood = cleanPart(spec.mood);
  const style = cleanPart(spec.style);
  const composition = cleanPart(spec.composition);
  const camera = cleanPart(spec.camera);
  const lighting = cleanPart(spec.lighting);
  const colorPalette = cleanPart(spec.colorPalette);
  const materials = cleanPart(spec.materials);
  const motion = cleanPart(spec.motion);
  const constraints = cleanPart(spec.constraints);
  const avoid = cleanPart(spec.avoid);
  const additional = cleanPart(spec.additionalDetails);

  const parts: string[] = [];

  // 主句
  const lead = (() => {
    if (action) return `${subject}, ${action}`;
    return subject;
  })();
  pushIf(parts, lead);

  pushIf(parts, setting);
  pushIf(parts, timeOfDay);
  pushIf(parts, mood);
  pushIf(parts, style);
  pushIf(parts, composition);
  pushIf(parts, camera);
  pushIf(parts, lighting);
  pushIf(parts, colorPalette);
  pushIf(parts, materials);
  if (params.mediaType === 'video') {
    pushIf(parts, motion);
  }
  pushIf(parts, additional);

  let prompt = parts.join(', ');
  if (constraints) {
    prompt = `${prompt}. ${constraints}`;
  }
  if (avoid) {
    prompt = `${prompt}. Avoid: ${avoid}`;
  }

  prompt = prompt.trim();
  if (!prompt.endsWith('.')) {
    prompt = `${prompt}.`;
  }
  return prompt;
}

