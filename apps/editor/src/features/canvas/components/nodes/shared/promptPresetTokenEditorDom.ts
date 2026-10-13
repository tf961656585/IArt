import { ASSET_MENTION_TOKEN_PATTERN, assetMentionTokenOf } from "../../../engine/promptAssetMentions";

const PROMPT_PRESET_TOKEN_REGEX_SOURCE = String.raw`\[\[pp:([^\]]+)\]\]`;
/** pp 预设 token 与 @ 资产引用 token 的组合解析正则（交替顺序即文本先后顺序）。 */
const COMBINED_TOKEN_REGEX = new RegExp(
  `${PROMPT_PRESET_TOKEN_REGEX_SOURCE}|${ASSET_MENTION_TOKEN_PATTERN}`,
  "g",
);

export type PresetTokenSegment = {
  kind: "token";
  tokenType: "pp";
  presetId: string;
  start: number;
  end: number;
};

export type AssetTokenSegment = {
  kind: "token";
  tokenType: "asset";
  assetId: string;
  start: number;
  end: number;
};

export type TokenSegment = PresetTokenSegment | AssetTokenSegment;

type TextSegment = { kind: "text"; text: string; start: number; end: number };

export type Segment = TokenSegment | TextSegment;

export function parseSegments(text: string): Segment[] {
  const value = typeof text === "string" ? text : "";
  if (!value) return [{ kind: "text", text: "", start: 0, end: 0 }];

  const segments: Segment[] = [];
  let cursor = 0;

  COMBINED_TOKEN_REGEX.lastIndex = 0;
  for (
    let m = COMBINED_TOKEN_REGEX.exec(value);
    m;
    m = COMBINED_TOKEN_REGEX.exec(value)
  ) {
    const full = m[0] ?? "";
    const presetId = m[1] ?? "";
    const assetId = m[2] ?? "";
    const start = typeof m.index === "number" ? m.index : -1;
    if (start < 0) continue;
    const end = start + full.length;

    if (start > cursor) {
      segments.push({
        kind: "text",
        text: value.slice(cursor, start),
        start: cursor,
        end: start,
      });
    }

    if (presetId) {
      segments.push({ kind: "token", tokenType: "pp", presetId, start, end });
    } else if (assetId) {
      segments.push({ kind: "token", tokenType: "asset", assetId, start, end });
    } else {
      segments.push({ kind: "text", text: full, start, end });
    }

    cursor = end;
  }

  if (cursor < value.length) {
    segments.push({
      kind: "text",
      text: value.slice(cursor),
      start: cursor,
      end: value.length,
    });
  }

  if (segments.length === 0) {
    segments.push({ kind: "text", text: value, start: 0, end: value.length });
  }

  return segments;
}

export function tokenPlaceholder(presetId: string): string {
  return `[[pp:${presetId}]]`;
}

export function serializeEditor(editor: HTMLDivElement): string {
  const parts: string[] = [];
  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const presetId = el.dataset["ppId"];
    if (presetId) {
      parts.push(tokenPlaceholder(presetId));
      continue;
    }
    const assetId = el.dataset["assetId"];
    if (assetId) {
      parts.push(assetMentionTokenOf(assetId));
      continue;
    }
    if (el.tagName === "BR") {
      parts.push("\n");
      continue;
    }
    parts.push(el.textContent ?? "");
  }
  return parts.join("");
}

type ChildEntry = {
  node: ChildNode;
  length: number;
  text: string | undefined;
};

function getChildEntries(editor: HTMLDivElement): ChildEntry[] {
  const entries: ChildEntry[] = [];
  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      entries.push({ node, length: text.length, text });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const presetId = el.dataset["ppId"];
    if (presetId) {
      entries.push({
        node,
        length: tokenPlaceholder(presetId).length,
        text: undefined,
      });
      continue;
    }
    const assetId = el.dataset["assetId"];
    if (assetId) {
      entries.push({
        node,
        length: assetMentionTokenOf(assetId).length,
        text: undefined,
      });
      continue;
    }
    if (el.tagName === "BR") {
      entries.push({ node, length: 1, text: "\n" });
      continue;
    }
    const text = el.textContent ?? "";
    entries.push({ node, length: text.length, text });
  }
  return entries;
}

function getRawIndexFromDomPosition(
  editor: HTMLDivElement,
  container: Node,
  offset: number,
): number {
  const entries = getChildEntries(editor);

  if (container === editor) {
    const clamped = Math.max(0, Math.min(entries.length, offset));
    let acc = 0;
    for (let i = 0; i < clamped; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      acc += entry.length;
    }
    return acc;
  }

  if (container.nodeType === Node.TEXT_NODE) {
    const idx = entries.findIndex((e) => e.node === container);
    if (idx < 0) return 0;
    let acc = 0;
    for (let i = 0; i < idx; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      acc += entry.length;
    }
    const indexedEntry = entries[idx];
    const maxOffset = indexedEntry !== undefined ? indexedEntry.length : 0;
    return acc + Math.max(0, Math.min(maxOffset, offset));
  }

  // 若点到 token 内部（理论上 contentEditable=false 不会发生），回退到其父级位置
  const parent = container.parentNode;
  if (parent && parent !== editor && editor.contains(parent)) {
    return getRawIndexFromDomPosition(editor, parent, offset);
  }

  return 0;
}

