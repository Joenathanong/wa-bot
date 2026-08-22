'use strict';

/**
 * Hapus Windows Service milik bot.
 *
 *   npm run service:uninstall    (Command Prompt sebagai Administrator)
 *
 * Data, sesi WhatsApp, dan konfigurasi tidak ikut terhapus.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../src/config');

const SERVICE_NAME = process.env.SERVICE_NAME || 'Telegram WA Bridge';

function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  HAPUS WINDOWS SERVICE');
  console.log('==========================================================');
  console.log('');

  if (os.platform() !== 'win32') {
    console.error('Skrip ini hanya untuk Windows.');
    process.exit(1);
  }

  try {
    execFileSync('net', ['session'], { stdio: 'ignore' });
  } catch (err) {
    console.error('PERLU HAK ADMINISTRATOR.');
    console.error('Buka Command Prompt sebagai administrator, lalu:');
    console.error('  cd /d "' + config.ROOT + '"');
    console.error('  npm run service:uninstall');
    process.exit(1);
  }

  let Service;
  try {
    ({ Service } = require('node-windows'));
  } catch (err) {
    console.error('Library "node-windows" tidak ditemukan. Jalankan: npm install node-windows');
    process.exit(1);
  }

  const svc = new Service({
    name: SERVICE_NAME,
    script: path.join(config.ROOT, 'src', 'index.js'),
  });

  const bersihkanDaemon = () => {
    // Bila folder ini tertinggal, pemasangan berikutnya akan dikira
    // "sudah terpasang" oleh node-windows padahal Windows tidak mengenalnya.
    const dir = path.join(config.ROOT, 'src', 'daemon');
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      if (!fs.existsSync(dir)) console.log('Folder ' + dir + ' dibersihkan.');
    } catch (err) {
      console.log('Folder daemon tidak bisa dihapus otomatis: ' + (err.code || err.message));
      console.log('Hapus manual bila pemasangan berikutnya bermasalah: ' + dir);
    }
  };

  svc.on('uninstall', () => {
    bersihkanDaemon();
    console.log('✔ Service dihapus: ' + SERVICE_NAME + ' (id ' + (svc.id || '-') + ')');
    console.log('');
    console.log('Data, sesi WhatsApp, dan file .env tetap utuh.');
    console.log('Untuk menjalankan manual lagi: npm start');
    console.log('');
    process.exit(0);
  });

  svc.on('alreadyuninstalled', () => {
    console.log('Service dengan nama ini memang tidak ada.');
    bersihkanDaemon();
    process.exit(0);
  });

  svc.on('error', (err) => {
    console.error('Gagal menghapus service:', err && err.message ? err.message : err);
    console.error('Pastikan Command Prompt dijalankan SEBAGAI ADMINISTRATOR.');
    process.exit(1);
  });

  console.log('Menghentikan dan menghapus service...');
  svc.stop();
  svc.uninstall();
}

main();
