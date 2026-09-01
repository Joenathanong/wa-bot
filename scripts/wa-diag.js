'use strict';

/**
 * Diagnosa koneksi WhatsApp - kumpulkan SEMUA yang dibutuhkan untuk
 * menentukan kenapa WhatsApp tidak pernah siap, dalam satu perintah.
 *
 *   npm run wa:diag
 *
 * Tidak menyambung ke WhatsApp dan tidak mengubah apa pun. Aman dijalankan
 * sementara service sedang berjalan.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'src', 'config'));

function garis(judul) {
  console.log('\n' + '='.repeat(66));
  if (judul) console.log('  ' + judul);
  console.log('='.repeat(66));
}

const temuan = [];
function catat(tingkat, teks, saran) {
  temuan.push({ tingkat, teks, saran });
}

function ukuranFolder(dir) {
  let total = 0;
  let jumlah = 0;
  const jalan = (d) => {
    let isi;
    try { isi = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of isi) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) jalan(p);
      else {
        try { total += fs.statSync(p).size; jumlah += 1; } catch (err) { /* abaikan */ }
      }
    }
  };
  jalan(dir);
  return { bytes: total, berkas: jumlah };
}

function cekPort(host) {
  return new Promise((resolve) => {
    const mulai = Date.now();
    const req = https.request({ hostname: host, port: 443, path: '/', method: 'HEAD', timeout: 10000 },
      (res) => { resolve({ ok: true, status: res.statusCode, ms: Date.now() - mulai }); res.resume(); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout 10 detik' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

async function main() {
  garis('DIAGNOSA KONEKSI WHATSAPP');
  console.log('Mesin      :', os.hostname(), `(${os.platform()} ${os.arch()})`);
  console.log('Node       :', process.version);
  console.log('Waktu      :', new Date().toISOString());

  /* ------------------------- 1. pengaturan ------------------------- */
  garis('1. PENGATURAN');
  const w = config.whatsapp || {};
  console.log('CHROME_PATH        :', w.chromePath || '(kosong - pakai Chromium bawaan Puppeteer)');
  console.log('WA_WEB_VERSION     :', w.webVersion || '(kosong - pakai versi terbaru)');
  console.log('WA_READY_TIMEOUT_MS:', w.readyTimeoutMs, `(${Math.round(w.readyTimeoutMs / 1000)} detik)`);

  // Jalur Windows tidak bisa diperiksa dari sistem lain - jangan sampai
  // laporan ini menuduh CHROME_PATH salah padahal cuma beda mesin.
  const jalurWindows = /^[A-Za-z]:\\/.test(w.chromePath || '');
  const bisaDiperiksa = w.chromePath && (process.platform === 'win32' || !jalurWindows);
  if (w.chromePath && !bisaDiperiksa) {
    console.log('  -> jalur Windows, tidak bisa diperiksa dari', process.platform, '- dilewati');
  } else if (w.chromePath) {
    if (fs.existsSync(w.chromePath)) {
      console.log('  -> berkas Chrome ADA');
    } else {
      console.log('  -> BERKAS TIDAK ADA di jalur itu');
      catat('GAWAT', 'CHROME_PATH menunjuk berkas yang tidak ada.',
        'Perbaiki CHROME_PATH di .env, atau kosongkan agar memakai Chromium bawaan.');
    }
  }
  if (w.webVersion) {
    catat('PERHATIAN', `WA_WEB_VERSION disematkan ke ${w.webVersion}.`,
      'Versi yang disematkan bisa menjadi usang dan justru memicu logout. '
      + 'Bila WhatsApp bermasalah, coba beri tanda # di depan baris ini lalu jalankan ulang.');
  }

  /* -------------------------- 2. folder sesi ------------------------ */
  garis('2. FOLDER SESI');
  const sesi = path.join(ROOT, '.wwebjs_auth');
  const sesiKlien = path.join(sesi, 'session-telegram-wa-bridge');
  console.log('Lokasi:', sesi);

  if (!fs.existsSync(sesi)) {
    console.log('  -> TIDAK ADA. Belum pernah login.');
    catat('GAWAT', 'Belum ada sesi WhatsApp sama sekali.',
      'Aplikasi akan berhenti di tahap QR sampai ada yang memindainya. '
      + 'QR dikirim sebagai gambar ke chat admin Telegram.');
  } else {
    const u = ukuranFolder(sesiKlien);
    const adaDefault = fs.existsSync(path.join(sesiKlien, 'Default'));
    console.log(`  -> ${u.berkas} berkas, ${(u.bytes / 1048576).toFixed(1)} MB`);
    console.log('  -> folder "Default":', adaDefault ? 'ADA' : 'TIDAK ADA');
    try {
      console.log('  -> terakhir diubah  :', fs.statSync(sesiKlien).mtime.toISOString());
    } catch (e) { /* abaikan */ }

    if (u.bytes < 1048576 || !adaDefault) {
      catat('GAWAT', 'Folder sesi ada tetapi isinya tidak wajar (terlalu kecil / tanpa "Default").',
        'Sesi kemungkinan rusak. Jalankan: npm run wa:reset lalu pindai QR baru.');
    }

    // Kunci profil - penanda Chrome masih memegang folder ini.
    for (const nama of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(sesiKlien, nama);
      if (fs.existsSync(p)) {
        console.log(`  -> ADA kunci profil: ${nama}`);
        catat('GAWAT', `Berkas kunci "${nama}" masih ada di folder sesi.`,
          'Biasanya berarti ada proses Chrome lama yang masih memegang folder ini. '
          + 'Hentikan service, jalankan: taskkill /F /IM chrome.exe /T, lalu nyalakan lagi.');
      }
    }
  }

  /* ------------------------- 3. proses Chrome ----------------------- */
  garis('3. PROSES CHROME YANG SEDANG JALAN');
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: 'utf8' });
      const baris = out.split('\n').map((x) => x.trim()).filter((x) => x.startsWith('"chrome.exe"'));
      console.log(`Ditemukan ${baris.length} proses chrome.exe`);
      if (baris.length > 20) {
        catat('PERHATIAN', `${baris.length} proses Chrome sedang berjalan.`,
          'Kalau WhatsApp tidak pernah siap, sebagian mungkin sisa percobaan sebelumnya '
          + 'yang menumpuk. taskkill /F /IM chrome.exe /T membersihkannya (menutup juga '
          + 'Chrome yang Anda pakai sendiri).');
      }
    } else {
      const out = execSync('ps -eo comm 2>/dev/null | grep -ci chrom || true', { encoding: 'utf8' });
      console.log('Proses chrome/chromium:', out.trim());
    }
  } catch (err) {
    console.log('Tidak bisa memeriksa daftar proses:', err.message);
  }

  /* --------------------------- 4. jaringan -------------------------- */
  garis('4. JARINGAN');
  for (const host of ['web.whatsapp.com', 'ocs.iegsystem.id']) {
    const r = await cekPort(host);
    console.log(`  ${host.padEnd(22)}`, r.ok ? `OK (HTTP ${r.status}, ${r.ms} ms)` : `GAGAL - ${r.error}`);
    if (!r.ok && host === 'web.whatsapp.com') {
      catat('GAWAT', 'Mesin ini tidak bisa menghubungi web.whatsapp.com.',
        'Periksa firewall/proxy kantor. Tanpa ini WhatsApp tidak akan pernah tersambung.');
    }
  }

  /* ---------------------------- 5. log ------------------------------ */
  garis('5. RIWAYAT WHATSAPP DI LOG');
  const logPath = config.logFile || path.join(ROOT, 'data', 'app.log');
  console.log('Berkas:', logPath);
  if (!fs.existsSync(logPath)) {
    console.log('  -> tidak ada.');
  } else {
    const isi = fs.readFileSync(logPath, 'utf8').split('\n');
    const wa = isi.filter((b) => b.includes('[WA]'));
    console.log(`  -> ${wa.length} baris [WA] dari ${isi.length} baris log`);

    const pola = {
      'QR dibuat (menunggu dipindai)': /QR generated/,
      'authenticated': /WhatsApp authenticated/,
      'READY (berhasil)': /WhatsApp ready/,
      'macet sebelum ready': /tidak pernah mencapai status/,
      'browser sudah berjalan': /browser is already running/,
      'sesi dicabut / logout': /LOGOUT|dicabut/i,
      'auth_failure': /authentication failed/,
    };
    console.log('\n  Ringkasan kejadian:');
    for (const [nama, re] of Object.entries(pola)) {
      const cocok = wa.filter((b) => re.test(b));
      if (cocok.length > 0) {
        console.log(`    ${String(cocok.length).padStart(4)}x  ${nama.padEnd(32)} terakhir: ${(cocok[cocok.length - 1].match(/^\[([^\]]+)\]/) || [, '?'])[1]}`);
      }
    }

    const macet = wa.filter((b) => /tidak pernah mencapai status/.test(b));
    if (macet.length > 0) {
      const terakhir = macet[macet.length - 1];
      const tahap = (terakhir.match(/macet di "([^"]+)"/) || [, '?'])[1];
      console.log(`\n  TAHAP MACET TERAKHIR: "${tahap}"`);
      if (tahap === 'qr') {
        catat('GAWAT', 'Macet di tahap QR - tidak ada yang memindai QR-nya.',
          'Ini TIDAK akan selesai sendiri berapa kali pun diulang. Buka chat admin '
          + 'Telegram, cari gambar QR terbaru, lalu pindai dari HP: WhatsApp > '
          + 'Perangkat Tertaut > Tautkan Perangkat.');
      } else if (tahap === 'authenticated') {
        catat('GAWAT', 'Macet di tahap authenticated - halaman WhatsApp Web tidak selesai dimuat.',
          'Hampir selalu ketidakcocokan build. Setel WA_WEB_VERSION=2.3000.1015901307 '
          + 'di .env lalu jalankan ulang. Bila malah logout, kosongkan lagi dan pindai QR baru.');
      }
    }

    console.log('\n  30 baris [WA] terakhir:');
    for (const b of wa.slice(-30)) console.log('   ', b);
  }

  /* --------------------------- kesimpulan --------------------------- */
  garis('KESIMPULAN');
  if (temuan.length === 0) {
    console.log('Tidak ada masalah yang terdeteksi dari pemeriksaan ini.');
    console.log('Bila WhatsApp tetap tidak siap, kirimkan seluruh keluaran perintah ini.');
  } else {
    for (const t of temuan) {
      console.log(`\n[${t.tingkat}] ${t.teks}`);
      console.log(`  -> ${t.saran}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error('Diagnosa gagal:', err.message);
  process.exit(1);
});
