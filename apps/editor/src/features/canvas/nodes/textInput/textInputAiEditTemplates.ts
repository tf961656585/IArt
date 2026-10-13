export const TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID = 'none' as const;

export const TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT = `
你是“媒体内容创作提示词优化助手”，擅长把用户的想法改写成更高质量、可直接用于图片/视频/音频生成模型的提示词。

工作方式：
- 先理解用户的修改意图/约束，再基于“原文”进行改写与增强。
- 尽量保留原文中已经明确的关键信息（主体、动作、场景、风格、镜头、光线、氛围、时长/节奏、音色、负面要求等），必要时补全缺失但常用的细节，但不要凭空捏造与用户意图冲突的内容。
- 输出应简洁、具体、可执行；避免空泛形容词堆砌；避免自相矛盾。
- 如果原文是中文就用中文输出；如果原文是英文就用英文输出（除非用户另有要求）。

输出要求：
- 只输出改写后的最终文本。
- 不要解释，不要给建议，不要输出思考过程。
- 不要包含任何前后缀/标题/Markdown。
`.trim();

const TEMPLATE_RULES = [
  '模板规则（严格遵守）：',
  '1. 模板只提供表现形式和思路，不是填空题。',
  '2. 严禁把“你想怎么改”或“原文”整段复制粘贴到模板字段里来凑格式。',
  '3. 必须先理解修改意图与原文信息，再按模板结构抽象/重组，给出该模板下的最佳表现形式（可补全常用细节但不要捏造与用户意图冲突的内容）。',
  '4. 只输出最终结果；不要解释/建议/思考过程；不要输出 Markdown/代码块/```。',
  '5. 输出必须严格采用下方模板结构，不得额外输出说明文字。',
].join('\n');

const JSON_TEMPLATE = `{
  "task": "generate_image",
  "subject": {
    "who": "a young woman",
    "appearance": ["short black hair", "natural makeup"],
    "wardrobe": ["white shirt", "denim jacket"]
  },
  "scene": {
    "location": "subway platform",
    "time": "rainy night",
    "props": ["wet floor reflections", "neon signs"]
  },
  "style": {
    "primary": "photorealistic",
    "mood": "cinematic"
  },
  "camera": {
    "shot": "close-up",
    "lens": "85mm",
    "depth_of_field": "shallow"
  },
  "lighting": {
    "key": "soft side light",
    "accent": "neon rim light"
  },
  "composition": {
    "aspect_ratio": "3:4",
    "focus": "eyes in sharp focus"
  },
  "negative": ["blurry face", "extra fingers", "watermark", "text"]
}`;

const TIMELINE_TEMPLATE = `[GLOBAL / ANCHORS]
Style: 35mm cinematic, warm teal-orange grade, realistic.
Main character: “Lin”, female, short black hair, silver round glasses, red trench coat (keep consistent).
Setting: rainy neon street, night, wet reflections, light fog.
Camera rules: natural handheld, shallow DOF, no zoom unless stated.
Audio intent: rain ambience + distant traffic, no music unless stated.

[TIMELINE / SHOTS]
[00:00-00:03] SHOT 1 (wide establishing): Lin stands under a convenience-store awning, rain streaks visible, neon reflections on pavement. Camera: slow dolly-in.
[00:03-00:07] SHOT 2 (medium): Lin checks a crumpled paper map, looks up, determined. Camera: hold, slight handheld sway. Lighting: same neon key + soft fill from shop window.
[00:07-00:12] SHOT 3 (close-up): Lin smiles subtly; raindrop slides on glasses. Camera: tight close-up, rack focus from raindrop to her eye. End on a clean hold (no fade).`;

export const TEXT_INPUT_AI_EDIT_TEMPLATE_IDS = ['json', 'timeline'] as const;

export type TextInputAiEditTemplateId =
  | typeof TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID
  | (typeof TEXT_INPUT_AI_EDIT_TEMPLATE_IDS)[number];

export type TextInputAiEditTemplateDefinition = {
  id: (typeof TEXT_INPUT_AI_EDIT_TEMPLATE_IDS)[number];
  label: string;
  description: string;
  template: string;
};

export type TextInputAiEditTemplateOption =
  | {
      id: typeof TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID;
      label: string;
      description: string;
    }
  | TextInputAiEditTemplateDefinition;

export const TEXT_INPUT_AI_EDIT_TEMPLATES: TextInputAiEditTemplateDefinition[] = [
  {
    id: 'json',
    label: '结构化模板',
    description: '按主体、场景、风格等分项填写，适合精细控制画面。',
    template: JSON_TEMPLATE,
  },
  {
    id: 'timeline',
    label: '时间线模板',
    description: '按镜头和时间顺序组织内容，适合多镜头、多段视频。',
    template: TIMELINE_TEMPLATE,
  },
];

export const TEXT_INPUT_AI_EDIT_TEMPLATE_OPTIONS: TextInputAiEditTemplateOption[] = [
  {
    id: TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID,
    label: '不用模板',
    description: '直接按你的描述改写，不加额外格式。',
  },
  ...TEXT_INPUT_AI_EDIT_TEMPLATES,
];

const TEMPLATE_REGISTRY = new Map(
  TEXT_INPUT_AI_EDIT_TEMPLATES.map((template) => [template.id, template]),
);

export function isTextInputAiEditTemplateId(value: string): value is TextInputAiEditTemplateId {
  if (value === TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID) return true;
  return TEXT_INPUT_AI_EDIT_TEMPLATE_IDS.some((id) => id === value);
}

export type BuildTextInputAiEditSystemPromptOptions = {
  templateId: TextInputAiEditTemplateId | undefined;
};

export function buildTextInputAiEditSystemPrompt(
  options: BuildTextInputAiEditSystemPromptOptions | undefined = undefined,
): string {
  const templateId = options !== null && options !== undefined ? options.templateId : undefined;
  if (!templateId || templateId === TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID) {
    return TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT;
  }

  const template = TEMPLATE_REGISTRY.get(templateId);
  if (!template) {
    return TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT;
  }

  return [TEXT_INPUT_AI_EDIT_SYSTEM_PROMPT, TEMPLATE_RULES, template.template].join('\n\n');
}
