'use strict';

/**
 * Tambalan pengiriman media WhatsApp Web.
 *
 * RIWAYAT MASALAH (semua sudah dibuktikan lewat probe di halaman, bukan dugaan)
 * ---------------------------------------------------------------------------
 * 1. `consolidate: GAGAL - u.isBlobEqual is not a function`
 *    WhatsApp Web menghapus `isBlobEqual` dari modul yang dipakai
 *    `MediaObject.consolidate`. DITAMBAL (lapis 2).
 * 2. `castToV4: unexpected mmsv3 type image`
 *    Setelah consolidate lewat, langkah berikutnya di processMediaData -
 *    `shouldUseMediaCache(castToV4(mediaObject.type))` - melempar. castToV4
 *    tidak lagi menerima nama tipe v3 seperti "image". DITAMBAL (lapis 3).
 * 3. `Data passed to getter must include an id property (it's how we memoize)`
 *    Galat yang akhirnya sampai ke pemakai. Hanya SATU frame tumpukan yang
 *    terbawa lewat Puppeteer, jadi lapis 4 memasang perekam tumpukan penuh di
 *    dalam halaman. Hasilnya: `processMediaData: OK` - medianya sudah
 *    terunggah - dan yang melempar adalah pembuatan model pesan, di
 *    getValidatedSender -> getSender. Pengirimnya undefined. BELUM ditambal.
 *
 *    Dugaan pertama - data media menimpa medan id/from/to pesan karena
 *    whatsapp-web.js menebarnya SESUDAH medan itu - sudah DIPATAHKAN oleh
 *    pencatatnya sendiri: identitasModel dan identitasJson keduanya kosong,
 *    data media tidak membawa satu pun medan identitas pesan. Pencatatnya
 *    dipertahankan (lapis 5), penghapusnya dicabut.
 *
 *    Lapis 6 lalu memeriksa objek `message` yang sudah jadi, dan jejaknya
 *    memberi petunjuk yang jelas:
 *
 *      from: 628567126259@c.us    <- nomor telepon
 *      lid:  66173282562288@lid   <- akun ini PUNYA LID
 *      lidMode: undefined         <- bukan false: groupMetadata-nya kosong
 *      author: undefined          <- diisi, tetap gagal
 *
 *    Mengisi author tidak menolong. Tapi `lidMode: undefined` itu yang
 *    menarik: whatsapp-web.js memilih pengirim dengan
 *    `chat.groupMetadata && chat.groupMetadata.isLidAddressingMode`, jadi
 *    groupMetadata yang belum dimuat membuatnya memakai nomor telepon tanpa
 *    peringatan - walau group-nya mungkin beralamat LID. DICOBA (lapis 7):
 *    groupMetadata dimuat lebih dulu, supaya whatsapp-web.js memilih
 *    pengirimnya sendiri dengan benar, dan nilai isLidAddressingMode yang
 *    sesungguhnya tercatat.
 *
 * Tidak ada perbaikan di hulu untuk nomor 1 dan 2: `pedroslopez/whatsapp-web.js`
 * cabang main memuat kode yang sama.
 *
 * Semua tambalan dipasang DI DALAM halaman dan hanya menambah/membungkus -
 * tidak ada yang dihapus, dan `npm install` tidak menghapusnya.
 */

