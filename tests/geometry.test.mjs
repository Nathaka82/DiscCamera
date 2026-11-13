import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guideGeometry, squareCrop, clampZoom } from '../web/geometry.mjs';
import { photoFile } from '../web/photo.mjs';

test('the hole radius is 41% of the outer radius at every viewport size', () => {
  for (const size of [320, 393, 440, 1000]) {
    const guide = guideGeometry(size);
    assert.equal(guide.holeRadius, guide.outerRadius * 0.41);
    assert.equal(guide.cx, size / 2);
    assert.equal(guide.cy, size / 2);
  }
});
test('landscape and portrait square crops preserve the centred composition', () => {
  assert.deepEqual(squareCrop(8064, 6048), { x: 1008, y: 0, side: 6048, outputSize: 6048 });
  assert.deepEqual(squareCrop(6048, 8064), { x: 0, y: 1008, side: 6048, outputSize: 6048 });
});
test('digital zoom reduces real output pixels instead of upscaling', () => {
  assert.deepEqual(squareCrop(4032, 3024, 2), { x: 1260, y: 756, side: 1512, outputSize: 1512 });
  assert.equal(squareCrop(4032, 3024, 1.7).outputSize, 1778);
});
test('invalid images and unsupported zoom cannot produce a crop', () => {
  for (const args of [[0, 100], [100, -2], [100, 100, 0], [NaN, 100], [100, 100, Infinity]]) {
    assert.throws(() => squareCrop(...args), RangeError);
  }
});
test('zoom respects supported ranges and increments', () => {
  assert.equal(clampZoom(9, 1, 4), 4);
  assert.equal(clampZoom(0.5, 1, 4), 1);
  assert.equal(clampZoom(1.23, 1, 4, 0.1), 1.2);
});
test('export is a shareable JPEG with a filesystem-safe unique timestamp', () => {
  const file = photoFile(new Blob(['photo']), new Date('2026-11-13T12:30:45.123Z'));
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.name, 'donut-2026-11-13T12-30-45-123Z.jpg');
});
test('the actual SVG uses the specified hole ratio', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /viewBox="0 0 1000 1000"/);
  assert.match(html, /cx="500" cy="500" r="205" fill="white"/);
});
test('the manifest supports repository subpaths and real PNG icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../web/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) {
    const data = await readFile(new URL(`../web/${icon.src}`, import.meta.url));
    assert.equal(data.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
    assert.equal(data.subarray(1, 4).toString(), 'PNG');
  }
});
