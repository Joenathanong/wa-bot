'use strict';

/**
 * Pasang bot sebagai WINDOWS SERVICE.
 *
 *   npm run service:install   (Command Prompt / PowerShell sebagai Administrator)
 *
 * Kelebihan dibanding PM2:
 *   - berjalan di luar sesi login, jadi Anda boleh logout, ganti user,
 *     atau mengunci layar tanpa mematikan bot;
 *   - Windows menyalakannya sendiri saat booting, sebelum siapa pun login;
 *   - tidak perlu auto-login yang menurunkan keamanan.
 *
 * Konsekuensinya: tidak ada terminal untuk menampilkan QR WhatsApp.
 * Karena itu QR dikirim sebagai gambar ke admin lewat Telegram.
 *
 * Skrip ini tidak mempercayai laporan library. Setiap klaim "sudah terpasang"
 * maupun "berhasil" diverifikasi langsung ke Windows lewat `sc query`, karena
 * node-windows menilainya dari keberadaan berkas, bukan dari daftar service.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../src/config');

const SERVICE_NAME = process.env.SERVICE_NAME || 'Telegram WA Bridge';
const AKUN_KHUSUS = (process.env.SERVICE_ACCOUNT || '').trim();

let sudahSelesai = false;

/* ----------------------------- pembantu ----------------------------- */

function keluar(pesan, kode = 1) {
  console.error('');
  console.error(pesan);
  console.error('');
  process.exit(kode);
}

