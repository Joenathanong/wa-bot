'use strict';

/**
 * Hapus sesi WhatsApp supaya bisa login ulang dengan QR baru.
 *
 *   npm run wa:reset
 *
 * Dipakai ketika:
 *   - perangkat tertaut dilepas dari HP (log: "disconnected: LOGOUT")
 *   - ingin mengganti nomor WhatsApp pengirim
 *   - folder sesi rusak / terkunci
 *
 * Database (user, template, daftar group) TIDAK tersentuh.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hapus(target) {
  if (!fs.existsSync(target)) {
    console.log('  (tidak ada)      ' + target);
    return true;
  }
  for (let percobaan = 1; percobaan <= 5; percobaan += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (!fs.existsSync(target)) {
        console.log('  DIHAPUS          ' + target);
        return true;
      }
    } catch (err) {
      console.log(`  gagal (${percobaan}/5): ${err.code || err.message}`);
    }
    await sleep(1500);
  }
  console.log('  MASIH TERKUNCI   ' + target);
  return false;
}

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  RESET SESI WHATSAPP');
  console.log('==========================================================');
  console.log('');
  console.log('Pastikan aplikasi sudah dihentikan (Ctrl+C) sebelum melanjutkan.');
  console.log('Bila masih ada Chrome milik bot yang berjalan, tutup dengan:');
  console.log('  Git Bash        :  taskkill //F //IM chrome.exe');
  console.log('  Command Prompt  :  taskkill /F /IM chrome.exe');
  console.log('');

  const targets = [
    config.whatsapp.sessionPath,
    path.join(config.ROOT, '.wwebjs_cache'),
  ];

  let semua = true;
  for (const t of targets) {
    const ok = await hapus(t);
    if (!ok) semua = false;
  }

  console.log('');
  if (semua) {
    console.log('Selesai. Jalankan "npm start" lalu scan QR yang muncul di terminal.');
    console.log('Data user, template, dan daftar group tetap utuh di data/bot.db.');
  } else {
    console.log('Sebagian berkas masih dipegang proses lain.');
    console.log('Tutup Chrome milik bot lalu jalankan perintah ini sekali lagi.');
    process.exit(1);
  }
  console.log('');
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
