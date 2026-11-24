import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kit } from './kit.mjs';
import { Workspace, WorkspaceError } from './store.mjs';

const projectFields = 'id, name, customer, created_at AS createdAt, template';
const projectId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectEntry = row => ({ ...row, isDemo: false });

export class Projects {
  constructor(workspace) {
    this.dataDir = workspace.dataDir;
    this.demo = {
      id: kit.demo.id, name: '柠檬蓝花', customer: '', template: 'lemon', isDemo: true,
      createdAt: statSync(resolve(this.dataDir, 'porvia.sqlite')).birthtime.toISOString(),
    };
    this.workspaces = new Map([[this.demo.id, workspace]]);
    this.db = new DatabaseSync(resolve(this.dataDir, 'projects.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 4000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        customer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        template TEXT NOT NULL CHECK(template IN ('blank', 'lemon')),
        request_id TEXT NOT NULL UNIQUE
      );
    `);
  }

  list() {
    const rows = this.db.prepare(`SELECT ${projectFields} FROM projects ORDER BY created_at DESC, rowid DESC`).all();
    return [...rows.map(projectEntry), this.demo];
  }

  create({ name, customer, template, requestId }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT ${projectFields} FROM projects WHERE request_id = ?`).get(requestId);
      if (existing) {
        if (existing.name !== name || existing.customer !== customer || existing.template !== template) {
          throw new WorkspaceError(409, '此建档请求已保存，请重新提交新项目。');
        }
        this.db.exec('COMMIT');
        return projectEntry(existing);
      }
      const entry = { id: randomUUID(), name, customer, createdAt: new Date().toISOString(), template };
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)')
        .run(entry.id, entry.name, entry.customer, entry.createdAt, entry.template, requestId);
      this.db.exec('COMMIT');
      return projectEntry(entry);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  open(id) {
    if (id === null || id === this.demo.id) return { project: this.demo, workspace: this.workspaces.get(this.demo.id) };
    if (!projectId.test(id)) throw new WorkspaceError(404, '找不到此项目。');
    const row = this.db.prepare(`SELECT ${projectFields} FROM projects WHERE id = ?`).get(id);
    if (!row) throw new WorkspaceError(404, '找不到此项目。');
    if (!this.workspaces.has(id)) {
      this.workspaces.set(id, new Workspace(resolve(this.dataDir, 'projects', id), { template: row.template, isDemo: false }));
    }
    return { project: projectEntry(row), workspace: this.workspaces.get(id) };
  }

  close() {
    for (const [id, workspace] of this.workspaces) {
      if (id !== this.demo.id) workspace.db.close();
    }
    this.db.close();
  }
}
