'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger').scope('OCS');

/**
 * Klien HTTP untuk IEG OCS (https://ocs.iegsystem.id).
 * Tanpa dependensi tambahan - memakai modul https bawaan Node.
 *
 * Kontrak autentikasi (hasil pembacaan bundel aplikasi OCS):
 *   POST /Auth/Login   body {username, password, companydb} -> { Token: "<jwt>" }
 *   Header berikutnya: Authorization: Bearer <Token>
 *   Saat 401 pada endpoint non-/Auth/: POST /Auth/Refresh (memakai cookie)
 *     -> { Token } lalu permintaan diulang satu kali.
 *   POST /Auth/Logout untuk mengakhiri sesi.
 *
 * Cookie disimpan sendiri karena /Auth/Refresh bergantung pada cookie HttpOnly.
 */
class OcsClient {
  constructor({
    baseUrl = 'https://ocs.iegsystem.id',
    username,
    password,
    database,
    timeoutMs = 20000,
    userAgent = 'telegram-wa-bridge/1.0 (+ocs-report)',
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.database = database;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 20000);
    this.userAgent = userAgent;

    this.token = null;
    this.tokenExp = 0;      // detik epoch, dari klaim exp JWT
    this.cookies = new Map();
    this._loginInFlight = null;
  }

  /* --------------------------- utilitas ---------------------------- */

