// DashScope multimodal request and result host rules adapted from BeatDesign (Apache-2.0).
import { scenePresets } from './scene-presets.mjs';

const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const model = 'qwen-image-2.1-turbo';
const maxReferenceBytes = 10 * 1024 * 1024;
const maxRequestImageBytes = 30 * 1024 * 1024;
const maxOutputBytes = 12 * 1024 * 1024;
const rejectedStatuses = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

const roleDirections = new Map([
  ['product', 'The real product photo is the authority for the identity and silhouette of both pieces. Keep the cup profile and handle, glaze, proportions and rounded-square saucer recognizable.'],
  ['approved-print', 'The approved Print A/B placement preview guides cup decoration and placement only. Apply it on the cup body only, preserving the original artwork and the real product geometry.'],
  ['approved-packaging', 'The approved packaging concept guides lighting, composition, visual tone and restrained styling only.'],
  ['supplier-structure', 'The supplier packaging photo guides general box construction only. Ignore the supplier photo’s product, brand, dimensions and insert fit.'],
  ['graphic', 'The source artwork guides the box motif only. Do not apply this raw artwork to the cup.'],
]);

const projectRoleDirections = new Map([
  ['product', 'The selected main product photo is the authority for the identity and silhouette of the product. Preserve all visible pieces, their shape, proportions, rim and handle profiles, glaze, color and material.'],
  ['approved-print', 'The approved print preview guides the decoration and placement only. Reproduce the supplied artwork and its position on the same product surface.'],
]);

const customPackagingOptions = {
  A: 'Folding carton with understated paperboard construction and clearly visible folded flaps.',
  B: 'Rigid gift box with a separate lift-off lid shown next to the open box.',
};

class ImageGenerationError extends Error {
  constructor(publicMessage, uncertain = false, requestId = null) {
    super(publicMessage);
    this.name = 'ImageGenerationError';
    this.publicMessage = publicMessage;
    this.uncertain = uncertain;
    this.requestId = requestId;
  }
}

function rasterType(bytes) {
  const signature = Buffer.from(bytes.subarray(0, 12));
  if (signature.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (signature.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (signature.toString('latin1', 0, 4) === 'RIFF' && signature.toString('latin1', 8) === 'WEBP') return 'image/webp';
  return null;
}

function validateKey(key) {
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim())) {
    throw new ImageGenerationError('请先在服务端配置有效的百炼 API Key。');
  }
}

function validateReferences(references, directions, label, maximum) {
  if (!Array.isArray(references) || !references.length || references.length > maximum) {
    throw new ImageGenerationError(`请选择 1–${maximum} 张${label}参考图。`);
  }
  let size = 0;
  const roles = new Set();
  for (const reference of references) {
    const { role, bytes, mimeType } = reference ?? {};
    if (!directions.has(role) || !(bytes instanceof Uint8Array) || bytes.length > maxReferenceBytes || mimeType !== rasterType(bytes) || !mimeType) {
      throw new ImageGenerationError(`${label}参考图不可用。请使用 10 MB 以内的 PNG、JPEG 或 WebP。`);
    }
    roles.add(role);
    size += bytes.length;
  }
  if (size > maxRequestImageBytes) {
    throw new ImageGenerationError('参考图片总大小超过 30 MB。');
  }
  return roles;
}

function validateProjectReferences(references, label) {
  const roles = validateReferences(references, projectRoleDirections, label, 2);
  if (!roles.has('product') || roles.size !== references.length) {
    throw new ImageGenerationError(`${label}生成需要一张商品主图，可另选一张印花效果图。`);
  }
}

function packagingPrompt(preset, brief, references) {
  const referenceRoles = references.map(({ role }, index) => `Image ${index + 1}. ${roleDirections.get(role)}`);
  const decoration = references.some(({ role }) => role === 'approved-print')
    ? 'Use only the approved cup print shown in its designated reference.'
    : 'Keep existing product decoration unchanged. Leave the cup blank if the real product is blank.';
  return [
    'Create a photorealistic packaging concept for Longway 146, using only the references identified below for their assigned purposes.',
    `Package: ${preset.label}. ${preset.instructions}`,
    ...referenceRoles,
    'Include exactly one real 146 cup and one real 146 rounded-square saucer. Show the entire open package and both pieces.',
    decoration,
    brief.trim() && `Optional visual adjustment from the reviewer: ${brief.trim()}.`,
    'The reviewer adjustment is subordinate to the selected box structure, product identity, print, item count and the following requirements.',
    'No labels, text, branding, measurements, diagrams or claims of verified fit. Final dimensions, materials and insert fit require factory confirmation.',
  ].filter(Boolean).join('\n');
}

function scenePrompt(preset, brief, references) {
  const referenceRoles = references.map(({ role }, index) => `Image ${index + 1}. ${projectRoleDirections.get(role)}`);
  return [
    'Create a photorealistic landscape lifestyle image for a bone china sales proposal.',
    `Setting: ${preset.instructions}`,
    ...referenceRoles,
    references.some(({ role }) => role === 'approved-print')
      ? 'Use the approved print only where shown in its designated reference.'
      : 'Preserve the product decoration as photographed. Keep undecorated surfaces blank.',
    brief.trim() && `Project scene requirements: ${brief.trim()}`,
    'The setting, props, background and lighting may change. The product identity, decoration and number of pieces must match the references.',
    'Make the product the clear focal point, with all product pieces fully in frame and room around them for a cover crop.',
    'Exclude extra product units, invented logos, added text, watermarks and claims about the product.',
  ].filter(Boolean).join('\n');
}

