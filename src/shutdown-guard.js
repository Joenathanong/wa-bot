'use strict';

const logger = require('./logger').scope('APP');

/**
 * Pengaman waktu untuk proses berhenti.
 *
 * Windows Service Control Manager hanya memberi waktu terbatas (bawaan sekitar
 * 30 detik) sebelum menyatakan "The service could not be stopped". Jalur
 * shutdown aplikasi ini menutup Puppeteer/Chrome, dan Chrome kadang menggantung
 * tanpa batas - akibatnya `net stop` gagal dan service tersangkut STOP_PENDING
 * sampai dimatikan paksa lewat taskkill.
 *
 * Karena itu shutdown diberi tenggat sendiri: bila belum selesai dalam
 * `ms` milidetik, proses keluar paksa. Kehilangan penutupan yang rapi jauh
 * lebih murah daripada service yang macet.
 *
 * @param {number} ms tenggat dalam milidetik
 * @param {() => void} [onTimeout] dipanggil saat tenggat terlampaui;
 *        bawaannya menghentikan proses dengan kode 0
 * @returns {{ batalkan: () => void, timer: NodeJS.Timeout }}
 */
function pasangPengamanShutdown(ms, onTimeout) {
  const tenggat = Math.max(1000, Number(ms) || 10000);
  const keluar = typeof onTimeout === 'function'
    ? onTimeout
    : () => process.exit(0);

  const timer = setTimeout(() => {
    logger.warn(
      `Shutdown belum selesai setelah ${tenggat} ms - proses dihentikan paksa. ` +
      'Biasanya Chrome/WhatsApp Web yang menggantung; sesi WhatsApp tetap aman.'
    );
    keluar();
  }, tenggat);

  // unref: pengaman ini tidak boleh menjadi alasan proses tetap hidup.
  if (timer.unref) timer.unref();

  return {
    timer,
    batalkan() { clearTimeout(timer); },
  };
}

module.exports = { pasangPengamanShutdown };