export function tryGetSelectionRange(
  editor: HTMLDivElement,
): { start: number; end: number } | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1) return null;
  const range = selection.getRangeAt(0);
  const startInEditor =
    editor.contains(range.startContainer) || range.startContainer === editor;
  const endInEditor =
    editor.contains(range.endContainer) || range.endContainer === editor;
  if (!startInEditor || !endInEditor) return null;
  const start = getRawIndexFromDomPosition(
    editor,
    range.startContainer,
    range.startOffset,
  );
  const end = getRawIndexFromDomPosition(
    editor,
    range.endContainer,
    range.endOffset,
  );
  return start <= end ? { start, end } : { start: end, end: start };
}

export function getSelectionRange(editor: HTMLDivElement): {
  start: number;
  end: number;
} {
  return tryGetSelectionRange(editor) ?? { start: 0, end: 0 };
}

/**
 * 读取当前 Selection 落在编辑器内的原始 Range（用于就地插入节点）。
 * 选区缺失或端点不在编辑器内时返回 null，由调用方决定复位光标等兜底。
 */
export function getSelectionRangeInEditor(editor: HTMLDivElement): Range | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1) return null;
  const range = selection.getRangeAt(0);
  const startInEditor =
    editor.contains(range.startContainer) || range.startContainer === editor;
  const endInEditor =
    editor.contains(range.endContainer) || range.endContainer === editor;
  if (!startInEditor || !endInEditor) return null;
  return range;
}

export function setSelectionRange(
  editor: HTMLDivElement,
  start: number,
  end: number,
) {
  if (typeof window === "undefined") return;
  const selection = window.getSelection();
  if (!selection) return;

  const entries = getChildEntries(editor);
  const total = entries.reduce((sum, e) => sum + e.length, 0);
  const safeStart = Math.max(0, Math.min(total, start));
  const safeEnd = Math.max(0, Math.min(total, end));

  const resolveDomPos = (
    index: number,
  ): { container: Node; offset: number } => {
    let acc = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      const nextAcc = acc + entry.length;
      if (index < nextAcc) {
        if (entry.node.nodeType === Node.TEXT_NODE) {
          return { container: entry.node, offset: index - acc };
        }
        // token / br：放在它前面或后面
        const childIndex = index === acc ? i : i + 1;
        return { container: editor, offset: childIndex };
      }
      acc = nextAcc;
    }
    return { container: editor, offset: entries.length };
  };

  const startPos = resolveDomPos(safeStart);
  const endPos = resolveDomPos(safeEnd);
  const range = document.createRange();
  try {
    range.setStart(startPos.container, startPos.offset);
    range.setEnd(endPos.container, endPos.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // ignore
  }
}

export function findBoundaryToken(
  text: string,
  cursor: number,
  direction: "before" | "after",
): TokenSegment | null {
  const segments = parseSegments(text).filter(
    (seg): seg is TokenSegment => seg.kind === "token",
  );
  if (segments.length === 0) return null;
  if (direction === "before") {
    return segments.find((t) => t.end === cursor) ?? null;
  }
  return segments.find((t) => t.start === cursor) ?? null;
}

export function removeTokenRange(
  value: string,
  token: TokenSegment,
): { next: string; cursor: number } {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end);
  let next = before + after;
  const cursor = token.start;

  // 移除 token 后，如果当前位置出现多余空格（常见于插入时补的空格），做一次轻量去重
  if (
    next[cursor] === " " &&
    (cursor === 0 || /\s/.test(next[cursor - 1] ?? ""))
  ) {
    next = next.slice(0, cursor) + next.slice(cursor + 1);
  }

  return { next, cursor };
}

export function truncateTooltip(content: string, max = 600): string {
  const safe = typeof content === "string" ? content : "";
  if (safe.length <= max) return safe;
  return safe.slice(0, max) + "…";
}

export function hasSuggestionOpen(editor: HTMLDivElement | null): boolean {
  if (!editor) return false;
  const { ppOpen, mentionOpen } = editor.dataset;
  return ppOpen === "true" || mentionOpen === "true";
}

export function syncSuggestionDataset(
  editor: HTMLDivElement | null,
  state: { pp: boolean; mention: boolean },
): void {
  if (!editor) return;
  if (state.pp) {
    editor.dataset["ppOpen"] = "true";
  } else {
    delete editor.dataset["ppOpen"];
  }
  if (state.mention) {
    editor.dataset["mentionOpen"] = "true";
  } else {
    delete editor.dataset["mentionOpen"];
  }
}
