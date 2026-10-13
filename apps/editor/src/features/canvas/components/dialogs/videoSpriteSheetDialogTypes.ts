import type { VideoMeta } from '../../types';

export type SpriteSheetDialogPayload = {
  startTime: number;
  endTime: number;
  fpsMultiplier: number;
  stepSize: number;
};

export interface VideoSpriteSheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoUrl: string | null;
  videoMeta: VideoMeta | null;
  fps: number | undefined;
  onConfirm: (payload: SpriteSheetDialogPayload) => void;
}