const SKRIP = function () {
  const lap = { lapis: [] };
  // Catatan disetel ulang tiap pemasangan - dan pemasangan dijalankan persis
  // sebelum tiap pengiriman. Jadi tumpukan yang terbaca setelah gagal selalu
  // dari percobaan ITU, bukan sisa percobaan sebelumnya.
  window.__waFix = {};

  // --- peta modul WhatsApp Web -------------------------------------------
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

  // Pembungkus aman: panggil yang asli, tangkap galatnya, pakai nilai cadangan.
  // Dipakai untuk titik-titik yang MELEMPAR padahal hasilnya cuma optimasi.
  const bungkus = (namaModul, namaFn, cadangan, label) => {
    try {
      const mod = window.require(namaModul);
      if (!mod || typeof mod[namaFn] !== 'function') { lap.lapis.push(label + ': TIDAK ADA'); return; }
      if (mod['__waFix_' + namaFn]) { lap.lapis.push(label + ': sudah ada'); return; }
      const asli = mod[namaFn];
      mod[namaFn] = function () {
        try { return asli.apply(this, arguments); }
        catch (e) {
          window.__waFix[namaFn + 'Gagal'] = String((e && e.message) || e);
          return cadangan;
        }
      };
      mod['__waFix_' + namaFn] = true;
      lap.lapis.push(label + ': OK');
    } catch (e) {
      lap.lapis.push(label + ': GAGAL - ' + String((e && e.message) || e));
    }
  };

  // --- siapa yang masih punya isBlobEqual? -------------------------------
  // Membaca sumber SEMUA modul berarti men-string-kan puluhan MB kode. Modul
  // media dulu; pindai seluruhnya hanya kalau tidak ketemu.
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

  // --- LAPIS 1: pasang kembali isBlobEqual di modul yang dirujuk ----------
  // Catatan: pada bundel 1 Okt 2026 lapis ini TIDAK menemukan sasaran
  // (pemakai: 0 dari 14.326 modul) - sumber factory-nya tidak terbaca lewat
  // modulesMap. Dibiarkan karena murah dan bisa kena di bundel lain; yang
  // benar-benar menyelamatkan pengiriman adalah lapis 2.
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
  const dipasang = [];
  const jejak = [];
  for (const p of pemakai) {
    try {
      const vars = new Set();
      const re = /([A-Za-z_$][\w$]*)\s*\.\s*isBlobEqual/g;
      let m;
      while ((m = re.exec(p.s)) !== null) vars.add(m[1]);
      for (const v of vars) {
        const reAsal = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\s*[\'"]([\\w$]+)[\'"]\\s*\\)');
        const asal = reAsal.exec(p.s);
        jejak.push(p.nama + ':' + v + '->' + (asal ? asal[1] : '?'));
        const kandidat = asal ? [asal[1]] : [];
        if (!asal) {
          // Hanya modul yang SUDAH terinisialisasi: window.require() pada modul
          // yang belum jalan akan menjalankan factory-nya, dan memaksa modul
          // WhatsApp Web sembarangan hidup lebih berisiko daripada tambalan ini.
          const reAll = /[A-Za-z_$][\w$]*\(\s*['"]([A-Z][\w$]*)['"]\s*\)/g;
          let x; const set = new Set();
          while ((x = reAll.exec(p.s)) !== null) set.add(x[1]);
          for (const n of set) { if (peta && peta[n] && peta[n].isInitialized) kandidat.push(n); }
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
  lap.lapis.push('polyfill isBlobEqual: ' + dipasang.length + ' modul');

  // --- LAPIS 2: bungkus getOrCreateMediaObject --------------------------
  // consolidate() cuma menggabungkan data hasil prep ke objek media. Kalau
  // melempar, medannya disetel langsung - uploadMedia setelahnya membaca objek
  // media itu, bukan nilai kembalian consolidate.
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

  // --- LAPIS 3: castToV4 + shouldUseMediaCache jangan melempar ----------
  // processMediaData memanggil:
  //   shouldUseMediaCache(castToV4(mediaObject.type))
  // Hasilnya HANYA menentukan apakah blob-nya ditaruh di cache memori -
  // optimasi, bukan syarat kirim. castToV4 kini menolak "image", jadi seluruh
  // pengiriman gagal karena sebuah optimasi. Dibikin tidak melempar:
  // castToV4 -> null, shouldUseMediaCache -> false (lewati cache).
  bungkus('WAWebMmsMediaTypes', 'castToV4', null, 'bungkus castToV4');
  bungkus('WAWebMediaDataUtils', 'shouldUseMediaCache', false, 'bungkus shouldUseMediaCache');

  // --- LAPIS 4: rekam tumpukan penuh ------------------------------------
  // Galat yang sampai ke pemakai - "Data passed to getter must include an id
  // property" - hanya membawa SATU frame lewat Puppeteer, jadi langkah yang
  // melempar tidak pernah terlihat. Dua fungsi dibungkus supaya tumpukan
  // penuhnya tersimpan, dan supaya jelas kegagalannya di penyiapan media
  // (processMediaData) atau sesudahnya (pembuatan & pengiriman pesan):
  const rekam = (nama) => {
    try {
      if (!window.WWebJS || typeof window.WWebJS[nama] !== 'function') {
        lap.lapis.push('rekam ' + nama + ': TIDAK ADA'); return;
      }
      if (window.WWebJS['__waFixRekam_' + nama]) {
        lap.lapis.push('rekam ' + nama + ': sudah ada'); return;
      }
      const asli = window.WWebJS[nama];
      window.WWebJS[nama] = async function () {
        try {
          const hasil = await asli.apply(this, arguments);
          window.__waFix[nama] = 'OK';
          return hasil;
        } catch (e) {
          window.__waFix[nama] = 'GAGAL';
          window.__waFix[nama + 'Galat'] = String((e && e.message) || e);
          window.__waFix[nama + 'Tumpukan'] = String((e && e.stack) || '(tanpa tumpukan)').slice(0, 1500);
          throw e;
        }
      };
      window.WWebJS['__waFixRekam_' + nama] = true;
      lap.lapis.push('rekam ' + nama + ': OK');
    } catch (e) {
      lap.lapis.push('rekam ' + nama + ': GAGAL - ' + String((e && e.message) || e));
    }
  };
  // Jejak pesan TIDAK disetel ulang tiap pemasangan: pesan teks yang berhasil
  // harus tetap tersimpan agar bisa dibandingkan dengan yang gagal.
  window.__waJejakPesan = window.__waJejakPesan || [];

  // --- LAPIS 7: biarkan whatsapp-web.js melihat mode alamat group ---------
  //
  // Jejak pesan (1 Okt 2026) memperlihatkan ini:
  //
  //   from: 628567126259@c.us          <- nomor telepon
  //   lid:  66173282562288@lid         <- akun ini PUNYA LID
  //   lidMode: undefined               <- bukan false: groupMetadata-nya kosong
  //
  // Lihat cara whatsapp-web.js memilih pengirim (Injected/Utils.js ~425):
  //
  //   from = chat.groupMetadata && chat.groupMetadata.isLidAddressingMode
  //            ? lidUser : meUser
  //
  // Kalau groupMetadata belum dimuat, syaratnya falsy dan nomor telepon yang
  // dipakai - TANPA peringatan, walau group-nya sebenarnya beralamat LID.
  // Pesan media memvalidasi pengirimnya (getValidatedSender), pesan teks tidak;
  // itu menjelaskan kenapa teks ke group yang sama selalu lolos.
  //
  // Jadi di sini groupMetadata dimuat lebih dulu - bukan menebak pengirim yang
  // benar, tapi membuat whatsapp-web.js bisa memilihnya sendiri dengan benar.
  // Nilai isLidAddressingMode yang sesungguhnya ikut dicatat: kalau ternyata
  // false, dugaan LID ini mati dan kita tahu seketika.
  try {
    if (!window.WWebJS || typeof window.WWebJS.sendMessage !== 'function') {
      lap.lapis.push('muat groupMetadata: TIDAK ADA');
    } else if (window.WWebJS.__waFixKirim) {
      lap.lapis.push('muat groupMetadata: sudah ada');
    } else {
      const asliKirim = window.WWebJS.sendMessage;
      window.WWebJS.sendMessage = async function (chat, content, options) {
        const jj = { tahap: 'pra-kirim' };
        try {
          const grup = !!(chat && chat.id && typeof chat.id.isGroup === 'function' && chat.id.isGroup());
          jj.grup = String(grup);
          jj.adaMedia = String(!!(options && options.media));
          jj.gmSebelum = String(!!(chat && chat.groupMetadata));
          if (grup && !(chat && chat.groupMetadata)) {
            const sid = (chat.id && (chat.id._serialized || String(chat.id))) || null;
            try {
              await window.require('WAWebGroupQueryJob')
                .queryAndUpdateGroupMetadataById({ id: sid });
              jj.muat = 'queryAndUpdate OK';
            } catch (e) { jj.muat = 'queryAndUpdate GAGAL - ' + String((e && e.message) || e).slice(0, 80); }
            if (!chat.groupMetadata) {
              try {
                const C = window.require('WAWebCollections');
                const GM = C.GroupMetadata || C.WAWebGroupMetadataCollection;
                await GM.update(window.require('WAWebWidFactory').createWid(sid));
                jj.muat2 = 'update OK';
              } catch (e) { jj.muat2 = 'update GAGAL - ' + String((e && e.message) || e).slice(0, 80); }
            }
          }
          jj.gmSesudah = String(!!(chat && chat.groupMetadata));
          jj.lidMode = String(chat && chat.groupMetadata && chat.groupMetadata.isLidAddressingMode);
        } catch (e) { jj.galat = String((e && e.message) || e); }
        try {
          window.__waJejakPesan.push(jj);
          while (window.__waJejakPesan.length > 6) window.__waJejakPesan.shift();
        } catch (e) { /* jejak tidak boleh menggagalkan kirim */ }
        try {
          const hasil = await asliKirim.apply(this, arguments);
          window.__waFix.sendMessage = 'OK';
          return hasil;
        } catch (e) {
          window.__waFix.sendMessage = 'GAGAL';
          window.__waFix.sendMessageGalat = String((e && e.message) || e);
          window.__waFix.sendMessageTumpukan = String((e && e.stack) || '(tanpa tumpukan)').slice(0, 1200);
          throw e;
        }
      };
      window.WWebJS.__waFixKirim = true;
      lap.lapis.push('muat groupMetadata: OK');
    }
  } catch (e) {
    lap.lapis.push('muat groupMetadata: GAGAL - ' + String((e && e.message) || e));
  }

  // --- LAPIS 5: rekam isi data media (pencatat saja) ---------------------
  //
  // Tumpukan penuh (1 Okt 2026) menunjukkan medianya SUDAH terunggah
  // (processMediaData: OK) dan yang melempar adalah pembuatan model pesannya:
  //
  //   new t -> constructor -> initialize -> getValidatedSender -> getSender
  //   -> getter memoized: "must include an id property ... but got undefined"
  //
  // getSender membaca pengirim pesan, dan dapat undefined. Lihat cara
  // whatsapp-web.js menyusun pesannya (Injected/Utils.js ~470):
  //
  //   const message = { ...options, id: newMsgKey, from: from, to: chat.id,
  //                     ..., ...mediaOptions,
  //                     ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}) }
  //
  // mediaOptions ditebar SESUDAH id/from/to. mediaOptions adalah model hasil
  // prepRawMedia - model yang sekarang ikut membawa medan-medan pesan. Satu
  // medan `from: undefined` di sana cukup untuk menimpa pengirim yang benar,
  // dan pengiriman teks tidak kena karena tidak ada mediaOptions untuk
  // menebarnya. Jadi: buang medan identitas pesan dan semua medan bernilai
  // undefined dari yang ditebar - keduanya mustahil berisi informasi media.
  const IDENTITAS = ['id', 'from', 'to', 'author', 'participant', 'self', 'ack', 'local', 'isNewMsg', 't'];
  try {
    if (!window.WWebJS || typeof window.WWebJS.processMediaData !== 'function') {
      lap.lapis.push('rekam data media: TIDAK ADA');
    } else if (window.WWebJS.__waFixRekamMedia) {
      lap.lapis.push('rekam data media: sudah ada');
    } else {
      const asli = window.WWebJS.processMediaData;
      window.WWebJS.processMediaData = async function () {
        let hasil;
        try {
          hasil = await asli.apply(this, arguments);
          window.__waFix.processMediaData = 'OK';
        } catch (e) {
          window.__waFix.processMediaData = 'GAGAL';
          window.__waFix.processMediaDataGalat = String((e && e.message) || e);
          window.__waFix.processMediaDataTumpukan = String((e && e.stack) || '(tanpa tumpukan)').slice(0, 1500);
          throw e;
        }
        // Catat APA yang ditemukan sebelum dibuang - ini yang membuktikan atau
        // mematahkan dugaan di atas, di jalur kirim yang sungguhan.
        try {
          const j = (hasil && typeof hasil.toJSON === 'function') ? hasil.toJSON() : null;
          window.__waFix.identitasModel = IDENTITAS
            .filter((k) => Object.prototype.hasOwnProperty.call(hasil, k))
            .map((k) => k + '=' + String(hasil[k]));
          window.__waFix.identitasJson = j
            ? IDENTITAS.filter((k) => k in j).map((k) => k + '=' + String(j[k]))
            : null;
          window.__waFix.kunciJson = j ? Object.keys(j).slice(0, 50) : null;
        } catch (e) { window.__waFix.catatGagal = String((e && e.message) || e); }
        // TIDAK ADA yang dibuang lagi. Pencatat di atas membuktikan dugaannya
        // salah - identitasModel dan identitasJson keduanya kosong - jadi
        // penghapusnya dicabut. Penghapus itu juga terbukti menyentuh medan
        // yang bukan urusannya (model.parent, model.collection): justru
        // menambah variabel baru, bukan mengurangi.
        return hasil;
      };
      window.WWebJS.__waFixRekamMedia = true;
      lap.lapis.push('rekam data media: OK');
    }
  } catch (e) {
    lap.lapis.push('rekam data media: GAGAL - ' + String((e && e.message) || e));
  }

  // --- LAPIS 6: periksa objek pesan tepat sebelum diserahkan -------------
  //
  // whatsapp-web.js menyusun `message` lalu memanggil
  //   addAndSendMsgToChat(chat, message)
  // dan di dalam situlah model pesannya dibangun dan getSender melempar. Ini
  // satu-satunya titik di mana objek pesan yang SUDAH JADI bisa dilihat.
  //
  // Dicatat (bukan ditebak): from, to, author, participant, tipe, dan siapa
  // meUser/lidUser-nya. Jejaknya TIDAK disetel ulang tiap pemasangan, jadi
  // pesan teks yang berhasil ikut tersimpan - dan perbedaannya dengan pesan
  // gambar yang gagal bisa dibandingkan langsung.
  //
  // Lalu dua perbaikan, masing-masing hanya kalau medannya memang kosong dan
  // masing-masing dicatat, supaya kalau berhasil kita tahu yang mana:
  //   a. message.from kosong  -> isi dari meUser/lidUser
  //   b. grup tanpa author    -> isi dari id.participant
  // Cabang STATUS di whatsapp-web.js memang menyetel `author: participant`;
  // cabang chat biasa tidak. Kalau WhatsApp Web kini mewajibkannya untuk
  // pesan media, di sinilah ketahuan.
  try {
    const SM = window.require('WAWebSendMsgChatAction');
    if (!SM || typeof SM.addAndSendMsgToChat !== 'function') {
      lap.lapis.push('periksa pesan: TIDAK ADA');
    } else if (SM.__waFixPeriksa) {
      lap.lapis.push('periksa pesan: sudah ada');
    } else {
      const asli = SM.addAndSendMsgToChat;
      SM.addAndSendMsgToChat = function (chat, message) {
        const jj = {};
        try {
          const MU = window.require('WAWebUserPrefsMeUser');
          const meUser = MU.getMaybeMePnUser ? MU.getMaybeMePnUser() : undefined;
          const lidUser = MU.getMaybeMeLidUser ? MU.getMaybeMeLidUser() : undefined;
          const sb = (v) => { try { return v == null ? String(v) : (v._serialized || String(v)); } catch (e) { return '?'; } };
          jj.tipe = String(message && message.type);
          jj.from = sb(message && message.from);
          jj.to = sb(message && message.to);
          jj.author = sb(message && message.author);
          jj.idPartisipan = sb(message && message.id && message.id.participant);
          jj.idRemote = sb(message && message.id && message.id.remote);
          jj.me = sb(meUser);
          jj.lid = sb(lidUser);
          jj.lidMode = String(chat && chat.groupMetadata && chat.groupMetadata.isLidAddressingMode);
          jj.grup = String(!!(chat && chat.id && typeof chat.id.isGroup === 'function' && chat.id.isGroup()));

          // Perbaikan HANYA untuk pesan media. Pesan teks ke group yang sama
          // terbukti berhasil apa adanya - jalur yang sudah jalan tidak disentuh.
          if (jj.tipe !== 'chat') {
            // a. pengirim kosong
            if (message && !message.from) {
              const ganti = lidUser || meUser;
              if (ganti) { message.from = ganti; jj.perbaikan = (jj.perbaikan || '') + 'from<-' + sb(ganti) + ' '; }
            }
            // b. grup tanpa author
            if (message && !message.author && jj.grup === 'true') {
              const ganti = (message.id && message.id.participant) || message.from;
              if (ganti) { message.author = ganti; jj.perbaikan = (jj.perbaikan || '') + 'author<-' + sb(ganti) + ' '; }
            }
          }
        } catch (e) { jj.galat = String((e && e.message) || e); }
        try {
          window.__waJejakPesan.push(jj);
          while (window.__waJejakPesan.length > 4) window.__waJejakPesan.shift();
        } catch (e) { /* jejak tidak boleh menggagalkan kirim */ }
        return asli.apply(this, arguments);
      };
      SM.__waFixPeriksa = true;
      lap.lapis.push('periksa pesan: OK');
    }
  } catch (e) {
    lap.lapis.push('periksa pesan: GAGAL - ' + String((e && e.message) || e));
  }

  return lap;
};

/**
 * Uji tambalan dengan PNG 1x1 - sampai sebelum unggahan - sekalian mengumpulkan
 * kosakata tipe media yang MASIH diterima castToV4, supaya kalau tambalan
 * "jangan melempar" tidak cukup, nilai yang benar bisa dipakai.
 */
const UJI = async function (data) {
  const out = { langkah: [], diag: {} };
  const coba = async (nama, fn) => {
    try { const v = await fn(); out.langkah.push(nama + ': OK'); return v; }
    catch (e) { out.langkah.push(nama + ': GAGAL - ' + String((e && e.message) || e)); out.gagalDi = nama; throw e; }
  };
  let mo = null; let md = null;
  try {
    const OpaqueData = window.require('WAWebMediaOpaqueData');
    const file = window.WWebJS.mediaInfoToFile({ data, mimetype: 'image/png', filename: 'uji.png' });
    const od = await coba('createFromData', () => OpaqueData.createFromData(file, 'image/png'));
    md = await coba('waitForPrep', () => window.require('WAWebPrepRawMedia').prepRawMedia(od, {}).waitForPrep());
    mo = await coba('getOrCreateMediaObject', () => window.require('WAWebMediaStorage').getOrCreateMediaObject(md.filehash));
    const mt = await coba('msgToMediaType', () => window.require('WAWebMmsMediaTypes')
      .msgToMediaType({ type: md.type, isGif: md.isGif, isNewsletter: false }));
    out.diag.mediaType = JSON.stringify(mt);
    await coba('consolidate', () => mo.consolidate(md.toJSON()));
    await coba('castToV4+shouldUseMediaCache', () => window.require('WAWebMediaDataUtils')
      .shouldUseMediaCache(window.require('WAWebMmsMediaTypes').castToV4(mo.type)));
  } catch (e) { /* sudah tercatat di out.langkah */ }

  // Kosakata tipe: mana yang diterima castToV4 sekarang?
  try {
    const T = window.require('WAWebMmsMediaTypes');
    out.diag.tipeMo = mo ? String(mo.type) : null;
    out.diag.tipeMd = md ? String(md.type) : null;
    out.diag.mmsKunci = Object.keys(T).slice(0, 30);
    const asliCast = T.__waFix_castToV4 ? null : T.castToV4;
    const uji = ['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'gif', 'IMAGE', 'image/jpeg'];
    out.diag.castToV4 = uji.map((t) => {
      try {
        const v = (asliCast || T.castToV4)(t);
        return t + '=' + String(v);
      } catch (e) { return t + '!' + String((e && e.message) || e).slice(0, 50); }
    });
  } catch (e) { out.diag.kosakata = 'gagal: ' + String((e && e.message) || e); }

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
      logger[baik ? 'info' : 'error']('Uji media WA: ' + JSON.stringify(hasil.uji).slice(0, 1800));
    } catch (e) {
      hasil.uji = { galat: String((e && e.message) || e) };
      logger.warn('Uji media WA tidak bisa dijalankan: ' + ((e && e.message) || e));
    }
  }
  return hasil;
}

/**
 * Baca catatan tambalan dari halaman - termasuk tumpukan penuh kegagalan
 * processMediaData yang terakhir. Dipanggil SETELAH pengiriman gagal.
 *
 * @param {import('puppeteer').Page} page
 */
async function bacaCatatanMedia(page) {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      try {
        return JSON.parse(JSON.stringify({
          jejakPesan: window.__waJejakPesan || [],
          fix: window.__waFix || {},
        }));
      } catch (e) { return { galat: String((e && e.message) || e) }; }
    });
  } catch (e) {
    return { galat: String((e && e.message) || e) };
  }
}

module.exports = { pasangTambalanMedia, bacaCatatanMedia };
