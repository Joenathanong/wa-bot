'use strict';

const logger = require('./logger').scope('DOI');
const { samarkanUrl } = require('./doi-client');

/**
 * Tangkap layar halaman web Monitoring DOI menjadi gambar siap kirim.
 *
 * ================== KENAPA TANGKAP LAYAR, BUKAN SVG? ==================
 * WhatsApp TIDAK BISA mengirim SVG - format itu bukan gambar yang dikenalinya.
 * Jadi apa pun jalurnya, SVG harus dirender lebih dulu. Ketika perendernya
 * memakai librsvg (sharp), font yang tidak ada di mesin diganti font lain dan
 * tata letaknya bergeser; tabel yang tadinya lurus jadi berantakan.
 *
 * Menangkap layar halaman web menghindari seluruh persoalan itu: yang merender
 * adalah browser, dengan font browser, jadi hasilnya PERSIS seperti yang
 * terlihat di layar. Dan browsernya sudah ada - Chrome yang sama dipakai
 * WhatsApp Web, tanpa satu pun dependensi baru.
 * ======================================================================
 *
 * Halaman DOI menyediakan mode khusus `?bare=1`: ukurannya pas 1600x900,
 * tanpa padding, tanpa baris tombol, tanpa popup. Jadi tangkapan VIEWPORT
 * langsung menjadi gambar jadi - bot tidak perlu mencari elemen atau menebak
 * ukuran, dan ukurannya tidak berubah walau tata letak halaman diubah nanti.
 *
 * TIGA HAL YANG MUDAH TERLEWAT, dan semuanya dijaga di berkas ini:
 *   1. Halaman BARU, bukan menavigasi halaman WhatsApp Web - itu memutus sesi.
 *   2. page.close() di dalam finally. Tanpa itu, tab menumpuk tiap hari
 *      sampai browsernya mati kehabisan memori.
 *   3. Menunggu PENANDA SIAP, bukan timer. Data halaman diambil setelah
 *      halaman tampil; tangkapan yang terlalu cepat menghasilkan poster
 *      kosong yang terlihat sah - itu jenis kesalahan yang paling berbahaya,
 *      karena tidak ada yang tahu isinya salah.
 */

const LEBAR_BAWAAN = 1600;
const TINGGI_BAWAAN = 900;
const SELECTOR_BAWAAN = '[data-siap="1"]';

/**
 * Pastikan URL halaman memuat `bare=1`.
 *
 * Tanpa parameter itu, yang tertangkap adalah halaman penuh berikut baris
 * tombol dan padding-nya - gambarnya "hampir benar", yang justru paling
 * mudah lolos tanpa disadari. Ditambahkan otomatis, bukan diserahkan pada
 * ingatan orang yang menempelkan URL-nya.
 */
function pastikanBare(url) {
  const teks = String(url || '').trim();
  if (!teks) return teks;
  try {
    const u = new URL(teks);
    if (/\/api\//.test(u.pathname)) return teks;   // endpoint API, bukan halaman
    if (!u.searchParams.has('bare')) {
      u.searchParams.set('bare', '1');
      return u.toString();
    }
    return teks;
  } catch (err) {
    return teks;                                    // URL tak sah diurus pemanggil
  }
}

/** Apakah URL ini halaman web (untuk ditangkap layar), bukan endpoint SVG? */
function tampakHalaman(url) {
  const teks = String(url || '').trim();
  if (!teks) return false;
  try {
    const u = new URL(teks);
    if (/\.svg$/i.test(u.pathname)) return false;
    return !/\/api\//.test(u.pathname);
  } catch (err) {
    return false;
  }
}

/**
 * @param {string} url
 * @param {{ambilBrowser: Function, lebar?: number, tinggi?: number, skala?: number,
 *          format?: string, selector?: string|null, timeoutMs?: number}} opsi
 * @returns {Promise<{buffer: Buffer, mimetype: string, cara: string, nama: string}>}
 */
async function tangkapHalaman(url, opsi = {}) {
  const alamat = pastikanBare(url);
  if (!alamat) throw new Error('URL halaman DOI belum disetel. Setel dengan /doiurl <url>');
  try { new URL(alamat); } catch (err) {
    throw new Error('URL halaman DOI tidak sah. Tempelkan URL lengkap termasuk https://');
  }

  const ambil = opsi.ambilBrowser;
  if (typeof ambil !== 'function') throw new Error('browser tidak tersedia');
  const browser = await ambil();
  if (!browser || typeof browser.newPage !== 'function') {
    throw new Error(
      'Chrome belum tersedia. Jalur ini memakai browser yang sama dengan WhatsApp Web, '
      + 'jadi tunggu sampai status WhatsApp "ready" lalu coba lagi.'
    );
  }

  const format = ['jpg', 'jpeg'].includes(String(opsi.format || 'jpeg').toLowerCase()) ? 'jpeg' : 'png';
  const lebar = Math.max(320, parseInt(opsi.lebar, 10) || LEBAR_BAWAAN);
  const tinggi = Math.max(240, parseInt(opsi.tinggi, 10) || TINGGI_BAWAAN);
  const skala = Math.min(3, Math.max(1, parseInt(opsi.skala, 10) || 2));
  const timeoutMs = Math.max(5000, parseInt(opsi.timeoutMs, 10) || 60000);
  const selector = opsi.selector === null || opsi.selector === ''
    ? null
    : String(opsi.selector || SELECTOR_BAWAAN);

  // Halaman BARU. Jangan pernah menavigasi halaman WhatsApp Web.
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: lebar, height: tinggi, deviceScaleFactor: skala });
    await page.goto(alamat, { waitUntil: 'networkidle0', timeout: timeoutMs });

    if (selector) {
      try {
        await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 30000) });
      } catch (err) {
        // Sengaja GAGAL, bukan menangkap layar apa adanya. Poster "Loading..."
        // yang terkirim ke group operasional terlihat sah dan tidak ada yang
        // memeriksanya - jauh lebih berbahaya daripada laporan yang tidak
        // datang dan langsung kelihatan.
        throw new Error(
          `penanda siap "${selector}" tidak muncul dalam batas waktu. Halaman mungkin `
          + 'gagal memuat data, atau penandanya berubah. Periksa URL di peramban; '
          + 'bila penandanya memang sudah tidak ada, matikan penungguan dengan '
          + '/doiselector hapus'
        );
      }
    }

    const buffer = await page.screenshot({
      type: format,
      ...(format === 'jpeg' ? { quality: 92 } : {}),
    });
    const hasil = Buffer.from(buffer);
    logger.info(
      `Halaman DOI ditangkap: ${lebar}x${tinggi} @${skala}x = `
      + `${lebar * skala}x${tinggi * skala}, ${Math.round(hasil.length / 1024)} KB `
      + `(${samarkanUrl(alamat)})`
    );
    return {
      buffer: hasil,
      mimetype: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      cara: `Chrome (halaman ${lebar}x${tinggi} @${skala}x)`,
      nama: `doi-harian.${format === 'jpeg' ? 'jpg' : 'png'}`,
    };
  } finally {
    // Tanpa baris ini, satu tab menumpuk setiap kali laporan dikirim -
    // beberapa minggu kemudian browsernya mati dan WhatsApp ikut putus.
    try { await page.close(); } catch (e) { /* halaman sudah tertutup */ }
  }
}

module.exports = {
  tangkapHalaman,
  pastikanBare,
  tampakHalaman,
  LEBAR_BAWAAN,
  TINGGI_BAWAAN,
  SELECTOR_BAWAAN,
};
