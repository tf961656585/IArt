/**
 * 草稿校验失败的可读提示（Hub 只拿到后端返回的一句话，映射必须在这里完成）。
 *
 * 按错误码优先、再按出错字段兜底：同一个错误码在不同字段上含义相同，先给最具体的那条。
 * 文案面向「正在配置接口格式的用户」：说清改哪里、为什么，不用内部词（规则树、binding、
 * payload_format 一律不出现）。
 */
export const describeDraftBodyError = (
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string => {
  if (issues.some((issue) => issue.message === 'interface_format_submit_path_not_relative')) {
    return '请求路径必须是相对路径：以 / 开头，不能带域名，也不能包含 .. 段';
  }
  if (issues.some((issue) => issue.message === 'interface_format_polling_path_not_relative')) {
    return '查询进度的地址必须是相对路径：以 / 开头，不能带域名，也不能包含 .. 段';
  }
  if (issues.some((issue) => issue.message === 'interface_format_body_path_invalid')) {
    return '请求体路径只能用字母、数字、_、-，层级之间用点号分隔（例如 input.text）';
  }
  if (issues.some((issue) => issue.message === 'interface_format_field_key_reserved')) {
    return '这个字段位置是系统保留的，提示词请用「提示词位置」填写';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_prompt_path_conflicts_with_parameter' ||
        issue.message === 'interface_format_model_path_conflicts',
    )
  ) {
    return '提示词、模型 ID 与参数发送到同一个位置了，请改掉其中一处';
  }
  if (issues.some((issue) => issue.message === 'interface_format_parameter_key_duplicated')) {
    return '有两个参数发送到了同一个位置，请改成不重复的请求体路径、查询参数名或请求头名';
  }
  if (issues.some((issue) => issue.message === 'interface_format_parameter_enum_values_missing')) {
    return '选值类型的参数至少要给一个候选值';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_header_name_invalid' ||
        issue.message === 'interface_format_header_name_forbidden',
    )
  ) {
    return '请求头名称不合法或由软件自动管理（如 Content-Type、Authorization），请换一个名称';
  }
  if (issues.some((issue) => issue.message === 'interface_format_query_name_invalid')) {
    return '查询参数名称只能用字母、数字、下划线、点、短横线和方括号';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_header_value_invalid' ||
        issue.message === 'interface_format_query_value_invalid',
    )
  ) {
    return '固定请求头或查询参数的值里不能有换行等控制字符';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_fixed_header_conflicts' ||
        issue.message === 'interface_format_fixed_header_duplicated',
    )
  ) {
    return '固定请求头与参数或鉴权使用了同一个请求头名称，请改掉其中一处';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_fixed_query_conflicts' ||
        issue.message === 'interface_format_fixed_query_duplicated',
    )
  ) {
    return '固定查询参数与参数、提示词、模型 ID 或鉴权使用了同一个查询参数名，请改掉其中一处';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_submit_path_query_conflicts' ||
        issue.message === 'interface_format_polling_path_query_conflicts',
    )
  ) {
    return '请求路径里写死的查询参数与别处重复了，请删掉其中一处';
  }
  if (issues.some((issue) => issue.message === 'interface_format_text_payload_requires_text_prompt')) {
    return '纯文本请求体要求提示词发送到「请求体正文」';
  }
  if (issues.some((issue) => issue.message === 'interface_format_text_binding_requires_text_payload')) {
    return '提示词选择「请求体正文」时，数据格式必须是纯文本';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_text_payload_forbids_body_fields' ||
        issue.message === 'interface_format_text_payload_forbids_media_slots',
    )
  ) {
    return '纯文本请求体没有请求体字段，参数请改为发送到查询参数或请求头，素材位不能使用';
  }
  if (issues.some((issue) => issue.message === 'interface_format_model_path_binding_requires_placeholder')) {
    return '模型 ID 选择「地址路径」时，请求路径里必须包含 {model} 占位';
  }
  if (issues.some((issue) => issue.message === 'interface_format_form_content_type_invalid')) {
    return '表单数据格式要求 Content-Type 是 application/x-www-form-urlencoded';
  }
  if (issues.some((issue) => issue.message === 'interface_format_polling_body_requires_post')) {
    return '轮询只有用 POST 时才能带请求体';
  }
  if (issues.some((issue) => issue.message === 'interface_format_polling_form_body_must_be_object')) {
    return '表单格式的轮询请求体必须是一组字段';
  }
  if (
    issues.some(
      (issue) =>
        issue.message === 'interface_format_media_slot_duplicated' ||
        issue.message === 'interface_format_media_field_key_conflicts',
    )
  ) {
    return '素材位重复，或者与参数发到了同一个位置，请改成不重复的素材位与请求体路径';
  }
  if (issues.some((issue) => issue.message === 'interface_format_multipart_slot_requires_multipart_submit')) {
    return '素材位选择「表单文件上传」时，数据格式必须是表单文件（multipart）';
  }
  if (issues.some((issue) => issue.message === 'interface_format_multipart_slot_requires_null_content_type')) {
    return '表单文件上传的 Content-Type 由软件按上传内容自动生成，请留空';
  }
  if (issues.some((issue) => issue.message === 'interface_format_inline_slot_single_file_only')) {
    return '素材位直接内嵌进请求体时一次只能放一个文件，请把最多张数改为 1';
  }
  if (issues.some((issue) => issue.message === 'interface_format_needs_fetch_requires_async')) {
    return '选择「先拿标识、再取一次结果」时，必须同时填写查询进度的方式（异步任务）';
  }
  if (issues.some((issue) => issue.message === 'interface_format_needs_fetch_media_type_missing')) {
    return '再取一次拿到的是文件内容时，请选择它是图片、视频还是音频';
  }
  if (issues.some((issue) => issue.message === 'interface_format_needs_fetch_after_missing')) {
    return '再取一次拿到的是结构化内容时，请填写产物在这个响应里的位置';
  }
  const field = issues[0]?.path[0];
  if (field === 'display_name') return '请给这个接口格式起一个名字（最多 80 个字）';
  if (field === 'submit') return '请求方式的信息不完整，请检查请求路径、请求方法、数据格式与鉴权';
  if (field === 'prompt_binding') return '请选择提示词的发送位置';
  if (field === 'model_binding') return '模型 ID 的发送位置不合法';
  if (field === 'parameters') return '参数的填写有误，请检查发送位置、类型与候选值';
  if (field === 'behavior') return '成功判定或结果形态的格式无效，请检查后重试';
  if (field === 'format_id') return '接口格式的标识格式不对，请重试';
  return '接口格式的内容格式无效，请检查后重试';
};