  _cookieHeader() {
    if (this.cookies.size === 0) return null;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _storeCookies(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      const pair = String(raw).split(';')[0];
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  /** Baca klaim exp dari JWT tanpa memverifikasi tanda tangan. */
  static decodeExp(token) {
    try {
      const part = String(token).split('.')[1];
      if (!part) return 0;
      const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(json);
      return Number(payload.exp) || 0;
    } catch (err) {
      return 0;
    }
  }

  _tokenExpired() {
    if (!this.token) return true;
    if (!this.tokenExp) return false;         // tidak diketahui - anggap masih hidup
    return Date.now() / 1000 >= this.tokenExp - 60;  // sisakan 1 menit
  }

  /* ------------------------ permintaan mentah ---------------------- */

  _request(method, path, { body = null, headers = {} } = {}) {
    const url = new URL(path.startsWith('http') ? path : this.baseUrl + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const finalHeaders = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': this.userAgent,
      ...headers,
    };
    if (body !== null && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    if (body !== null) finalHeaders['Content-Length'] = Buffer.byteLength(body);
    const cookie = this._cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: finalHeaders,
    };

    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        this._storeCookies(res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Waktu tunggu habis (${this.timeoutMs} ms) saat ${method} ${url.pathname}`));
      });
      req.on('error', reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }

  /* ----------------------------- sesi ------------------------------ */

  /** Login dan simpan token. Panggilan berbarengan dipakai bersama. */
  async login() {
    if (this._loginInFlight) return this._loginInFlight;
    this._loginInFlight = this._doLogin().finally(() => { this._loginInFlight = null; });
    return this._loginInFlight;
  }

  async _doLogin() {
    if (!this.username || !this.password || !this.database) {
      throw new Error('OCS_USERNAME, OCS_PASSWORD, dan OCS_DATABASE wajib diisi di .env');
    }
    const body = JSON.stringify({
      username: String(this.username),
      password: String(this.password),
      companydb: String(this.database),
    });
    const res = await this._request('POST', '/Auth/Login', { body });

    if (res.status !== 200) {
      throw new Error(`Login OCS gagal (HTTP ${res.status}). ${ringkas(res.text)}`);
    }
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (err) {
      throw new Error(`Login OCS gagal: jawaban bukan JSON. ${ringkas(res.text)}`);
    }
    const token = data && (data.Token || data.token);
    if (!token) {
      throw new Error(`Login OCS gagal: token tidak ada di jawaban. ${ringkas(res.text)}`);
    }
    this.token = token;
    this.tokenExp = OcsClient.decodeExp(token);
    logger.info('Login OCS berhasil sebagai', this.username, '/', this.database);
    return token;
  }

  /** Perpanjang token memakai cookie. Mengembalikan true bila berhasil. */
  async refresh() {
    try {
      const res = await this._request('POST', '/Auth/Refresh');
      if (res.status !== 200) return false;
      const data = JSON.parse(res.text);
      const token = data && (data.Token || data.token);
      if (!token) return false;
      this.token = token;
      this.tokenExp = OcsClient.decodeExp(token);
      logger.debug('Token OCS diperpanjang lewat /Auth/Refresh');
      return true;
    } catch (err) {
      logger.debug('Perpanjangan token gagal:', err.message);
      return false;
    }
  }

  async logout() {
    if (!this.token) return;
    try {
      await this._request('POST', '/Auth/Logout', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      logger.debug('Logout OCS gagal (diabaikan):', err.message);
    } finally {
      this.token = null;
      this.tokenExp = 0;
      this.cookies.clear();
    }
  }

  /* ------------------------- ambil data JSON ----------------------- */

  /**
   * GET yang mengurus token: login bila belum ada, refresh lalu ulang bila 401.
   * @param {string} path contoh: '/FulfilmentDashboard/Summary'
   * @param {Record<string, string|number>} params
   */
  async getJson(path, params = {}) {
    if (this._tokenExpired()) await this.login();

    const qs = buildQuery(params);
    const full = qs ? `${path}?${qs}` : path;

    let res = await this._request('GET', full, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (res.status === 401) {
      const ok = await this.refresh();
      if (!ok) await this.login();
      res = await this._request('GET', full, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    }

    if (res.status !== 200) {
      throw new Error(`OCS ${path} menjawab HTTP ${res.status}. ${ringkas(res.text)}`);
    }
    if (!res.text || !res.text.trim()) return null;
    try {
      return JSON.parse(res.text);
    } catch (err) {
      throw new Error(`OCS ${path} mengirim jawaban yang bukan JSON. ${ringkas(res.text)}`);
    }
  }

  /**
   * Ambil seluruh bagian Fulfilment Dashboard untuk satu rentang waktu.
   * Bagian yang gagal diisi null, bukan menggagalkan keseluruhan laporan.
   * @param {{from: string, to: string, shop?: string, channel?: string,
   *          area?: string, shift?: string, role?: string, dateType?: string}} filter
   */
  async fetchFulfilment(filter) {
    const dasar = {
      from: filter.from,
      to: filter.to,
      shop: filter.shop || 'All',
      channel: filter.channel || 'All',
      area: filter.area || 'All',
    };
    const denganTanggal = { ...dasar, dateType: filter.dateType || 'dueDate' };
    const denganPeran = { ...dasar, role: filter.role || 'all', shift: filter.shift || 'All' };

    const bagian = [
      ['summary', '/FulfilmentDashboard/Summary', denganTanggal],
      ['statusBuckets', '/FulfilmentDashboard/StatusBuckets', denganTanggal],
      ['funnel', '/FulfilmentDashboard/PipelineFunnel', denganTanggal],
      ['aging', '/FulfilmentDashboard/Aging', denganTanggal],
      ['throughput', '/FulfilmentDashboard/Throughput', denganPeran],
      ['leaderboard', '/FulfilmentDashboard/Leaderboard', denganPeran],
      ['cycle', '/FulfilmentDashboard/CycleTime', dasar],
    ];

    const hasil = { filter, errors: [] };
    for (const [nama, path, params] of bagian) {
      try {
        hasil[nama] = await this.getJson(path, params);
      } catch (err) {
        hasil[nama] = null;
        hasil.errors.push(`${nama}: ${err.message}`);
        logger.warn(`Bagian "${nama}" gagal diambil: ${err.message}`);
      }
    }
    return hasil;
  }

  /**
   * Ambil HANYA leaderboard + throughput untuk satu rentang waktu.
   * Dipakai untuk peringkat operator bulan berjalan, yang rentangnya berbeda
   * dengan sisa laporan (harian).
   *
   * role sengaja dikirim 'all': penyaringan peran dilakukan di sisi kita,
   * supaya bisa memilih lebih dari satu peran sekaligus (packer + picker).
   */
  async fetchOperatorRange(filter) {
    const params = {
      from: filter.from,
      to: filter.to,
      shop: filter.shop || 'All',
      channel: filter.channel || 'All',
      area: filter.area || 'All',
      role: 'all',
      shift: filter.shift || 'All',
    };

    const hasil = { from: filter.from, to: filter.to, errors: [] };
    for (const [nama, path] of [
      ['leaderboard', '/FulfilmentDashboard/Leaderboard'],
      ['throughput', '/FulfilmentDashboard/Throughput'],
    ]) {
      try {
        hasil[nama] = await this.getJson(path, params);
      } catch (err) {
        hasil[nama] = null;
        hasil.errors.push(`${nama} (bulan berjalan): ${err.message}`);
        logger.warn(`Bagian "${nama}" bulan berjalan gagal diambil: ${err.message}`);
      }
    }
    return hasil;
  }

  /* --------------------- stok & penjualan per SKU -------------------- */

  /**
   * Daftar stok dari halaman Stocks > View V2.
   * Penyaringan dikerjakan di sisi OCS lewat OData supaya yang terkirim
   * lewat jaringan hanya baris yang memang dibutuhkan.
   *
   * @param {{ambang?: number, kategori?: string, hanyaAktif?: boolean,
   *          area?: string}} filter
   * @returns {Promise<Array>}
   */
  async fetchLowStock(filter = {}) {
    const syarat = [];
    if (filter.hanyaAktif !== false) syarat.push('IsActive eq true');
    if (filter.kategori) syarat.push(`Category eq '${String(filter.kategori).replace(/'/g, "''")}'`);
    if (filter.area) syarat.push(`AreaId eq '${String(filter.area).replace(/'/g, "''")}'`);
    const ambang = Number.isFinite(filter.ambang) ? filter.ambang : 1000;
    syarat.push(`AvailableQty lt ${Math.round(ambang)}`);

    const hasil = await this.getJson('/odata/DTO_WmsItemStockLiteV2', {
      $filter: syarat.join(' and '),
      $orderby: 'AvailableQty',
    });
    if (!hasil) return [];
    return Array.isArray(hasil) ? hasil : (hasil.value || []);
  }

  /**
   * Penjualan per SKU per hari dari halaman Report > Order > Sku.
   * @param {{from: string, to: string, platform?: string, shop?: string, area?: string}} filter
   * @returns {Promise<Array>}
   */
  async fetchOrderPerSku(filter) {
    const hasil = await this.getJson('/Report/OrderPerSkuReport', {
      from: filter.from,
      to: filter.to,
      platform: filter.platform || 'All',
      shop: filter.shop || 'All',
      area: filter.area || 'All',
    });
    if (!hasil) return [];
    return Array.isArray(hasil) ? hasil : (hasil.value || hasil.data || []);
  }

  /**
   * Sama seperti di atas, tetapi rentang panjang dipecah menjadi beberapa
   * permintaan. OCS menjawab 504 Gateway Timeout untuk rentang 90 hari
   * sekaligus, sedangkan 30 hari aman (sekitar 2 MB per potong).
   *
   * @param {{from: string, to: string, chunkDays?: number}} filter
   */
  async fetchOrderPerSkuRange(filter) {
    const potong = Math.max(1, Number(filter.chunkDays) || 30);
    const HARI = 24 * 3600 * 1000;
    const akhir = new Date(filter.to).getTime();
    let mulai = new Date(filter.from).getTime();

    const semua = [];
    const errors = [];
    const berhasil = [];      // rentang yang BENAR-BENAR berhasil ditarik
    let bagian = 0;
    while (mulai < akhir) {
      const sampai = Math.min(akhir, mulai + potong * HARI);
      bagian += 1;
      try {
        const baris = await this.fetchOrderPerSku({
          from: new Date(mulai).toISOString(),
          to: new Date(sampai).toISOString(),
          platform: filter.platform,
          shop: filter.shop,
          area: filter.area,
        });
        semua.push(...baris);
        berhasil.push({ from: new Date(mulai).toISOString(), to: new Date(sampai).toISOString() });
        logger.debug(`Penjualan bagian ${bagian}: ${baris.length} baris`);
      } catch (err) {
        errors.push(`penjualan bagian ${bagian}: ${err.message}`);
        logger.warn(`Penjualan bagian ${bagian} gagal: ${err.message}`);
      }
      mulai = sampai;
    }

    // PENTING: rentang yang gagal HARUS ikut dikeluarkan dari pembagi.
    // Kalau tidak, penjualannya hilang tetapi harinya tetap dihitung -
    // rata-rata jadi terlalu rendah persis pada saat data sedang bermasalah,
    // dan peringatan stok habis datang terlambat tanpa ada yang sadar.
    return { baris: semua, errors, berhasil };
  }

  /* ------------------------- lock stock ----------------------------- */

  /**
   * SKU yang stok ter-reserve-nya melebihi stok tersedia.
   * OCS sudah menyediakan bendera IsUnderReserve yang persis berarti
   * ReserveQty > AvailableQty, tetapi pemanggil tetap memeriksa ulang
   * angkanya sendiri supaya laporan tidak pernah bergantung pada satu
   * bendera saja.
   *
   * @param {{hanyaAktif?: boolean, kategori?: string, area?: string}} filter
   */
  async fetchUnderReserve(filter = {}) {
    const syarat = ['ReserveQty gt AvailableQty'];
    if (filter.hanyaAktif !== false) syarat.push('IsActive eq true');
    if (filter.kategori) syarat.push(`Category eq '${String(filter.kategori).replace(/'/g, "''")}'`);
    if (filter.area) syarat.push(`AreaId eq '${String(filter.area).replace(/'/g, "''")}'`);

    const hasil = await this.getJson('/odata/DTO_WmsItemStockLiteV2', {
      $filter: syarat.join(' and '),
      $orderby: 'Sku',
    });
    if (!hasil) return [];
    return Array.isArray(hasil) ? hasil : (hasil.value || []);
  }

  /**
   * Master Bundle - isi tiap bundle: BundleSku -> daftar SellerSku komponen.
   * Bundle tidak punya rak sendiri, jadi shopnya hanya bisa diketahui
   * lewat komponennya. Tanpa parameter; sekitar 1.800 baris (~570 KB).
   */
  async fetchBundle() {
    const hasil = await this.getJson('/MasterData/GetBundle');
    if (!hasil) return [];
    return Array.isArray(hasil) ? hasil : (hasil.value || hasil.data || []);
  }

  /**
   * Master Sku Rack - satu-satunya sumber pemetaan SellerSku -> ShopCode.
   * Tidak menerima parameter apa pun; seluruh isinya (sekitar 700 baris,
   * ~220 KB) dikembalikan sekaligus.
   */
  async fetchSkuRack() {
    const hasil = await this.getJson('/MasterData/GetSkuRack');
    if (!hasil) return [];
    return Array.isArray(hasil) ? hasil : (hasil.value || hasil.data || []);
  }
}

function buildQuery(params) {
  const bagian = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    bagian.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return bagian.join('&');
}

function ringkas(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}

module.exports = OcsClient;
module.exports.buildQuery = buildQuery;
