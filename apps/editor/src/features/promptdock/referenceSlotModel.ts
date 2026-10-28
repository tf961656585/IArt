import type { ExecutableCatalogMediaSlot } from '@iart/contracts';

import type { PromptDockReference } from './PromptDock.types';

/**
 * 本模块需要的模型目录信息（结构子集）。
 *
 * 只声明 `media_slots` 一个字段：用途域的全部判据只依赖素材位清单，不读模型的其他属性。
 * 用结构子集而不是绑死 `PromptDockCatalogEntry`，让本模块在测试里能用窄替身、也让
 * 「它到底依赖什么」写在签名上。
 */
export type SlotCatalogEntry = {
  /**
   * `| undefined` 是必需的：`exactOptionalPropertyTypes` 下 `?: X` 只表示「键可缺席」，
   * 不接受「键存在且值为 undefined」；而目录契约里该字段正是 `X | undefined`。
   */
  media_slots?: readonly ExecutableCatalogMediaSlot[] | undefined;
};

/**
 * PromptDock 参考区「用途」域模型（纯逻辑，无 React / 无 i18n）。
 *
 * 设计依据：`docs/editor/PromptDock参考区用途标注-design.md`。
 *
 * 单一事实源纪律：候选用途只来自模型目录下发的 `media_slots`，本文件不保存任何
 * 「哪族支持哪些位」的表；本文件只做「给定模型 + 给定媒体类型 → 候选用途」与
 * 「给定草稿 → 阻断结论」的推导。
 */

/** 某媒体类型在当前模型上的候选用途（按目录下发顺序）。 */
export const candidateSlots = (
  entry: SlotCatalogEntry | null | undefined,
  mediaType: 'image' | 'video' | 'audio',
): ExecutableCatalogMediaSlot[] =>
  (entry?.media_slots ?? []).filter((slot) => slot.mediaKind === mediaType);

/**
 * 当前模型是否接受某媒体类型作为参考（参考准入的模型能力判定）。
 *
 * 判据只有模型目录下发的素材位清单，与素材来源无关（导入 / 生成 / 加工 / 会话存量一视同仁）：
 * - `supported`：该媒体类型有素材位，可作参考（余量另由 `resolveAddPlacement` 判定）；
 * - `unsupported`：模型声明了素材位，但没有该媒体类型的位——参考区放不下它；
 * - `no-slot-model`：模型没有任何素材位（纯文生图 / 文生视频等）。这是「没有用途模型」的
 *   兼容口径：沿用既有行为允许加入，引用落未指定，用途域不参与。
 */
export type MediaSupport = 'supported' | 'unsupported' | 'no-slot-model';

export const resolveMediaSupport = (
  entry: SlotCatalogEntry | null | undefined,
  mediaType: 'image' | 'video' | 'audio',
): MediaSupport => {
  const slots = entry?.media_slots ?? [];
  if (slots.length === 0) return 'no-slot-model';
  return slots.some((slot) => slot.mediaKind === mediaType) ? 'supported' : 'unsupported';
};

/**
 * 引用的用途取值（归一）：`undefined` 与 `null` 同义，都是「未指定」。
 *
 * 条目类型上 `slotId` 是可选，读取侧一律经此归一，避免 `undefined !== null` 这类判错。
 */
export const slotIdOf = (reference: PromptDockReference): string | null => reference.slotId ?? null;

/** 该用途位是否可放多张（多张位即「普通参考」这类用途）。 */
export const slotIsMulti = (slot: ExecutableCatalogMediaSlot): boolean => slot.maxFiles > 1;

/** 该用途位当前被多少条引用绑定（用途容量判据的唯一计数口径）。 */
export const slotBindingCount = (
  references: readonly PromptDockReference[],
  slot: ExecutableCatalogMediaSlot,
): number => references.filter((ref) => slotIdOf(ref) === slot.slotId).length;

/** 该用途位是否还有余量（`maxFiles` 是上限，不是「是否多张」的布尔）。 */
export const slotHasRoom = (
  slot: ExecutableCatalogMediaSlot,
  references: readonly PromptDockReference[],
): boolean => slotBindingCount(references, slot) < slot.maxFiles;

/**
 * 加入参考时的默认落位（设计 §4.3，一次判定、不做二次推断）：
 * - 只有一个候选 → 直接绑该用途；
 * - 有多个候选且存在多张位 → 绑该多张位；
 * - 有多个候选且全是单张位 → 未指定（**刻意不按 schema 第一位自动占用**：
 *   把「用户没表达」当成「用户先要首帧」，推错就产出语义错且不报错的结果）。
 */
export const defaultSlotId = (
  entry: SlotCatalogEntry | null | undefined,
  mediaType: 'image' | 'video' | 'audio',
): string | null => {
  const candidates = candidateSlots(entry, mediaType);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]?.slotId ?? null;
  const multi = candidates.find((slot) => slotIsMulti(slot));
  return multi?.slotId ?? null;
};

