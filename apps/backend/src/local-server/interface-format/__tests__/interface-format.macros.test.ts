import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerationMediaSlotId } from '@iart/contracts';
import {
  assertNoMacroResidue,
  resolveMacroTree,
  type InterfaceFormatMacroScope,
} from '../macros.cts';
import type { InterfaceFormatJsonValue } from '../schema.cts';

/**
 * 合成期宏的机械门禁。
 *
 * 钉五件事：
 * ① `$slot_present` / `$any_slot_present` 按本记录的素材位求值；
 * ② `$if` 有 `else` 时选分支、无 `else` 时结果为 `$OMIT`；
 * ③ `$OMIT` 在对象里删键、在数组里删元素，且从 `then` 分支向上一层传播；
 * ④ 嵌套结构逐层求值（宏可出现在数组元素、对象键值、以及 `then` 分支内部）；
 * ⑤ 未知宏 / 条件非布尔 / 未知素材位 / 根被整体省略一律抛可读错误码，残留检测抓得住漏网宏。
 *
 * 这些语义是「请求规则只有一个来源」的前提：预设用宏表达素材位分支，宏一旦静默失效，
 * 请求体就会带着 `{"$if":...}` 对象发给上游——没有编译器或 schema 能兜住它。
 */

const scopeOf = (...slots: GenerationMediaSlotId[]): InterfaceFormatMacroScope => ({
  acceptedMediaSlots: new Set(slots),
});

void test('$slot_present 按本记录接受的素材位求值', () => {
  const tree: InterfaceFormatJsonValue = {
    first: { $slot_present: 'first_frame' },
    last: { $slot_present: 'last_frame' },
  };
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('first_frame')), { first: true, last: false });
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf()), { first: false, last: false });
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('first_frame', 'last_frame')), {
    first: true,
    last: true,
  });
});

void test('$any_slot_present 只回答「有没有任何素材位被接受」', () => {
  const tree: InterfaceFormatJsonValue = { any: { $any_slot_present: true } };
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf()), { any: false });
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('last_frame')), { any: true });
});

void test('$if 有 else 时选分支，条件可以是布尔字面量', () => {
  const bySlot: InterfaceFormatJsonValue = {
    mode: { $if: { $slot_present: 'reference_image' }, then: 'edits', else: 'generations' },
  };
  assert.deepStrictEqual(resolveMacroTree(bySlot, scopeOf('reference_image')), { mode: 'edits' });
  assert.deepStrictEqual(resolveMacroTree(bySlot, scopeOf()), { mode: 'generations' });

  const literalElse: InterfaceFormatJsonValue = {
    value: { $if: false, then: 'unreachable', else: 'literal' },
  };
  assert.deepStrictEqual(resolveMacroTree(literalElse, scopeOf()), { value: 'literal' });
});

void test('$if 无 else 时结果为 $OMIT：对象删键、数组删元素', () => {
  const tree: InterfaceFormatJsonValue = {
    keep: 1,
    drop: { $if: { $slot_present: 'last_frame' }, then: 'tail' },
  };
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf()), { keep: 1 });
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('last_frame')), { keep: 1, drop: 'tail' });

  const list: InterfaceFormatJsonValue = [
    'head',
    { $if: { $slot_present: 'last_frame' }, then: 'tail' },
    'foot',
  ];
  assert.deepStrictEqual(resolveMacroTree(list, scopeOf()), ['head', 'foot']);
  assert.deepStrictEqual(resolveMacroTree(list, scopeOf('last_frame')), ['head', 'tail', 'foot']);
});

void test('$OMIT 从 then 分支向上一层传播（条件嵌套）', () => {
  // 外层成立、内层不成立：整个键消失，而不是留下一个空对象或 null。
  const tree: InterfaceFormatJsonValue = {
    level: {
      $if: { $slot_present: 'first_frame' },
      then: { $if: { $slot_present: 'last_frame' }, then: { type: 'last_frame' } },
    },
  };
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('first_frame')), {});
  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('first_frame', 'last_frame')), {
    level: { type: 'last_frame' },
  });
});

