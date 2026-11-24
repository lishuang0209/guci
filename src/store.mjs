import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kit, readKit, root } from './kit.mjs';

const proposalSlots = ['lifestyle', 'source', 'printA', 'printB', 'packA', 'packB'];

const initialState = ({ hasTemplate, isDemo }) => ({
  revision: 0,
  inquiry: null,
  buyer: {
    use: isDemo ? kit.demo.use : null,
    quantity: isDemo ? kit.demo.quantity : null,
    quantityQualifier: isDemo ? kit.demo.quantityQualifier : '',
    quantityUnit: kit.demo.quantityUnit,
  },
  selected: hasTemplate ? {
    lifestyle: 'lifestyle-kit', source: 'source-146',
    printA: 'print-a-kit', printB: 'print-b-kit', packA: 'pack-a-kit', packB: 'pack-b-kit',
  } : Object.fromEntries(proposalSlots.map(slot => [slot, null])),
  ...(hasTemplate ? {} : { product: null, artworkId: null }),
  prints: Object.fromEntries(kit.print.options.map(option => [option.id.at(-1).toUpperCase(), option])),
  packing: { A: { brief: '', reviewed: {} }, B: { brief: '', reviewed: {} } },
  replies: [],
});

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Workspace {
  constructor(dataDir = process.env.PORVIA_DATA_DIR || resolve(root, '.porvia'), { template = 'lemon', isDemo = true } = {}) {
    this.dataDir = resolve(dataDir);
    this.hasTemplate = template === 'lemon';
    this.runningJobs = new Set();
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(this.dataDir, 'porvia.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 4000;
      CREATE TABLE IF NOT EXISTS workspace (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, slot TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
        request_id TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL, pdf BLOB NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, ?)')
      .run(JSON.stringify(initialState({ hasTemplate: this.hasTemplate, isDemo })));
  }

  state() {
    return JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE singleton = 1').get().data);
  }

  update(revision, change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.state();
      if (revision !== state.revision) throw new WorkspaceError(409, '工作台已有更新。已刷新数据，请重新操作。');
      const result = change(state);
      state.revision++;
      this.db.prepare('UPDATE workspace SET data = ? WHERE singleton = 1').run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  assets() {
    const saved = this.db.prepare('SELECT metadata FROM assets ORDER BY rowid DESC').all();
    return [...(this.hasTemplate ? kit.assets : []), ...saved.map(row => JSON.parse(row.metadata))];
  }

  asset(id, slot) {
    const templateAsset = this.hasTemplate ? kit.assets.find(item => item.id === id) : null;
    const asset = templateAsset ??
      JSON.parse(this.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(id)?.metadata ?? 'null');
    if (!asset || (slot && asset.slot !== slot)) throw new WorkspaceError(422, '素材不存在，或引用超出当前选项范围。');
    return asset;
  }

  load(asset) {
    const trusted = this.asset(asset.id);
    if (trusted.path) {
      try { return readKit(trusted.path); }
      catch { throw new WorkspaceError(422, `缺少原始素材「${trusted.label}」。请恢复开发包中的文件。`); }
    }
    const entry = this.db.prepare('SELECT bytes FROM assets WHERE id = ?').get(trusted.id);
    if (!entry) throw new WorkspaceError(422, `素材「${trusted.label}」缺少原文件。`);
    return Buffer.from(entry.bytes);
  }

  addAsset(asset, bytes) {
    this.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(asset.id, JSON.stringify(asset), bytes);
  }

  jobs() {
    return this.db.prepare('SELECT status, metadata FROM jobs ORDER BY rowid DESC').all()
      .map(row => ({ ...JSON.parse(row.metadata), status: row.status }));
  }

  claimJob(job) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id);
      if (existing) throw new WorkspaceError(409, '该生成请求已记录，请查看包装历史。');
      if (job.mode === 'model') {
        const unresolved = this.db.prepare("SELECT id FROM jobs WHERE slot = ? AND status IN ('running', 'needs_review')").get(job.slot);
        if (unresolved) {
          const name = job.slot === 'lifestyle' ? '场景图' : '包装';
          throw new WorkspaceError(409, `该${name}已有未确认的模型请求，请先查看历史。`);
        }
      }
      this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(job.id, job.slot, 'running', JSON.stringify(job));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishJob(job, status) {
    this.db.prepare('UPDATE jobs SET status = ?, metadata = ? WHERE id = ?').run(status, JSON.stringify(job), job.id);
  }

  recordResult(job, asset, bytes) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.addAsset(asset, bytes);
      this.finishJob({ ...job, assetId: asset.id }, 'succeeded');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  versionForRequest(requestId) {
    return this.db.prepare('SELECT version FROM versions WHERE request_id = ?').get(requestId)?.version;
  }

  latestVersion() {
    return this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM versions').get().version;
  }

  versions() {
    return this.db.prepare('SELECT version, created_at, snapshot FROM versions ORDER BY version DESC').all()
      .map(row => ({ version: row.version, createdAt: row.created_at, snapshot: JSON.parse(row.snapshot) }));
  }

  saveVersion(snapshot, requestId, pdf) {
    this.db.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?)')
      .run(snapshot.version, new Date().toISOString(), requestId, JSON.stringify(snapshot), pdf);
  }

  download(version) {
    const row = this.db.prepare('SELECT pdf FROM versions WHERE version = ?').get(version);
    if (!row) throw new WorkspaceError(404, '找不到该版本的 PDF。');
    return Buffer.from(row.pdf);
  }
}
