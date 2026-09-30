'use strict';

const logger = require('./logger').scope('DOI');
const { ambilSvg, samarkanUrl } = require('./doi-client');
const { svgKeGambar } = require('./doi-image');
const { tangkapHalaman, pastikanBare, tampakHalaman, SELECTOR_BAWAAN } = require('./doi-page');
const { normalisasiPic } = require('./lock-report');
const { kunciHari, jamLokal, tanggalLokal } = require('./stock-report');
const { validateWhatsappNumber, buildMentions } = require('./render');
const tujuan = require('./tujuan');

/**
 * Penjadwal MONITORING DOI (jalur 5).
 *
 * Alurnya sederhana dan sengaja dibuat begitu:
 *
 *   1. buka halaman web Monitoring DOI (URL + token di setelan)
 *   2. tangkap layarnya menjadi gambar (JPEG/PNG)
 *   3. kirim GAMBAR ke group tujuan
 *   4. kirim TEKS sebagai pesan kedua, lengkap dengan mention PIC
 *
 * Yang membuat jalur ini berdiri sendiri, bukan menempel ke jalur lain:
 * group tujuan, daftar PIC, isi teks, dan jam kirimnya punya setelan
 * sendiri - semuanya bisa diubah dari Telegram tanpa menyentuh berkas dan
 * tanpa me-restart service.
 *
 * ================== KENAPA TEKS JADI PESAN KEDUA? ==================
 * Caption gambar di WhatsApp bisa memuat mention, tetapi pada banyak versi
 * WhatsApp Web caption panjang terpotong dan mention di dalamnya tidak
 * selalu berubah menjadi notifikasi. Dua pesan terpisah membuat gambar tetap
 * utuh dan mention PIC pasti bekerja. Yang ingin satu pesan bisa memilihnya
 * lewat /doicaption on.
 * ===================================================================
 */

const KUNCI = {
  enabled: 'doi_enabled',
  hours: 'doi_hours',
  groups: 'doi_groups',
  pic: 'doi_pic',
  teks: 'doi_text',
  url: 'doi_url',
  format: 'doi_format',
  mode: 'doi_mode',
  lebar: 'doi_width',
  tinggi: 'doi_height',
  skala: 'doi_scale',
  selector: 'doi_selector',
  caption: 'doi_caption',
  lastFired: 'doi_last_fired',
};

const TEKS_BAWAAN = [
  'Dear {pic}',
  '',
  'Berikut *Monitoring DOI* per {datetime}.',
  '*Mohon segera tindak lanjuti SKU dengan DOI di bawah ambang.*',
  '',
  'Terima kasih.',
  '',
  '_Sent by BOT-WRH_',
].join('\n');

class DoiScheduler {
  constructor({
    db, whatsapp, queue, config, notifyAdmins = null,
    pengambil = null, perender = null, penangkap = null,
  }) {
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.notifyAdmins = notifyAdmins;
    this.dasar = (config && config.doi) || {};

    // Bisa diganti saat pengujian supaya tidak menyentuh jaringan / Chrome.
    this.pengambil = pengambil || ambilSvg;
    this.perender = perender || svgKeGambar;
    this.penangkap = penangkap || tangkapHalaman;

    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastOkAt = null;
    this.lastError = null;
    this.lastSkip = null;          // {waktu, alasan}
    this.lastCara = null;          // perender yang dipakai terakhir
    this.lastBytes = null;
    this.stats = { runs: 0, sent: 0, failed: 0, skipped: 0 };
    this._groupTidakDikenal = [];
    this._groupBelumDisetel = false;
  }

  /* --------------------------- pengaturan --------------------------- */

  _setting(kunci, bawaan) {
    if (!this.db) return bawaan;
    const v = this.db.getSetting(kunci, null);
    return (v === null || v === undefined || v === '') ? bawaan : v;
  }

