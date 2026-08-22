'use strict';

/**
 * Logger sederhana tanpa dependency.
 * Format: [2026-08-21 21:14:43] [INFO ] [WA] pesan
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/* ------------------------------------------------------------------ *
 * Log ke berkas.
 * Wajib ketika aplikasi berjalan sebagai Windows Service: tidak ada
 * terminal, dan keluaran konsol belum tentu tertangkap oleh pembungkus
 * service. Tanpa ini, masalah di mode service tidak meninggalkan jejak.
 *
 * Bawaan: data/app.log, berputar pada 5 MB (satu berkas cadangan).
 * Matikan dengan LOG_FILE=off
 * ------------------------------------------------------------------ */
const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 5 * 1024 * 1024;
let fileState = null;   // null = belum disiapkan, false = dimatikan

function logFile() {
  if (fileState !== null) return fileState;

  const raw = (process.env.LOG_FILE || '').trim();
  if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'false') {
    fileState = false;
    return fileState;
  }

  const target = raw
    ? (path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
    : path.join(ROOT, 'data', 'app.log');

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fileState = target;
  } catch (err) {
    fileState = false;   // jangan sampai gagal menulis log mematikan aplikasi
  }
  return fileState;
}

function appendToFile(line) {
  const target = logFile();
  if (!target) return;
  try {
    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    if (stat && stat.size > MAX_BYTES) {
      try { fs.renameSync(target, target + '.1'); } catch (e) { /* abaikan */ }
    }
    fs.appendFileSync(target, line + '\n', 'utf8');
  } catch (err) {
    // Berkas terkunci atau disk penuh - abaikan, konsol tetap jalan.
  }
}

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toText(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function write(level, scope, args) {
  if (LEVELS[level] < currentLevel()) return;
  const tag = level.toUpperCase().padEnd(5, ' ');
  const prefix = scope ? `[${stamp()}] [${tag}] [${scope}]` : `[${stamp()}] [${tag}]`;
  const stream = level === 'error' ? console.error : console.log;
  stream(prefix, ...args);
  appendToFile(prefix + ' ' + args.map(toText).join(' '));
}

function make(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
    child: (sub) => make(scope ? `${scope}:${sub}` : sub),
  };
}

module.exports = make('');
module.exports.scope = make;
module.exports.logFilePath = () => logFile() || null;
