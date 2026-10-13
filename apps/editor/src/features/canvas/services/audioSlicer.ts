/**
 * 音频切分服务
 * - 使用 Web Audio API 切分音频
 * - 将切分后的音频落盘到本地
 */

import type { AudioSegment } from '../types/audioSegment';
import { storeBlobMedia } from './mediaStorage';

/** 切分结果 */
export interface SliceResult {
  segmentId: string;
  segmentUrl: string;
}

/**
 * 将字符串写入 DataView
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 将 AudioBuffer 编码为 WAV Blob
 */
function encodeWavBlob(audioBuffer: AudioBuffer): Blob {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const dataLength = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data (interleaved)
  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  let pos = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = channels[ch];
      const sample = Math.max(-1, Math.min(1, (channelData !== null && channelData !== undefined ? channelData[i] : undefined) ?? 0));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(pos, intSample, true);
      pos += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * 使用 Web Audio API 切分音频
 * @param audioBlob 原始音频 Blob
 * @param segments 要切分的分段列表
 * @param nodeGraphId 画板 ID
 * @param nodeId 节点 ID
 * @returns 切分结果列表
 */
export async function sliceAudio(
  audioBlob: Blob,
  segments: AudioSegment[],
  nodeGraphId: string,
  nodeId: string
): Promise<SliceResult[]> {
  const audioContext = new AudioContext();

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const results: SliceResult[] = [];

    for (const segment of segments) {
      // 计算采样点范围
      const startSample = Math.floor(segment.startTime * audioBuffer.sampleRate);
      const endSample = Math.min(
        Math.floor(segment.endTime * audioBuffer.sampleRate),
        audioBuffer.length
      );
      const length = endSample - startSample;

      if (length <= 0) {
        console.warn(`分段 ${segment.name} 长度无效，跳过`);
        continue;
      }

      // 创建新的 AudioBuffer
      const slicedBuffer = audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        length,
        audioBuffer.sampleRate
      );

      // 复制样本数据
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const sourceData = audioBuffer.getChannelData(channel);
        const targetData = slicedBuffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          targetData[i] = sourceData[startSample + i] ?? 0;
        }
      }

      // 编码为 WAV Blob
      const wavBlob = encodeWavBlob(slicedBuffer);

      const stored = await storeBlobMedia(wavBlob, {
        nodeGraphId,
        nodeId,
        source: 'audio-segment',
        originalUrl: `segment://${segment.name}`,
        filenamePrefix: 'segment',
        mimeType: 'audio/wav',
      });

      results.push({
        segmentId: segment.id,
        segmentUrl: stored.url,
      });
    }

    return results;
  } finally {
    await audioContext.close();
  }
}

/**
 * 获取音频时长
 * @param audioBlob 音频 Blob
 * @returns 时长（秒）
 */
export async function getAudioDuration(audioBlob: Blob): Promise<number> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer.duration;
  } finally {
    await audioContext.close();
  }
}
