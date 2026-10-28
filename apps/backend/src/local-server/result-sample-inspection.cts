import {
  RECIPE_PATH_DISCOVERY_MAX_PATHS,
  type InterfaceRecipePathDiscoveryResponse,
} from '@iart/contracts';
import { isPlainObject } from './utils.cts';

/**
 * 响应样本检查的唯一共享实现（路径发现）。
 *
 * 历史：这段展开逻辑最初内联在 `routes/interface-recipe-routes.cts` 里，只服务配方页的
 * 「样本路径发现」。2026-10-26 起 Hub「接口格式」页也提供同一能力（旅程设计 §4），两条路由
 * 必须给出**逐条相同**的路径与取值——复制第二份实现会在改路径语法（如数组下标形态）时让两个
 * 页面各说一套，因此抽到这里，两边都引用本模块。
 *
 * 边界：
 * - 纯函数，无 IO、无网络、不读不写任何存储；
 * - 只做「把样本展开成路径 + 取值」，不做任何自动判定（选哪条路径、什么值算完成仍由用户确认）；
 * - 路径上限的值域 owner 是 contracts 的 `RECIPE_PATH_DISCOVERY_MAX_PATHS`，本模块只转出一个
 *   语义别名，不复制字面量。
 */

/**
 * 路径发现最多返回的条目数（契约声明的值的别名；单一事实源仍是 contracts）。
 *
 * 上限存在的意义：用户可能粘贴几十 MB 的响应，无上限展开会卡住主线程并把响应体撑爆。
 */
export const SAMPLE_PATH_DISCOVERY_MAX_PATHS = RECIPE_PATH_DISCOVERY_MAX_PATHS;

/** 路径条目的取值类型（与响应契约同源，不另立枚举）。 */
type SamplePathKind = InterfaceRecipePathDiscoveryResponse['paths'][number]['value_kind'];

/** 单条路径发现结果。 */
type SamplePathEntry = InterfaceRecipePathDiscoveryResponse['paths'][number];

/**
 * 把用户粘贴的样本解析成 JSON 值。
 *
 * 用户可能贴 JSON 文本而不是 JSON 值：字符串先尝试 `JSON.parse`，失败按原字符串处理
 * （「响应体就是一段纯文本」仍是合法样本）。
 */
const parseSampleValue = (sample: unknown): unknown => {
  if (typeof sample !== 'string') return sample;
  try {
    return JSON.parse(sample);
  } catch {
    return sample;
  }
};

const valueKindOf = (value: unknown): SamplePathKind | null => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
};

const joinSamplePath = (base: string, segment: string): string => (base ? `${base}.${segment}` : segment);

/**
 * 展开样本里的全部字段路径与取值（DFS，含容器节点；上限 `SAMPLE_PATH_DISCOVERY_MAX_PATHS`）。
 *
 * 路径语法与运行时求值器一致（点号分隔、数组用数字下标），界面点选后可直接填入判定/产物路径。
 */
const collectSamplePaths = (value: unknown, basePath: string, bucket: SamplePathEntry[]): void => {
  if (bucket.length >= SAMPLE_PATH_DISCOVERY_MAX_PATHS) return;

  if (Array.isArray(value)) {
    if (basePath) bucket.push({ path: basePath, value, value_kind: 'array' });
    for (let index = 0; index < value.length; index += 1) {
      if (bucket.length >= SAMPLE_PATH_DISCOVERY_MAX_PATHS) return;
      collectSamplePaths(value[index], joinSamplePath(basePath, String(index)), bucket);
    }
    return;
  }
  if (isPlainObject(value)) {
    if (basePath) bucket.push({ path: basePath, value, value_kind: 'object' });
    for (const [key, child] of Object.entries(value)) {
      if (bucket.length >= SAMPLE_PATH_DISCOVERY_MAX_PATHS) return;
      collectSamplePaths(child, joinSamplePath(basePath, key), bucket);
    }
    return;
  }
  const kind = valueKindOf(value);
  // 标量：根标量没有字段路径，不产出条目（用户贴的是一整段 JSON 时的正常情况）。
  if (kind === null || !basePath) return;
  bucket.push({ path: basePath, value, value_kind: kind });
};

/**
 * 把响应头展开成路径条目（追加在响应体条目之后）。
 *
 * 路径取归一化后的头名（`Headers` 已小写）：运行时求值器在响应体未命中时按同名字符串回落
 * 响应头，因此这里产出的是「用户点选后能直接填进判定/产物路径」的同一个名字。
 *
 * 与响应体同名的头不产出条目：求值器优先读响应体，列出一个永远读不到的头值会误导用户。
 * 命中上限后不再追加（与响应体共用一个上限）。
 */
const collectSampleHeaderPaths = (
  headers: Headers,
  bucket: SamplePathEntry[],
  bodyPaths: readonly string[],
): void => {
  const bodyPathSet = new Set(bodyPaths);
  for (const [name, value] of headers.entries()) {
    if (bucket.length >= SAMPLE_PATH_DISCOVERY_MAX_PATHS) return;
    if (bodyPathSet.has(name)) continue;
    bucket.push({ path: name, value, value_kind: 'string' });
  }
};

export {
  parseSampleValue,
  valueKindOf,
  joinSamplePath,
  collectSamplePaths,
  collectSampleHeaderPaths,
  type SamplePathEntry,
  type SamplePathKind,
};
