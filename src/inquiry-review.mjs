import { WorkspaceError } from './store.mjs';

const textFields = new Map([
  ['use', ['用途', 120]],
  ['quantityQualifier', ['数量修饰', 80]],
  ['sku', ['货号', 48]],
  ['print', ['印花要求', 240]],
]);

function optionalText(value, label, max) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new WorkspaceError(422, `${label}需为不超过 ${max} 字符的文本。`);
  }
  return value.trim() || null;
}

function normalizeField(key, value) {
  const text = textFields.get(key);
  if (text) return optionalText(value, ...text);
  if (key === 'quantity') {
    if (value !== null && !(Number.isSafeInteger(value) && value > 0)) {
      throw new WorkspaceError(422, '数量需为大于 0 的整数，可以留空待确认。');
    }
    return value;
  }
  if (key === 'packaging') {
    if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string')) {
      throw new WorkspaceError(422, '包装要求需为文本列表，最多可填写 12 项。');
    }
    return [...new Set(value.map(item => optionalText(item, '包装要求', 120)).filter(Boolean))];
  }
  if (key === 'packagingConfirmed') {
    if (typeof value !== 'boolean') throw new WorkspaceError(422, '请指定客户是否已确认包装。');
    return value;
  }
  throw new WorkspaceError(422, '此字段不可在询盘结果中修改。');
}

export function effectiveInquiry(inquiry) {
  return inquiry?.result ? { ...inquiry.result, ...inquiry.review } : null;
}

export function acceptedInquiryQuantity(inquiry, result) {
  return Number.isSafeInteger(result.quantity) && result.quantity > 0 &&
    (!result.needsReview || Object.hasOwn(inquiry.review ?? {}, 'quantity')) ? result.quantity : null;
}

export function reviewInquiry(inquiry, fields) {
  if (!inquiry?.result) throw new WorkspaceError(422, '请先提取询盘信息。');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) {
    throw new WorkspaceError(422, '请提供要修改的询盘字段。');
  }
  const current = effectiveInquiry(inquiry);
  const changes = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalizeField(key, value)]));
  const review = { ...inquiry.review, ...changes };

  if (changes.quantity === null) review.quantityQualifier = null;
  if (Object.hasOwn(changes, 'packaging')) {
    const packagingChanged = JSON.stringify(changes.packaging) !== JSON.stringify(current.packaging ?? []);
    if (packagingChanged && current.packagingConfirmed && !Object.hasOwn(changes, 'packagingConfirmed')) {
      review.packagingConfirmed = false;
    }
  }
  if (changes.packagingConfirmed === true && (review.packaging ?? inquiry.result.packaging)?.length !== 1) {
    throw new WorkspaceError(422, '请先填写客户实际确认的一种包装。');
  }

  return review;
}
