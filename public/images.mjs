import { removeArtworkBackground } from './artwork-cutout.mjs';

const projectId = new URLSearchParams(location.search).get('project');
const imageLimit = 12 * 1024 * 1024;

export function workspaceUrl(path) {
  if (!projectId) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set('project', projectId);
  return url.pathname + url.search;
}

export const assetUrl = id => workspaceUrl(`/api/assets/${encodeURIComponent(id)}`);

export function loadImage(id) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('素材加载失败，请恢复原始文件后重试。'));
    image.src = assetUrl(id);
  });
}

export const imageData = canvas => canvas.toDataURL('image/png').split(',')[1];

async function decodeImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('图片无法解码。'); });
  if (bitmap.width > 5000 || bitmap.height > 5000) {
    bitmap.close();
    throw new Error('图片长边请控制在 5000 像素以内。');
  }
  return bitmap;
}

function blobData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取本地图片。'));
    reader.readAsDataURL(blob);
  });
}

export async function fileData(file) {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > imageLimit) {
    throw new Error('请选择不超过 12 MB 的 PNG 或 JPEG。');
  }
  const bitmap = await decodeImage(file);
  bitmap.close();
  return blobData(file);
}

export async function decodeArtwork(file) {
  if (file.size > imageLimit) throw new Error('印花素材单张最多 12 MB。');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
  const isJpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const isWebp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) throw new Error('请选择 JPG、PNG 或 WebP 格式的印花素材。');
  return { bitmap: await decodeImage(file), isPng };
}

export function drawArtworkImage(canvas, bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return context;
}

export async function artworkImageData(file, bitmap, isPng, settings) {
  if (isPng && !settings) return blobData(file);
  const canvas = document.createElement('canvas');
  for (const maxEdge of [3000, 1600]) {
    const context = drawArtworkImage(canvas, bitmap, maxEdge);
    if (settings) {
      const source = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = context.createImageData(canvas.width, canvas.height);
      const { hasForeground, changed } = removeArtworkBackground(source, settings.color, settings.tolerance, result.data);
      if (!hasForeground || !changed) throw new Error('请调整背景颜色或容差后再保存。');
      context.putImageData(result, 0, 0);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片转换失败，请重试。');
    if (blob.size <= imageLimit) return blobData(blob);
  }
  throw new Error('处理后的印花图片超过 12 MB，请缩小原图后重试。');
}

export async function packagingAdjustment(baseId, option, treatment) {
  const image = await loadImage(baseId);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  if (treatment === 'copy') return imageData(canvas);

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let matches = 0;
  for (let y = 0; y < canvas.height; y++) {
    const v = y / canvas.height;
    for (let x = 0; x < canvas.width; x++) {
      const u = x / canvas.width;
      const outer = option === 'B' ? (v < 0.35 || v > 0.71 || u < 0.22 || u > 0.79) :
        (v < 0.32 || v > 0.74 || u < 0.17 || u > 0.84);
      if (!outer) continue;
      const i = (y * canvas.width + x) * 4;
      const [r, g, b] = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      const green = option === 'B' ? g - r > 4 && g - b > 3 && g < 160 :
        g >= r - 3 && g - b > 12 && g < 190;
      if (!green) continue;
      const strength = Math.min(1, (g - b - 3) / 17);
      const change = (treatment === 'lighter' ? 28 : -21) * strength;
      pixels.data[i] += change * 0.89;
      pixels.data[i + 1] += change;
      pixels.data[i + 2] += change * 0.92;
      matches++;
    }
  }
  if (!matches) throw new Error('这张参考图里没有检测到适合本地改色的盒面。');
  ctx.putImageData(pixels, 0, 0);
  return imageData(canvas);
}
