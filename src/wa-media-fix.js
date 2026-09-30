'use strict';

/**
 * Tambalan pengiriman media WhatsApp Web.
 *
 * MASALAH YANG DITAMBAL
 * ---------------------
 * Probe langkah-demi-langkah (whatsapp.js `_probeMedia`) sudah membuktikan
 * bahwa jalur penyiapan media sehat sampai langkah keempat:
 *
 *   createFromData: OK
 *   waitForPrep: OK            <- filehash terisi
 *   getOrCreateMediaObject: OK
 *   msgToMediaType: OK
 *   consolidate: GAGAL - u.isBlobEqual is not a function
 *
 * Artinya WhatsApp Web menghapus/mengganti nama fungsi `isBlobEqual` dari
 * modul yang dipakai `MediaObject.consolidate`. Kode whatsapp-web.js
 * (src/util/Injected/Utils.js, `processMediaData`) memanggil consolidate tanpa
 * pelindung, jadi seluruh pengiriman gambar gagal. Tidak ada perbaikan di
 * hulu: `pedroslopez/whatsapp-web.js` cabang main memuat kode yang sama.
 *
 * CARA MENAMBAL - dua lapis, tanpa menyentuh node_modules
 * ------------------------------------------------------
 * 1. TAMBAL AKAR: cari modul yang dipakai consolidate dan pasang kembali
 *    `isBlobEqual` yang hilang. Kalau berhasil, consolidate jalan normal -
 *    ini yang paling kita inginkan.
 * 2. JARING PENGAMAN: bungkus `getOrCreateMediaObject` supaya objek media yang
 *    dikembalikannya punya `consolidate` sendiri yang menangkap galat lalu
 *    menyetel medannya langsung. Jadi kalau lapis 1 tidak kena sasaran,
 *    unggahan tetap diteruskan alih-alih melempar.
 *
 * Keduanya idempoten dan hanya menambah properti - tidak ada yang dihapus.
 * Semua dijalankan di dalam halaman, jadi `npm install` tidak menghapusnya.
 */

