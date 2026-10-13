type DynamicDetail = Record<string, unknown>;

type DesktopE2EEventPayload = {
  type: string;
  detail: DynamicDetail | null | undefined;
};

type DesktopE2EBridge = {
  reportDesktopE2EEvent: (
    payload: DesktopE2EEventPayload
  ) => Promise<boolean | null | undefined> | boolean | null | undefined | undefined;
};

const getDesktopE2EBridge = (): DesktopE2EBridge | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window.electron as DesktopE2EBridge | undefined) ?? null;
};

export const reportDesktopE2EEvent = async (
  type: string,
  detail: DynamicDetail | null | undefined
): Promise<boolean> => {
  const bridge = getDesktopE2EBridge();
  if (!bridge || typeof bridge.reportDesktopE2EEvent !== 'function') {
    return false;
  }
  const normalizedType = typeof type === 'string' ? type.trim() : '';
  if (!normalizedType) {
    return false;
  }
  try {
    const result = await bridge.reportDesktopE2EEvent({
      type: normalizedType,
      detail: detail ?? null,
    });
    return Boolean(result);
  } catch {
    return false;
  }
};
