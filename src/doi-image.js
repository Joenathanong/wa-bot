'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger').scope('DOI');
const { ukuranSvg } = require('./doi-client');

/**
 * Pengubah SVG menjadi gambar raster (PNG/JPEG) untuk dikirim ke WhatsApp.
 *
 * WhatsApp tidak menampilkan SVG. Jadi SVG dari web DOI harus dirender dulu.
 *
 * ===================== KENAPA TIGA JALUR? =====================
 * Petunjuk aslinya memakai ImageMagick ("convert doi.svg doi.jpg"). Itu
 * bekerja di meja kerja, tetapi menjadikan pengiriman laporan bergantung
 * pada satu program yang harus dipasang terpisah di PC produksi - dan pada
 * mesin Windows yang baru diinstal, ImageMagick nyaris pasti belum ada.
 * Aplikasi ini sudah membawa Chrome (dipakai WhatsApp Web), jadi perender
 * SVG kelas satu SUDAH ADA di mesin yang sama.
 *
 * Urutan yang dicoba:
 *   1. sharp          - bila kebetulan terpasang; paling cepat.
 *   2. Chrome         - browser yang sama dengan WhatsApp Web. TANPA pemasangan
 *                       tambahan apa pun. Ini jalur utama di produksi.
 *   3. ImageMagick    - magick / convert, bila memang ada di PATH.
 *
 * Yang pertama berhasil dipakai, dan cara yang dipakai ikut dilaporkan supaya
 * /doistatus bisa menyebutkannya - kalau hasil gambarnya aneh, langkah pertama
 * diagnosa adalah mengetahui siapa yang merendernya.
 * ==============================================================
 */

const LEBAR_BAWAAN = 1080;
const LEBAR_MAKS = 2000;

function mime(format) {
  return format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
}

function ekstensi(format) {
  return format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png';
}

/**
 * Ukuran render akhir: lebar mengikuti setelan, tinggi mengikuti rasio SVG
 * supaya gambarnya tidak gepeng. SVG tanpa ukuran sama sekali dirender pada
 * lebar bawaan dengan tinggi mengikuti isi.
 */
function hitungUkuran(svg, lebarDiminta) {
  const lebar = Math.min(LEBAR_MAKS, Math.max(200, parseInt(lebarDiminta, 10) || LEBAR_BAWAAN));
  const asli = ukuranSvg(svg);
  if (!asli) return { width: lebar, height: null, skala: null };
  const skala = lebar / asli.width;
  return { width: lebar, height: Math.max(1, Math.round(asli.height * skala)), skala };
}

/* ------------------------------ 1. sharp ------------------------------ */

async function lewatSharp(svg, { format, lebar }) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    return null;                    // tidak terpasang - bukan kegagalan
  }
  const u = hitungUkuran(svg, lebar);
  let img = sharp(Buffer.from(svg), { density: 192 }).resize({
    width: u.width,
    ...(u.height ? { height: u.height } : {}),
    fit: 'contain',
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  }).flatten({ background: { r: 255, g: 255, b: 255 } });
  img = (format === 'jpeg' || format === 'jpg')
    ? img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    : img.png({ compressionLevel: 9 });
  const buffer = await img.toBuffer();
  return { buffer, mimetype: mime(format), cara: 'sharp' };
}

/* ------------------------------ 2. Chrome ----------------------------- */

/**
 * Render memakai Chrome yang sudah dipakai WhatsApp Web.
 *
 * Halaman baru dibuka di browser yang SAMA, lalu ditutup lagi. Halaman
 * WhatsApp Web tidak disentuh sedikit pun - membaginya akan merusak sesi.
 *
 * @param {() => any} ambilBrowser fungsi yang mengembalikan puppeteer Browser
 */
