'use client';
/**
 * 角色 Dock（底部边缘唤起）
 * - 未唤起：底部显示柔和蓝色渐变提示（不遮挡交互）
 * - 唤起：鼠标滑到屏幕下边缘自动展开角色栏
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { CharacterAvatarBar } from './CharacterAvatarBar';

const EDGE_TRIGGER_PX = 16;
const HIDE_DELAY_MS = 260;

export function CharacterDock() {
  const [awake, setAwake] = useState(false);
  const [hoveringDock, setHoveringDock] = useState(false);
  const hoveringDockRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    hoveringDockRef.current = hoveringDock;
  }, [hoveringDock]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const wakeUp = useCallback(() => {
    clearHideTimer();
    setAwake(true);
  }, [clearHideTimer]);

  const scheduleSleep = useCallback(() => {
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setAwake(false);
    }, HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const distanceToBottom = window.innerHeight - event.clientY;
      if (distanceToBottom <= EDGE_TRIGGER_PX) {
        wakeUp();
        return;
      }

      if (!hoveringDockRef.current) {
        scheduleSleep();
      } else {
        clearHideTimer();
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearHideTimer();
    };
  }, [wakeUp, scheduleSleep, clearHideTimer]);

  return (
    <div className="absolute inset-x-0 bottom-0 z-canvas-banner pointer-events-none">
      {/* 未唤起提示：柔和蓝色渐变（高度尽量小，不影响工作区交互） */}
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-x-0 bottom-0 h-2',
          'bg-gradient-to-t from-blue-500/25 via-blue-400/10 to-transparent',
          'transition-opacity duration-200',
          awake ? 'opacity-0' : 'opacity-100'
        )}
      />

      {/* Dock 内容 */}
      <div
        className={cn(
          'flex justify-center pb-4',
          'transition-all duration-200 ease-out',
          awake ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
        )}
      >
        <div
          className={cn('pointer-events-auto', !awake && 'pointer-events-none')}
          onMouseEnter={() => {
            setHoveringDock(true);
            wakeUp();
          }}
          onMouseLeave={() => {
            setHoveringDock(false);
            scheduleSleep();
          }}
        >
          <CharacterAvatarBar />
        </div>
      </div>
    </div>
  );
}