  static parseJam(raw) {
    const jam = String(raw || '').split(',')
      .map((s) => parseInt(String(s).trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
    return Array.from(new Set(jam)).sort((a, b) => a - b);
  }

  static parseDaftar(raw) {
    return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  static pisahKoma(teks) {
    return String(teks || '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  opsi() {
    const d = this.dasar;
    const c = (this.config && this.config.ocs) || {};
    const url = String(this._setting(KUNCI.url, d.url || ''));
    const modeTersimpan = String(this._setting(KUNCI.mode, d.mode || '')).toLowerCase();
    // Mode tidak perlu disetel manual: URL sudah mengatakannya. Endpoint
    // /api/.../svg berarti SVG, apa pun selainnya adalah halaman web.
    // Setelan eksplisit tetap menang, untuk kasus yang tidak terduga.
    const mode = ['halaman', 'svg'].includes(modeTersimpan)
      ? modeTersimpan
      : (tampakHalaman(url) || !url ? 'halaman' : 'svg');
    // Mode halaman = poster jadi, JPEG 92 seperti yang diuji di sisi web.
    // Mode SVG = tabel hasil render, PNG supaya angkanya tidak berbayang.
    const formatBawaan = d.format || (mode === 'halaman' ? 'jpg' : 'png');
    const format = String(this._setting(KUNCI.format, formatBawaan)).toLowerCase();
    const lebarBawaan = d.lebar || (mode === 'halaman' ? 1600 : 1080);
    return {
      hours: DoiScheduler.parseJam(this._setting(KUNCI.hours, (d.hours || []).join(','))),
      groupIds: DoiScheduler.parseDaftar(this._setting(KUNCI.groups, (d.groupIds || []).join(','))),
      url: mode === 'halaman' ? pastikanBare(url) : url,
      urlMentah: url,
      mode,
      format: ['png', 'jpg', 'jpeg'].includes(format) ? format : formatBawaan,
      lebar: Math.max(200, parseInt(this._setting(KUNCI.lebar, lebarBawaan), 10) || lebarBawaan),
      tinggi: Math.max(240, parseInt(this._setting(KUNCI.tinggi, d.tinggi || 900), 10) || 900),
      skala: Math.min(3, Math.max(1, parseInt(this._setting(KUNCI.skala, d.skala || 2), 10) || 2)),
      selector: (() => {
        const v = this.db ? this.db.getSetting(KUNCI.selector, null) : null;
        if (v === null || v === undefined) return d.selector === undefined ? SELECTOR_BAWAAN : d.selector;
        return String(v);   // string kosong = sengaja tidak menunggu penanda
      })(),
      caption: String(this._setting(KUNCI.caption, d.caption ? '1' : '0')) === '1',
      teks: String(this._setting(KUNCI.teks, d.teks || TEKS_BAWAAN)),
      timeoutMs: d.timeoutMs || 60000,
      tzOffsetMinutes: c.tzOffsetMinutes || 420,
      tzLabel: c.tzLabel || 'WIB',
    };
  }

  enabled() {
    const v = this.db ? this.db.getSetting(KUNCI.enabled, null) : null;
    if (v !== null && v !== undefined && v !== '') return String(v) === '1';
    return this.dasar.enabled === true;
  }

  setEnabled(on) {
    if (this.db) this.db.setSetting(KUNCI.enabled, on ? '1' : '0');
    logger.info('Monitoring DOI', on ? 'DIAKTIFKAN' : 'DIMATIKAN');
  }

  /** Simpan satu pengaturan. Mengembalikan pesan konfirmasi untuk Telegram. */
  setOpsi(nama, nilai) {
    if (!KUNCI[nama]) throw new Error(`pengaturan "${nama}" tidak dikenal`);

    if (nama === 'hours') {
      if (/^(hapus|kosong|mati|off)$/i.test(String(nilai).trim())) {
        this.db.setSetting(KUNCI.hours, '');
        return 'Jam kirim dikosongkan - DOI tidak akan terkirim otomatis lagi.';
      }
      const jam = DoiScheduler.parseJam(nilai);
      if (jam.length === 0) throw new Error('isi jam 0-23 dipisah koma, contoh: 8,13,16');
      this.db.setSetting(KUNCI.hours, jam.join(','));
      return `Jam kirim DOI: ${this._jamTeks(jam)}`;
    }

    if (nama === 'groups') {
      const daftar = DoiScheduler.parseDaftar(nilai);
      this.db.setSetting(KUNCI.groups, daftar.join(','));
      return daftar.length === 0
        ? 'Group tujuan DOI dikosongkan - laporan tidak akan terkirim.'
        : `Group tujuan DOI: ${daftar.join(', ')}`;
    }

    if (nama === 'url') {
      const teks = String(nilai || '').trim();
      if (/^(hapus|kosong)$/i.test(teks)) {
        this.db.setSetting(KUNCI.url, '');
        return 'URL DOI dikosongkan.';
      }
      let u;
      try { u = new URL(teks); } catch (err) {
        throw new Error('URL tidak sah. Tempelkan URL lengkap termasuk https://');
      }
      if (!/^https?:$/.test(u.protocol)) throw new Error('URL harus http atau https');
      // Mode ikut URL-nya, tidak perlu disetel terpisah: satu perintah, satu
      // keputusan. Setelan mode lama dibersihkan supaya tidak diam-diam
      // bertengkar dengan URL yang baru.
      this.db.setSetting(KUNCI.url, teks);
      this.db.setSetting(KUNCI.mode, '');
      const o = this.opsi();
      if (o.mode === 'halaman') {
        const bare = pastikanBare(teks) !== teks
          ? '\n\nParameter "bare=1" ditambahkan otomatis - tanpa itu yang tertangkap '
            + 'adalah halaman penuh berikut tombol dan padding-nya.'
          : '';
        return `URL DOI: ${samarkanUrl(o.url)}\nMode: TANGKAP LAYAR HALAMAN `
          + `(${o.lebar}x${o.tinggi} @${o.skala}x, ${o.format.toUpperCase()})${bare}`;
      }
      return `URL DOI: ${samarkanUrl(o.url)}\nMode: RENDER SVG (${o.format.toUpperCase()} ${o.lebar}px)`;
    }

    if (nama === 'mode') {
      const m = String(nilai).trim().toLowerCase();
      if (/^(auto|otomatis|hapus|kosong)$/i.test(m)) {
        this.db.setSetting(KUNCI.mode, '');
        return `Mode mengikuti URL lagi. Sekarang: ${this.opsi().mode}`;
      }
      if (!['halaman', 'svg'].includes(m)) throw new Error('pilih: halaman, svg, atau auto');
      this.db.setSetting(KUNCI.mode, m);
      return m === 'halaman'
        ? 'Mode: TANGKAP LAYAR HALAMAN - dirender browser, jadi font dan tata letaknya '
          + 'persis seperti yang terlihat di layar.'
        : 'Mode: RENDER SVG - endpoint SVG diambil lalu dirender sendiri.';
    }

    if (nama === 'tinggi') {
      const n = parseInt(String(nilai).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 240 || n > 4000) throw new Error('isi tinggi 240 - 4000 piksel');
      this.db.setSetting(KUNCI.tinggi, String(n));
      return `Tinggi halaman: ${n} piksel`;
    }

    if (nama === 'skala') {
      const n = parseInt(String(nilai).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 1 || n > 3) throw new Error('isi 1, 2, atau 3');
      this.db.setSetting(KUNCI.skala, String(n));
      const o = this.opsi();
      return `Ketajaman: ${n}x (gambar jadi ${o.lebar * n}x${o.tinggi * n} piksel)`
        + (n === 1 ? ' - berkas paling kecil' : n >= 3 ? ' - berkas paling besar' : ' - teks tajam saat di-zoom di HP');
    }

    if (nama === 'selector') {
      const teks = String(nilai || '').trim();
      if (/^(hapus|kosong|mati|off)$/i.test(teks)) {
        this.db.setSetting(KUNCI.selector, '');
        return 'Penungguan penanda siap DIMATIKAN. Layar ditangkap segera setelah '
          + 'jaringan halaman tenang - ada risiko poster tertangkap sebelum datanya tampil.';
      }
      if (/^(reset|bawaan|default)$/i.test(teks)) {
        this.db.setSetting(KUNCI.selector, SELECTOR_BAWAAN);
        return `Penanda siap kembali ke bawaan: ${SELECTOR_BAWAAN}`;
      }
      this.db.setSetting(KUNCI.selector, teks);
      return `Penanda siap: ${teks}`;
    }

    if (nama === 'format') {
      const f = String(nilai).trim().toLowerCase();
      if (!['png', 'jpg', 'jpeg'].includes(f)) throw new Error('pilih: png atau jpg');
      this.db.setSetting(KUNCI.format, f);
      return f === 'png'
        ? 'Format gambar: PNG (paling tajam untuk tabel dan angka)'
        : 'Format gambar: JPG (berkas lebih kecil, tulisan sedikit berbayang)';
    }

    if (nama === 'lebar') {
      const n = parseInt(String(nilai).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 200 || n > 2000) throw new Error('isi lebar 200 - 2000 piksel');
      this.db.setSetting(KUNCI.lebar, String(n));
      return `Lebar gambar: ${n} piksel`;
    }

    if (nama === 'caption') {
      const on = /^(on|1|ya|nyala|true)$/i.test(String(nilai).trim());
      this.db.setSetting(KUNCI.caption, on ? '1' : '0');
      return on
        ? 'Teks dikirim sebagai CAPTION gambar - satu pesan saja.'
        : 'Teks dikirim sebagai PESAN KEDUA setelah gambar (disarankan).';
    }

    if (nama === 'teks') {
      const teks = String(nilai == null ? '' : nilai);
      if (/^(reset|bawaan|default)$/i.test(teks.trim())) {
        this.db.setSetting(KUNCI.teks, TEKS_BAWAAN);
        return `Teks dikembalikan ke bawaan:\n\n${TEKS_BAWAAN}`;
      }
      if (teks.trim().length < 3) throw new Error('teks terlalu pendek');
      this.db.setSetting(KUNCI.teks, teks);
      return `Teks DOI disimpan:\n\n${teks}`;
    }

    throw new Error(`pengaturan "${nama}" tidak bisa diubah dari sini`);
  }

  _jamTeks(jam) {
    return jam.map((j) => `${String(j).padStart(2, '0')}:00`).join(', ');
  }

  /* ------------------------------- PIC ------------------------------ */

  /**
   * PIC Monitoring DOI - daftar datar, TERPISAH dari PIC lock stock maupun
   * PIC laporan stok. Orangnya memang boleh berbeda; itu justru alasan
   * jalur ini dibuat sendiri.
   */
  picList() {
    try {
      const mentah = this._setting(KUNCI.pic, '');
      if (mentah) return normalisasiPic(JSON.parse(mentah));
    } catch (err) {
      logger.warn('Pengaturan PIC DOI rusak, diabaikan:', err.message);
    }
    return [];
  }

  setPicNama(nama) {
    const baru = DoiScheduler.pisahKoma(nama);
    if (baru.length === 0) {
      this.db.setSetting(KUNCI.pic, '');
      return 'PIC DOI dikosongkan - pesan dikirim tanpa sapaan.';
    }
    const lama = this.picList();
    const hasil = baru.map((n, i) => ({ nama: n, nomor: (lama[i] && lama[i].nomor) || '' }));
    this.db.setSetting(KUNCI.pic, JSON.stringify(hasil));
    return `PIC DOI (${hasil.length} orang):\n${this._picTeks(hasil)}`;
  }

  setPicNomor(nomor) {
    const daftar = this.picList();
    if (daftar.length === 0) throw new Error('belum ada PIC. Isi namanya dulu dengan /doipic');
    const mentah = String(nomor || '').trim();
    if (mentah === '' || /^(hapus|kosong|-)$/i.test(mentah)) {
      const kosong = daftar.map((p) => ({ ...p, nomor: '' }));
      this.db.setSetting(KUNCI.pic, JSON.stringify(kosong));
      return 'Semua nomor PIC DOI dihapus - namanya tetap disapa, tanpa mention.';
    }
    const potongan = DoiScheduler.pisahKoma(mentah);
    if (potongan.length > daftar.length) {
      throw new Error(`ada ${potongan.length} nomor tetapi hanya ${daftar.length} nama PIC. `
        + 'Tambahkan namanya dulu dengan /doipic');
    }
    const bersih = [];
    for (const [i, n] of potongan.entries()) {
      if (/^(kosong|-)$/i.test(n)) { bersih.push(''); continue; }
      const cek = validateWhatsappNumber(n);
      if (!cek.ok) throw new Error(`nomor ke-${i + 1} ("${n}"): ${cek.error}`);
      bersih.push(cek.value);
    }
    const hasil = daftar.map((p, i) => ({ ...p, nomor: i < bersih.length ? bersih[i] : p.nomor }));
    this.db.setSetting(KUNCI.pic, JSON.stringify(hasil));
    return `PIC DOI:\n${this._picTeks(hasil)}`;
  }

  _picTeks(daftar) {
    return daftar
      .map((p, i) => `  ${i + 1}. ${p.nama}${p.nomor ? ` (@${p.nomor})` : ' - belum ada nomor'}`)
      .join('\n');
  }

  /* ------------------------------- teks ----------------------------- */

  /**
   * Susun teks pendamping beserta daftar JID yang benar-benar di-mention.
   *
   * Placeholder: {pic} {datetime} {date} {time} {tanggal} {jam}
   * PIC tanpa nomor tetap disapa dengan namanya - tidak menjadi mention,
   * dan itu disengaja: nama yang salah tulis lebih baik terlihat daripada
   * hilang tanpa jejak.
   */
  susunTeks(now = new Date()) {
    const o = this.opsi();
    const pic = this.picList();
    const off = o.tzOffsetMinutes;

    const denganNomor = pic.filter((p) => p.nomor);
    const { jids } = buildMentions(
      denganNomor.map((p) => ({ name: p.nama, whatsapp_number: p.nomor })),
      'number'
    );
    const bagian = pic.map((p) => (p.nomor ? `${p.nama} @${p.nomor}` : p.nama));
    const sapaan = bagian.length === 0
      ? 'Tim'
      : (bagian.length === 1 ? bagian[0] : `${bagian.slice(0, -1).join(', ')} & ${bagian[bagian.length - 1]}`);

    const tanggal = tanggalLokal(now, off);
    const jam = jamLokal(now, off, o.tzLabel);
    const teks = String(o.teks)
      .split('{pic}').join(sapaan)
      .split('{users}').join(sapaan)
      .split('{datetime}').join(`${tanggal} ${jam}`)
      .split('{tanggal}').join(tanggal)
      .split('{date}').join(tanggal)
      .split('{jam}').join(jam)
      .split('{time}').join(jam);

    return { text: teks, mentions: jids, pic };
  }

  /** Teks contoh untuk /doitext dan /doistatus, tanpa mengirim apa pun. */
  pratinjau(now = new Date()) {
    const s = this.susunTeks(now);
    return `${s.text}\n\n(${s.mentions.length} mention)`;
  }

  /* ----------------------------- penjadwal --------------------------- */

  _kunciJam(now, off, jam) {
    return `${kunciHari(now, off)}:${String(jam).padStart(2, '0')}`;
  }

  /**
   * Jam kirim yang jatuh tempo sekarang, atau null. Toleransi menit dipakai
   * supaya laporan tetap terkirim walau service baru hidup pukul 08:04.
   */
  jatuhTempo(now = new Date(), toleransiMenit = 10) {
    const o = this.opsi();
    if (o.hours.length === 0) return null;
    const l = new Date(now.getTime() + o.tzOffsetMinutes * 60000);
    const jam = l.getUTCHours();
    if (!o.hours.includes(jam)) return null;
    if (l.getUTCMinutes() > toleransiMenit) return null;
    const kunci = this._kunciJam(now, o.tzOffsetMinutes, jam);
    if (this.db && this.db.getSetting(KUNCI.lastFired, '') === kunci) return null;
    return { jam, kunci };
  }

  start() {
    if (this.timer) return;
    const o = this.opsi();
    logger.info(o.hours.length > 0
      ? `Monitoring DOI dijadwalkan pukul ${this._jamTeks(o.hours)} ${o.tzLabel}.`
      : 'Monitoring DOI: belum ada jam kirim yang disetel (/doijam).');
    if (o.hours.length > 0 && !this.enabled()) {
      logger.warn('Tombol Monitoring DOI sedang MATI - jam kirim tidak menghasilkan apa pun. Nyalakan dengan /doion.');
    }
    this.timer = setInterval(() => {
      const tempo = this.jatuhTempo();
      if (!tempo) return;
      // Jamnya sudah tiba. Bila tetap tidak dikirim, sebutkan alasannya -
      // jadwal yang diam tanpa jejak adalah gejala yang tidak bisa dilacak.
      if (!this.enabled()) { this._catatDilewati('tombol MATI - nyalakan dengan /doion'); return; }
      if (this.db) this.db.setSetting(KUNCI.lastFired, tempo.kunci);
      this.runOnce().catch((err) => logger.error('Monitoring DOI gagal:', err.message));
    }, 60000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /* --------------------------- satu putaran -------------------------- */

  async runOnce({ paksa = false, now = new Date() } = {}) {
    if (this.running) {
      this.stats.skipped += 1;
      logger.warn('Putaran DOI sebelumnya belum selesai - dilewati.');
      return { status: 'skipped', reason: 'sedang berjalan' };
    }
    if (!paksa && !this.enabled()) {
      this.stats.skipped += 1;
      this._catatDilewati('tombol MATI - nyalakan dengan /doion');
      return { status: 'skipped', reason: 'dimatikan' };
    }

    this.running = true;
    this.lastRunAt = Date.now();
    this.stats.runs += 1;
    try {
      // Tujuan diperiksa LEBIH DULU, sebelum menarik gambar dari web.
      // Menarik SVG lalu merendernya untuk kemudian ditolak karena group
      // belum disetel hanya membuang waktu dan menyamarkan sebab aslinya:
      // pesan galat yang muncul jadi soal URL/render, padahal yang kurang
      // adalah tujuannya.
      this.periksaTujuan();
      const gambar = await this.ambilGambar();
      const teks = this.susunTeks(now);
      const hasil = await this.kirim(gambar, teks);
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.stats.sent += 1;
      return { status: 'sent', groups: hasil.terkirim, cara: gambar.cara, bytes: gambar.buffer.length, text: teks.text };
    } catch (err) {
      this.stats.failed += 1;
      this.lastError = err.message;
      logger.error('Monitoring DOI gagal:', err.message);
      this._notify(`Monitoring DOI gagal: ${err.message}`);
      return { status: 'failed', reason: err.message };
    } finally {
      this.running = false;
    }
  }

  /** Browser Chrome milik WhatsApp Web - dipakai kedua mode. */
  _ambilBrowser() {
    return (this.wa && typeof this.wa.browser === 'function') ? this.wa.browser() : null;
  }

  /**
   * Ambil gambar DOI siap kirim.
   *
   * MODE UTAMA "halaman": buka halaman web ?bare=1 lalu tangkap layarnya.
   * Yang merender adalah browser, dengan font browser, jadi hasilnya persis
   * seperti yang terlihat di layar - tidak ada risiko font pengganti yang
   * menggeser tata letak tabel.
   *
   * MODE "svg" tetap ada untuk endpoint /api/.../svg. Perlu diingat: apa pun
   * modenya, yang dikirim ke WhatsApp SELALU gambar raster. WhatsApp tidak
   * bisa mengirim SVG sama sekali - galatnya bahkan menyesatkan
   * ("Data passed to getter must include an id property"), terbaca seperti
   * masalah ID group padahal medianya yang salah format.
   */
  async ambilGambar() {
    const o = this.opsi();
    if (!o.url) {
      throw new Error('URL DOI belum disetel. Setel dengan /doiurl <url lengkap berikut token>');
    }

    let gambar;
    if (o.mode === 'halaman') {
      gambar = await this.penangkap(o.url, {
        ambilBrowser: () => this._ambilBrowser(),
        lebar: o.lebar,
        tinggi: o.tinggi,
        skala: o.skala,
        format: o.format,
        selector: o.selector,
        timeoutMs: o.timeoutMs,
      });
    } else {
      const { svg } = await this.pengambil(o.url, { timeoutMs: o.timeoutMs });
      gambar = await this.perender(svg, {
        format: o.format,
        lebar: o.lebar,
        // Chrome-nya milik WhatsApp Web; halaman baru dibuka dan ditutup
        // sendiri oleh perender, halaman WhatsApp tidak disentuh.
        ambilBrowser: () => this._ambilBrowser(),
      });
    }
    this.lastCara = gambar.cara;
    this.lastBytes = gambar.buffer.length;
    return gambar;
  }

  /**
   * Group tujuan DOI.
   *
   * WAJIB disebut - TIDAK ADA "jatuh ke semua group aktif". Jalur yang punya
   * PIC dan isi pesan sendiri harus punya tujuan yang disebut, bukan diwarisi
   * dari Forwarder; lihat alasan lengkapnya di src/tujuan.js.
   */
  targetGroups() {
    const pilihan = this.opsi().groupIds;
    this._groupTidakDikenal = [];
    this._groupBelumDisetel = pilihan.length === 0;
    if (this._groupBelumDisetel) return [];

    const semua = this.db.listWaGroups().map((g) => ({ id: String(g.group_id), name: g.name || g.group_id }));
    const hasil = [];
    const tidakDikenal = [];
    for (const p of pilihan) {
      const cocok = semua.find((g) => g.id === p || String(g.name).toLowerCase() === p.toLowerCase());
      if (cocok) hasil.push(cocok);
      else if (/@g\.us$/i.test(p)) hasil.push({ id: p, name: p });
      else tidakDikenal.push(p);
    }
    this._groupTidakDikenal = tidakDikenal;
    return hasil;
  }

  /**
   * Pastikan ada tujuan yang jelas. Melempar galat yang menyebutkan cara
   * memperbaikinya, bukan sekadar "gagal".
   */
  periksaTujuan() {
    const groups = this.targetGroups();
    if (groups.length > 0) return groups;
    if (this._groupTidakDikenal.length > 0) {
      throw new Error(`tujuan tidak dikenal: ${this._groupTidakDikenal.join(', ')}. `
        + 'Isi dengan JID (contoh 1203...@g.us) atau nama group yang terdaftar di /groups.');
    }
    throw new Error(
      'group tujuan DOI BELUM DISETEL. Jalur ini sengaja tidak memakai group '
      + 'Forwarder maupun group jalur lain supaya tidak menumpuk. '
      + 'Setel dengan: /doigroup <JID atau nama group>'
    );
  }

  /** Kirim gambar lalu teks ke seluruh group tujuan. */
  async kirim(gambar, teks) {
    const groups = this.periksaTujuan();
    if (!this.wa.isReady()) throw new Error('WhatsApp belum tersambung');

    const o = this.opsi();
    let terkirim = 0;
    const gagal = [];
    for (const group of groups) {
      try {
        if (o.caption) {
          // Satu pesan: gambar dengan teks sebagai caption.
          await this.queue.enqueue(
            () => this.wa.sendImage(group.id, gambar, { caption: teks.text, mentions: teks.mentions }),
            `DOI gambar+caption -> ${group.name}`
          );
        } else {
          await this.queue.enqueue(
            () => this.wa.sendImage(group.id, gambar),
            `DOI gambar -> ${group.name}`
          );
          if (String(teks.text || '').trim()) {
            await this.queue.enqueue(
              () => this.wa.sendText(group.id, teks.text, teks.mentions),
              `DOI teks -> ${group.name} (${teks.mentions.length} mention)`
            );
          }
        }
        terkirim += 1;
      } catch (err) {
        gagal.push(`${group.name}: ${err.message}`);
        logger.error(`Monitoring DOI gagal dikirim ke "${group.name}": ${err.message}`);
      }
    }
    if (terkirim === 0) throw new Error(`gagal ke seluruh group. ${gagal.join(' | ')}`);
    if (gagal.length > 0) {
      this._notify(`Monitoring DOI terkirim ke ${terkirim}/${groups.length} group. Gagal: ${gagal.join(' | ')}`);
    }
    logger.info(`Monitoring DOI terkirim ke ${terkirim} group.`);
    return { terkirim, gagal };
  }

  /** Group DOI yang juga dipakai jalur lain - dibuat kelihatan, bukan didiamkan. */
  groupBentrok() {
    const peta = tujuan.petaTujuan(this.db, this.config);
    const milikDoi = this.targetGroups().map((g) => String(g.id));
    const bentrok = [];
    for (const g of peta.forwarder) {
      if (milikDoi.includes(g.id)) bentrok.push({ id: g.id, name: g.name, jalur: 'Forwarder Telegram' });
    }
    for (const jid of tujuan.jidJalur(this.db, this.config, 'lock')) {
      if (milikDoi.includes(String(jid))) bentrok.push({ id: jid, name: jid, jalur: 'Peringatan Lock Stock' });
    }
    return bentrok;
  }

  ringkasanStatus() {
    const o = this.opsi();
    const off = o.tzOffsetMinutes;
    const B = [];
    B.push(`Monitoring DOI: ${this.enabled() ? 'AKTIF' : 'MATI'}`);
    B.push(o.hours.length > 0
      ? `Jam kirim: ${this._jamTeks(o.hours)} ${o.tzLabel}`
      : 'Jam kirim: belum disetel');
    B.push(`Sumber gambar: ${samarkanUrl(o.url)}`);
    B.push(o.mode === 'halaman'
      ? `Cara: tangkap layar halaman ${o.lebar}x${o.tinggi} @${o.skala}x `
        + `= ${o.lebar * o.skala}x${o.tinggi * o.skala} ${o.format.toUpperCase()}`
      : `Cara: render SVG jadi ${o.format.toUpperCase()} ${o.lebar}px`);
    if (o.mode === 'halaman') {
      B.push(`Penanda siap: ${o.selector || '(tidak ditunggu - berisiko poster kosong)'}`);
    }
    B.push(`Teks: ${o.caption ? 'jadi caption gambar (1 pesan)' : 'pesan kedua setelah gambar'}`);
    const pic = this.picList();
    B.push(`PIC: ${pic.length === 0 ? '(belum diisi - pesan tanpa sapaan)'
      : pic.map((p) => `${p.nama}${p.nomor ? ` (@${p.nomor})` : ' [tanpa nomor]'}`).join(', ')}`);
    const groups = this.targetGroups();
    B.push(`Group tujuan: ${this._groupBelumDisetel ? 'BELUM DISETEL - tidak akan terkirim'
      : groups.map((g) => g.name).join(', ')}`);
    if (this._groupTidakDikenal.length > 0) {
      B.push(`Tujuan tidak dikenal: ${this._groupTidakDikenal.join(', ')}`);
    }
    const bentrok = this.groupBentrok();
    if (bentrok.length > 0) {
      B.push(`PERHATIAN: group "${bentrok[0].name}" juga dipakai ${bentrok[0].jalur} - dua jalur akan menumpuk. Lihat /tujuan.`);
    }
    B.push(`Penjadwal: ${this.timer ? 'jalan' : 'TIDAK JALAN'}`);
    B.push(`Perender terakhir: ${this.lastCara || '-'}${this.lastBytes ? ` (${Math.round(this.lastBytes / 1024)} KB)` : ''}`);
    B.push(`Terakhir dijalankan: ${this.lastRunAt ? jamLokal(new Date(this.lastRunAt), off, o.tzLabel) : '-'}`);
    B.push(`Terakhir berhasil: ${this.lastOkAt ? jamLokal(new Date(this.lastOkAt), off, o.tzLabel) : '-'}`);
    if (this.lastSkip) {
      B.push(`Terakhir dilewati: ${jamLokal(new Date(this.lastSkip.waktu), off, o.tzLabel)} - ${this.lastSkip.alasan}`);
    }
    B.push(`Terkirim: ${this.stats.sent} | gagal: ${this.stats.failed} | dilewati: ${this.stats.skipped}`);
    if (this.lastError) B.push(`Galat terakhir: ${this.lastError}`);

    if (!o.url) {
      B.push('');
      B.push('CATATAN: URL belum disetel. /doiurl https://doi-monitor.vercel.app/api/public/wa/svg?k=TOKEN');
    } else if (this._groupBelumDisetel) {
      B.push('');
      B.push('CATATAN: group tujuan belum disetel. /doigroup <JID atau nama group>');
    } else if (o.hours.length === 0) {
      B.push('');
      B.push('CATATAN: jam kirim belum disetel, jadi tidak akan pernah terkirim otomatis. /doijam 8,13,16');
    } else if (!this.enabled()) {
      B.push('');
      B.push('CATATAN: tombol sedang MATI. Nyalakan dengan /doion.');
    }
    return B.join('\n');
  }

  _catatDilewati(alasan) {
    this.lastSkip = { waktu: Date.now(), alasan };
    this.stats.skipped += 1;
    logger.info(`Monitoring DOI dilewati: ${alasan}.`);
  }

  _notify(text) {
    if (typeof this.notifyAdmins === 'function') {
      try { this.notifyAdmins(text); } catch (e) { /* diabaikan */ }
    }
  }
}

module.exports = DoiScheduler;
module.exports.KUNCI = KUNCI;
module.exports.TEKS_BAWAAN = TEKS_BAWAAN;
