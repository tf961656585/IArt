import type { PromptInterviewMediaType } from '@/features/canvas/types/node';
import type { PromptInterviewQuestion, PromptInterviewQuestionId, NextQuestionPlan, PlanNextQuestionParams } from './types';
import { getPromptInterviewQuestion, PROMPT_INTERVIEW_QUESTIONS } from './questionBank';

function isFilled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : false;
}

function askedQuestionIds(turns: Array<{ questionId: string }>): Set<string> {
  return new Set(turns.map((t) => t.questionId));
}

function questionPoolByMediaType(mediaType: PromptInterviewMediaType): PromptInterviewQuestion[] {
  return PROMPT_INTERVIEW_QUESTIONS
    .filter((q) => q.mediaTypes.includes(mediaType))
    .sort((a, b) => b.priority - a.priority);
}

export function planNextQuestion(params: PlanNextQuestionParams): NextQuestionPlan {
  const remaining = Math.max(0, params.maxTurns - params.turns.length);
  if (remaining <= 0) return null;

  const asked = askedQuestionIds(params.turns);

  const ordered: PromptInterviewQuestionId[] = params.questionOrder.length
    ? params.questionOrder
    : questionPoolByMediaType(params.mediaType).map((q) => q.id);

  for (const id of ordered) {
    if (asked.has(id)) continue;
    const q = getPromptInterviewQuestion(id);
    if (!q) continue;
    if (!q.mediaTypes.includes(params.mediaType)) continue;
    const value = params.spec[q.field];
    if (isFilled(value)) continue;
    return { question: q, remaining };
  }

  // 若所有“缺口问题”都填完了，仍可在剩余轮次里补充 additionalDetails
  if (!asked.has('additionalDetails')) {
    const q = getPromptInterviewQuestion('additionalDetails');
    if (q && q.mediaTypes.includes(params.mediaType)) {
      return { question: q, remaining };
    }
  }

  return null;
}
