'use strict';

/**
 * Pemeriksaan kesiapan.
 *
 *   npm run setup
 *
 * Menjawab satu pertanyaan: apa lagi yang kurang sebelum bot bisa jalan?
 * Berguna terutama setelah memindahkan project ke PC baru - semuanya
 * diperiksa sekaligus, bukan ditemukan satu per satu lewat kegagalan.
 *
 * Tidak mengubah apa pun. Hanya membaca dan melapor.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../src/config');

const OK = '  [ OK ] ';
const WARN = '  [ !  ] ';
const BAD = '  [GAGAL] ';

const langkah = [];   // hal yang masih harus dikerjakan pengguna
let adaMasalah = false;

function judul(t) {
  console.log('');
  console.log(t);
  console.log('-'.repeat(t.length));
}

function ok(t) { console.log(OK + t); }
function warn(t) { console.log(WARN + t); }
function bad(t) { console.log(BAD + t); adaMasalah = true; }

/* --------------------------- pemeriksaan --------------------------- */

function cekNode() {
  judul('Node.js');
  const versi = process.versions.node;
  const mayor = parseInt(versi.split('.')[0], 10);
  if (mayor >= 20) ok(`Node ${versi}`);
  else if (mayor >= 18) warn(`Node ${versi} - jalan, tetapi disarankan Node 20/22 LTS`);
  else {
    bad(`Node ${versi} terlalu lama. Perlu minimal 18, disarankan 22 LTS.`);
    langkah.push('Pasang Node.js 22 LTS: winget install -e --id OpenJS.NodeJS.LTS');
  }
}

function cekDependency() {
  judul('Dependency');
  const wajib = Object.keys(require('../package.json').dependencies || {});
  const hilang = [];
  for (const nama of wajib) {
    try {
      require.resolve(nama);
    } catch (err) {
      hilang.push(nama);
    }
  }
  if (hilang.length === 0) {
    ok(`${wajib.length} paket terpasang`);
  } else {
    bad('Belum terpasang: ' + hilang.join(', '));
    langkah.push('Pasang dependency: npm ci   (atau npm install bila belum ada package-lock.json)');
  }

  const lock = path.join(config.ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) ok('package-lock.json ada - versi bisa direproduksi dengan npm ci');
  else warn('package-lock.json tidak ada - jalankan npm install sekali untuk membuatnya');
}

function cekEnv() {
  judul('Konfigurasi (.env)');
  if (!fs.existsSync(path.join(config.ROOT, '.env'))) {
    bad('.env belum ada');
    langkah.push('Salin .env.example menjadi .env lalu isi TELEGRAM_BOT_TOKEN dan ADMIN_TELEGRAM_IDS');
    return;
  }
  const cek = config.validate();
  for (const e of cek.errors) bad(e);
  for (const w of cek.warnings) warn(w);
  if (cek.ok && cek.warnings.length === 0) ok('Lengkap');
  else if (cek.ok) ok('Cukup untuk dijalankan');
  else langkah.push('Perbaiki isi .env sesuai pesan di atas');

  if (config.whatsapp.webVersion) {
    warn('WA_WEB_VERSION disematkan: ' + config.whatsapp.webVersion);
    warn('  Versi terlalu lama bisa ditolak WhatsApp dan memicu LOGOUT.');
    warn('  Hapus baris itu bila tidak sedang mengatasi masalah tertentu.');
  }
}

function cekChrome() {
  judul('Browser untuk WhatsApp Web');
  if (config.whatsapp.chromePath) {
    if (fs.existsSync(config.whatsapp.chromePath)) {
      ok('CHROME_PATH: ' + config.whatsapp.chromePath);
    } else {
      bad('CHROME_PATH menunjuk berkas yang tidak ada: ' + config.whatsapp.chromePath);
      langkah.push('Perbaiki atau hapus CHROME_PATH di .env - aplikasi bisa mencari Chrome sendiri');
    }
    return;
  }
  const { findLocalBrowser } = require('../src/whatsapp');
  const ketemu = findLocalBrowser();
  if (ketemu) {
    ok('Ditemukan: ' + ketemu);
  } else {
    const bawaan = path.join(os.homedir(), '.cache', 'puppeteer');
    if (fs.existsSync(bawaan)) warn('Chrome sistem tidak ditemukan, tetapi ada cache Puppeteer di ' + bawaan);
    else {
      bad('Chrome maupun Edge tidak ditemukan');
      langkah.push('Pasang Chrome: winget install -e --id Google.Chrome');
    }
  }
}