function tidur(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows menolak pendaftaran service tanpa hak Administrator, TETAPI
 * node-windows memancarkan event "install" dan "start" tanpa memeriksanya.
 * Tanpa pemeriksaan ini, skrip melaporkan sukses padahal tidak terjadi apa-apa.
 */
function punyaHakAdmin() {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

/** Tanya Windows: service ini ada, dan sedang apa? null = tidak terdaftar. */
function statusService(id) {
  try {
    const keluaran = execFileSync('sc', ['query', id], { encoding: 'utf8' });
    const m = /STATE\s*:\s*\d+\s+(\w+)/i.exec(keluaran);
    return m ? m[1].toUpperCase() : 'TIDAK DIKETAHUI';
  } catch (err) {
    return null;
  }
}

/**
 * Cari service dengan sabar.
 *
 * Dua jebakan yang pernah membuat skrip ini salah lapor:
 *  1. `svc.id` dari node-windows TIDAK memuat ".exe", sedangkan WinSW
 *     mendaftarkan service dengan id + ".exe". Kedua bentuk harus dicoba.
 *  2. Pendaftaran dan penyalaan butuh beberapa detik; menanyakannya seketika
 *     dijawab "tidak ada" padahal sedang berlangsung.
 */
function tungguService(kandidat, timeoutMs = 20000) {
  const batas = Date.now() + timeoutMs;
  let terakhir = null;
  for (;;) {
    for (const id of kandidat) {
      const state = statusService(id);
      if (state !== null) {
        terakhir = { id, state };
        if (state === 'RUNNING') return terakhir;
      }
    }
    if (Date.now() >= batas) return terakhir;
    tidur(1500);
  }
}

function nyalakan(id) {
  try {
    execFileSync('sc', ['start', id], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function folderDaemon() {
  return path.join(config.ROOT, 'src', 'daemon');
}

/**
 * Rapikan XML WinSW sebelum didaftarkan.
 *
 * node-windows menulis blok <serviceaccount> berisi domain mesin + user
 * "LocalSystem". Itu BUKAN akun yang sah - LocalSystem adalah akun bawaan
 * tanpa domain. Bila <allowservicelogon> ikut menyala, WinSW mencoba memberi
 * hak "Log on as a service" ke akun itu, gagal dengan
 *   LookupAccountName failed: 1332
 * dan membatalkan seluruh pemasangan.
 *
 * Tanpa blok tersebut, Windows menjalankannya sebagai LocalSystem - yang
 * memang diinginkan.
 */
function bersihkanXml(dir) {
  if (AKUN_KHUSUS) return;   // akun khusus memang membutuhkan blok itu

  let berkas = null;
  try {
    berkas = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.xml'));
  } catch (err) { return; }
  if (!berkas) return;

  const penuh = path.join(dir, berkas);
  try {
    const isi = fs.readFileSync(penuh, 'utf8');
    const bersih = isi.replace(/\s*<serviceaccount>[\s\S]*?<\/serviceaccount>/i, '');
    if (bersih !== isi) {
      fs.writeFileSync(penuh, bersih, 'utf8');
      console.log('Blok <serviceaccount> yang tidak sah dihapus dari ' + berkas + '.');
      console.log('Service akan berjalan sebagai LocalSystem (bawaan Windows).');
    }
  } catch (err) {
    console.log('Tidak dapat merapikan XML service: ' + err.message);
  }
}

/**
 * Daftarkan service langsung lewat WinSW, melewati node-windows.
 * Dipakai bila node-windows gagal - helper elevasinya kerap gagal diam-diam.
 */
function pasangLangsung(kandidat) {
  const dir = folderDaemon();
  bersihkanXml(dir);

  let exe = null;
  try {
    exe = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe'));
  } catch (err) { /* folder belum ada */ }
  if (!exe) return null;

  const penuh = path.join(dir, exe);
  console.log('');
  console.log('Mendaftarkan langsung lewat WinSW: ' + penuh);
  try {
    execFileSync(penuh, ['install'], { cwd: dir, stdio: 'inherit' });
  } catch (err) {
    console.error('Pendaftaran langsung gagal: ' + (err.message || err));
    return null;
  }
  return tungguService(kandidat, 20000);
}

/* --------------------------- penyelesaian --------------------------- */

function selesaikan(kandidat, catatan) {
  if (sudahSelesai) return;
  sudahSelesai = true;

  console.log('Memastikan ke Windows (bisa sampai 20 detik)...');
  let hasil = tungguService(kandidat, 20000);

  if (!hasil) {
    if (catatan) console.log(catatan);
    hasil = pasangLangsung(kandidat);
  }

  if (!hasil) {
    console.error('');
    console.error('GAGAL: Windows tidak mengenal service ini.');
    console.error('Sudah dicoba dua nama: ' + kandidat.join(' dan '));
    console.error('');
    console.error('Coba daftarkan manual (Command Prompt sebagai Administrator):');
    console.error('  cd /d "' + folderDaemon() + '"');
    console.error('  telegramwabridge.exe install');
    console.error('  sc start telegramwabridge.exe');
    console.error('');
    console.error('Bila muncul "LookupAccountName failed: 1332", hapus seluruh blok');
    console.error('<serviceaccount>...</serviceaccount> dari berkas XML di folder itu,');
    console.error('lalu ulangi perintah install.');
    console.error('');
    console.error('Bila tetap gagal, pindahkan project ke jalur TANPA SPASI');
    console.error('(mis. C:\\bot\\telegram-wa-bridge) lalu ulangi.');
    console.error('');
    process.exit(1);
  }

  const id = hasil.id;
  let state = hasil.state;

  if (state !== 'RUNNING') {
    console.log('Menyalakan service...');
    nyalakan(id);
    const lagi = tungguService([id], 20000);
    if (lagi) state = lagi.state;
  }

  console.log('');
  console.log('✔ Service terdaftar dan berstatus: ' + state);
  console.log('  Nama tampilan : ' + SERVICE_NAME);
  console.log('  ID service    : ' + id + '   <- pakai ini untuk net/sc');
  console.log('');
  console.log('Yang perlu diketahui:');
  console.log('  • Bot tetap hidup walau Anda logout atau berganti user.');
  console.log('  • Log aplikasi : ' + path.join(config.ROOT, 'data', 'app.log'));
  console.log('  • Log service  : ' + folderDaemon());
  console.log('  • QR WhatsApp dikirim ke admin lewat Telegram, bukan ke layar.');
  console.log('');
  console.log('Periksa kapan saja:  npm run service:status');
  console.log('Kelola lewat services.msc, atau sebagai Administrator:');
  console.log('    net stop ' + id);
  console.log('    net start ' + id);
  console.log('');

  if (state !== 'RUNNING') {
    console.log('CATATAN: status masih ' + state + '.');
    console.log('Periksa ' + path.join(config.ROOT, 'data', 'app.log') + ' untuk alasannya.');
    console.log('');
  }
  process.exit(0);
}

/* ------------------------------- utama ------------------------------ */

function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  PASANG SEBAGAI WINDOWS SERVICE');
  console.log('==========================================================');
  console.log('');

  if (os.platform() !== 'win32') {
    keluar('Skrip ini hanya untuk Windows. Di Linux gunakan systemd atau PM2.');
  }

  if (!punyaHakAdmin()) {
    keluar([
      'PERLU HAK ADMINISTRATOR.',
      '',
      'Windows tidak mengizinkan pendaftaran service dari prompt biasa,',
      'dan kegagalannya TIDAK terlihat - seolah berhasil padahal tidak.',
      '',
      'Caranya:',
      '  1. Tekan tombol Windows, ketik: cmd',
      '  2. Klik kanan "Command Prompt" > Run as administrator',
      '  3. cd /d "' + config.ROOT + '"',
      '  4. npm run service:install',
      '',
      'Git Bash atau PowerShell biasa tidak cukup, kecuali dibuka sebagai administrator.',
    ].join('\n'));
  }

  let Service;
  try {
    ({ Service } = require('node-windows'));
  } catch (err) {
    keluar([
      'Library "node-windows" belum terpasang. Jalankan sekali:',
      '',
      '    npm install node-windows',
      '',
      'lalu ulangi perintah ini.',
    ].join('\n'));
  }

  const cek = config.validate();
  if (!cek.ok) {
    console.error('Konfigurasi belum siap:');
    for (const e of cek.errors) console.error('  • ' + e);
    keluar('Perbaiki file .env lalu ulangi.');
  }

  const sesiWa = path.join(config.whatsapp.sessionPath, `session-${config.whatsapp.clientId}`);
  if (!fs.existsSync(sesiWa)) {
    console.log('CATATAN: sesi WhatsApp belum ada.');
    console.log('  Service akan mengirim QR ke admin lewat Telegram saat pertama jalan.');
    console.log('  Bila lebih suka memindai dari layar, jalankan "npm start" dulu,');
    console.log('  scan QR, hentikan, lalu pasang service ini.');
    console.log('');
  }

  const svc = new Service({
    name: SERVICE_NAME,
    description: 'Meneruskan peringatan stok dari Telegram ke WhatsApp Group dengan mention.',
    script: path.join(config.ROOT, 'src', 'index.js'),
    workingDirectory: config.ROOT,
    // Hanya diaktifkan bila memakai akun Windows tertentu. Bila dinyalakan
    // untuk LocalSystem, WinSW gagal dengan "LookupAccountName failed: 1332".
    allowServiceLogon: !!AKUN_KHUSUS,
    env: [{ name: 'NODE_ENV', value: 'production' }],
    stopparentfirst: true,
    wait: 5,
    grow: 0.5,
    maxRestarts: 20,
  });

  const dasar = svc.id || 'telegramwabridge';
  const kandidat = [dasar + '.exe', dasar];

  if (AKUN_KHUSUS) {
    svc.logOnAs.domain = (process.env.SERVICE_DOMAIN || os.hostname()).trim();
    svc.logOnAs.account = AKUN_KHUSUS;
    svc.logOnAs.password = process.env.SERVICE_PASSWORD || '';
    console.log('Service akan berjalan sebagai akun: ' + svc.logOnAs.domain + '\\' + AKUN_KHUSUS);
    console.log('Pastikan akun itu punya hak "Log on as a service".');
  } else {
    console.log('Service akan berjalan sebagai LocalSystem.');
    console.log('Bila Chrome gagal dijalankan di mode ini, isi SERVICE_ACCOUNT dan');
    console.log('SERVICE_PASSWORD di .env lalu pasang ulang.');
  }
  console.log('');

  // node-windows menilai "sudah terpasang" dari keberadaan berkas di
  // src/daemon, BUKAN dari daftar service Windows. Sisa folder dari percobaan
  // yang gagal membuatnya salah menyimpulkan - jadi tanyakan ke Windows.
  svc.on('alreadyinstalled', () => {
    selesaikan(kandidat,
      'node-windows mengira service sudah ada karena folder src/daemon masih\n' +
      'tertinggal, padahal Windows tidak mengenalnya. Mendaftarkan sendiri...');
  });

  svc.on('invalidinstallation', () => {
    console.error('Pemasangan tidak lengkap. Jalankan Command Prompt SEBAGAI ADMINISTRATOR.');
    process.exit(1);
  });

  svc.on('install', () => {
    console.log('Berkas service dibuat. Menjalankan...');
    try { svc.start(); } catch (err) { /* diverifikasi di bawah */ }
    selesaikan(kandidat, null);
  });

  svc.on('start', () => selesaikan(kandidat, null));

  svc.on('error', (err) => {
    console.error('Gagal memasang service:', err && err.message ? err.message : err);
    process.exit(1);
  });

  console.log('Memasang service...');
  svc.install();

  // Jaring pengaman bila node-windows tidak memancarkan event sama sekali.
  const jaring = setTimeout(
    () => selesaikan(kandidat, 'Tidak ada kabar dari node-windows. Memeriksa sendiri...'),
    25000
  );
  if (jaring.unref) jaring.unref();
}

main();
