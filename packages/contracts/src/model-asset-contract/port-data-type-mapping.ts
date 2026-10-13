import type { ModelAssetNodeProjectionDataType } from './protocol-constants';

/**
 * component → port data_type 映射表
 *
 * 集中维护 parameter_schema 字段的 component 类型到端口 data_type 的映射。
 * 用于 buildProjectionFromPackage() 从 data_source 自动推导 input_ports 时查表。
 *
 * 新增 component 类型时必须在此表同步添加对应映射。
 */
export const COMPONENT_TO_PORT_DATA_TYPE: Record<
  string,
  ModelAssetNodeProjectionDataType
> = {
  textarea: 'text',
  text: 'text',
  imageUpload: 'image',
  file: 'url',
  select: 'text',
  number: 'text',
  slider: 'text',
  switch: 'text',
  toggle: 'text',
  radio: 'text',
  imageSize: 'text',
};

/**
 * 根据 component 类型推导端口的 data_type。
 * 未识别的 component 默认返回 'text'。
 */
export const derivePortDataTypeFromComponent = (
  component: string,
): ModelAssetNodeProjectionDataType => {
  const mapped = COMPONENT_TO_PORT_DATA_TYPE[component];
  if (mapped !== undefined) {
    return mapped;
  }
  return 'text';
};
