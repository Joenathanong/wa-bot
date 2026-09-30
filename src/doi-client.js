'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger').scope('DOI');

/**
 * Pengambil gambar DOI dari web Monitoring DOI.
 *
 * Yang diambil adalah SVG siap-tampil dari endpoint publiknya, contoh:
 *   https://doi-monitor.vercel.app/api/public/wa/svg?k=RAHASIA
 *
 * HANYA MEMBACA. Tidak ada satu pun permintaan selain GET di berkas ini -
 * bot ini tidak punya urusan mengubah apa pun di sisi web DOI.
 *
 * Token ikut di dalam URL, jadi URL-nya diperlakukan seperti kredensial:
 * disimpan di .env / tabel settings, dan setiap kali ditampilkan ke Telegram
 * atau ke log, tokennya disamarkan lewat samarkanUrl().
 */

/** Nama parameter yang isinya dianggap rahasia. */
const PARAM_RAHASIA = ['k', 'key', 'token', 'secret', 'apikey', 'api_key'];

/**
 * Samarkan token di dalam URL supaya aman ditampilkan.
 * "…/svg?k=RAHASIA" -> "…/svg?k=•••••"
 */
function samarkanUrl(mentah) {
  const teks = String(mentah || '');
  if (!teks) return '(belum disetel)';
  try {
    // Sengaja menyulap teksnya langsung, BUKAN lewat URLSearchParams.set():
    // set() ikut meng-encode ulang seluruh query, sehingga penyamarannya
    // muncul sebagai %E2%80%A2%E2%80%A2... - tidak terbaca, dan malah
    // membuat admin curiga URL-nya rusak.
    new URL(teks); // hanya untuk memastikan URL-nya sah
    return teks.replace(
      new RegExp(`([?&])(${PARAM_RAHASIA.join('|')})=([^&#]*)`, 'gi'),
      (cocok, pemisah, nama) => `${pemisah}${nama}=*****`
    );
  } catch (err) {
    // Bukan URL yang sah - jangan pernah menampilkannya mentah, karena
    // justru teks tak-sah inilah yang paling mungkin memuat token salah tempel.
    return '(URL tidak sah)';
  }
}

/** Apakah teks ini benar-benar sebuah SVG? */
function tampakSvg(teks) {
  const awal = String(teks || '').slice(0, 2000).toLowerCase();
  return awal.includes('<svg');
}

/**
 * Ukuran gambar dari atribut width/height, atau dari viewBox bila tidak ada.
 * Dipakai untuk menentukan ukuran render supaya hasilnya tidak gepeng.
 * @returns {{width: number, height: number}|null}
 */
function ukuranSvg(svg) {
  const teks = String(svg || '');
  const angka = (s) => {
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = angka((teks.match(/\bwidth\s*=\s*["']([^"']+)["']/i) || [])[1]);
  const h = angka((teks.match(/\bheight\s*=\s*["']([^"']+)["']/i) || [])[1]);
  if (w && h) return { width: Math.round(w), height: Math.round(h) };

  const vb = (teks.match(/\bviewBox\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (vb) {
    const bagian = vb.trim().split(/[\s,]+/).map(Number);
    if (bagian.length === 4 && bagian[2] > 0 && bagian[3] > 0) {
      return { width: Math.round(bagian[2]), height: Math.round(bagian[3]) };
    }
  }
  return null;
}

/**
 * Ambil SVG dari URL. GET biasa, mengikuti redirect (Vercel kadang
 * mengalihkan), dengan batas waktu supaya penjadwal tidak menggantung.
 *
 * @returns {Promise<{svg: string, bytes: number, url: string}>}
 */
function ambilSvg(url, { timeoutMs = 20000, maxRedirect = 3 } = {}) {
  const alamat = String(url || '').trim();
  if (!alamat) {
    throw new Error('URL SVG DOI belum disetel. Setel dengan /doiurl <url lengkap berikut token>');
  }
  let parsed;
  try { parsed = new URL(alamat); } catch (err) {
    throw new Error('URL SVG DOI tidak sah. Tempelkan URL lengkap termasuk https://');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('URL SVG DOI harus http atau https');
  }

  return new Promise((resolve, reject) => {
    const mesin = parsed.protocol === 'http:' ? http : https;
    const req = mesin.get(alamat, {
      headers: { Accept: 'image/svg+xml,text/xml,*/*', 'User-Agent': 'telegram-wa-bridge/1.0' },
      timeout: timeoutMs,
    }, (res) => {
      const kode = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(kode) && res.headers.location) {
        res.resume();
        if (maxRedirect <= 0) return reject(new Error('terlalu banyak pengalihan (redirect)'));
        const lanjut = new URL(res.headers.location, alamat).toString();
        return ambilSvg(lanjut, { timeoutMs, maxRedirect: maxRedirect - 1 }).then(resolve, reject);
      }

      const potongan = [];
      let panjang = 0;
      res.on('data', (c) => {
        potongan.push(c);
        panjang += c.length;
        // SVG laporan wajar di bawah beberapa MB. Batas ini menjaga agar
        // endpoint yang salah (mis. mengembalikan halaman HTML besar) tidak
        // menghabiskan memori service.
        if (panjang > 12 * 1024 * 1024) {
          req.destroy(new Error('balasan terlalu besar (>12 MB) - endpoint salah?'));
        }
      });
      res.on('end', () => {
        const isi = Buffer.concat(potongan).toString('utf8');
        if (kode === 401 || kode === 403) {
          return reject(new Error(`token DOI ditolak (HTTP ${kode}). Perbarui dengan /doiurl`));
        }
        if (kode < 200 || kode >= 300) {
          // Cuplikan pesan server sering menjelaskan sebabnya; dipotong agar
          // tidak membanjiri Telegram, dan tidak mungkin memuat token.
          const cuplik = isi.replace(/\s+/g, ' ').trim().slice(0, 200);
          return reject(new Error(`HTTP ${kode}${cuplik ? ` - ${cuplik}` : ''}`));
        }
        if (!tampakSvg(isi)) {
          const cuplik = isi.replace(/\s+/g, ' ').trim().slice(0, 120);
          return reject(new Error(
            'balasan bukan SVG. Pastikan URL-nya endpoint SVG, bukan halaman web. '
            + `Awal balasan: "${cuplik}"`
          ));
        }
        logger.info(`SVG DOI diambil: ${Math.round(panjang / 1024)} KB dari ${samarkanUrl(alamat)}`);
        resolve({ svg: isi, bytes: panjang, url: alamat });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`tidak ada balasan dalam ${timeoutMs} ms`)));
    req.on('error', (err) => reject(new Error(err.message)));
  });
}

module.exports = { ambilSvg, samarkanUrl, ukuranSvg, tampakSvg, PARAM_RAHASIA };