void test('嵌套：宏可出现在数组元素内部、then 分支内部与多层对象里', () => {
  const tree: InterfaceFormatJsonValue = {
    args: [
      { kind: 'literal', value: 'prompt' },
      {
        $if: { $slot_present: 'first_frame' },
        then: {
          kind: 'compute',
          entries: {
            type: { $if: { $slot_present: 'first_frame' }, then: 'first_frame', else: 'unknown' },
          },
        },
      },
      {
        $if: { $any_slot_present: true },
        then: [
          { $if: { $slot_present: 'last_frame' }, then: 'last_frame' },
        ],
      },
    ],
  };

  assert.deepStrictEqual(resolveMacroTree(tree, scopeOf('first_frame')), {
    args: [
      { kind: 'literal', value: 'prompt' },
      { kind: 'compute', entries: { type: 'first_frame' } },
      [],
    ],
  });
});

void test('解析产物不含任何宏键（残留检测通过）', () => {
  const tree: InterfaceFormatJsonValue = {
    a: { $if: { $slot_present: 'first_frame' }, then: { $any_slot_present: true } },
    b: [{ $slot_present: 'last_frame' }],
  };
  const resolved = resolveMacroTree(tree, scopeOf('first_frame'));
  assertNoMacroResidue(resolved);
  assert.equal(JSON.stringify(resolved).includes('$'), false);
});

void test('残留检测对对象键与数组元素里的宏键都抛错', () => {
  assert.throws(
    () => assertNoMacroResidue({ a: { $if: true, then: 1 } }),
    /interface_format_macro_residue/,
  );
  assert.throws(
    () => assertNoMacroResidue([{ b: { $slot_present: 'first_frame' } }]),
    /interface_format_macro_residue/,
  );
  assert.throws(
    () => assertNoMacroResidue({ a: { $any_slot_present: true } }),
    /interface_format_macro_residue/,
  );
  assert.throws(() => assertNoMacroResidue({ $OMIT: true }), /interface_format_macro_residue/);
  assert.doesNotThrow(() => assertNoMacroResidue({ a: 1, b: ['x'] }));
});

void test('未知宏与形状错误抛可读错误码', () => {
  assert.throws(
    () => resolveMacroTree({ $unknown: true }, scopeOf()),
    /interface_format_macro_unknown/,
  );
  assert.throws(
    () => resolveMacroTree({ $slot_present: 'first_frame', extra: 1 }, scopeOf()),
    /interface_format_macro_shape_invalid/,
  );
  assert.throws(
    () => resolveMacroTree({ $if: 'yes', then: 1 }, scopeOf()),
    /interface_format_macro_condition_invalid/,
  );
  assert.throws(
    () => resolveMacroTree({ $if: true }, scopeOf()),
    /interface_format_macro_if_shape_invalid/,
  );
  assert.throws(
    () => resolveMacroTree({ $if: true, then: 1, otherwise: 2 }, scopeOf()),
    /interface_format_macro_if_shape_invalid/,
  );
  assert.throws(
    () => resolveMacroTree({ $if: { $any_slot_present: false }, then: 1 }, scopeOf()),
    /interface_format_macro_any_slot_present_invalid/,
  );
  // 素材位 id 拼错必须当场报错：静默 false 会让整段规则悄悄消失。
  assert.throws(
    () => resolveMacroTree({ $slot_present: 'not_a_media_slot' }, scopeOf()),
    /interface_format_macro_slot_unknown/,
  );
});

void test('根节点被整体省略视为预设错误', () => {
  assert.throws(
    () => resolveMacroTree({ $if: false, then: { a: 1 } }, scopeOf()),
    /interface_format_macro_omitted_root/,
  );
});
