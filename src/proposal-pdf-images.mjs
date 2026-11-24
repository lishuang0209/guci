import { deflateSync, inflateSync } from 'node:zlib';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxPixels = 25_000_000;
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const pngChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function imageSize(width, height) {
  if (width < 1 || height < 1 || width * height > maxPixels) {
    throw new Error('Image dimensions are outside the supported PDF export range.');
  }
}

function jpegDescriptor(bytes) {
  if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('The selected JPEG could not be decoded.');
  let adobe = false;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xee && bytes.toString('ascii', offset + 2, offset + 7) === 'Adobe') adobe = true;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const bits = bytes[offset + 2];
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const colors = bytes[offset + 7];
      const space = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[colors];
      if (bits !== 8 || !space) break;
      imageSize(width, height);
      const decode = adobe && colors === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
      return { width, height, bytes, dictionary: `/ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}` };
    }
    offset += length;
  }
  throw new Error('The selected JPEG could not be decoded.');
}

function paeth(left, above, diagonal) {
  const guess = left + above - diagonal;
  const leftDelta = Math.abs(guess - left);
  const aboveDelta = Math.abs(guess - above);
  const diagonalDelta = Math.abs(guess - diagonal);
  if (leftDelta <= aboveDelta && leftDelta <= diagonalDelta) return left;
  return aboveDelta <= diagonalDelta ? above : diagonal;
}

function unfilterRow(row, prior, bytes, start, pixelStride) {
  const filter = bytes[start];
  if (filter > 4) throw new Error('Unknown PNG row filter.');
  for (let x = 0; x < row.length; x += 1) {
    const left = x >= pixelStride ? row[x - pixelStride] : 0;
    const above = prior[x];
    const diagonal = x >= pixelStride ? prior[x - pixelStride] : 0;
    let correction = 0;
    if (filter === 1) correction = left;
    if (filter === 2) correction = above;
    if (filter === 3) correction = (left + above) >> 1;
    if (filter === 4) correction = paeth(left, above, diagonal);
    row[x] = bytes[start + 1 + x] + correction;
  }
}

function rasterizePng(compressed, width, height, bits, colorType, palette, transparency, interlaced) {
  const channels = pngChannels[colorType];
  const colorChannels = colorType === 0 || colorType === 4 ? 1 : 3;
  const hasAlphaChannel = colorType === 4 || colorType === 6;
  const pixelStride = Math.ceil(bits * channels / 8);
  const maxSample = (1 << bits) - 1;
  const sample = (row, index) => {
    if (bits === 8) return row[index];
    if (bits === 16) return row.readUInt16BE(index * 2);
    const bit = index * bits;
    return (row[bit >> 3] >> (8 - bits - bit % 8)) & maxSample;
  };
  const toByte = value => bits === 8 ? value : Math.round(value * 255 / maxSample);
  const passes = (interlaced ? adam7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx);
    const rows = Math.ceil((height - y) / dy);
    return { x, y, dx, dy, columns, rows, length: Math.ceil(columns * channels * bits / 8) };
  }).filter(({ columns, rows }) => columns > 0 && rows > 0);
  const length = passes.reduce((total, pass) => total + (pass.length + 1) * pass.rows, 0);
  const bytes = inflateSync(compressed, { maxOutputLength: length });
  if (bytes.length !== length) throw new Error('The selected PNG has invalid image data.');
  const color = Buffer.allocUnsafe(width * height * colorChannels);
  const alpha = hasAlphaChannel || transparency ? Buffer.allocUnsafe(width * height) : null;
  let offset = 0;
  for (const pass of passes) {
    let prior = Buffer.alloc(pass.length);
    let row = Buffer.alloc(pass.length);
    for (let y = 0; y < pass.rows; y += 1) {
      unfilterRow(row, prior, bytes, offset, pixelStride);
      offset += pass.length + 1;
      const rowStart = (pass.y + y * pass.dy) * width + pass.x;
      for (let x = 0; x < pass.columns; x += 1) {
        const pixel = rowStart + x * pass.dx;
        if (colorType === 3) {
          const index = sample(row, x);
          const paletteOffset = index * 3;
          if (paletteOffset >= palette.length) throw new Error('The selected PNG has an invalid palette.');
          palette.copy(color, pixel * 3, paletteOffset, paletteOffset + 3);
          if (alpha) alpha[pixel] = transparency[index] ?? 255;
          continue;
        }
        let transparent = Boolean(transparency);
        for (let channel = 0; channel < colorChannels; channel += 1) {
          const value = sample(row, x * channels + channel);
          color[pixel * colorChannels + channel] = toByte(value);
          if (transparent && transparency.readUInt16BE(channel * 2) !== value) transparent = false;
        }
        if (alpha) alpha[pixel] = hasAlphaChannel ? toByte(sample(row, x * channels + colorChannels)) : (transparent ? 0 : 255);
      }
      [prior, row] = [row, prior];
    }
  }
  const image = (pixels, space) => ({ width, height, bytes: deflateSync(pixels), dictionary: `/ColorSpace ${space} /BitsPerComponent 8 /Filter /FlateDecode` });
  const rgb = image(color, colorChannels === 1 ? '/DeviceGray' : '/DeviceRGB');
  if (alpha) rgb.alpha = image(alpha, '/DeviceGray');
  return rgb;
}

