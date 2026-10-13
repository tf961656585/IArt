'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type VideoPlaceholderProps = {
  className: string | undefined;
  label: ReactNode | undefined;
};

export function VideoPlaceholder({ className, label = 'Video' }: VideoPlaceholderProps) {
  return (
    <div className={cn('flex items-center justify-center text-xs text-muted-foreground', className)}>
      {label}
    </div>
  );
}

export default VideoPlaceholder;
