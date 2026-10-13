// 裸 16-bit PCM（audio/l16 / audio/pcm）→ WAV 容器封装。
//
// 背景：Gemini TTS 等模型返回 audio/l16; rate=24000; channels=1，是**无文件头的
// 原始 PCM 字节流**。播放器（浏览器 <audio>、系统播放器）依赖 RIFF/WAVE 容器头
// 才能识别采样率/声道/位深，裸流会被静默拒绝。
//
// 字节布局与前端 apps/editor/src/features/canvas/services/mediaStorage.ts
// :createWavBlobFromPcm 完全一致，保证前后端产物同构（44 字节标准 WAV 头）。

const PCM_INLINE_MIME_TYPES = new Set(['audio/l16', 'audio/pcm']);

const isPcmMimeType = (normalizedMime: string): boolean =>
  PCM_INLINE_MIME_TYPES.has(normalizedMime);

const writeAscii = (buffer: Buffer, offset: number, value: string): void => {
  buffer.write(value, offset, 'ascii');
};

/**
 * 把裸 16-bit PCM 字节流封装成标准 WAV 容器（44 字节头 + PCM 数据）。
 * 仅支持单声道/多声道 16-bit PCM，与 audio/l16 规范一致。
 */
const wrapPcmInWav = (pcm: Buffer, sampleRate: number, channelCount: number): Buffer => {
  const bitsPerSample = 16;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const wav = Buffer.alloc(44 + pcm.length);
  writeAscii(wav, 0, 'RIFF');
  wav.writeUInt32LE(36 + pcm.length, 4);
  writeAscii(wav, 8, 'WAVE');
  writeAscii(wav, 12, 'fmt ');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  writeAscii(wav, 36, 'data');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

/**
 * 从 data URL mimeType 头解析出的已知参数。
 * rate / channels 是 audio/l16 规范的固定字段；其余参数当前不消费。
 */
type MimeTypeParams = {
  readonly rate: string | undefined;
  readonly channels: string | undefined;
};

type PcmCoercionResult = {
  /** 转换后的字节（PCM 已补 WAV 头；非 PCM 原样返回） */
  readonly buffer: Buffer;
  /** 归一后的 mimeType（PCM 补头后为 audio/wav；非 PCM 原样返回） */
  readonly mimeType: string;
  /** 是否发生了 PCM→WAV 转换 */
  readonly coerced: boolean;
};

/**
 * 若 mimeType 是裸 PCM 类型，补 WAV 头并归一 mimeType 为 audio/wav；
 * 否则原样返回。sampleRate 缺失时回退 24000（Gemini TTS 默认），channels 缺失回退 1。
 *
 * @param params mimeType 已知参数（rate / channels），从 data URL 头解析得到
 */
const coercePcmToWavIfNeeded = (
  buffer: Buffer,
  normalizedMime: string,
  params: MimeTypeParams,
): PcmCoercionResult => {
  if (!isPcmMimeType(normalizedMime)) {
    return { buffer, mimeType: normalizedMime, coerced: false };
  }
  const parsedRate = Number.parseInt(params.rate ?? '', 10);
  const sampleRate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 24000;
  const parsedChannels = Number.parseInt(params.channels ?? '', 10);
  const channelCount = Number.isFinite(parsedChannels) && parsedChannels > 0 ? parsedChannels : 1;
  return {
    buffer: wrapPcmInWav(buffer, sampleRate, channelCount),
    mimeType: 'audio/wav',
    coerced: true,
  };
};

export { coercePcmToWavIfNeeded, type MimeTypeParams };