function cekData() {
  judul('Data dan sesi');

  const db = config.db.path;
  if (fs.existsSync(db)) {
    try {
      const Database = require('../src/database');
      const d = new Database(db);
      const user = d.listActiveUsers().length;
      const grup = d.listActiveWaGroups().length;
      const tpl = d.getActiveTemplate();
      d.close();
      ok(`Database: ${user} user aktif, ${grup} group tujuan, template "${tpl ? tpl.name : '-'}"`);
      if (user === 0) langkah.push('Tambahkan user penerima mention lewat /admin > Kelola User');
      if (grup === 0) langkah.push('Tambahkan WhatsApp Group tujuan lewat /groups');
    } catch (err) {
      warn('Database ada tetapi tidak terbaca: ' + err.message);
    }
  } else {
    warn('Database belum ada - akan dibuat otomatis saat pertama dijalankan');
  }

  const sesiWa = path.join(config.whatsapp.sessionPath, `session-${config.whatsapp.clientId}`);
  if (fs.existsSync(sesiWa)) ok('Sesi WhatsApp ada - tidak perlu scan QR');
  else {
    warn('Sesi WhatsApp belum ada - perlu scan QR sekali');
    langkah.push('Jalankan npm start lalu scan QR (atau pasang service, QR dikirim lewat Telegram)');
  }

  if (config.usesUserSource) {
    if (fs.existsSync(config.telegramUser.sessionFile)) ok('Sesi akun Telegram ada');
    else {
      bad('Sesi akun Telegram belum ada, padahal TELEGRAM_SOURCE=' + config.source);
      langkah.push('Login akun Telegram: npm run tg:login');
    }
  }
}

function cekService() {
  if (os.platform() !== 'win32') return;
  judul('Windows Service');
  const kandidat = ['telegramwabridge.exe', 'telegramwabridge'];
  let ketemu = null;
  for (const id of kandidat) {
    try {
      const out = execFileSync('sc', ['query', id], { encoding: 'utf8' });
      const m = /STATE\s*:\s*\d+\s+(\w+)/i.exec(out);
      ketemu = { id, state: m ? m[1].toUpperCase() : 'TIDAK DIKETAHUI' };
      break;
    } catch (err) { /* lanjut ke kandidat berikutnya */ }
  }
  if (!ketemu) {
    warn('Belum terpasang sebagai service - bot hanya hidup selama terminal terbuka');
    langkah.push('Pasang service (Command Prompt sebagai Administrator): npm run service:install');
  } else if (ketemu.state === 'RUNNING') {
    ok(`${ketemu.id} sedang RUNNING`);
  } else {
    warn(`${ketemu.id} terdaftar tetapi ${ketemu.state}`);
    langkah.push(`Nyalakan service: net start ${ketemu.id}`);
  }
}

/* ------------------------------ utama ------------------------------ */

function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  PEMERIKSAAN KESIAPAN');
  console.log('  ' + config.ROOT);
  console.log('==========================================================');

  cekNode();
  cekDependency();
  cekEnv();
  cekChrome();
  cekData();
  cekService();

  console.log('');
  console.log('==========================================================');
  if (langkah.length === 0) {
    console.log('  SIAP. Tidak ada yang perlu dikerjakan.');
    console.log('==========================================================');
    console.log('');
    console.log('Periksa keadaan bot kapan saja:  npm run service:status');
    console.log('');
    process.exit(0);
  }

  console.log('  YANG MASIH PERLU DIKERJAKAN');
  console.log('==========================================================');
  console.log('');
  langkah.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  console.log('');
  process.exit(adaMasalah ? 1 : 0);
}

main();
