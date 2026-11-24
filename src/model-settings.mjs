import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceError } from './store.mjs';

const model = 'qwen-image-2.1-turbo';
const maxKeyLength = 512;

function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key.length <= maxKeyLength && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export class ModelSettings {
  constructor(dataDir, fallbackKey) {
    this.dataDir = dataDir;
    this.path = resolve(dataDir, 'model-api-key');
    this.fallbackKey = normalizeKey(fallbackKey);
  }

  savedKey() {
    let file;
    try {
      file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
      throw error;
    }
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > maxKeyLength || (process.platform !== 'win32' && (stat.mode & 0o077))) {
        return null;
      }
      return normalizeKey(readFileSync(file, 'utf8'));
    } finally {
      closeSync(file);
    }
  }

  effectiveKey() {
    return this.savedKey() ?? this.fallbackKey;
  }

  status() {
    const savedLocally = Boolean(this.savedKey());
    return { configured: savedLocally || Boolean(this.fallbackKey), savedLocally, model };
  }

  save(input) {
    const key = normalizeKey(input);
    if (!key) throw new WorkspaceError(422, '请输入 1–512 个无空格的可打印 ASCII 字符作为 API Key。');
    const temporary = resolve(this.dataDir, `.model-key-${randomUUID()}.tmp`);
    const file = openSync(temporary, 'wx', 0o600);
    try {
      try {
        writeFileSync(file, key, 'utf8');
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* A failed save must not replace the existing key. */ }
      throw error;
    }
    return { configured: true, savedLocally: true, model };
  }
}
