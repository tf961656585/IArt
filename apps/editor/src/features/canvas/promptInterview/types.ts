import type { PromptInterviewMediaType, PromptInterviewSpecV1, PromptInterviewTurnV1 } from '@/features/canvas/types/node';

export type PromptInterviewQuestionId =
  | 'subject'
  | 'action'
  | 'setting'
  | 'timeOfDay'
  | 'style'
  | 'composition'
  | 'camera'
  | 'lighting'
  | 'colorPalette'
  | 'materials'
  | 'mood'
  | 'motion'
  | 'constraints'
  | 'avoid'
  | 'additionalDetails';

export type PromptInterviewQuestion = {
  id: PromptInterviewQuestionId;
  title: string;
  description: string | undefined;
  mediaTypes: PromptInterviewMediaType[];
  field: keyof PromptInterviewSpecV1;
  inputMode: 'choice' | 'free' | 'choice_or_free';
  localSuggestions: string[];
  priority: number;
};

export type PromptInterviewProfile = {
  id: string;
  label: string;
  mediaType: PromptInterviewMediaType;
  questionOrder: PromptInterviewQuestionId[];
};

export type NextQuestionPlan = {
  question: PromptInterviewQuestion;
  remaining: number;
} | null;

export type PlanNextQuestionParams = {
  mediaType: PromptInterviewMediaType;
  spec: PromptInterviewSpecV1;
  turns: PromptInterviewTurnV1[];
  maxTurns: number;
  questionOrder: PromptInterviewQuestionId[];
};

