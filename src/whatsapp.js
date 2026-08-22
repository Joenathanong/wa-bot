'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const logger = require('./logger').scope('WA');

/**
 * Lokasi Chrome/Edge yang lazim dipakai, sebagai cadangan bila Chromium
 * bawaan Puppeteer belum terunduh saat `npm install`.
 */
function knownBrowserPaths() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
}

/** @returns {string|null} path browser pertama yang benar-benar ada */
function findLocalBrowser(candidates = knownBrowserPaths()) {
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* abaikan */ }
  }
  return null;
}

/** Ubah error whatsapp-web.js yang kriptik menjadi keterangan yang berguna. */
function describeError(err) {
  const name = (err && err.name) || 'Error';
  const msg = (err && err.message) || String(err);
  const short = String(msg).trim();
  if (short.length <= 3) {
    return `${name}: ${short} (error terminifikasi dari WhatsApp Web - biasanya ` +
      'ketidakcocokan versi whatsapp-web.js dengan build WhatsApp Web terbaru)';
  }
  return `${name}: ${short}`;
}

/**
 * Ciri halaman WhatsApp Web sudah tidak dapat dipakai lagi: WhatsApp Web
 * memuat ulang dirinya (mis. setelah pembaruan atau menganggur lama),
 * sehingga Puppeteer kehilangan pegangan ke frame lama. Semua panggilan ke
 * halaman gagal SETELAH itu - termasuk pengiriman pesan - padahal klien
 * masih tampak "ready". Karena itu keadaan ini harus dideteksi dan dipulihkan.
 */
const CONTEXT_LOST = /detached frame|detached window|execution context was destroyed|target closed|session closed|protocol error|because of a navigation/i;

function isContextLost(err) {
  return CONTEXT_LOST.test(String((err && err.message) || err));
}

/**
 * Profil Chrome masih terkunci oleh proses lama. Terjadi ketika klien
 * sebelumnya tidak benar-benar mati - mis. saat halaman sudah terlepas,
 * `destroy()` tidak sanggup mematikan browsernya.
 */
const BROWSER_LOCKED = /browser is already running|singletonlock|processsingleton|profile appears to be in use/i;

// Timer di sini TIDAK boleh di-unref: kalau tidak, saat penantian ini
// satu-satunya pekerjaan yang tersisa, Node akan keluar begitu saja dan
// pemulihan tidak pernah selesai.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jangan biarkan penutupan browser menggantung selamanya. */
function withTimeout(promise, ms, label = 'operasi') {
  let timer = null;
  const batas = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} melebihi ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), batas])
    .finally(() => { if (timer) clearTimeout(timer); });
}

const BROWSER_MISSING = /could not find chrome|could not find browser|failed to launch|browser was not found|revision .* is not downloaded/i;

/**
 * Pembungkus whatsapp-web.js.
 * - Autentikasi LocalAuth (sesi persisten, QR hanya sekali)
 * - Event lengkap: qr / ready / authenticated / auth_failure / disconnected
 * - REAL WhatsApp mention lewat opsi `mentions`
 * - Tidak pernah melempar error ke luar sampai membuat proses mati
 */
class WhatsAppService extends EventEmitter {
  constructor({ clientId, sessionPath, chromePath = null, webVersion = null,
    browserFinder = findLocalBrowser, healthCheckMs = 60000, unlockDelayMs = 2500,
    readyTimeoutMs = 120000 }) {
    super();
    this.healthCheckMs = healthCheckMs;
    this.unlockDelayMs = unlockDelayMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this._readyTimer = null;
    this.stuckCount = 0;
    this._handlingLogout = false;
    this.loggedOut = false;
    this._healthTimer = null;
    this._recovering = false;
    this._triedUnlock = false;
    this.recoveries = 0;
    this.clientId = clientId;
    this.sessionPath = sessionPath;
    this.chromePath = chromePath;
    this.webVersion = webVersion;
    this.browserFinder = browserFinder;

    this.client = null;
    this.ready = false;
    this.state = 'stopped'; // stopped | starting | qr | authenticated | ready | disconnected | failed
    this.lastQr = null;
    this.readySince = null;
    this.info = null;
    this._restartTimer = null;
    this._restartAttempts = 0;
    this._stopping = false;
    this._triedLocalBrowser = false;
    this.lastStoreReport = null;
  }

