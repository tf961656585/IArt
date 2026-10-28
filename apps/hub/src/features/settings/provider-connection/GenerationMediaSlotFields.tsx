import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '@iart/ui';
import type {
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
} from '@iart/contracts';
import { InfoHint } from './InfoHint';

/**
 * 素材位逐项勾选（2026-10-19 拍板：用户在添加模型时勾选该模型接受哪些素材）。
 *
 * 能力事实来自**该接口格式的族模板**（`GET /api/generation-family-templates/:id` 的
 * `supports_media_slots`），Hub 不另维护一份清单：换族即换可勾的位，用户不会看到该族
 * 表达不了的入口（「能选但一提交就失败」的根因就在这类更宽的能力面）。
 *
 * 三个界面状态各有专属呈现，不用同一个空态糊过去：
 * - 读到了且 0 位（可灵文生视频）：**不渲染素材区块**——空框会让用户以为漏了什么；
 * - 正在读：一行「正在读取…」，不渲染半截勾选框；
 * - 读不到：一行原因 + 阻断提交（调用方按 `blocked` 判定），否则会落一条素材位未知的记录。
 */

/** 素材位 → 用户可见名（业务语言，不写协议术语）。新增素材位时这里必须同步补齐。 */
export const GENERATION_MEDIA_SLOT_LABELS: Record<GenerationMediaSlotId, string> = {
  reference_image: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_video: '参考视频',
  reference_audio: '参考音频',
  feature_video: '特征视频',
  base_video: '基础视频',
};

/**
 * 该接口格式下必勾的素材位。
 *
 * 必选事实来自契约随描述符下发的 `required_media_slots`（族能力事实的唯一来源是 Runtime
 * Backend 的族注册表）——**不在这里另列一份**：消费侧另存一份会在改族时漏改，产出「能建但
 * 一提交就失败」的模型。这里只做一次防御性收窄：必选位必须同时在该族可表达的位里，否则忽略
 * （族数据异常时宁可少强制一项，也不要强制一个界面渲染不出来的位）。
 */
export const requiredMediaSlotsFor = (
  requiredSlots: readonly GenerationMediaSlotId[],
  supportedSlots: readonly GenerationMediaSlotId[],
): GenerationMediaSlotId[] => requiredSlots.filter((slot) => supportedSlots.includes(slot));

type MediaSlotLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      supportedSlots: GenerationMediaSlotId[];
      /**
       * 素材位 → 该族模板里的参数字段键。
       *
       * 提交时据此裁掉「已取消勾选那位」留下的参数覆盖：覆盖条目按模板字段键存，只有模板
       * 知道哪个键属于哪个位。字段键是模板事实，用户改名只改发送名，不影响这份映射。
       */
      fieldKeyBySlotId: Partial<Record<GenerationMediaSlotId, string>>;
    }
  | { kind: 'failed' };

export type GenerationMediaSlotsState = {
  /** 按该族能力渲染的勾选项（已交过：不含该族表达不了的位） */
  load: MediaSlotLoad;
  /** 已勾的素材位（可能含上一族残留，渲染与提交都必须先与 `supportedSlots` 求交） */
  selected: GenerationMediaSlotId[];
  /** 必勾位（渲染为已勾且不可取消） */
  requiredSlots: GenerationMediaSlotId[];
  toggle: (slot: GenerationMediaSlotId, next: boolean) => void;
  /** 换接口格式时清空过勾选的可读反馈；没清过为 null */
  resetNotice: string | null;
  /** 素材位还没定下来（读取中/读取失败）：提交必须等到能确定清单 */
  blocked: boolean;
};

/**
 * 素材位状态（添加与修改两个入口共用）。
 *
 * `loadDescriptor` 每次渲染都可能是新引用（调用方是内联箭头函数），因此用 ref 取最新值、
 * effect 只随接口格式变化触发——否则每次父组件重渲染都会重新发一次请求。
 */
