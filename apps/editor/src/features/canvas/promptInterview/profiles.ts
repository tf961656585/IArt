import type { PromptInterviewMediaType } from '@/features/canvas/types/node';
import type { PromptInterviewProfile } from './types';

const registry = new Map<string, PromptInterviewProfile>();
let defaultRegistered = false;

export function registerPromptInterviewProfile(profile: PromptInterviewProfile): void {
  registry.set(profile.id, profile);
}

export function getPromptInterviewProfile(profileId: string | null | undefined): PromptInterviewProfile | null {
  if (!profileId) return null;
  return registry.get(profileId) ?? null;
}

export function getDefaultPromptInterviewProfileId(mediaType: PromptInterviewMediaType): string {
  return mediaType === 'video' ? 'universal-video' : 'universal-image';
}

export function ensurePromptInterviewProfilesRegistered(): void {
  if (defaultRegistered) return;
  defaultRegistered = true;

  registerPromptInterviewProfile({
    id: 'universal-image',
    label: '通用（图像）',
    mediaType: 'image',
    questionOrder: [
      'subject',
      'action',
      'setting',
      'style',
      'composition',
      'camera',
      'lighting',
      'colorPalette',
      'materials',
      'mood',
      'constraints',
      'avoid',
      'additionalDetails',
    ],
  });

  registerPromptInterviewProfile({
    id: 'universal-video',
    label: '通用（视频）',
    mediaType: 'video',
    questionOrder: [
      'subject',
      'action',
      'setting',
      'style',
      'composition',
      'camera',
      'lighting',
      'motion',
      'colorPalette',
      'materials',
      'mood',
      'constraints',
      'avoid',
      'additionalDetails',
    ],
  });
}

