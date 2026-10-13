const rankMediaUrlCandidate = (url: unknown): number => {
  if (!url || typeof url !== 'string') return 0;
  const lower = url.toLowerCase();
  let score = 0;
  if (lower.includes('.mp4') || lower.includes('.webm') || lower.includes('.mov')) {
    score += 60;
  }
  if (
    lower.includes('.mp3') ||
    lower.includes('.wav') ||
    lower.includes('.m4a') ||
    lower.includes('.aac') ||
    lower.includes('.ogg') ||
    lower.includes('.flac')
  ) {
    score += 80;
  }
  if (lower.includes('audio') || lower.includes('music')) score += 25;
  if (lower.includes('video')) score += 20;
  if (
    lower.includes('.png') ||
    lower.includes('.jpg') ||
    lower.includes('.jpeg') ||
    lower.includes('.webp') ||
    lower.includes('.gif')
  ) {
    score += 8;
  }
  if (lower.includes('image') || lower.includes('cover') || lower.includes('thumbnail')) score += 5;
  return score;
};

export {
  rankMediaUrlCandidate,
};