function customPackagingPrompt(option, brief, references) {
  const referenceRoles = references.map(({ role }, index) => `Image ${index + 1}. ${projectRoleDirections.get(role)}`);
  return [
    'Create a photorealistic packaging concept for the bone china product shown in the supplied references.',
    `Package: ${customPackagingOptions[option]}`,
    ...referenceRoles,
    references.some(({ role }) => role === 'approved-print')
      ? 'Apply the approved print to the product only where shown in its reference. Keep the exterior of the box free of invented branding.'
      : 'Preserve the product decoration as photographed. Keep undecorated surfaces blank.',
    'Show the complete open package and the same product pieces and count as in the main photo. Treat unrelated props as scenery.',
    'Use a restrained neutral palette by default. The project brief can specify alternative styling, colors and materials.',
    brief.trim() && `Project packaging requirements: ${brief.trim()}`,
    'The shape, proportions, item count, finish and approved decoration of the product, and the selected box type, must match the references and package description.',
    'Show a presentation concept only. Exclude added text, diagrams, measurements and claims of verified dimensions, materials, fit or protection.',
  ].filter(Boolean).join('\n');
}

function providerRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : null;
}

function resultUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) {
    throw new Error('Unexpected result host');
  }
  return url;
}

async function readOutput(response) {
  if (!response.ok || Number(response.headers.get('content-length')) > maxOutputBytes || !response.body) {
    throw new Error('Unavailable result');
  }
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxOutputBytes) {
        await reader.cancel();
        throw new Error('Result exceeds maximum size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function generateImage({ prompt, references, key, fetcher }) {
  const content = references.map(({ bytes, mimeType }) => ({
    image: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
  }));
  content.push({ text: prompt });
  const body = JSON.stringify({
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters: { size: '1360*768', n: 1, prompt_extend: false, watermark: false },
  });
  let response;
  let result;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(600_000),
      body,
    });
    result = await response.json();
  } catch {
    throw new ImageGenerationError('百炼请求状态未确认，请核对模型服务记录。', true);
  }

  const requestId = providerRequestId(result?.request_id);
  if (!response.ok || result?.code) {
    const rejected = rejectedStatuses.has(response.status) && !result?.output;
    const message = rejected
      ? `百炼拒绝了该请求（HTTP ${response.status}）。请核对 API Key、模型权限和请求限制后再试。`
      : '百炼请求状态未确认，请核对模型服务记录。';
    throw new ImageGenerationError(message, !rejected, requestId);
  }

  try {
    const image = result.output?.choices?.[0]?.message?.content?.find((item) => typeof item?.image === 'string')?.image;
    const response = await fetcher(resultUrl(image), { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    const bytes = await readOutput(response);
    const mimeType = rasterType(bytes);
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') throw new Error('Result is not a supported raster image');
    return { bytes, mimeType, requestId };
  } catch {
    throw new ImageGenerationError('百炼已响应，但未能保存结果图。请核对模型服务记录。', true, requestId);
  }
}

export async function generatePackagingImage({ preset, brief = '', references, key, fetcher = fetch }) {
  validateKey(key);
  if (!['pack-a-v1', 'pack-b-v1'].includes(preset?.id) || typeof preset.instructions !== 'string' || !preset.instructions.trim()) {
    throw new ImageGenerationError('包装预设不可用。');
  }
  if (typeof brief !== 'string' || brief.trim().length > 1_600) {
    throw new ImageGenerationError('改稿要求最多 1,600 字。');
  }
  const roles = validateReferences(references, roleDirections, '包装', 10);
  if (!['product', 'approved-packaging', 'supplier-structure'].every(role => roles.has(role))) {
    throw new ImageGenerationError('缺少 146 商品实拍、包装选稿或供应商结构参考。');
  }
  return generateImage({ prompt: packagingPrompt(preset, brief, references), references, key, fetcher });
}

export async function generateCustomPackagingImage({ option, brief = '', references, key, fetcher = fetch }) {
  validateKey(key);
  if (typeof option !== 'string' || !Object.hasOwn(customPackagingOptions, option)) {
    throw new ImageGenerationError('请选择有效的包装类型。');
  }
  if (typeof brief !== 'string' || brief.trim().length > 1_600) {
    throw new ImageGenerationError('包装要求最多 1,600 字。');
  }
  validateProjectReferences(references, '包装');
  return generateImage({ prompt: customPackagingPrompt(option, brief, references), references, key, fetcher });
}

export async function generateSceneImage({ scene, brief = '', references, key, fetcher = fetch }) {
  validateKey(key);
  if (typeof scene !== 'string' || !Object.hasOwn(scenePresets, scene)) {
    throw new ImageGenerationError('请选择有效的场景。');
  }
  if (typeof brief !== 'string' || brief.trim().length > 1_600) {
    throw new ImageGenerationError('场景说明最多 1,600 字。');
  }
  if (scene === 'custom' && !brief.trim()) throw new ImageGenerationError('请填写自定义场景说明。');
  validateProjectReferences(references, '场景');
  return generateImage({ prompt: scenePrompt(scenePresets[scene], brief, references), references, key, fetcher });
}