/**
 * 「加入参考」的落位结论（设计 §4.3，含容量判据）。
 *
 * - `slot`：默认用途还有余量，直接绑它；
 * - `unspecified`：没有可自动承接的用途（全单张位，或默认多张位已满但同媒体类型还有别的
 *   候选位有余量）——留给用户在徽章上显式指定；
 * - `full`：该媒体类型的候选位全部放满，本次不得加入（不静默丢弃，也不制造交不出去的草稿）。
 */
export type AddPlacement =
  | { kind: 'slot'; slotId: string }
  | { kind: 'unspecified' }
  | { kind: 'full'; mediaType: 'image' | 'video' | 'audio'; capacity: number };

/**
 * 给一条新引用决定落位（设计 §4.3）。
 *
 * 与 `defaultSlotId` 的区别：默认落位只回答「默认是哪一位」，不知道现有引用；本函数带
 * `references`，因此是**唯一**能把用途张数落成行为的地方——加入路径必须走它，否则
 * 「最多 N 张」只会退化成「是不是多张」的布尔。
 *
 * 余量按每个位单独计算；该媒体类型全部候选位都没有余量时才拒绝加入。默认多张位放满但
 * 别的候选位还有余量时落未指定，保住「先加进来、再点徽章标用途」的流程。
 */
export const resolveAddPlacement = (
  entry: SlotCatalogEntry | null | undefined,
  mediaType: 'image' | 'video' | 'audio',
  references: readonly PromptDockReference[],
): AddPlacement => {
  const candidates = candidateSlots(entry, mediaType);
  // 没有用途模型的媒体类型沿用既有行为：加入后落未指定，用途域不参与。
  if (candidates.length === 0) return { kind: 'unspecified' };
  const remaining = candidates.reduce(
    (sum, slot) => sum + Math.max(0, slot.maxFiles - slotBindingCount(references, slot)),
    0,
  );
  if (remaining === 0) {
    const capacity = candidates.reduce((sum, slot) => sum + slot.maxFiles, 0);
    return { kind: 'full', mediaType, capacity };
  }
  // 唯一候选且还有余量 → 唯一去处，直接绑（§4.3 第 1 档）。
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined && slotHasRoom(only, references)) {
    return { kind: 'slot', slotId: only.slotId };
  }
  // 多候选：绑还有余量的多张位；多张位放满则落未指定，不硬塞进已满的位。
  const multi = candidates.find((slot) => slotIsMulti(slot) && slotHasRoom(slot, references));
  if (multi !== undefined) return { kind: 'slot', slotId: multi.slotId };
  return { kind: 'unspecified' };
};

/**
 * 存量引用的兜底用途（设计 §8）：**仅在模型声明了可放多张的该媒体类型参考位时**视为
 * 「普通参考」，否则一律「未指定」（进入阻断并要求显式指定）。
 *
 * 与 `defaultSlotId`（§4.3「加入参考」的默认落位）只差一档：唯一候选且该位只能放一张时，
 * §4.3 直接绑它（用户主动加入的图只有一种去处），§8 不绑——调用方没表达，不能替它认定
 * 那唯一一个单张位就是首帧。这一档不能靠复用 `defaultSlotId` 表达：否则单张位模型上的
 * 存量/脚本引用会被凭空造出用途，且多张引用会一起挤进同一个单张位。
 */
export const legacySlotId = (
  entry: SlotCatalogEntry | null | undefined,
  mediaType: 'image' | 'video' | 'audio',
): string | null =>
  candidateSlots(entry, mediaType).find((slot) => slotIsMulti(slot))?.slotId ?? null;

/** 某用途位当前被哪张图占用（单张位同一时刻只允许一张；多张位不占用）。 */
export const slotOccupant = (
  references: readonly PromptDockReference[],
  slot: ExecutableCatalogMediaSlot,
): PromptDockReference | null => {
  if (slotIsMulti(slot)) return null;
  return references.find((ref) => slotIdOf(ref) === slot.slotId) ?? null;
};

/** 把某条引用的用途改为 `slotId`；若目标单张位已被另一张占用，原占用者退回「未指定」。 */
export const reassignSlot = (
  references: readonly PromptDockReference[],
  refId: string,
  slotId: string | null,
  entry: SlotCatalogEntry | null | undefined,
): PromptDockReference[] => {
  const target = references.find((ref) => ref.refId === refId);
  if (target === undefined) return [...references];
  const candidates = candidateSlots(entry, target.mediaType);
  const slot = candidates.find((candidate) => candidate.slotId === slotId);
  return references.map((ref) => {
    if (ref.refId === refId) return { ...ref, slotId };
    // 换绑：目标为单张位且已被别人占用时，原占用者退回未指定（不删图、不出现「选不了」死角）。
    if (slot !== undefined && !slotIsMulti(slot) && slotIdOf(ref) === slotId) {
      return { ...ref, slotId: null };
    }
    return ref;
  });
};

