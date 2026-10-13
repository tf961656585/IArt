'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface DeferredHoverActivationHandlers {
  isHovered: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * 交互门控下的 hover 激活补偿：
 * - 交互期间不触发 onHoverEnter（避免性能开销）
 * - 若交互窗口内进入 hover，则在交互结束且仍 hover 时补发一次 onHoverEnter
 */
export const useDeferredHoverActivation = (params: {
  isInteracting: boolean;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
}): DeferredHoverActivationHandlers => {
  const { isInteracting, onHoverEnter, onHoverLeave } = params;
  const [isHovered, setIsHovered] = useState(false);
  const pendingActivationRef = useRef(false);

  const onPointerEnter = useCallback(() => {
    setIsHovered(true);
    if (isInteracting) {
      pendingActivationRef.current = true;
      return;
    }
    pendingActivationRef.current = false;
    onHoverEnter();
  }, [isInteracting, onHoverEnter]);

  const onPointerLeave = useCallback(() => {
    pendingActivationRef.current = false;
    setIsHovered(false);
    onHoverLeave();
  }, [onHoverLeave]);

  useEffect(() => {
    if (isInteracting) return;
    if (!isHovered) return;
    if (!pendingActivationRef.current) return;
    pendingActivationRef.current = false;
    onHoverEnter();
  }, [isHovered, isInteracting, onHoverEnter]);

  return { isHovered, onPointerEnter, onPointerLeave };
};

export default useDeferredHoverActivation;