  /** Mulai klien WhatsApp (tidak melempar error). */
  async start() {
    if (this.client) return;
    this._stopping = false;
    this.state = 'starting';

    let Client;
    let LocalAuth;
    let qrcode;
    try {
      ({ Client, LocalAuth } = require('whatsapp-web.js'));
      qrcode = require('qrcode-terminal');
    } catch (err) {
      logger.error('Dependency WhatsApp belum terpasang. Jalankan: npm install');
      logger.error(err.message);
      this.state = 'failed';
      return;
    }

    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    };
    if (this.chromePath) {
      puppeteerOptions.executablePath = this.chromePath;
      logger.info('Memakai Chrome dari CHROME_PATH:', this.chromePath);
    }

    const clientOptions = {
      authStrategy: new LocalAuth({ clientId: this.clientId, dataPath: this.sessionPath }),
      puppeteer: puppeteerOptions,
      takeoverOnConflict: true,
      qrMaxRetries: 0,
    };

    // Menyematkan versi WhatsApp Web tertentu. Berguna ketika build terbaru
    // WhatsApp Web memecahkan whatsapp-web.js (mis. getChats melempar "r").
    if (this.webVersion) {
      clientOptions.webVersionCache = {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${this.webVersion}.html`,
      };
      logger.info('Menyematkan versi WhatsApp Web:', this.webVersion);
      logger.warn('Versi yang terlalu lama bisa DITOLAK WhatsApp dan memicu LOGOUT.');
      logger.warn('Bila muncul "disconnected: LOGOUT", hapus WA_WEB_VERSION dari .env.');
    }

    this.client = new Client(clientOptions);

    this.client.on('qr', (qr) => {
      this.lastQr = qr;
      this.state = 'qr';
      this.ready = false;
      logger.info('WhatsApp QR generated - silakan scan dengan aplikasi WhatsApp di HP Anda');
      console.log('');
      try { qrcode.generate(qr, { small: true }); } catch (e) { console.log(qr); }
      console.log('  WhatsApp > Perangkat Tertaut > Tautkan Perangkat > scan QR di atas');
      console.log('');
      this.emit('qr', qr);
    });

    this.client.on('loading_screen', (percent, message) => {
      logger.info('WhatsApp memuat', `${percent}%`, message || '');
      this._armReadyTimer();   // ada kemajuan - beri waktu lagi
    });

    this.client.on('authenticated', () => {
      this.state = 'authenticated';
      this.lastQr = null;
      logger.info('WhatsApp authenticated');
      this._armReadyTimer();
      this.emit('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      this.state = 'failed';
      this.ready = false;
      logger.error('WhatsApp authentication failed:', msg);
      logger.error('Hapus folder .wwebjs_auth lalu jalankan ulang untuk scan QR baru.');
      this.emit('auth_failure', msg);
    });

    this.client.on('ready', async () => {
      this.ready = true;
      this._startHealthCheck();
      this.state = 'ready';
      this.readySince = Date.now();
      this._restartAttempts = 0;
      this._triedUnlock = false;
      this.stuckCount = 0;
      this.loggedOut = false;
      this._handlingLogout = false;
      this._clearReadyTimer();
      try {
        this.info = this.client.info || null;
      } catch (e) { this.info = null; }
      const who = this.info && this.info.wid ? this.info.wid._serialized : '(tidak diketahui)';
      logger.info('WhatsApp ready - tersambung sebagai', who);
      this.emit('ready');
    });

    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.state = 'disconnected';
      this._clearReadyTimer();
      logger.warn('WhatsApp disconnected:', reason);
      this.emit('disconnected', reason);

      // LOGOUT berbeda dari putus koneksi biasa: sesinya benar-benar dicabut
      // (perangkat tertaut dilepas dari HP, atau WhatsApp menolak versi web
      // yang dipakai). Menyambung ulang dengan sesi lama percuma - yang
      // dibutuhkan adalah sesi baru, artinya scan QR lagi.
      if (/logout/i.test(String(reason))) {
        this._handleLogout(reason).catch((err) => logger.error('Penanganan logout gagal:', err.message));
        return;
      }
      this._scheduleRestart();
    });

    try {
      await this.client.initialize();
    } catch (err) {
      this.ready = false;
      this.state = 'failed';

      // Chromium bawaan Puppeteer belum terunduh: coba Chrome/Edge yang
      // sudah terpasang di komputer ini sebelum menyerah.
      if (BROWSER_MISSING.test(String(err.message)) && !this.chromePath && !this._triedLocalBrowser) {
        this._triedLocalBrowser = true;
        const local = this.browserFinder();
        if (local) {
          logger.warn('Chromium bawaan Puppeteer tidak ditemukan. Memakai browser yang sudah terpasang:');
          logger.warn('  ' + local);
          logger.warn('Agar permanen, tambahkan ke .env:  CHROME_PATH=' + local);
          this.chromePath = local;
          try { if (this.client) await this.client.destroy(); } catch (e) { /* abaikan */ }
          this.client = null;
          return this.start();
        }
      }

      // Profil masih terkunci proses Chrome lama: matikan paksa lalu ulangi.
      if (BROWSER_LOCKED.test(String(err.message)) && !this._triedUnlock) {
        this._triedUnlock = true;
        logger.warn('Profil Chrome masih terkunci proses lama - menutup paksa lalu mencoba lagi.');
        await this._forceKillBrowser();
        this._clearProfileLocks();
        return this.start();
      }

      logger.error('Gagal menjalankan klien WhatsApp:', err.message);
      if (BROWSER_LOCKED.test(String(err.message))) {
        logger.error('');
        logger.error('  Masih ada proses Chrome yang memegang folder sesi.');
        logger.error('  Tutup semua jendela Chrome milik bot, atau jalankan di Command Prompt:');
        logger.error('    taskkill /F /IM chrome.exe');
        logger.error('  lalu jalankan ulang aplikasi.');
        logger.error('');
      }
      if (BROWSER_MISSING.test(String(err.message))) {
        logger.error('');
        logger.error('  Browser untuk WhatsApp Web belum tersedia. Dua cara memperbaikinya:');
        logger.error('  1) Unduh Chromium bawaan  :  npx puppeteer browsers install chrome');
        logger.error('  2) Pakai Chrome/Edge yang sudah ada, tambahkan di .env:');
        logger.error('     CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
        logger.error('');
      }
      this._scheduleRestart();
    }
  }

  _scheduleRestart() {
    if (this._stopping || this._restartTimer) return;
    this._restartAttempts += 1;
    const delay = Math.min(5 * 60000, 15000 * this._restartAttempts);
    logger.warn(`Mencoba menyambung ulang WhatsApp dalam ${Math.round(delay / 1000)} detik (percobaan ${this._restartAttempts})`);
    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      try {
        if (this.client) {
          try { await this.client.destroy(); } catch (e) { /* ignore */ }
          this.client = null;
        }
        await this.start();
      } catch (err) {
        logger.error('Gagal menyambung ulang:', err.message);
        this._scheduleRestart();
      }
    }, delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  /**
   * Sesi dicabut. Matikan browser lebih dulu supaya berkas profil dilepas
   * (kalau tidak, pembersihan bawaan whatsapp-web.js gagal dengan
   * "EBUSY: resource busy or locked"), hapus folder sesi, lalu mulai lagi
   * dari nol sehingga QR baru muncul.
   */
  async _handleLogout(reason) {
    if (this._handlingLogout || this._stopping) return;
    this._handlingLogout = true;
    this.loggedOut = true;

    logger.error('');
    logger.error('  SESI WHATSAPP DICABUT (' + reason + ').');
    logger.error('  Penyebab tersering:');
    logger.error('   • perangkat tertaut dilepas dari HP, atau');
    logger.error('   • WA_WEB_VERSION yang disematkan sudah terlalu lama sehingga ditolak WhatsApp.');
    logger.error('  Aplikasi akan menyiapkan sesi baru - SIAPKAN HP untuk scan QR.');
    logger.error('');
    this.emit('logged_out', reason);

    await this._forceKillBrowser();
    await this._removeSessionFolder();

    this._triedUnlock = false;
    this.stuckCount = 0;
    this._restartAttempts = 0;

    try {
      await this.start();
      this._handlingLogout = false;
    } catch (err) {
      this._handlingLogout = false;
      logger.error('Gagal menyiapkan sesi baru:', err.message);
      this._scheduleRestart();
    }
  }

  /** Hapus folder sesi, sabar terhadap berkas yang masih terkunci Windows. */
  async _removeSessionFolder() {
    for (let percobaan = 1; percobaan <= 5; percobaan += 1) {
      try {
        fs.rmSync(this.sessionPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        if (!fs.existsSync(this.sessionPath)) {
          logger.info('Folder sesi lama dihapus:', this.sessionPath);
          return true;
        }
      } catch (err) {
        logger.warn(`Menghapus folder sesi gagal (percobaan ${percobaan}): ${err.code || err.message}`);
      }
      await sleep(1500);
    }
    logger.error('Folder sesi tidak bisa dihapus otomatis. Hentikan aplikasi lalu hapus manual:');
    logger.error('  ' + this.sessionPath);
    return false;
  }

  /**
   * WhatsApp kadang berhenti di tahap "authenticated" dan tidak pernah
   * mencapai "ready": injeksi Store-nya menggantung karena build WhatsApp Web
   * tidak cocok dengan whatsapp-web.js. Tanpa penjaga ini, bot diam total
   * tanpa satu pun pesan error. Setiap kemajuan (loading_screen) mengulur
   * batas waktu, jadi sinkronisasi yang memang lama tidak ikut dipotong.
   */
  _armReadyTimer() {
    if (this.readyTimeoutMs <= 0 || this._stopping) return;
    this._clearReadyTimer();
    this._readyTimer = setTimeout(() => {
      this._readyTimer = null;
      if (this.ready || this._stopping || this._recovering) return;

      this.stuckCount += 1;
      const detik = Math.round(this.readyTimeoutMs / 1000);
      logger.error(`WhatsApp tidak pernah mencapai status "ready" dalam ${detik} detik (macet di "${this.state}").`);
      if (this.stuckCount >= 2) {
        logger.error('');
        logger.error('  Ini biasanya ketidakcocokan build WhatsApp Web dengan whatsapp-web.js.');
        logger.error('  Coba sematkan build lama di .env lalu jalankan ulang:');
        logger.error('    WA_WEB_VERSION=2.3000.1015901307');
        logger.error('  Daftar versi: https://github.com/wppconnect-team/wa-version/tree/main/html');
        logger.error('');
      }
      this.emit('stuck', this.stuckCount);
      this.recover('macet sebelum ready').catch(() => { /* sudah dicatat */ });
    }, this.readyTimeoutMs);
    if (this._readyTimer.unref) this._readyTimer.unref();
  }

  _clearReadyTimer() {
    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
  }

  /**
   * Matikan browser sungguh-sungguh. `client.destroy()` saja tidak cukup
   * ketika halaman sudah terlepas: prosesnya tetap hidup dan mengunci
   * folder profil, sehingga percobaan berikutnya ditolak dengan
   * "The browser is already running for ...".
   */
  async _forceKillBrowser() {
    const client = this.client;
    if (!client) return;
    const browser = client.pupBrowser;

    try { await withTimeout(client.destroy(), 8000, 'destroy()'); }
    catch (e) { logger.debug('destroy() dilewati:', e.message); }

    if (browser) {
      try { await withTimeout(browser.close(), 5000, 'browser.close()'); }
      catch (e) { logger.debug('browser.close() dilewati:', e.message); }
      try {
        const proc = typeof browser.process === 'function' ? browser.process() : null;
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
          logger.warn('Proses Chrome lama dimatikan paksa (pid ' + proc.pid + ').');
        }
      } catch (e) { logger.debug('kill() dilewati:', e.message); }
    }

    this.client = null;
    // Beri waktu sistem operasi melepas kunci folder profil.
    await sleep(this.unlockDelayMs);
  }

  /** Hapus berkas kunci profil Chrome yang tertinggal dari proses yang sudah mati. */
  _clearProfileLocks() {
    const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
    let dibersihkan = 0;
    const sapu = (dir, depth) => {
      if (depth > 2) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { sapu(full, depth + 1); continue; }
        if (names.includes(entry.name)) {
          try { fs.unlinkSync(full); dibersihkan += 1; } catch (e) { /* abaikan */ }
        }
      }
    };
    sapu(this.sessionPath, 0);
    if (dibersihkan > 0) logger.warn(`Membersihkan ${dibersihkan} berkas kunci profil Chrome yang tertinggal.`);
    return dibersihkan;
  }

  /* ------------- pemulihan saat halaman WhatsApp Web hilang ------------- */

  _startHealthCheck() {
    if (this._healthTimer || this.healthCheckMs <= 0) return;
    this._healthTimer = setInterval(() => {
      this.healthCheck().catch(() => { /* sudah dilaporkan di dalam */ });
    }, this.healthCheckMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  _stopHealthCheck() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  /** Pastikan halaman WhatsApp Web masih bisa dipakai. */
  async healthCheck() {
    if (!this.ready || this._recovering || this._stopping) return true;
    const page = this.client && this.client.pupPage;
    if (!page || typeof page.evaluate !== 'function') return true;
    try {
      await page.evaluate(() => 1);
      return true;
    } catch (err) {
      if (isContextLost(err)) {
        logger.warn('Halaman WhatsApp Web sudah tidak dapat dipakai (' + err.message + ')');
        await this.recover('halaman terlepas');
        return false;
      }
      logger.warn('Pemeriksaan halaman WhatsApp gagal:', err.message);
      return false;
    }
  }

  /**
   * Bangun ulang klien WhatsApp. Sesi LocalAuth tetap dipakai sehingga
   * TIDAK perlu scan QR ulang.
   */
  async recover(reason = 'manual') {
    if (this._recovering || this._stopping) return false;
    this._recovering = true;
    this.recoveries += 1;
    this.ready = false;
    this.state = 'recovering';
    this._stopHealthCheck();
    this._clearReadyTimer();
    logger.warn(`Memulihkan koneksi WhatsApp (${reason}) - pemulihan ke-${this.recoveries}. Tidak perlu scan QR ulang.`);
    this.emit('recovering', reason);

    await this._forceKillBrowser();
    this._clearProfileLocks();
    this._triedUnlock = false;
    this._recovering = false;

    try {
      await this.start();
      return true;
    } catch (err) {
      logger.error('Pemulihan WhatsApp gagal:', err.message);
      this._scheduleRestart();
      return false;
    }
  }

  async stop() {
    this._stopping = true;
    this._stopHealthCheck();
    this._clearReadyTimer();
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this.client) {
      try { await this.client.destroy(); } catch (e) { /* ignore */ }
    }
    this.client = null;
    this.ready = false;
    this.state = 'stopped';
  }

  isReady() {
    return this.ready === true && this.client !== null;
  }

  /**
   * Daftar seluruh Group WhatsApp pada akun yang tertaut.
   *
   * Memakai rantai cadangan karena `getChats()` bawaan whatsapp-web.js kerap
   * rusak pada build WhatsApp Web terbaru (melempar error terminifikasi "r"):
   *   1. client.getChats()          - cara resmi
   *   2. baca langsung Store di halaman WhatsApp Web
   * Bila keduanya gagal, error yang dilempar memuat kedua sebabnya sekaligus,
   * dan admin masih bisa memasukkan Group ID / link undangan secara manual.
   */
  async listGroups() {
    if (!this.isReady()) throw new Error('WhatsApp belum siap (belum ready)');
    const problems = [];

    try {
      const chats = await this.client.getChats();
      const groups = (chats || [])
        .filter((c) => c && c.isGroup)
        .map((c) => ({ id: c.id._serialized, name: c.name || '(tanpa nama)' }));
      if (groups.length > 0) return sortByName(groups);
      problems.push('getChats: tidak ada group');
    } catch (err) {
      problems.push('getChats: ' + describeError(err));
      logger.warn('getChats() gagal, mencoba membaca Store langsung -', describeError(err));
    }

    try {
      const detail = await this.listGroupsFromStoreDetailed();
      this.lastStoreReport = detail.tried;
      const groups = (detail.groups || []).map((g) => ({ id: g.id, name: g.name || '(tanpa nama)' }));
      if (groups.length > 0) {
        logger.info(`Berhasil membaca ${groups.length} group dari halaman WhatsApp Web via ${detail.dipakai}`);
        return sortByName(groups);
      }
      const ringkas = (detail.tried || [])
        .map((t) => t.error ? `${t.label}=error` : `${t.label}=${t.group}/${t.total}`)
        .join(', ');
      problems.push(`Store: tidak ada group (${ringkas || 'tidak ada jalur yang bisa dibaca'})`);
    } catch (err) {
      if (isContextLost(err)) {
        problems.push('Halaman WhatsApp Web terlepas (frame detached) - koneksi sedang dipulihkan otomatis');
        logger.warn('Halaman WhatsApp Web terlepas saat membaca daftar group - memulihkan koneksi.');
        this.recover('daftar group: halaman terlepas').catch(() => { /* sudah dicatat */ });
      } else {
        problems.push('Store: ' + describeError(err));
        logger.warn('Pembacaan Store juga gagal -', describeError(err));
      }
    }

    const error = new Error(problems.join(' | '));
    error.recoverable = true;
    throw error;
  }

  /**
   * Baca daftar group langsung dari halaman WhatsApp Web.
   *
   * `getChats()` bawaan whatsapp-web.js rusak pada build WhatsApp Web terbaru,
   * dan letak data internalnya berpindah-pindah antar build. Karena itu
   * beberapa jalur dicoba berurutan; yang pertama membuahkan hasil dipakai.
   * Laporan percobaan ikut dikembalikan agar mudah didiagnosa.
   *
   * @returns {Promise<{groups: Array<{id,name}>, tried: Array}>}
   */
  async listGroupsFromStoreDetailed() {
    const page = this.client && this.client.pupPage;
    if (!page || typeof page.evaluate !== 'function') {
      throw new Error('Halaman WhatsApp Web tidak dapat diakses');
    }

    return page.evaluate(() => {
      const tried = [];
      const isGroupId = (id) => typeof id === 'string' && id.endsWith('@g.us');

      const idOf = (o) => {
        try {
          if (!o) return '';
          if (typeof o === 'string') return o;
          if (o.id === undefined || o.id === null) return '';
          if (typeof o.id === 'string') return o.id;
          if (o.id._serialized) return o.id._serialized;
          if (typeof o.id.toString === 'function') return o.id.toString();
          return '';
        } catch (e) { return ''; }
      };

      const nameOf = (o, id) => {
        try {
          const langsung = o && (o.formattedTitle || o.name || o.subject
            || (o.groupMetadata && o.groupMetadata.subject)
            || (o.contact && (o.contact.name || o.contact.pushname)));
          if (langsung) return String(langsung);
          const store = window.Store || {};
          if (store.Chat && typeof store.Chat.get === 'function') {
            const c = store.Chat.get(id);
            if (c) return String(c.formattedTitle || c.name || c.subject || '');
          }
        } catch (e) { /* abaikan */ }
        return '';
      };

      const kumpulkan = (label, ambil) => {
        try {
          const raw = ambil();
          const arr = Array.isArray(raw) ? raw : (raw && raw.length !== undefined ? Array.from(raw) : []);
          const hasil = [];
          for (const item of arr) {
            const id = idOf(item);
            if (!isGroupId(id)) continue;
            hasil.push({ id, name: nameOf(item, id) });
          }
          tried.push({ label, total: arr.length, group: hasil.length });
          return hasil;
        } catch (err) {
          tried.push({ label, error: String((err && err.message) || err).slice(0, 120) });
          return [];
        }
      };

      const S = window.Store || {};
      const kandidat = [
        ['Store.Chat.getModelsArray', () => S.Chat && S.Chat.getModelsArray && S.Chat.getModelsArray()],
        ['Store.Chat.models', () => S.Chat && (S.Chat.models || S.Chat._models)],
        ['Store.Chat.getModelsArray(all)', () => S.Chat && S.Chat.getModelsArray && S.Chat.getModelsArray(true)],
        ['Store.GroupMetadata.getModelsArray', () => S.GroupMetadata && S.GroupMetadata.getModelsArray && S.GroupMetadata.getModelsArray()],
        ['Store.GroupMetadata.models', () => S.GroupMetadata && (S.GroupMetadata.models || S.GroupMetadata._models)],
        ['Store.ChatCollection', () => S.ChatCollection && (S.ChatCollection.models || (S.ChatCollection.getModelsArray && S.ChatCollection.getModelsArray()))],
        ['WWebJS.getChats', () => window.WWebJS && window.WWebJS.getChats && window.WWebJS.getChats()],
      ];

      for (const [label, ambil] of kandidat) {
        const hasil = kumpulkan(label, ambil);
        if (hasil.length > 0) {
          const unik = [];
          const seen = {};
          for (const g of hasil) {
            if (seen[g.id]) continue;
            seen[g.id] = true;
            unik.push(g);
          }
          return { groups: unik, tried, dipakai: label };
        }
      }
      return { groups: [], tried, dipakai: null };
    });
  }

  /** Bentuk sederhana untuk pemakaian biasa. */
  async listGroupsFromStore() {
    const hasil = await this.listGroupsFromStoreDetailed();
    this.lastStoreReport = hasil.tried;
    return (hasil.groups || []).map((g) => ({ id: g.id, name: g.name || '(tanpa nama)' }));
  }

  /**
   * Laporan apa saja yang tersedia di halaman WhatsApp Web.
   * Dipakai oleh perintah /wadiag untuk mendiagnosa build yang bermasalah.
   */
  async probeStore() {
    const page = this.client && this.client.pupPage;
    if (!page || typeof page.evaluate !== 'function') {
      throw new Error('Halaman WhatsApp Web tidak dapat diakses');
    }
    const info = await page.evaluate(() => {
      const S = window.Store;
      const aman = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
      return {
        versiWA: aman(() => (window.Debug && window.Debug.VERSION) || null),
        adaStore: typeof S !== 'undefined' && S !== null,
        kunciStore: aman(() => (S ? Object.keys(S).slice(0, 60) : []), []),
        chat: aman(() => (S && S.Chat ? {
          ada: true,
          punyaGetModelsArray: typeof S.Chat.getModelsArray === 'function',
          jumlahModels: (S.Chat.models && S.Chat.models.length)
            || (S.Chat._models && S.Chat._models.length) || 0,
          jumlahGetModels: typeof S.Chat.getModelsArray === 'function'
            ? (S.Chat.getModelsArray() || []).length : null,
        } : { ada: false })),
        groupMetadata: aman(() => (S && S.GroupMetadata ? {
          ada: true,
          jumlah: (S.GroupMetadata.getModelsArray && (S.GroupMetadata.getModelsArray() || []).length)
            || (S.GroupMetadata.models && S.GroupMetadata.models.length) || 0,
        } : { ada: false })),
        wwebjs: aman(() => (window.WWebJS ? Object.keys(window.WWebJS).slice(0, 30) : null)),
      };
    });
    return info;
  }

  /**
   * Ambil Group ID dari link undangan WhatsApp.
   * @param {string} codeOrLink 'https://chat.whatsapp.com/XXXX' atau kodenya saja
   */
  async resolveInvite(codeOrLink) {
    if (!this.isReady()) throw new Error('WhatsApp belum siap (belum ready)');
    const code = String(codeOrLink).trim().replace(/^https?:\/\/(chat\.whatsapp\.com|wa\.me)\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!code) throw new Error('Link undangan tidak dikenali');
    const info = await this.client.getInviteInfo(code);
    if (!info) throw new Error('Group tidak ditemukan untuk link tersebut');
    const id = (info.id && (info.id._serialized || info.id)) || info.gid || '';
    if (!String(id).endsWith('@g.us')) throw new Error('Link tidak menunjuk ke sebuah Group');
    return { id: String(id), name: info.subject || info.name || '(tanpa nama)' };
  }

  async getChatName(chatId) {
    if (!this.isReady()) return null;
    try {
      const chat = await this.client.getChatById(chatId);
      return chat ? (chat.name || chatId) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Kirim pesan teks. Bila `mentions` diisi (array JID), pesan dikirim
   * sebagai REAL WhatsApp mention.
   * @param {string} chatId  contoh: 120363012345678901@g.us
   * @param {string} text
   * @param {string[]} mentions daftar JID, contoh: ['6281234567890@c.us']
   */
  async sendText(chatId, text, mentions = []) {
    if (!this.isReady()) throw new Error('WhatsApp belum siap - pesan tidak dikirim');
    if (!chatId) throw new Error('Target WhatsApp Group belum dipilih (buka /groups)');

    const options = {};
    if (Array.isArray(mentions) && mentions.length > 0) options.mentions = mentions;

    try {
      const msg = await this.client.sendMessage(chatId, text, options);
      logger.info(`Pesan terkirim ke ${chatId}` + (options.mentions ? ` dengan ${options.mentions.length} mention` : ''));
      return msg;
    } catch (err) {
      // Beberapa versi whatsapp-web.js lama meminta objek Contact,
      // bukan string JID, pada opsi mentions.
      if (options.mentions) {
        logger.warn('Pengiriman dengan JID string gagal, mencoba memakai objek Contact:', err.message);
        const contacts = [];
        for (const jid of options.mentions) {
          try { contacts.push(await this.client.getContactById(jid)); } catch (e) {
            logger.warn('Kontak tidak ditemukan di WhatsApp:', jid);
          }
        }
        if (contacts.length > 0) {
          const msg = await this.client.sendMessage(chatId, text, { mentions: contacts });
          logger.info(`Pesan terkirim ke ${chatId} dengan ${contacts.length} mention (mode Contact)`);
          return msg;
        }
      }
      if (isContextLost(err)) {
        logger.error('Pengiriman gagal karena halaman WhatsApp Web terlepas - memulihkan koneksi.');
        this.recover('gagal kirim: halaman terlepas').catch(() => { /* sudah dicatat */ });
        throw new Error('Halaman WhatsApp Web terlepas; koneksi sedang dipulihkan. Pesan akan disusulkan.');
      }
      throw err;
    }
  }

  status() {
    return {
      state: this.state,
      ready: this.ready,
      recoveries: this.recoveries,
      stuckCount: this.stuckCount,
      loggedOut: this.loggedOut,
      hasQr: !!this.lastQr,
      readySince: this.readySince,
      account: this.info && this.info.wid ? this.info.wid.user : null,
      pushname: this.info ? this.info.pushname : null,
    };
  }
}

function sortByName(groups) {
  return groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = WhatsAppService;
module.exports.describeError = describeError;
module.exports.isContextLost = isContextLost;
module.exports.isBrowserLocked = (err) => BROWSER_LOCKED.test(String((err && err.message) || err));
module.exports.findLocalBrowser = findLocalBrowser;
module.exports.knownBrowserPaths = knownBrowserPaths;
