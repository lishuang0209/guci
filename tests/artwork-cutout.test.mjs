import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasArtworkTransparency, removeArtworkBackground, suggestArtworkBackground,
} from '../public/artwork-cutout.mjs';

const white = [255, 255, 255, 255];
const ink = [21, 63, 41, 255];
const image = (width, height, pixels) => ({ width, height, data: new Uint8ClampedArray(pixels.flat()) });

test('suggests near-uniform background from three corners despite one occupied corner', () => {
  const original = image(3, 3, [
    [252, 251, 248, 255], white, ink,
    white, ink, white,
    [248, 250, 245, 255], white, [250, 249, 245, 255],
  ]);
  assert.deepEqual(suggestArtworkBackground(original), [250, 250, 246]);
  assert.equal(hasArtworkTransparency(original), false);
  assert.deepEqual(suggestArtworkBackground(image(2, 2, [
    [240, 80, 14, 255], [20, 85, 230, 255], ink, white,
  ])), null);
});

test('removes flat backgrounds and enclosed letter holes while reducing pale edge halos', () => {
  const edge = [225, 229, 231, 255];
  const original = image(5, 3, [
    white, edge, ink, ink, white,
    white, ink, white, ink, white,
    white, ink, ink, ink, white,
  ]);
  const copy = original.data.slice();
  const output = new Uint8ClampedArray(original.data.length);
  assert.deepEqual(removeArtworkBackground(original, [255, 255, 255], 18, output),
    { hasForeground: true, changed: true });
  assert.equal(output[3], 0);
  assert.equal(output[(5 + 2) * 4 + 3], 0);
  assert.deepEqual(Array.from(output.slice(8, 12)), ink);
  assert.equal(output[7], 153);
  assert.ok(output[4] < edge[0]);
  assert.deepEqual(original.data, copy);
});

test('preserves prior transparency and reports empty or unchanged results', () => {
  const original = image(2, 2, [[0, 0, 0, 0], [21, 63, 41, 100], ink, white]);
  assert.equal(hasArtworkTransparency(original), true);
  const output = new Uint8ClampedArray(original.data.length);
  assert.deepEqual(removeArtworkBackground(original, [255, 255, 255], 18, output),
    { hasForeground: true, changed: true });
  assert.deepEqual(output.slice(0, 12), original.data.slice(0, 12));
  assert.deepEqual(removeArtworkBackground(original, [255, 0, 255], 18, output),
    { hasForeground: true, changed: false });
  assert.deepEqual(output, original.data);
  assert.deepEqual(removeArtworkBackground(image(1, 1, [white]), [255, 255, 255], 18, new Uint8ClampedArray(4)),
    { hasForeground: false, changed: true });
});
