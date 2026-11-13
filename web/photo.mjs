import { squareCrop } from './geometry.mjs';

export function withTimeout(promise, milliseconds, message = 'The camera took too long. Please try again.') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export async function decodePhoto(blob) {
  // HTMLImageElement applies EXIF orientation consistently, including on iOS.
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function squareJPEG(source, width, height, zoom = 1) {
  const crop = squareCrop(width, height, zoom);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = crop.outputSize;
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('There is not enough memory to prepare this photo. Please try again.');
    context.drawImage(source, crop.x, crop.y, crop.side, crop.side, 0, 0, crop.outputSize, crop.outputSize);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 1));
    if (!blob) throw new Error('The photo could not be exported. Please try again.');
    return { blob, size: crop.outputSize };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

export function photoFile(blob, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return new File([blob], `donut-${stamp}.jpg`, { type: 'image/jpeg', lastModified: date.getTime() });
}
