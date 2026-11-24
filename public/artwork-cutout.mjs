const cornerVariationLimit = 28;
const cornerMatchLimit = 22;
const edgeSoftness = 20;

function cornerColor({ width, data }, x, y, side) {
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  const sum = [0, 0, 0];
  for (let row = y; row < y + side; row++) {
    for (let col = x; col < x + side; col++) {
      const i = (row * width + col) * 4;
      if (data[i + 3] !== 255) return null;
      for (let channel = 0; channel < 3; channel++) {
        const value = data[i + channel];
        low[channel] = Math.min(low[channel], value);
        high[channel] = Math.max(high[channel], value);
        sum[channel] += value;
      }
    }
  }
  if (high.some((value, channel) => value - low[channel] > cornerVariationLimit)) return null;
  return sum.map(value => Math.round(value / (side * side)));
}

// A solid background should agree across at least three independently sampled corners.
export function suggestArtworkBackground(image) {
  const { width, height } = image;
  if (width < 2 || height < 2) return null;
  const side = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 30)));
  const corners = [
    [0, 0], [width - side, 0], [0, height - side], [width - side, height - side],
  ].map(([x, y]) => cornerColor(image, x, y, side)).filter(Boolean);
  for (const color of corners) {
    const matches = corners.filter(other =>
      color.every((value, channel) => Math.abs(value - other[channel]) <= cornerMatchLimit));
    if (matches.length >= 3) {
      return color.map((_, channel) =>
        Math.round(matches.reduce((sum, match) => sum + match[channel], 0) / matches.length));
    }
  }
  return null;
}

export function hasArtworkTransparency({ data }) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

// Tolerance is the maximum per-channel RGB difference that becomes fully transparent.
// Write to a separate pixel buffer so moving the slider can always start from the original.
export function removeArtworkBackground({ data }, [red, green, blue], tolerance, output) {
  output.set(data);
  let hasForeground = false;
  let changed = false;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    const distance = Math.max(Math.abs(data[i] - red), Math.abs(data[i + 1] - green), Math.abs(data[i + 2] - blue));
    const coverage = Math.min(1, Math.max(0, (distance - tolerance) / edgeSoftness));
    const nextAlpha = Math.round(alpha * coverage);
    if (nextAlpha > 0) hasForeground = true;
    if (nextAlpha === alpha) continue;
    changed = true;
    output[i + 3] = nextAlpha;
    if (nextAlpha > 0 && alpha === 255) {
      // Undo the source background mixed into softened edges to reduce visible halos.
      output[i] = red + (data[i] - red) / coverage;
      output[i + 1] = green + (data[i + 1] - green) / coverage;
      output[i + 2] = blue + (data[i + 2] - blue) / coverage;
    }
  }
  return { hasForeground, changed };
}
