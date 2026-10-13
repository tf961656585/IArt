import type React from "react";
import {
  Box,
  Clock,
  Dices,
  FileJson,
  Gauge,
  Hash,
  ImagePlus,
  Images,
  Info as InfoIcon,
  Layers,
  Link2,
  ListOrdered,
  Maximize2,
  MessageSquareText,
  Plug,
  Radio,
  Ratio,
  ScanFace,
  Lock as LockIcon,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Stamp,
  Timer,
  Volume2,
  XCircle,
  RectangleHorizontal,
  RectangleVertical,
} from "lucide-react";

// 根据字段语义选择合适的图标
export type IconComponentType = React.ComponentType<{ className: string | undefined }>;

export const getSemanticIcon = (args: {
  fieldKey: string | undefined;
  fieldType: string | undefined;
  label: string | undefined;
}): IconComponentType => {
  const { fieldKey, fieldType, label } = args;
  const key = (fieldKey ?? "").toLowerCase();
  const type = (fieldType ?? "").toLowerCase();
  const text = (label ?? "").toLowerCase();

  // 图片上传（保持）
  if (type === "imageupload" || type === "file") return ImagePlus;

  // 负面提示词
  if (
    key.includes("negative") ||
    key.startsWith("neg") ||
    text.includes("负") ||
    text.includes("反向") ||
    text.includes("负面") ||
    text.includes("负向")
  ) {
    return XCircle;
  }

  // 提示词/文本（在负面提示词之后）
  if (
    // 英文关键词，排除负面
    (key.includes("prompt") && !key.includes("negative") && !key.startsWith("neg")) ||
    // 中文关键词
    text.includes("提示词")
  ) {
    return MessageSquareText;
  }

  // 比例/宽高比
  if (
    key.includes("ratio") ||
    key.includes("aspect") ||
    key === "ar" ||
    text.includes("比例") ||
    text.includes("宽高比")
  ) {
    return Ratio;
  }

  // 分辨率/尺寸/宽高
  if (
    key.includes("resolution") ||
    key.includes("size") ||
    key.includes("width") ||
    key.includes("height") ||
    key.includes("dim") ||
    text.includes("分辨率") ||
    text.includes("尺寸") ||
    text.includes("宽度") ||
    text.includes("高度") ||
    text.includes("像素")
  ) {
    return RectangleHorizontal;
  }

  // 超分/放大（Maximize2）
  if (
    key.includes("upsample") ||
    key.includes("upscale") ||
    text.includes("超分") ||
    text.includes("放大")
  ) {
    return Maximize2;
  }

  // 步数/迭代
  if (
    key.includes("steps") ||
    key.endsWith("step") ||
    key.includes("iteration") ||
    key.includes("passes") ||
    key.includes("num_inference_steps") ||
    text.includes("步") ||
    text.includes("迭代")
  ) {
    return Layers;
  }

  // 时长（在步数之后）
  if (
    key.includes("duration") ||
    key.includes("seconds") ||
    text.includes("时长") ||
    text.includes("秒数")
  ) {
    return Timer;
  }

  // 水印
  if (key.includes("watermark") || text.includes("水印")) {
    return Stamp;
  }

  // 私有/隐私
  if (key.includes("private") || text.includes("私有") || text.includes("隐私")) {
    return LockIcon;
  }

  // 方向（横/竖）
  if (key.includes("orientation") || text.includes("方向") || text.includes("横竖")) {
    return RectangleVertical;
  }

  // 种子/随机
  if (
    key.includes("seed") ||
    key.includes("random") ||
    key.includes("rand") ||
    text.includes("随机")
  ) {
    return Dices;
  }

  // 引导系数/CFG
  if (
    key.includes("cfg") ||
    key.includes("guidance") ||
    text.includes("引导")
  ) {
    return SlidersHorizontal;
  }

  // 提示词权重/强度/去噪强度/帧率
  if (
    key.includes("weight") ||
    key.includes("strength") ||
    key.includes("denoise") ||
    // 帧率（fps / frame_rate / frameRate）
    key.includes("fps") ||
    key.includes("frame_rate") ||
    key.includes("framerate") ||
    text.includes("帧率") ||
    text.includes("权重") ||
    text.includes("强度")
  ) {
    return Gauge;
  }

  // 模型选择
  if (
    key.includes("model") ||
    key.includes("checkpoint") ||
    key.includes("base_model") ||
    key.includes("basemodel") ||
    text.includes("模型")
  ) {
    return Box;
  }

  // 模式选项（在模型选择之后）
  if (
    // 英文关键词（排除 imageMode）
    ((key.includes("mode") && !key.includes("imagemode")) ||
      key.includes("videomode") ||
      key.includes("operation")) ||
    // 中文关键词（排除“图像模式”）
    (text.includes("模式") && !text.includes("图像模式"))
  ) {
    return Settings2;
  }

  // 图像模式
  if (key.includes("imagemode") || text.includes("图像模式")) {
    return Images;
  }

  // 源类型
  if (
    key.endsWith("sourcetype") ||
    key.endsWith("source") ||
    text.includes("来源") ||
    text.includes("源")
  ) {
    return Plug;
  }

  // 链接/URL
  if (key.endsWith("url") || key.includes("link") || text.includes("链接")) {
    return Link2;
  }

  // 人脸ID
  if (
    key.includes("faceid") ||
    (key.includes("face") && key.includes("id")) ||
    text.includes("人脸")
  ) {
    return ScanFace;
  }

  // ID/标识（通用）
  if (
    key.endsWith("id") ||
    key.includes("identifier") ||
    text.includes("标识") ||
    text.includes("编号")
  ) {
    return Hash;
  }

  // 顺序/序列
  if (
    key.includes("sequential") ||
    key.includes("sequence") ||
    text.includes("顺序") ||
    text.includes("序列")
  ) {
    return ListOrdered;
  }

  // 最大图数
  if (
    key.includes("maximages") ||
    (key.includes("max") && key.includes("image")) ||
    (text.includes("最大") && text.includes("图"))
  ) {
    return Images;
  }

  // 流式输出
  if (key === "stream" || text.includes("流式")) {
    return Radio;
  }

  // 响应格式
  if (
    key.includes("responseformat") ||
    key.includes("response_format") ||
    (key.includes("format") && !key.includes("image")) ||
    text.includes("返回格式") ||
    text.includes("响应格式")
  ) {
    return FileJson;
  }

  // 增强/优化
  if (
    key.includes("enhance") ||
    key.includes("optimize") ||
    text.includes("增强") ||
    text.includes("优化") ||
    text.includes("润色")
  ) {
    return Sparkles;
  }

  // 时间点/时间码
  if (
    key.includes("soundstart") ||
    key.includes("soundend") ||
    key.includes("soundinsert") ||
    key.endsWith("time") ||
    text.includes("时间码") ||
    text.includes("开始时间") ||
    text.includes("结束时间")
  ) {
    return Clock;
  }

  // 音量
  if (key.includes("volume") || text.includes("音量")) {
    return Volume2;
  }

  // 采样器/算法/调度
  if (
    key.includes("sampler") ||
    key.includes("algorithm") ||
    key.includes("scheduler") ||
    key.includes("method") ||
    text.includes("采样") ||
    text.includes("算法") ||
    text.includes("调度")
  ) {
    return Settings;
  }

  // 兜底
  return InfoIcon;
};
