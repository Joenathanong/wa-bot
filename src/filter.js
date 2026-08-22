'use strict';

/**
 * SATU-SATUNYA keyword pemicu forwarding.
 * Jangan menambahkan keyword lain di file ini.
 */
const KEYWORD = 'dengan stok tersedia di bawah stok ter-reserve';

/**
 * Normalisasi ringan: menyamakan spasi/newline/non-breaking space dan
 * membuang karakter tak terlihat (zero-width) yang kadang ikut terbawa
 * dari Telegram. TIDAK menambah atau mengubah keyword.
 */
function normalize(text) {
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // karakter zero-width
    .replace(/\u00A0/g, ' ')                   // non-breaking space
    .replace(/\s+/g, ' ')                    // newline/tab/spasi ganda -> satu spasi
    .trim();
}

/**
 * @param {string} messageText teks polos pesan Telegram
 * @returns {boolean} true bila pesan harus diteruskan
 */
function shouldForward(messageText) {
  if (!messageText || typeof messageText !== 'string') return false;

  // Pemeriksaan utama - persis seperti spesifikasi.
  if (messageText.toLowerCase().includes(KEYWORD.toLowerCase())) return true;

  // Cadangan: keyword yang sama tetapi terpotong newline / spasi ganda.
  return normalize(messageText).toLowerCase().includes(KEYWORD.toLowerCase());
}

module.exports = { KEYWORD, shouldForward, normalize };
