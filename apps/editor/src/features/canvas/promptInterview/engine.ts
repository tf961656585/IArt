import { nanoid } from 'nanoid';
import type {
  PromptInterviewMediaType,
  PromptInterviewNodeData,
  PromptInterviewSpecV1,
  PromptInterviewTurnV1,
} from '@/features/canvas/types/node';
import type { PromptInterviewQuestion } from './types';

const createEmptyPromptInterviewSpec = (): PromptInterviewSpecV1 => ({
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
});

export function createPromptInterviewState(params: {
  profileId: string;
  mediaType: PromptInterviewMediaType;
  seedText: string | undefined;
  nowIso: string;
}): PromptInterviewNodeData {
  const seed = typeof params.seedText === 'string' ? params.seedText.trim() : '';
  const spec: PromptInterviewSpecV1 = {
    ...createEmptyPromptInterviewSpec(),
    additionalDetails: seed || undefined,
  };
  return {
    version: 1,
    profileId: params.profileId,
    mediaType: params.mediaType,
    status: 'in_progress',
    turns: [],
    spec,
    result: undefined,
    updatedAt: params.nowIso,
  };
}

function writeSpecField(spec: PromptInterviewSpecV1, question: PromptInterviewQuestion, answer: string): PromptInterviewSpecV1 {
  const next: PromptInterviewSpecV1 = { ...spec };
  const trimmed = answer.trim();
  if (trimmed.length === 0) return next;
  return { ...next, [question.field]: trimmed } as PromptInterviewSpecV1;
}

export function appendTurn(params: {
  state: PromptInterviewNodeData;
  question: PromptInterviewQuestion;
  answer: string;
  mode: PromptInterviewTurnV1['mode'];
  suggestions: string[] | undefined;
  nowIso: string;
}): PromptInterviewNodeData {
  const turn: PromptInterviewTurnV1 = {
    id: nanoid(),
    createdAt: params.nowIso,
    questionId: params.question.id,
    question: params.question.title,
    answer: params.answer,
    mode: params.mode,
    suggestions: params.suggestions,
  };

  const spec =
    params.mode === 'skip'
      ? params.state.spec
      : writeSpecField(params.state.spec, params.question, params.answer);

  return {
    ...params.state,
    status: 'in_progress',
    turns: [...params.state.turns, turn],
    spec,
    updatedAt: params.nowIso,
  };
}

export function setResult(params: {
  state: PromptInterviewNodeData;
  prompt: string;
  nowIso: string;
}): PromptInterviewNodeData {
  return {
    ...params.state,
    status: 'done',
    result: { prompt: params.prompt, updatedAt: params.nowIso },
    updatedAt: params.nowIso,
  };
}
