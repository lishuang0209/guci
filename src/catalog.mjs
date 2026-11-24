import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kit, readKit, root } from './kit.mjs';
import { WorkspaceError } from './store.mjs';

const productFields = 'id, sku, name_zh AS nameZh, name_en AS nameEn, revision';
const skuKey = sku => sku.normalize('NFC').toLowerCase();

const seedProducts = [
  {
    id: 'longway-146', sku: kit.product.sku, nameZh: kit.product.nameZh, nameEn: kit.product.nameEn,
    readImage: () => readKit('01-product/146-source.jpg'),
  },
  {
    id: 'longway-165', sku: '165', nameZh: '骨瓷茶杯与碟套装', nameEn: 'Fine Bone China Cup and Saucer Set',
    readImage: () => readFileSync(resolve(root, 'output/Longway-165/Longway-165-商品主图.jpg')),
  },
];

export class Catalog {
  constructor(dataDir) {
    this.db = new DatabaseSync(resolve(dataDir, 'catalog.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 4000;
      CREATE TABLE IF NOT EXISTS catalog_products (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        sku_key TEXT NOT NULL UNIQUE,
        name_zh TEXT NOT NULL,
        name_en TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png')),
        image BLOB NOT NULL
      );
    `);
    const existing = this.db.prepare('SELECT 1 FROM catalog_products WHERE id = ? OR sku_key = ?');
    const seed = this.db.prepare(`
      INSERT OR IGNORE INTO catalog_products (id, sku, sku_key, name_zh, name_en, mime_type, image)
      VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?)
    `);
    for (const { id, sku, nameZh, nameEn, readImage } of seedProducts) {
      if (existing.get(id, skuKey(sku))) continue;
      let image;
      try { image = readImage(); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      seed.run(id, sku, skuKey(sku), nameZh, nameEn, image);
    }
  }

  list() {
    return this.db.prepare(`SELECT ${productFields} FROM catalog_products ORDER BY sku_key`).all();
  }

  read(id) {
    const row = this.db.prepare(`
      SELECT ${productFields}, mime_type AS mimeType, image FROM catalog_products WHERE id = ?
    `).get(id);
    if (!row) throw new WorkspaceError(404, '资料库中找不到此商品。');
    const { mimeType, image, ...product } = row;
    return { product, mimeType, bytes: Buffer.from(image) };
  }

  create({ sku, nameZh, nameEn }, { mimeType, bytes }) {
    return this.save(() => this.db.prepare(`
      INSERT INTO catalog_products (id, sku, sku_key, name_zh, name_en, mime_type, image)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${productFields}
    `).get(randomUUID(), sku, skuKey(sku), nameZh, nameEn, mimeType, bytes));
  }

  update(id, revision, { sku, nameZh, nameEn }, image) {
    const updated = this.save(() => this.db.prepare(`
      UPDATE catalog_products
      SET sku = ?, sku_key = ?, name_zh = ?, name_en = ?, revision = revision + 1,
        mime_type = COALESCE(?, mime_type), image = COALESCE(?, image)
      WHERE id = ? AND revision = ?
      RETURNING ${productFields}
    `).get(sku, skuKey(sku), nameZh, nameEn, image?.mimeType ?? null, image?.bytes ?? null, id, revision));
    if (updated) return updated;
    if (!this.db.prepare('SELECT 1 FROM catalog_products WHERE id = ?').get(id)) {
      throw new WorkspaceError(404, '资料库中找不到此商品。');
    }
    throw new WorkspaceError(409, '商品资料已更新，请刷新后重试。');
  }

  save(operation) {
    try {
      return operation();
    } catch (error) {
      // SQLITE_CONSTRAINT_UNIQUE
      if (error.errcode === 2067) throw new WorkspaceError(409, '资料库中已存在此货号。');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
