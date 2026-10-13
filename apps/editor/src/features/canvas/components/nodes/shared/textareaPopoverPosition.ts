'use client';

export type ViewportRect = {
  left: number;
  top: number;
  bottom: number;
  height: number;
};

type PanelSize = { width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const safeNumber = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

const getTextareaScale = (textarea: HTMLTextAreaElement) => {
  const rect = textarea.getBoundingClientRect();
  const scaleX = textarea.offsetWidth > 0 ? rect.width / textarea.offsetWidth : 1;
  const scaleY = textarea.offsetHeight > 0 ? rect.height / textarea.offsetHeight : 1;
  return {
    rect,
    scaleX: safeNumber(scaleX, 1) || 1,
    scaleY: safeNumber(scaleY, 1) || 1,
  };
};

/**
 * 获取 textarea 当前光标在「视口坐标」下的近似矩形（用于 popover 锚点）。
 * - 兼容画布 zoom（CSS transform scale）导致的视觉缩放：用 rect/offset 尺寸推导 scale 并换算。
 * - 若计算失败则回退到 textarea 左下角。
 */
export function getTextareaCaretViewportRect(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): ViewportRect {
  const { rect, scaleX, scaleY } = getTextareaScale(textarea);
  const fallback: ViewportRect = {
    left: Math.round(rect.left),
    top: Math.round(rect.bottom),
    bottom: Math.round(rect.bottom),
    height: 0,
  };

  if (!(textarea.ownerDocument !== null && textarea.ownerDocument !== undefined ? textarea.ownerDocument.body : undefined)) return fallback;
  if (typeof window === 'undefined') return fallback;

  const style = window.getComputedStyle(textarea);
  const mirror = textarea.ownerDocument.createElement('div');
  const span = textarea.ownerDocument.createElement('span');

  // 影响换行/测量的关键样式（无需全量复制）
  const mirrorStyles: Array<keyof CSSStyleDeclaration> = [
    'direction',
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderTopStyle',
    'borderRightStyle',
    'borderBottomStyle',
    'borderLeftStyle',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontFamily',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'textAlign',
    'textIndent',
    'tabSize',
  ];

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'auto';

  for (const key of mirrorStyles) {
    const styleKey = String(key);
    mirror.style.setProperty(styleKey, style.getPropertyValue(styleKey));
  }

  const safeCaret = clamp(caretIndex, 0, textarea.value.length);
  mirror.textContent = textarea.value.slice(0, safeCaret);
  // zero-width space：用来拿到“光标后”的实际布局位置
  span.textContent = '\u200B';
  mirror.appendChild(span);

  textarea.ownerDocument.body.appendChild(mirror);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;

  const mirrorRect = mirror.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();

  mirror.remove();

  const offsetLeft = spanRect.left - mirrorRect.left;
  const offsetTop = spanRect.top - mirrorRect.top;
  const rawHeight = spanRect.height || parseFloat(style.lineHeight) || 16;

  const left = rect.left + offsetLeft * scaleX;
  const top = rect.top + offsetTop * scaleY;
  const height = rawHeight * scaleY;

  return {
    left: Math.round(safeNumber(left, fallback.left)),
    top: Math.round(safeNumber(top, fallback.top)),
    bottom: Math.round(safeNumber(top + height, fallback.bottom)),
    height: Math.round(safeNumber(height, 0)),
  };
}

export function resolvePopoverPosition({
  anchor,
  panelSize,
  gap = 6,
  margin = 12,
}: {
  anchor: ViewportRect;
  panelSize: PanelSize;
  gap: number | undefined;
  margin: number | undefined;
}): { left: number; top: number } {
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;

  const safeWidth = Math.max(0, safeNumber(panelSize.width, 0));
  const safeHeight = Math.max(0, safeNumber(panelSize.height, 0));

  const minLeft = margin;
  const maxLeft = Math.max(margin, viewportWidth - margin - safeWidth);
  const minTop = margin;
  const maxTop = Math.max(margin, viewportHeight - margin - safeHeight);

  const preferredLeft = anchor.left;
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - safeHeight;

  const canPlaceBelow = belowTop + safeHeight <= viewportHeight - margin;
  const canPlaceAbove = aboveTop >= margin;

  const preferredTop = canPlaceBelow || !canPlaceAbove ? belowTop : aboveTop;

  return {
    left: Math.round(clamp(preferredLeft, minLeft, maxLeft)),
    top: Math.round(clamp(preferredTop, minTop, maxTop)),
  };
}

/**
 * 获取 contentEditable 光标的「视口坐标」近似矩形（用于 popover 锚点）。
 * - 通过 Selection/Range 计算；若拿不到 rect，则用临时 marker 兜底。
 */
export function getContentEditableCaretViewportRect(editor: HTMLElement): ViewportRect {
  const rect = editor.getBoundingClientRect();
  const fallback: ViewportRect = {
    left: Math.round(rect.left),
    top: Math.round(rect.bottom),
    bottom: Math.round(rect.bottom),
    height: 0,
  };

  if (typeof window === 'undefined') return fallback;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1) return fallback;

  const range = selection.getRangeAt(0);
  const startInEditor = editor.contains(range.startContainer) || range.startContainer === editor;
  if (!startInEditor) return fallback;

  const clientRect =
    typeof (range as Range).getClientRects === 'function'
      ? ((range as Range).getClientRects() !== null && (range as Range).getClientRects() !== undefined ? (range as Range).getClientRects()[0] : undefined)
      : null;
  if (clientRect && clientRect.height > 0) {
    return {
      left: Math.round(clientRect.left),
      top: Math.round(clientRect.top),
      bottom: Math.round(clientRect.bottom),
      height: Math.round(clientRect.height),
    };
  }

  // collapsed range 在某些环境下会拿到 0 rect，这里用 marker 兜底
  const original = range.cloneRange();
  const marker = editor.ownerDocument.createElement('span');
  marker.textContent = '\u200B';
  marker.style.whiteSpace = 'pre';
  marker.style.pointerEvents = 'none';
  marker.style.opacity = '0';

  try {
    const temp = range.cloneRange();
    temp.collapse(true);
    temp.insertNode(marker);
    const markerRect = marker.getBoundingClientRect();
    return {
      left: Math.round(markerRect.left),
      top: Math.round(markerRect.top),
      bottom: Math.round(markerRect.bottom),
      height: Math.round(markerRect.height || 0),
    };
  } catch {
    return fallback;
  } finally {
    marker.remove();
    try {
      selection.removeAllRanges();
      selection.addRange(original);
    } catch {
      // ignore
    }
  }
}
