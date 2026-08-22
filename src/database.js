'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger').scope('DB');

/* ------------------------------------------------------------------ *
 * Driver
 * Utama  : better-sqlite3 (dependency resmi project ini)
 * Cadangan: node:sqlite bawaan Node >= 22.5 - dipakai hanya bila
 *           better-sqlite3 gagal dimuat (mis. gagal build di Windows),
 *           supaya aplikasi tetap hidup. API keduanya kompatibel untuk
 *           pemakaian di file ini (exec / prepare / run / get / all).
 * ------------------------------------------------------------------ */
function openDatabase(file) {
  try {
    const Better = require('better-sqlite3');
    const db = new Better(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info('SQLite driver: better-sqlite3');
    return db;
  } catch (err) {
    logger.warn('better-sqlite3 tidak tersedia (' + err.code + '), memakai node:sqlite bawaan Node');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    logger.info('SQLite driver: node:sqlite');
    return db;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  whatsapp_number  TEXT    NOT NULL UNIQUE,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id     TEXT NOT NULL,
  telegram_message_id  TEXT NOT NULL,
  processed_at         TEXT NOT NULL,
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_messages (processed_at);
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_wa_groups_active ON wa_groups (active);
`;

const DEFAULT_TEMPLATE_NAME = 'Stock Lock Alert';
const DEFAULT_TEMPLATE_CONTENT = [
  'Dear {users}',
  '',
  'Sesuai informasi diatas, terdapat lock stock yang lebih besar daripada stock saat ini.',
  'Mohon segera lepas Lock Stock sebelum terjadi Oversell.',
  '',
  'Note: Pesan ini dikirim oleh Bot WH',
  '',
  'Terima kasih.',
].join('\n');

const now = () => new Date().toISOString();

class Database {
  constructor(file) {
    this.file = file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info('Folder data dibuat:', dir);
    }
    const isNew = !fs.existsSync(file);
    this.db = openDatabase(file);
    this.db.exec(SCHEMA);
    this._seed();
    logger.info(isNew ? 'Database baru dibuat:' : 'Database dibuka:', file);
  }

  _seed() {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM templates').get().c;
    if (Number(count) === 0) {
      this.db
        .prepare('INSERT INTO templates (name, content, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
        .run(DEFAULT_TEMPLATE_NAME, DEFAULT_TEMPLATE_CONTENT, now(), now());
      logger.info('Template default dibuat:', DEFAULT_TEMPLATE_NAME);
    }
    // Pindahkan target group lama (satu nilai di settings) ke tabel wa_groups
    // supaya pengaturan yang sudah ada tidak hilang saat aplikasi diperbarui.
    const groupCount = Number(this.db.prepare('SELECT COUNT(*) AS c FROM wa_groups').get().c);
    if (groupCount === 0) {
      const legacy = this.db.prepare("SELECT value FROM settings WHERE key = 'wa_group_id'").get();
      const legacyName = this.db.prepare("SELECT value FROM settings WHERE key = 'wa_group_name'").get();
      if (legacy && legacy.value) {
        this.db
          .prepare('INSERT INTO wa_groups (group_id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
          .run(legacy.value, (legacyName && legacyName.value) || '', now(), now());
        logger.info('Target group lama dipindahkan ke daftar group:', legacy.value);
      }
    }

    const defaults = {
      wa_group_id: '',
      wa_group_name: '',
      message_delay_ms: '',      // kosong = pakai nilai dari .env
      mention_display: 'number', // number | name
      forwarding_enabled: '1',
    };
    for (const [k, v] of Object.entries(defaults)) {
      const row = this.db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
      if (!row) {
        this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, now());
      }
    }
  }

  close() {
    try { this.db.close(); } catch (e) { /* ignore */ }
  }

  /* ----------------------------- settings ----------------------------- */
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === '') return fallback;
    return row.value;
  }

  setSetting(key, value) {
    const exists = this.db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (exists) {
      this.db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run(String(value), now(), key);
    } else {
      this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), now());
    }
    return true;
  }

  /* ------------------------------ users ------------------------------- */
  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE ASC').all();
  }

  listActiveUsers() {
    return this.db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY id ASC').all();
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
  }

  getUserByNumber(number) {
    return this.db.prepare('SELECT * FROM users WHERE whatsapp_number = ?').get(String(number)) || null;
  }

  createUser(name, whatsappNumber) {
    const res = this.db
      .prepare('INSERT INTO users (name, whatsapp_number, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(String(name).trim(), String(whatsappNumber).trim(), now(), now());
    return this.getUser(Number(res.lastInsertRowid));
  }

  updateUser(id, fields) {
    const allowed = ['name', 'whatsapp_number', 'active'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(key === 'active' ? (fields[key] ? 1 : 0) : String(fields[key]).trim());
      }
    }
    if (sets.length === 0) return this.getUser(id);
    sets.push('updated_at = ?');
    values.push(now(), Number(id));
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getUser(id);
  }

  deleteUser(id) {
    const res = this.db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
    return Number(res.changes) > 0;
  }

  /* ---------------------------- templates ----------------------------- */
  listTemplates() {
    return this.db.prepare('SELECT * FROM templates ORDER BY id ASC').all();
  }

  getTemplate(id) {
    return this.db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(id)) || null;
  }

  getActiveTemplate() {
    return (
      this.db.prepare('SELECT * FROM templates WHERE active = 1 ORDER BY id ASC').get() ||
      this.db.prepare('SELECT * FROM templates ORDER BY id ASC').get() ||
      null
    );
  }

  updateTemplate(id, fields) {
    const sets = [];
    const values = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(String(fields.name).trim()); }
    if (fields.content !== undefined) { sets.push('content = ?'); values.push(String(fields.content)); }
    if (fields.active !== undefined) { sets.push('active = ?'); values.push(fields.active ? 1 : 0); }
    if (sets.length === 0) return this.getTemplate(id);
    sets.push('updated_at = ?');
    values.push(now(), Number(id));
    this.db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getTemplate(id);
  }

  resetTemplateToDefault(id) {
    return this.updateTemplate(id, { name: DEFAULT_TEMPLATE_NAME, content: DEFAULT_TEMPLATE_CONTENT });
  }

  /* ---------------------- WhatsApp Groups ----------------------------- */
  listWaGroups() {
    return this.db.prepare('SELECT * FROM wa_groups ORDER BY active DESC, name COLLATE NOCASE ASC, id ASC').all();
  }

  listActiveWaGroups() {
    return this.db.prepare('SELECT * FROM wa_groups WHERE active = 1 ORDER BY id ASC').all();
  }

  getWaGroup(id) {
    return this.db.prepare('SELECT * FROM wa_groups WHERE id = ?').get(Number(id)) || null;
  }

  getWaGroupByGid(groupId) {
    return this.db.prepare('SELECT * FROM wa_groups WHERE group_id = ?').get(String(groupId)) || null;
  }

  /** Tambah group; bila sudah ada, perbarui namanya dan aktifkan kembali. */
  addWaGroup(groupId, name = '') {
    const existing = this.getWaGroupByGid(groupId);
    if (existing) {
      this.db
        .prepare('UPDATE wa_groups SET name = COALESCE(NULLIF(?, \'\'), name), active = 1, updated_at = ? WHERE id = ?')
        .run(String(name), now(), existing.id);
      this._syncPrimaryGroup();
      return this.getWaGroup(existing.id);
    }
    const res = this.db
      .prepare('INSERT INTO wa_groups (group_id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(String(groupId), String(name), now(), now());
    this._syncPrimaryGroup();
    return this.getWaGroup(Number(res.lastInsertRowid));
  }

  updateWaGroup(id, fields) {
    const sets = [];
    const values = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(String(fields.name)); }
    if (fields.active !== undefined) { sets.push('active = ?'); values.push(fields.active ? 1 : 0); }
    if (sets.length === 0) return this.getWaGroup(id);
    sets.push('updated_at = ?');
    values.push(now(), Number(id));
    this.db.prepare(`UPDATE wa_groups SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this._syncPrimaryGroup();
    return this.getWaGroup(id);
  }

  deleteWaGroup(id) {
    const res = this.db.prepare('DELETE FROM wa_groups WHERE id = ?').run(Number(id));
    this._syncPrimaryGroup();
    return Number(res.changes) > 0;
  }

  /** Jaga settings lama tetap terisi group aktif pertama (kompatibilitas). */
  _syncPrimaryGroup() {
    const first = this.db.prepare('SELECT * FROM wa_groups WHERE active = 1 ORDER BY id ASC').get();
    this.setSetting('wa_group_id', first ? first.group_id : '');
    this.setSetting('wa_group_name', first ? first.name : '');
  }

  /* ----------------------- processed_messages ------------------------- */
  isProcessed(chatId, messageId) {
    const row = this.db
      .prepare('SELECT id FROM processed_messages WHERE telegram_chat_id = ? AND telegram_message_id = ?')
      .get(String(chatId), String(messageId));
    return !!row;
  }

  markProcessed(chatId, messageId) {
    try {
      this.db
        .prepare('INSERT INTO processed_messages (telegram_chat_id, telegram_message_id, processed_at) VALUES (?, ?, ?)')
        .run(String(chatId), String(messageId), now());
      return true;
    } catch (err) {
      // UNIQUE constraint = sudah pernah tercatat (race condition)
      return false;
    }
  }

  countProcessed() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM processed_messages').get().c);
  }

  pruneProcessed(days = 30) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const res = this.db.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(cutoff);
    const n = Number(res.changes);
    if (n > 0) logger.info(`Membersihkan ${n} catatan processed_messages lebih lama dari ${days} hari`);
    return n;
  }
}

module.exports = Database;
module.exports.DEFAULT_TEMPLATE_NAME = DEFAULT_TEMPLATE_NAME;
module.exports.DEFAULT_TEMPLATE_CONTENT = DEFAULT_TEMPLATE_CONTENT;