const SKRIP = function () {
  const lap = { lapis: [] };
  window.__waFix = window.__waFix || {};

  // --- ambil peta modul WhatsApp Web -------------------------------------
  let peta = null;
  try { peta = window.require('__debug').modulesMap; } catch (e) { /* coba cara lain */ }
  if (!peta) { try { peta = window.__debug && window.__debug.modulesMap; } catch (e) { /* menyerah */ } }
  lap.peta = peta ? Object.keys(peta).length : 0;

  const sumber = (m) => {
    try {
      const f = m && (m.factory || m.defineFactory);
      return typeof f === 'function' ? String(f) : '';
    } catch (e) { return ''; }
  };
  const ekspor = (m) => {
    try {
      if (!m) return null;
      if (m.publicModule && m.publicModule.exports) return m.publicModule.exports;
      if (m.exports) return m.exports;
      return null;
    } catch (e) { return null; }
  };

  // --- siapa yang masih punya isBlobEqual? -------------------------------
  // Membaca sumber SEMUA modul berarti men-string-kan puluhan MB kode, dan itu
  // membekukan halaman beberapa detik. consolidate hampir pasti ada di modul
  // media, jadi yang itu dulu; pindai seluruhnya hanya kalau tidak ketemu.
  const penyedia = [];
  const pemakai = [];
  const pindai = (saring) => {
    for (const nama of Object.keys(peta)) {
      if (saring && !saring.test(nama)) continue;
      const m = peta[nama];
      try {
        const ex = m && m.isInitialized ? ekspor(m) : null;
        if (ex && typeof ex.isBlobEqual === 'function' && penyedia.indexOf(nama) < 0) penyedia.push(nama);
      } catch (e) { /* modul rewel - lewati */ }
      try {
        const src = sumber(m);
        if (src && src.indexOf('isBlobEqual') >= 0) pemakai.push({ nama, s: src });
      } catch (e) { /* factory tidak bisa dibaca - lewati */ }
    }
  };
  if (peta) {
    pindai(/media|blob|mms|opaque/i);
    lap.pindai = 'media';
    if (pemakai.length === 0) { pindai(null); lap.pindai = 'penuh'; }
  }
  lap.penyedia = penyedia.slice(0, 8);
  lap.pemakai = pemakai.map((p) => p.nama).slice(0, 8);

  // --- implementasi pengganti -------------------------------------------
  // "Apakah dua blob ini blob yang sama?" - identitas objek, lalu filehash.
  // Sengaja konservatif: kalau tidak yakin, jawab TIDAK sama, sehingga
  // consolidate mengambil jalur "simpan yang baru" dan bukan melewatkannya.
  const isBlobEqual = function (a, b) {
    try {
      if (a === b) return true;
      if (!a || !b) return false;
      const ha = a.filehash || a.fileHash;
      const hb = b.filehash || b.fileHash;
      if (ha && hb) return ha === hb && (a.size == null || b.size == null || a.size === b.size);
      return false;
    } catch (e) { return false; }
  };

  // --- LAPIS 1: pasang isBlobEqual di modul yang dirujuk consolidate -----
  const dipasang = [];
  const jejak = [];
  for (const p of pemakai) {
    try {
      // nama variabel di depan .isBlobEqual (mis. "u" pada "u.isBlobEqual")
      const vars = new Set();
      const re = /([A-Za-z_$][\w$]*)\s*\.\s*isBlobEqual/g;
      let m;
      while ((m = re.exec(p.s)) !== null) vars.add(m[1]);
      for (const v of vars) {
        // cari "v = <req>("NamaModul")" di mana pun dalam factory
        const reAsal = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\s*[\'"]([\\w$]+)[\'"]\\s*\\)');
        const asal = reAsal.exec(p.s);
        jejak.push(p.nama + ':' + v + '->' + (asal ? asal[1] : '?'));
        const kandidat = asal ? [asal[1]] : [];
        if (!asal) {
          // Tidak ketemu lewat variabel: coba modul yang di-require di factory
          // ini - TAPI hanya yang sudah terinisialisasi. window.require() pada
          // modul yang belum jalan akan menjalankan factory-nya, dan memaksa
          // modul WhatsApp Web sembarangan hidup lebih berisiko daripada
          // tambalan ini sendiri.
          const reAll = /[A-Za-z_$][\w$]*\(\s*['"]([A-Z][\w$]*)['"]\s*\)/g;
          let x; const set = new Set();
          while ((x = reAll.exec(p.s)) !== null) set.add(x[1]);
          for (const n of set) {
            if (peta && peta[n] && peta[n].isInitialized) kandidat.push(n);
          }
        }
        for (const nama of kandidat.slice(0, 40)) {
          try {
            const mod = window.require(nama);
            if (mod && typeof mod === 'object' && typeof mod.isBlobEqual !== 'function') {
              try {
                Object.defineProperty(mod, 'isBlobEqual', {
                  value: isBlobEqual, configurable: true, writable: true, enumerable: false,
                });
                dipasang.push(nama);
              } catch (e2) {
                try { mod.isBlobEqual = isBlobEqual; dipasang.push(nama + '(langsung)'); }
                catch (e3) { /* modul terkunci */ }
              }
            }
          } catch (e) { /* modul tidak bisa di-require - lewati */ }
        }
      }
    } catch (e) { /* factory tidak bisa dibaca - lewati */ }
  }
  lap.jejak = jejak.slice(0, 8);
  lap.dipasang = dipasang.slice(0, 12);
  lap.lapis.push('polyfill: ' + dipasang.length + ' modul');

  // --- LAPIS 2: bungkus getOrCreateMediaObject --------------------------
  try {
    const MS = window.require('WAWebMediaStorage');
    if (MS && typeof MS.getOrCreateMediaObject === 'function' && !MS.__waFixConsolidate) {
      const asli = MS.getOrCreateMediaObject;
      MS.getOrCreateMediaObject = function () {
        const mo = asli.apply(this, arguments);
        try {
          if (mo && typeof mo.consolidate === 'function'
              && !Object.prototype.hasOwnProperty.call(mo, 'consolidate')) {
            const cons = mo.consolidate.bind(mo);
            Object.defineProperty(mo, 'consolidate', {
              value: function (json) {
                try { return cons(json); }
                catch (e) {
                  window.__waFix.consolidateGagal = String((e && e.message) || e);
                  // Jalur cadangan: setel medannya langsung. consolidate cuma
                  // menggabungkan data hasil prep ke objek media - yang dibaca
                  // uploadMedia setelahnya adalah objek media itu sendiri.
                  try {
                    if (typeof mo.set === 'function') { mo.set(json); window.__waFix.cadangan = 'set()'; return undefined; }
                  } catch (e2) { /* coba assign */ }
                  try { Object.assign(mo, json); window.__waFix.cadangan = 'assign()'; }
                  catch (e3) { window.__waFix.cadangan = 'GAGAL: ' + String((e3 && e3.message) || e3); }
                  return undefined;
                }
              },
              configurable: true, writable: true, enumerable: false,
            });
          }
        } catch (e) { /* biarkan objeknya apa adanya */ }
        return mo;
      };
      MS.__waFixConsolidate = true;
      lap.lapis.push('bungkus getOrCreateMediaObject: OK');
    } else if (MS && MS.__waFixConsolidate) {
      lap.lapis.push('bungkus getOrCreateMediaObject: sudah ada');
    } else {
      lap.lapis.push('bungkus getOrCreateMediaObject: TIDAK BISA');
    }
  } catch (e) {
    lap.lapis.push('bungkus getOrCreateMediaObject: GAGAL - ' + String((e && e.message) || e));
  }

  return lap;
};

/**
 * Uji tambalan dengan PNG 1x1 - sampai sebelum unggahan.
 * Mengembalikan laporan langkah, sama bentuknya dengan probe di whatsapp.js.
 */
const UJI = async function (data) {
  const out = { langkah: [] };
  const coba = async (nama, fn) => {
    try { const v = await fn(); out.langkah.push(nama + ': OK'); return v; }
    catch (e) { out.langkah.push(nama + ': GAGAL - ' + String((e && e.message) || e)); out.gagalDi = nama; throw e; }
  };
  try {
    const OpaqueData = window.require('WAWebMediaOpaqueData');
    const file = window.WWebJS.mediaInfoToFile({ data, mimetype: 'image/png', filename: 'uji.png' });
    const od = await coba('createFromData', () => OpaqueData.createFromData(file, 'image/png'));
    const md = await coba('waitForPrep', () => window.require('WAWebPrepRawMedia').prepRawMedia(od, {}).waitForPrep());
    const mo = await coba('getOrCreateMediaObject', () => window.require('WAWebMediaStorage').getOrCreateMediaObject(md.filehash));
    await coba('consolidate', () => mo.consolidate(md.toJSON()));
  } catch (e) { /* sudah tercatat */ }
  out.catatan = window.__waFix || null;
  return out;
};

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Pasang tambalan di halaman WhatsApp Web. Aman dipanggil berulang.
 *
 * @param {import('puppeteer').Page} page
 * @param {{info: Function, warn: Function, error: Function}} logger
 * @param {boolean} uji jalankan uji PNG 1x1 dan catat hasilnya
 */
async function pasangTambalanMedia(page, logger, uji = false) {
  if (!page) return null;
  const hasil = { lapor: null, uji: null };
  try {
    hasil.lapor = await page.evaluate(SKRIP);
    logger.info('Tambalan media WA: ' + JSON.stringify(hasil.lapor).slice(0, 900));
  } catch (e) {
    hasil.lapor = { galat: String((e && e.message) || e) };
    logger.warn('Tambalan media WA gagal dipasang: ' + ((e && e.message) || e));
    return hasil;
  }
  if (uji) {
    try {
      hasil.uji = await page.evaluate(UJI, PNG_1X1);
      const baik = !hasil.uji.gagalDi;
      logger[baik ? 'info' : 'error']('Uji media WA: ' + JSON.stringify(hasil.uji).slice(0, 900));
    } catch (e) {
      hasil.uji = { galat: String((e && e.message) || e) };
      logger.warn('Uji media WA tidak bisa dijalankan: ' + ((e && e.message) || e));
    }
  }
  return hasil;
}

module.exports = { pasangTambalanMedia };
