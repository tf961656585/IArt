export const labelResizeObserverCallback = <T extends ResizeObserverCallback>(
  callback: T,
  label: string,
): T => {
  try {
    Object.defineProperty(callback, '__IART_RO_LABEL', {
      configurable: true,
      value: label,
    });
  } catch {
    // Debug labels are best-effort and must not affect observer creation.
  }
  return callback;
};
