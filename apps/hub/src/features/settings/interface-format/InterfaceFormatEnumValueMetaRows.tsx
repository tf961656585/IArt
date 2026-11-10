import { Switch } from '@iart/ui';
import { InfoHint } from '../provider-connection/InfoHint';
import { enumMetaOf, upsertEnumMeta, type EnumValueMetaRow } from './interfaceFormatDraft';

/**
 * 每个可选值的「默认关闭」声明（`docs/model-assets/17-模型能力包定义与协作语义.md`
 * 的取值默认关闭段）。
 *
 * 为什么要有：同一协议族里，较新的能力往往只有部分模型或部分账号支持（例如 `gif` 只在
 * `gpt-image` 2.6 且账号具备 GIF 预览权限时可用）。取值随格式提供，但默认不出现在模型目录、
 * 创作面与执行表单；添加模型的人按自己实际接的服务勾一下即启用。
 *
 * 勾的是「这个取值默认关闭」，不是「禁用」：模型记录显式启用后照常可用。
 */
export function InterfaceFormatEnumValueMetaRows({
  rowIndex,
  values,
  meta,
  onChange,
}: {
  /** 参数行号（只用于生成稳定 id 与无障碍标签）。 */
  rowIndex: number;
  values: string[];
  meta: EnumValueMetaRow[];
  onChange: (rows: EnumValueMetaRow[]) => void;
}) {
  const filled = values.map((value) => value.trim()).filter((value) => value.length > 0);

  return (
    <div className="mt-2 flex flex-col gap-1">
      <span className="flex items-center gap-1 text-2xs text-muted-foreground">
        默认关闭
        <InfoHint
          subject="默认关闭"
          text="勾上的取值随格式提供，但不会默认出现在模型里；添加或修改模型时点一下就能启用。适用于只有部分模型或部分账号才支持的取值。"
        />
      </span>
      {filled.map((value, valueIndex) => {
        const current = enumMetaOf(meta, value);
        const optInId = `interface-format-param-${rowIndex}-opt-in-${valueIndex}`;
        return (
          <div key={value} className="flex items-center gap-2">
            <span className="min-w-24 max-w-48 truncate text-2xs">{value}</span>
            <Switch
              id={optInId}
              aria-label={`可选值「${value}」默认关闭`}
              checked={current.optIn}
              onCheckedChange={(checked) => onChange(upsertEnumMeta(meta, { ...current, optIn: checked }))}
            />
          </div>
        );
      })}
    </div>
  );
}