function pngDescriptor(bytes) {
  let header;
  let palette;
  let transparency;
  let complete = false;
  const imageChunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('The selected PNG is incomplete.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, end - 4);
    if (type === 'IHDR') header = payload;
    if (type === 'PLTE') palette = payload;
    if (type === 'tRNS') transparency = payload;
    if (type === 'IDAT') imageChunks.push(payload);
    if (type === 'IEND') {
      complete = size === 0;
      break;
    }
    offset = end;
  }
  if (header?.length !== 13 || !imageChunks.length || !complete) throw new Error('The selected PNG is invalid.');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bits = header[8];
  const colorType = header[9];
  imageSize(width, height);
  const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colorType];
  const interlaced = header[12] === 1;
  if (header[10] !== 0 || header[11] !== 0 || header[12] > 1 || !validDepths?.includes(bits)) {
    throw new Error('For PDF export, re-save the selected image as a standard PNG or an 8-bit JPEG.');
  }
  if (colorType === 3 && (!palette?.length || palette.length % 3 !== 0 || palette.length > 768)) {
    throw new Error('The selected PNG palette is invalid.');
  }
  const colors = colorType === 2 ? 3 : 1;
  if (transparency && colorType !== 3 && (colorType > 2 || transparency.length !== colors * 2)) {
    throw new Error('The selected PNG transparency is invalid.');
  }
  const compressed = Buffer.concat(imageChunks);
  if (interlaced || colorType === 4 || colorType === 6 || (colorType === 3 && transparency)) {
    return rasterizePng(compressed, width, height, bits, colorType, palette, transparency, interlaced);
  }
  const stride = 1 + Math.ceil(width * colors * bits / 8);
  const length = stride * height;
  const pixels = inflateSync(compressed, { maxOutputLength: length });
  if (pixels.length !== length) throw new Error('The selected PNG has invalid image data.');
  for (let offset = 0; offset < length; offset += stride) {
    if (pixels[offset] > 4) throw new Error('Unknown PNG row filter.');
  }
  const space = {
    0: '/DeviceGray',
    2: '/DeviceRGB',
    3: palette && `[/Indexed /DeviceRGB ${(palette.length / 3) - 1} <${palette.toString('hex')}>]`,
  }[colorType];
  const mask = transparency ? ` /Mask [${Array.from({ length: colors }, (_, i) => {
    const sample = transparency.readUInt16BE(i * 2);
    return `${sample} ${sample}`;
  }).join(' ')}]` : '';
  return {
    width,
    height,
    bytes: compressed,
    dictionary: `/ColorSpace ${space} /BitsPerComponent ${bits} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${bits} /Columns ${width} >>${mask}`,
  };
}

export function describeImage(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Expected a PNG or JPEG image buffer.');
  if (bytes.subarray(0, 8).equals(pngSignature)) return pngDescriptor(bytes);
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDescriptor(bytes);
  throw new Error('The selected image must be a PNG or JPEG file.');
}
