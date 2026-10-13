import { describe, it, expect } from 'vitest';
import { planNextQuestion } from '../planner';
import { ensurePromptInterviewProfilesRegistered, getPromptInterviewProfile } from '../profiles';
import type { PromptInterviewTurnV1 } from '@/features/canvas/types/node';

const createTurn = (questionId: string): PromptInterviewTurnV1 => ({
  id: 't1',
  createdAt: '2026-01-01T00:00:00.000Z',
  questionId,
  question: '',
  answer: '',
  mode: 'skip',
  suggestions: undefined,
});

const EMPTY_SPEC = {
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
} as const;

const requireProfile = (profileId: string) => {
  const profile = getPromptInterviewProfile(profileId);
  if (!profile) throw new Error(`missing prompt interview profile: ${profileId}`);
  return profile;
};

describe('promptInterview/planner', () => {
  it('plans questions by profile order and skips answered ids', () => {
    ensurePromptInterviewProfilesRegistered();
    const profile = requireProfile('universal-image');

    const first = planNextQuestion({
      mediaType: 'image',
      spec: { ...EMPTY_SPEC },
      turns: [],
      maxTurns: 8,
      questionOrder: profile.questionOrder,
    });
    expect(first?.question.id).toBe('subject');

    const second = planNextQuestion({
      mediaType: 'image',
      spec: { ...EMPTY_SPEC, subject: 'a cat' },
      turns: [createTurn('subject')],
      maxTurns: 8,
      questionOrder: profile.questionOrder,
    });
    expect(second?.question.id).not.toBe('subject');
  });

  it('returns null when out of turns', () => {
    ensurePromptInterviewProfilesRegistered();
    const profile = requireProfile('universal-image');
    const planned = planNextQuestion({
      mediaType: 'image',
      spec: { ...EMPTY_SPEC },
      turns: Array.from({ length: 8 }, (_, idx) => createTurn(`q${idx}`)),
      maxTurns: 8,
      questionOrder: profile.questionOrder,
    });
    expect(planned).toBeNull();
  });
});