/** 模型切换后的用途重判（设计 §4.5）。 */
export const rejudgeReferencesForModel = (
  references: readonly PromptDockReference[],
  entry: SlotCatalogEntry | null | undefined,
): PromptDockReference[] =>
  references.map((ref) => {
    const candidates = candidateSlots(entry, ref.mediaType);
    const currentSlotId = slotIdOf(ref);
    if (currentSlotId !== null && candidates.some((slot) => slot.slotId === currentSlotId)) {
      // 新模型仍有同名素材位 → 原样保留。
      return ref;
    }
    const next = defaultSlotId(entry, ref.mediaType);
    // 重判出的单张位若已被其它引用占用，保持未指定（不抢位、不静默删图）。
    if (next !== null) {
      const nextSlot = candidates.find((slot) => slot.slotId === next);
      if (nextSlot !== undefined && !slotIsMulti(nextSlot)) {
        const taken = references.some((other) => other.refId !== ref.refId && slotIdOf(other) === next);
        if (taken) return { ...ref, slotId: null };
      }
    }
    return { ...ref, slotId: next };
  });

/** 用途阻断的三类原因（供前置校验与界面呈现共用同一判据）。 */
export type SlotProblem =
  | {
      kind: 'required-slot-empty';
      fieldKey: string;
      slotId: string;
      label: string;
      mediaType: 'image' | 'video' | 'audio';
    }
  | {
      kind: 'unspecified-reference';
      refId: string;
      label: string;
      mediaType: 'image' | 'video' | 'audio';
    }
  /** 引用标的用途在**当前模型**上不存在（模型切换后残留、或调用方给错用途标识）。 */
  | {
      kind: 'slot-not-in-model';
      refId: string;
      label: string;
      slotId: string;
      mediaType: 'image' | 'video' | 'audio';
    }
  /** 绑定到某用途的条数超过该位声明的张数（模型切换 / 张数改小 / 复用 / 脚本提交）。 */
  | {
      kind: 'slot-over-capacity';
      slotId: string;
      fieldKey: string;
      label: string;
      mediaType: 'image' | 'video' | 'audio';
      count: number;
      maxFiles: number;
    };

/**
 * 参考区用途层面的问题（设计 §6）。
 *
 * 只读草稿的参考条目与模型目录条目，不读参数值、不读后端组装结果——
 * 「`[]` 能过校验」那条旧判据因此被就地关掉，而不是在组装期兜。
 *
 * 用途在当前模型上不存在的引用既不占用任何位、也不该再被算成「未指定」，
 * 否则用户会同时看到两条指向同一张图的提示；超量问题按用途位报一次，与「未指定」独立
 * （超量位上的图都已指定用途，不构成「未指定」）。
 */
export const collectSlotProblems = (
  references: readonly PromptDockReference[],
  entry: SlotCatalogEntry | null | undefined,
): SlotProblem[] => {
  const problems: SlotProblem[] = [];
  if (entry === null || entry === undefined) return problems;
  const slots = entry.media_slots ?? [];
  if (slots.length === 0) return problems;

  // 用途不在当前模型上：先单独点名。该引用不参与下面两条判据（不占位、不重复报未指定）。
  for (const ref of references) {
    const currentSlotId = slotIdOf(ref);
    if (currentSlotId === null) continue;
    const candidates = candidateSlots(entry, ref.mediaType);
    // 该媒体类型在本模型没有任何候选位 → 由既有「不兼容参考」承载，此处不重复报。
    if (candidates.length === 0) continue;
    if (candidates.some((slot) => slot.slotId === currentSlotId)) continue;
    problems.push({
      kind: 'slot-not-in-model',
      refId: ref.refId,
      label: ref.label,
      slotId: currentSlotId,
      mediaType: ref.mediaType,
    });
  }

  // 必填素材位必须有某张已标用途的引用占用。
  for (const slot of slots) {
    if (!slot.required) continue;
    const occupied = references.some((ref) => slotIdOf(ref) === slot.slotId);
    if (!occupied) {
      problems.push({
        kind: 'required-slot-empty',
        fieldKey: slot.fieldKey,
        slotId: slot.slotId,
        label: slot.label.length > 0 ? slot.label : slot.fieldKey,
        mediaType: slot.mediaKind,
      });
    }
  }

  // 用途位超量：加入路径已按余量落位，这里兜住不经过加入动作的超额来源——模型切换、
  // Hub 把张数改小、任务复用回填、脚本提交。不静默裁剪：图片是用户的资产，丢哪张都可能丢错。
  for (const slot of slots) {
    const count = slotBindingCount(references, slot);
    if (count <= slot.maxFiles) continue;
    problems.push({
      kind: 'slot-over-capacity',
      slotId: slot.slotId,
      fieldKey: slot.fieldKey,
      label: slot.label.length > 0 ? slot.label : slot.fieldKey,
      mediaType: slot.mediaKind,
      count,
      maxFiles: slot.maxFiles,
    });
  }

  // 存在未指定用途的引用（仅当该引用有可选用途时才要求指定）。
  for (const ref of references) {
    if (slotIdOf(ref) !== null) continue;
    if (candidateSlots(entry, ref.mediaType).length === 0) continue;
    problems.push({
      kind: 'unspecified-reference',
      refId: ref.refId,
      label: ref.label,
      mediaType: ref.mediaType,
    });
  }
  return problems;
};
