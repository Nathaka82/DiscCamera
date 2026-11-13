export const HOLE_RATIO = 0.41;

export function guideGeometry(size) {
  return { cx: size / 2, cy: size / 2, outerRadius: size / 2, holeRadius: size / 2 * HOLE_RATIO };
}

export function squareCrop(width, height, zoom = 1) {
  if (![width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 1) {
    throw new RangeError('Invalid image dimensions or zoom.');
  }
  const side = Math.min(width, height) / zoom;
  return { x: (width - side) / 2, y: (height - side) / 2, side, outputSize: Math.max(1, Math.floor(side)) };
}

export function clampZoom(value, min, max, step = 0.01) {
  const bounded = Math.min(max, Math.max(min, Number(value) || min));
  const snapped = min + Math.round((bounded - min) / step) * step;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
}
