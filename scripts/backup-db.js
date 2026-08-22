'use strict';

/** Salin data/bot.db ke folder backups dengan stempel waktu. */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const src = config.db.path;
if (!fs.existsSync(src)) {
  console.error('Database tidak ditemukan:', src);
  process.exit(1);
}
const dir = path.join(config.ROOT, 'backups');
fs.mkdirSync(dir, { recursive: true });
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const name = `bot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
const dest = path.join(dir, name);
fs.copyFileSync(src, dest);
console.log('Backup dibuat:', dest);
