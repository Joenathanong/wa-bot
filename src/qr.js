'use strict';

const logger = require('./logger').scope('QR');

/**
 * Membuat gambar QR agar bisa dikirim lewat Telegram.
 *
 * Diperlukan ketika aplikasi berjalan sebagai Windows Service: tidak ada
 * terminal untuk menampilkan QR, sehingga satu-satunya cara login WhatsApp
 * adalah menerima QR-nya di tempat lain.
 *
 * Library `qrcode` bersifat opsional. Bila tidak terpasang, aplikasi tetap
 * berjalan - hanya pengiriman gambar QR yang dilewati.
 */
async function renderQrPng(data) {
  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch (err) {
    return null;
  }
  try {
    return await QRCode.toBuffer(String(data), {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });
  } catch (err) {
    logger.warn('Gagal membuat gambar QR:', err.message);
    return null;
  }
}

/** true bila gambar QR bisa dibuat di lingkungan ini. */
function canRenderQr() {
  try { require('qrcode'); return true; } catch (err) { return false; }
}

module.exports = { renderQrPng, canRenderQr };
