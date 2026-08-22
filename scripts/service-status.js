'use strict';

/**
 * Lihat status Windows Service dan ekor log aplikasi.
 *
 *   npm run service:status
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../src/config');

const KANDIDAT = ['telegramwabridge.exe', 'telegramwabridge'];

function statusService(id) {
  try {
    const out = execFileSync('sc', ['query', id], { encoding: 'utf8' });
    const m = /STATE\s*:\s*\d+\s+(\w+)/i.exec(out);
    return m ? m[1].toUpperCase() : 'TIDAK DIKETAHUI';
  } catch (err) {
    return null;
  }
}

function main() {
  console.log('');
  console.log('=== STATUS WINDOWS SERVICE ===');
  console.log('');

  if (os.platform() !== 'win32') {
    console.log('Bukan Windows - lewati pemeriksaan service.');
  } else {
    let ketemu = false;
    for (const id of KANDIDAT) {
      const st = statusService(id);
      if (st !== null) {
        ketemu = true;
        console.log(`  ${id.padEnd(24)} ${st}`);
      }
    }
    if (!ketemu) {
      console.log('  Service belum terdaftar.');
      console.log('  Pasang dengan: npm run service:install  (Command Prompt sebagai Administrator)');
    }
  }

  const log = path.join(config.ROOT, 'data', 'app.log');
  console.log('');
  console.log('=== 25 BARIS TERAKHIR ' + log + ' ===');
  console.log('');
  try {
    const isi = fs.readFileSync(log, 'utf8').trim().split('\n');
    console.log(isi.slice(-25).join('\n'));
  } catch (err) {
    console.log('  (belum ada log - aplikasi belum pernah jalan dari sini)');
  }
  console.log('');
}

main();
