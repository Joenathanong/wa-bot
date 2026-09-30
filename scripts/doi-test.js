'use strict';

/**
 * Uji MONITORING DOI tanpa mengirim apa pun ke WhatsApp.
 *
 *   npm run doi:test                 - ambil SVG, render gambar, simpan ke data/
 *   npm run doi:test -- --teks       - hanya cetak teks pendamping (tanpa jaringan)
 *   npm run doi:test -- --url <url>  - pakai URL lain untuk sekali uji ini
 *
 * Gambarnya disimpan ke data/doi-test.png (atau .jpg) supaya bisa dibuka dan
 * dilihat sendiri sebelum dilepas ke group WhatsApp.
 */

const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const Database = require(path.join(__dirname, '..', 'src', 'database'));
const DoiScheduler = require(path.join(__dirname, '..', 'src', 'doi-scheduler'));
const { ambilSvg, samarkanUrl } = require(path.join(__dirname, '..', 'src', 'doi-client'));
const { svgKeGambar, ekstensi } = require(path.join(__dirname, '..', 'src', 'doi-image'));
const { tangkapHalaman } = require(path.join(__dirname, '..', 'src', 'doi-page'));
const { findLocalBrowser } = require(path.join(__dirname, '..', 'src', 'whatsapp'));

const argv = process.argv.slice(2);
const HANYA_TEKS = argv.includes('--teks');
const urlArg = (() => {
  const i = argv.indexOf('--url');
  return i >= 0 ? argv[i + 1] : null;
})();

function garis(judul) {
  console.log('\n' + '='.repeat(64));
  if (judul) console.log('  ' + judul);
  console.log('='.repeat(64));
}

/**
 * Chrome untuk uji ini dijalankan SENDIRI.
 *
 * Di aplikasi yang hidup, perender memakai Chrome milik WhatsApp Web. Skrip
 * uji tidak menyalakan WhatsApp (dan tidak boleh: itu akan memperebutkan
 * folder sesi), jadi di sini Chrome dinyalakan terpisah lalu ditutup lagi.
 */
async function browserSendiri() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    console.log('  (puppeteer tidak bisa dimuat - jalur Chrome dilewati)');
    return null;
  }
  const exe = config.whatsapp.chromePath || findLocalBrowser();
  try {
    return await puppeteer.launch({
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    console.log(`  (Chrome tidak bisa dijalankan: ${err.message})`);
    return null;
  }
}

async function main() {
  const db = new Database(config.db.path);
  const doi = new DoiScheduler({
    db, whatsapp: { isReady: () => false, browser: () => null }, queue: null, config,
  });
  const o = doi.opsi();

  garis('UJI MONITORING DOI');
  console.log(`URL          : ${samarkanUrl(urlArg || o.url)}`);
  console.log(`Cara         : ${o.mode === 'halaman'
    ? `tangkap layar halaman ${o.lebar}x${o.tinggi} @${o.skala}x`
    : `render SVG ${o.lebar}px`}`);
  if (o.mode === 'halaman') console.log(`Penanda siap : ${o.selector || '(tidak ditunggu)'}`);
  console.log(`Jam kirim    : ${o.hours.length ? o.hours.map((j) => `${String(j).padStart(2, '0')}:00`).join(', ') : '(belum disetel)'} ${o.tzLabel}`);
  console.log(`Format       : ${o.format.toUpperCase()} ${o.lebar}px`);
  console.log(`Teks jadi    : ${o.caption ? 'caption gambar' : 'pesan kedua'}`);
  const groups = doi.targetGroups();
  console.log(`Group tujuan : ${groups.length ? groups.map((g) => `${g.name} (${g.id})`).join(', ') : '(BELUM DISETEL)'}`);

  garis('TEKS PENDAMPING');
  const teks = doi.susunTeks();
  console.log(teks.text);
  console.log(`\n(${teks.mentions.length} mention: ${teks.mentions.join(', ') || '-'})`);
  const tanpaNomor = teks.pic.filter((p) => !p.nomor);
  if (tanpaNomor.length > 0) {
    console.log(`PERHATIAN: ${tanpaNomor.map((p) => p.nama).join(', ')} disapa tetapi TIDAK di-mention `
      + '(nomornya belum diisi - /doiwa).');
  }
  if (HANYA_TEKS) { db.close(); return; }

  const alamat = urlArg || o.url;
  if (!alamat) {
    console.log('\nURL belum disetel. Setel dulu: /doiurl <url> di Telegram, '
      + 'atau DOI_URL di .env, atau jalankan: npm run doi:test -- --url <url>');
    db.close();
    return;
  }

  garis(o.mode === 'halaman' ? 'TANGKAP LAYAR HALAMAN' : 'AMBIL SVG & RENDER');
  const browser = await browserSendiri();
  try {
    let gambar;
    if (o.mode === 'halaman') {
      if (!browser) throw new Error('Chrome tidak bisa dijalankan - mode halaman butuh browser. '
        + 'Isi CHROME_PATH di .env, atau uji mode SVG.');
      gambar = await tangkapHalaman(alamat, {
        ambilBrowser: () => browser,
        lebar: o.lebar,
        tinggi: o.tinggi,
        skala: o.skala,
        format: o.format,
        selector: o.selector,
        timeoutMs: o.timeoutMs,
      });
    } else {
      const { svg, bytes } = await ambilSvg(alamat, { timeoutMs: o.timeoutMs });
      console.log(`SVG terambil : ${Math.round(bytes / 1024)} KB`);
      gambar = await svgKeGambar(svg, {
        format: o.format,
        lebar: o.lebar,
        ambilBrowser: () => browser,
      });
    }
    const tujuan = path.join(path.dirname(config.db.path), `doi-test.${ekstensi(o.format)}`);
    fs.writeFileSync(tujuan, gambar.buffer);
    console.log(`Perender     : ${gambar.cara}`);
    console.log(`Ukuran       : ${Math.round(gambar.buffer.length / 1024)} KB`);
    console.log(`Disimpan ke  : ${tujuan}`);
    console.log('\nBuka berkas itu untuk memastikan gambarnya utuh sebelum dikirim ke group.');
    if (o.mode === 'halaman') {
      console.log('Periksa: apakah posternya penuh tanpa baris tombol, dan datanya sudah tampil?');
    }
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* diabaikan */ } }
    db.close();
  }
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  process.exit(1);
});