export function useGenerationMediaSlots({
  familyAdapterId,
  familyDisplayName,
  loadDescriptor,
  initialSelected = [],
}: {
  /** 当前接口格式；null = 还没选（创建表单空态起步） */
  familyAdapterId: string | null;
  /** 接口格式的中文名（清空反馈里点名「换成了哪个」） */
  familyDisplayName: string | null;
  loadDescriptor: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  /** 修改已添加模型时的回填值（创建表单不传） */
  initialSelected?: readonly GenerationMediaSlotId[];
}): GenerationMediaSlotsState {
  const [load, setLoad] = useState<MediaSlotLoad>({ kind: 'idle' });
  const [selected, setSelected] = useState<GenerationMediaSlotId[]>([...initialSelected]);
  const [requiredSlots, setRequiredSlots] = useState<GenerationMediaSlotId[]>([]);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const loadDescriptorRef = useRef(loadDescriptor);
  loadDescriptorRef.current = loadDescriptor;
  const displayNameRef = useRef(familyDisplayName);
  displayNameRef.current = familyDisplayName;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const previousFamilyRef = useRef<string | null>(null);

  useEffect(() => {
    // 换接口格式：旧勾选对新族可能不成立（新族表达不了那一位），一律清空——但要留可见反馈，
    // 静默清空会让用户以为勾选没生效。同一个接口格式重新选中不算换族。
    const previousFamily = previousFamilyRef.current;
    previousFamilyRef.current = familyAdapterId;
    if (previousFamily !== null && familyAdapterId !== null && previousFamily !== familyAdapterId) {
      const cleared = selectedRef.current.length > 0;
      setSelected([]);
      setResetNotice(
        cleared ? `已换成「${displayNameRef.current ?? familyAdapterId}」，之前勾的素材都清掉了。` : null,
      );
    } else if (familyAdapterId === null) {
      setSelected([]);
      setResetNotice(null);
    }

    if (familyAdapterId === null) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    loadDescriptorRef
      .current(familyAdapterId)
      .then((descriptor) => {
        if (cancelled) return;
        const supportedSlots = descriptor.supports_media_slots;
        const required = requiredMediaSlotsFor(descriptor.required_media_slots, supportedSlots);
        const fieldKeyBySlotId: Partial<Record<GenerationMediaSlotId, string>> = {};
        for (const field of descriptor.official_fields) {
          if (field.media_slot_id !== undefined) fieldKeyBySlotId[field.media_slot_id] = field.field_key;
        }
        setLoad({ kind: 'ready', supportedSlots, fieldKeyBySlotId });
        setRequiredSlots(required);
        // 首次进族或换族：必勾位自动勾上（用户不需要理解「为什么这一位必须接受」）
        setSelected((current) => {
          const kept = current.filter((slot) => supportedSlots.includes(slot));
          const merged = [...required.filter((slot) => !kept.includes(slot)), ...kept];
          // 回填值只对「当前记录的族」有意义：换族后旧回填不得混进新族
          return [...new Set(merged)];
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.debug('[generation-media-slots] 读不到族模板的素材位能力', error);
        setLoad({ kind: 'failed' });
        setRequiredSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [familyAdapterId]);

  const toggle = (slot: GenerationMediaSlotId, next: boolean): void => {
    // 必勾位不能取消：它决定这个模型能否成功生成，取消后只会造出一个永远失败的模型
    if (requiredSlots.includes(slot)) return;
    setSelected((current) => {
      if (!next) return current.filter((item) => item !== slot);
      return current.includes(slot) ? current : [...current, slot];
    });
  };

  return {
    load,
    selected,
    requiredSlots,
    toggle,
    resetNotice,
    blocked: load.kind !== 'ready',
  };
}

/**
 * 提交用的素材位清单：只留该族支持的位，并补齐必勾位。
 *
 * 取交集是因为「换族那一帧」与「能力读取失败」都可能让 `selected` 里留有该族表达不了的位；
 * 顺序按族能力的呈现顺序（数组顺序不承载语义，稳定顺序只为回读时好比对）。
 */
export const effectiveMediaSlots = (state: GenerationMediaSlotsState): GenerationMediaSlotId[] => {
  if (state.load.kind !== 'ready') return [];
  const supported = state.load.supportedSlots;
  const chosen = new Set(state.selected.filter((slot) => supported.includes(slot)));
  for (const slot of state.requiredSlots) chosen.add(slot);
  return supported.filter((slot) => chosen.has(slot));
};

/**
 * 勾选区（纯展示）：只渲染该族支持的位，0 位时整块不渲染。
 *
 * `selected` 与能力求交后再渲染，避免换族那一帧显示上一族的残留勾选。
 */
export function GenerationMediaSlotChecklist({
  state,
  label = '这个模型接受的素材',
}: {
  state: GenerationMediaSlotsState;
  label?: string;
}) {
  if (state.load.kind === 'loading') {
    return <p className="text-xs text-muted-foreground">正在读取这个接口格式能用的素材…</p>;
  }
  if (state.load.kind === 'failed') {
    return (
      <p className="text-xs text-muted-foreground">
        暂时读不到这个接口格式能用的素材。关掉这个窗口后点「刷新」再试。
      </p>
    );
  }
  if (state.load.kind !== 'ready') return null;
  const supportedSlots = state.load.supportedSlots;
  // 0 位的族（可灵文生视频）不渲染素材区块：空框会被读成「这里漏了什么」。
  // 但换族清空勾选这件事仍要说给用户听——那句反馈不能跟着区块一起消失。
  if (supportedSlots.length === 0) {
    return state.resetNotice === null ? null : (
      <p className="text-2xs text-muted-foreground">{state.resetNotice}</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {supportedSlots.map((slot) => {
          const required = state.requiredSlots.includes(slot);
          const checked = required || state.selected.includes(slot);
          return (
            <label
              key={slot}
              htmlFor={`generation-media-slot-${slot}`}
              className="flex cursor-pointer items-center gap-2 text-xs"
            >
              <Checkbox
                id={`generation-media-slot-${slot}`}
                checked={checked}
                disabled={required}
                onCheckedChange={(next) => state.toggle(slot, next === true)}
                aria-label={GENERATION_MEDIA_SLOT_LABELS[slot]}
              />
              <span>{GENERATION_MEDIA_SLOT_LABELS[slot]}</span>
              {required ? (
                <InfoHint
                  text="这个接口格式每次生成都要用首帧，所以不能取消。"
                  subject={`${GENERATION_MEDIA_SLOT_LABELS[slot]}必勾`}
                />
              ) : null}
            </label>
          );
        })}
      </div>
      {state.resetNotice === null ? null : (
        <p className="text-2xs text-muted-foreground">{state.resetNotice}</p>
      )}
    </div>
  );
}