async function lewatChrome(svg, { format, lebar, ambilBrowser }) {
  if (typeof ambilBrowser !== 'function') return null;
  const browser = await ambilBrowser();
  if (!browser || typeof browser.newPage !== 'function') return null;

  const u = hitungUkuran(svg, lebar);
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({
      width: u.width,
      height: u.height || 1200,
      deviceScaleFactor: 2,          // teks tabel tetap tajam saat di-zoom
    });
    // SVG ditanam langsung di dalam halaman, bukan lewat <img src>: <img>
    // memblokir font dan gaya di dalam SVG, sehingga tabelnya berubah bentuk.
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<style>html,body{margin:0;padding:0;background:#fff}'
      + `svg{display:block;width:${u.width}px;height:auto}</style></head>`
      + `<body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });

    const el = await page.$('svg');
    const tembakan = {
      type: (format === 'jpeg' || format === 'jpg') ? 'jpeg' : 'png',
      ...((format === 'jpeg' || format === 'jpg') ? { quality: 92 } : {}),
    };
    // Tangkap elemen SVG-nya, bukan seluruh halaman: tanpa ini, halaman yang
    // lebih tinggi daripada gambar menyisakan pita putih di bawah.
    const buffer = el
      ? await el.screenshot(tembakan)
      : await page.screenshot({ ...tembakan, fullPage: true });
    return { buffer: Buffer.from(buffer), mimetype: mime(format), cara: 'Chrome' };
  } finally {
    if (page) { try { await page.close(); } catch (e) { /* halaman sudah tertutup */ } }
  }
}

/* --------------------------- 3. ImageMagick --------------------------- */

function jalankan(perintah, argumen, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(perintah, argumen, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      resolve(String(stdout || ''));
    });
  });
}

async function lewatImageMagick(svg, { format, lebar }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doi-'));
  const masuk = path.join(dir, 'doi.svg');
  const keluar = path.join(dir, `doi.${ekstensi(format)}`);
  const u = hitungUkuran(svg, lebar);
  try {
    fs.writeFileSync(masuk, svg, 'utf8');
    const argumen = [
      '-background', 'white', '-density', '192',
      masuk, '-resize', `${u.width}x`, '-flatten', keluar,
    ];
    let cara = null;
    for (const program of ['magick', 'convert']) {
      try {
        await jalankan(program, program === 'magick' ? argumen : argumen);
        cara = `ImageMagick (${program})`;
        break;
      } catch (err) {
        logger.debug(`${program} tidak bisa dipakai: ${err.message}`);
      }
    }
    if (!cara) return null;
    const buffer = fs.readFileSync(keluar);
    return { buffer, mimetype: mime(format), cara };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* diabaikan */ }
  }
}

/* ------------------------------- gabungan ----------------------------- */

/**
 * Ubah SVG menjadi gambar siap kirim.
 *
 * @param {string} svg
 * @param {{format?: string, lebar?: number, ambilBrowser?: Function, urutan?: string[]}} opsi
 * @returns {Promise<{buffer: Buffer, mimetype: string, cara: string, nama: string}>}
 */
async function svgKeGambar(svg, opsi = {}) {
  if (!svg || typeof svg !== 'string') throw new Error('SVG kosong');
  const format = String(opsi.format || 'png').toLowerCase();
  const lebar = opsi.lebar || LEBAR_BAWAAN;
  const jalur = {
    sharp: lewatSharp,
    chrome: lewatChrome,
    imagemagick: lewatImageMagick,
  };
  const urutan = Array.isArray(opsi.urutan) && opsi.urutan.length > 0
    ? opsi.urutan
    : ['sharp', 'chrome', 'imagemagick'];

  const gagal = [];
  for (const nama of urutan) {
    const fn = jalur[nama];
    if (!fn) continue;
    try {
      const hasil = await fn(svg, { format, lebar, ambilBrowser: opsi.ambilBrowser });
      if (hasil && hasil.buffer && hasil.buffer.length > 0) {
        logger.info(`SVG DOI dirender lewat ${hasil.cara} (${Math.round(hasil.buffer.length / 1024)} KB).`);
        return { ...hasil, nama: `doi.${ekstensi(format)}` };
      }
      gagal.push(`${nama}: tidak tersedia`);
    } catch (err) {
      gagal.push(`${nama}: ${err.message}`);
      logger.warn(`Render lewat ${nama} gagal: ${err.message}`);
    }
  }
  throw new Error(
    `tidak ada perender SVG yang bisa dipakai (${gagal.join(' | ')}). `
    + 'Jalur utamanya adalah Chrome yang dipakai WhatsApp Web - pastikan WhatsApp '
    + 'sudah tersambung, atau pasang salah satu: npm install sharp, atau ImageMagick.'
  );
}

module.exports = {
  svgKeGambar,
  hitungUkuran,
  mime,
  ekstensi,
  LEBAR_BAWAAN,
  _lewatSharp: lewatSharp,
  _lewatChrome: lewatChrome,
  _lewatImageMagick: lewatImageMagick,
};
