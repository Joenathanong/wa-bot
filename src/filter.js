'use strict';

/**
 * Pemicu forwarding Telegram -> WhatsApp.
 *
 * Dulu keyword dipaku mati di berkas ini karena hanya ada SATU jenis
 * peringatan (stok di bawah reserve). Sejak menu 1 dialihkan menjadi
 * penerusan data pesanan (PAKET INSTANT), keyword harus bisa diganti
 * tanpa ubah kode: nilai aktifnya disimpan di tabel settings dan
 * diubah lewat /keyword. Nilai di bawah ini hanya default awal.
 */
const KEYWORD_DEFAULT = 'PAKET INSTANT';

/**
 * Normalisasi ringan: menyamakan spasi/newline/non-breaking space dan
 * membuang karakter tak terlihat (zero-width) yang kadang ikut terbawa
 * dari Telegram. TIDAK menambah atau mengubah keyword.
 */
function normalize(text) {
  return String(text)
    .replace(/[​-‍﻿]/g, '')   // karakter zero-width
    .replace(/ /g, ' ')                   // non-breaking space
    .replace(/\s+/g, ' ')                    // newline/tab/spasi ganda -> satu spasi
    .trim();
}

/**
 * @param {string} messageText teks polos pesan Telegram
 * @param {string} [keyword] keyword aktif; kosong = TERUSKAN SEMUA pesan
 * @returns {boolean} true bila pesan harus diteruskan
 */
function shouldForward(messageText, keyword = KEYWORD_DEFAULT) {
  if (!messageText || typeof messageText !== 'string') return false;

  const kunci = String(keyword == null ? '' : keyword).trim();
  // Keyword sengaja dikosongkan lewat "/keyword semua": tanpa saringan kata,
  // seluruh pesan dari chat yang diizinkan ikut diteruskan.
  if (!kunci) return true;

  // Pemeriksaan utama - persis seperti spesifikasi.
  if (messageText.toLowerCase().includes(kunci.toLowerCase())) return true;

  // Cadangan: keyword yang sama tetapi terpotong newline / spasi ganda.
  return normalize(messageText).toLowerCase().includes(normalize(kunci).toLowerCase());
}

module.exports = { KEYWORD: KEYWORD_DEFAULT, KEYWORD_DEFAULT, shouldForward, normalize };
