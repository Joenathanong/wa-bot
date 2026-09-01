'use strict';

/**
 * Uji otomatis tanpa koneksi nyata.
 *
 * Modul whatsapp-web.js dan node-telegram-bot-api digantikan STUB
 * (lihat node_modules pada mesin pengembangan) sehingga seluruh alur
 * dapat dijalankan tanpa WhatsApp Web maupun Telegram sungguhan.
 *
 *   npm test
 */

process.env.NODE_ENV = 'test';
// Kunci SEMUA variabel yang dipakai config, supaya file .env milik pengguna
// tidak pernah mempengaruhi hasil uji. 'both' menguji dua jalur sumber pesan
// sekaligus (bot dan akun).
process.env.TELEGRAM_SOURCE = 'both';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// Log uji TIDAK boleh menumpang data/app.log milik aplikasi sungguhan:
// stub memancarkan kejadian palsu (LOGOUT WhatsApp, sesi kedaluwarsa, group
// yang salah tulis) yang akan terbaca seolah-olah bot benar-benar bermasalah.
process.env.LOG_FILE = require('path').join(require('os').tmpdir(), 'telegram-wa-bridge-test.log');
process.env.TELEGRAM_BOT_TOKEN = '123456789:AAEEsTubTokenUntukPengujianSaja123';
process.env.ADMIN_TELEGRAM_IDS = '111,222';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '-100999';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'telegram-wa-bridge-test.db');
process.env.MESSAGE_DELAY_MS = '3000';
process.env.TELEGRAM_USER_SESSION_FILE = require('path').join(require('os').tmpdir(), 'telegram-wa-bridge-test.session');
global.__QUIET_QR__ = true;

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

/* ----------------------------------------------------------------- *
 * Ganti library luar dengan stub lokal (folder test/stubs) supaya
 * pengujian tidak pernah menyentuh WhatsApp Web / Telegram sungguhan.
 * ----------------------------------------------------------------- */
const Module = require('module');
const STUBS = {
  'whatsapp-web.js': path.join(__dirname, 'stubs', 'wwebjs.stub.js'),
  'node-telegram-bot-api': path.join(__dirname, 'stubs', 'telegram.stub.js'),
  'qrcode-terminal': path.join(__dirname, 'stubs', 'qrcode.stub.js'),
  'telegram': path.join(__dirname, 'stubs', 'gramjs.stub.js'),
  'telegram/sessions': path.join(__dirname, 'stubs', 'gramjs.stub.js'),
  'telegram/events': path.join(__dirname, 'stubs', 'gramjs.stub.js'),
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return STUBS[request];
  return originalResolve.call(this, request, ...rest);
};

const DB_FILE = process.env.DB_PATH;
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
}

const config = require('../src/config');
const Database = require('../src/database');
const MessageQueue = require('../src/queue');
const WhatsAppService = require('../src/whatsapp');
const Pipeline = require('../src/pipeline');
const AdminMenu = require('../src/admin');
const TelegramService = require('../src/telegram');
const TelegramUserSource = require('../src/telegram-user');
const filter = require('../src/filter');
const render = require('../src/render');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

function section(title) { console.log(`\n${title}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tunggu sampai antrean benar-benar kosong (mencegah kebocoran antar uji). */
async function drainQueue(queue, timeoutMs = 20000) {
  const t0 = Date.now();
  while ((queue.size() > 0 || queue.running) && Date.now() - t0 < timeoutMs) await sleep(10);
}

/* ================================================================== */
async function run() {
  console.log('\n=== UJI OTOMATIS TELEGRAM -> WHATSAPP BRIDGE ===');

  section('0. Isolasi konfigurasi');
  await test('uji memakai konfigurasi terkunci, bukan .env pengguna', () => {
    assert.strictEqual(config.source, 'both', 'TELEGRAM_SOURCE bocor dari .env');
    assert.strictEqual(config.usesBotSource, true);
    assert.strictEqual(config.usesUserSource, true);
    assert.deepStrictEqual(config.telegram.adminIds, ['111', '222']);
    assert.deepStrictEqual(config.telegram.allowedChatIds, ['-100999']);
    assert.ok(config.db.path.includes(os.tmpdir()), 'uji tidak boleh menyentuh data/bot.db produksi');
  });

  /* ---------------------------- FILTER ---------------------------- */
  section('1. Filter keyword');
  const TELEGRAM_SAMPLE =
    '⚠️ PERINGATAN STOK SHOPEE Ditemukan 110 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat). 🕒 2026-08-21 21:14:43 WIB';

  await test('pesan contoh Shopee diteruskan', () => assert.strictEqual(filter.shouldForward(TELEGRAM_SAMPLE), true));
  await test('pesan Tokopedia diteruskan', () => assert.strictEqual(filter.shouldForward('PERINGATAN TOKOPEDIA\nDitemukan SKU dengan stok tersedia di bawah stok ter-reserve.'), true));
  await test('case-insensitive', () => assert.strictEqual(filter.shouldForward('DENGAN STOK TERSEDIA DI BAWAH STOK TER-RESERVE'), true));
  await test('markdown ** tidak mengganggu', () => assert.strictEqual(filter.shouldForward('**110** SKU dengan stok tersedia di bawah stok ter-reserve'), true));
  await test('emoji tidak mengganggu', () => assert.strictEqual(filter.shouldForward('🔥🚨 dengan stok tersedia di bawah stok ter-reserve 🚨'), true));
  await test('keyword terpotong newline tetap terdeteksi', () => assert.strictEqual(filter.shouldForward('... dengan stok tersedia di bawah\nstok ter-reserve ...'), true));
  await test('"Stock opname selesai." diabaikan', () => assert.strictEqual(filter.shouldForward('Stock opname selesai.'), false));
  await test('"Stok Shopee normal." diabaikan', () => assert.strictEqual(filter.shouldForward('Stok Shopee normal.'), false));
  await test('"Stok tersedia di atas stok ter-reserve." diabaikan', () => assert.strictEqual(filter.shouldForward('Stok tersedia di atas stok ter-reserve.'), false));
  await test('"Stock hampir habis." diabaikan', () => assert.strictEqual(filter.shouldForward('Stock hampir habis.'), false));
  await test('input kosong/null aman', () => {
    assert.strictEqual(filter.shouldForward(''), false);
    assert.strictEqual(filter.shouldForward(null), false);
    assert.strictEqual(filter.shouldForward(undefined), false);
    assert.strictEqual(filter.shouldForward(12345), false);
  });
  await test('hanya SATU keyword yang dipakai', () => {
    assert.strictEqual(filter.KEYWORD, 'dengan stok tersedia di bawah stok ter-reserve');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'filter.js'), 'utf8');
    assert.strictEqual((src.match(/KEYWORD = /g) || []).length, 1);
  });

  /* --------------------------- VALIDASI --------------------------- */
  section('2. Validasi nomor WhatsApp');
  await test('6281234567890 diterima', () => assert.strictEqual(render.validateWhatsappNumber('6281234567890').ok, true));
  await test('+6281234567890 ditolak', () => assert.strictEqual(render.validateWhatsappNumber('+6281234567890').ok, false));
  await test('081234567890 ditolak', () => assert.strictEqual(render.validateWhatsappNumber('081234567890').ok, false));
  await test('huruf ditolak', () => assert.strictEqual(render.validateWhatsappNumber('62812abc').ok, false));
  await test('terlalu pendek ditolak', () => assert.strictEqual(render.validateWhatsappNumber('628').ok, false));
  await test('spasi/dash dibersihkan', () => assert.strictEqual(render.validateWhatsappNumber('628 123-456 7890').value, '6281234567890'));

  /* ---------------------------- RENDER ---------------------------- */
  section('3. Template & mention');
  const twoUsers = [
    { name: 'Ibu Jonathan', whatsapp_number: '6281234567890' },
    { name: 'Ibu Rika', whatsapp_number: '6289876543210' },
  ];
  await test('{users} diganti nomor + JID benar', () => {
    const r = render.renderTemplate('Dear {users}\nTerima kasih.', twoUsers);
    assert.strictEqual(r.text, 'Dear @6281234567890 & @6289876543210\nTerima kasih.');
    assert.deepStrictEqual(r.mentions, ['6281234567890@c.us', '6289876543210@c.us']);
  });
  await test('teks memuat @nomor untuk setiap JID (syarat REAL mention)', () => {
    const r = render.renderTemplate('Dear {users}', twoUsers);
    for (const jid of r.mentions) assert.ok(r.text.includes('@' + jid.split('@')[0]), 'nomor ' + jid + ' tidak ada di teks');
  });
  await test('tiga user digabung "A, B & C"', () => {
    const r = render.renderTemplate('{users}', twoUsers.concat([{ name: 'Pak Budi', whatsapp_number: '6281111111111' }]));
    assert.strictEqual(r.text, '@6281234567890, @6289876543210 & @6281111111111');
  });
  await test('mode "name" menampilkan nama + nomor', () => {
    const r = render.renderTemplate('Dear {users}', twoUsers, { mentionDisplay: 'name' });
    assert.strictEqual(r.text, 'Dear Ibu Jonathan @6281234567890 & Ibu Rika @6289876543210');
  });
  await test('preview Telegram memakai nama', () => {
    assert.strictEqual(render.renderPreviewForTelegram('Dear {users}', twoUsers), 'Dear @Ibu Jonathan & @Ibu Rika');
  });
  await test('tanpa user aktif tidak error', () => {
    const r = render.renderTemplate('Dear {users}', []);
    assert.strictEqual(r.hasUsers, false);
    assert.ok(r.text.includes('belum ada user aktif'));
  });

  /* ----------------------------- QUEUE ---------------------------- */
  section('4. Antrean & rate limit');
  await test('pekerjaan berjalan serial (tidak paralel)', async () => {
    const q = new MessageQueue({ delayMs: 0 });
    let concurrent = 0; let maxConcurrent = 0;
    const job = async () => { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); await sleep(15); concurrent -= 1; };
    await Promise.all([q.enqueue(job, 'a'), q.enqueue(job, 'b'), q.enqueue(job, 'c')]);
    assert.strictEqual(maxConcurrent, 1);
  });
  await test('jeda antar pesan dipatuhi', async () => {
    const q = new MessageQueue({ delayMs: 120 });
    const t0 = Date.now();
    await Promise.all([q.enqueue(async () => {}, '1'), q.enqueue(async () => {}, '2'), q.enqueue(async () => {}, '3')]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 230, `hanya ${elapsed} ms, seharusnya >= 240 ms`);
  });
  await test('gagal -> dicoba ulang lalu berhasil', async () => {
    const q = new MessageQueue({ delayMs: 0, maxRetries: 2 });
    let n = 0;
    const r = await q.enqueue(async () => { n += 1; if (n < 3) throw new Error('boom'); return 'ok'; }, 'retry');
    assert.strictEqual(r, 'ok');
    assert.strictEqual(n, 3);
  });
  await test('gagal permanen menolak promise', async () => {
    const q = new MessageQueue({ delayMs: 0, maxRetries: 1 });
    await assert.rejects(() => q.enqueue(async () => { throw new Error('selalu gagal'); }, 'x'));
  });

  /* --------------------------- DATABASE --------------------------- */
  section('5. Database');
  const db = new Database(config.db.path);
  await test('tabel & template default dibuat', () => {
    const t = db.getActiveTemplate();
    assert.ok(t && t.name === 'Stock Lock Alert');
    assert.ok(t.content.includes('{users}'));
    assert.ok(t.content.includes('Bot WH'));
  });
  await test('database yang ada tidak dihapus saat dibuka ulang', () => {
    const db2 = new Database(config.db.path);
    assert.strictEqual(db2.listTemplates().length, 1);
    db2.close();
  });
  await test('CRUD user', () => {
    const u = db.createUser('Ibu Jonathan', '6281234567890');
    assert.strictEqual(u.active, 1);
    const upd = db.updateUser(u.id, { name: 'Ibu Jonathan S.' });
    assert.strictEqual(upd.name, 'Ibu Jonathan S.');
    db.updateUser(u.id, { name: 'Ibu Jonathan' });
    assert.ok(db.getUserByNumber('6281234567890'));
  });
  await test('nomor duplikat ditolak database', () => {
    assert.throws(() => db.createUser('Kembar', '6281234567890'));
  });
  await test('user inactive tidak masuk listActiveUsers', () => {
    const b = db.createUser('Pak Budi', '6281111111111');
    db.updateUser(b.id, { active: 0 });
    assert.ok(!db.listActiveUsers().some((u) => u.id === b.id));
    assert.ok(db.listUsers().some((u) => u.id === b.id));
  });
  await test('processed_messages anti-duplikat', () => {
    assert.strictEqual(db.isProcessed('-100999', '1'), false);
    assert.strictEqual(db.markProcessed('-100999', '1'), true);
    assert.strictEqual(db.isProcessed('-100999', '1'), true);
    assert.strictEqual(db.markProcessed('-100999', '1'), false);
  });
  await test('settings get/set', () => {
    db.setSetting('mention_display', 'name');
    assert.strictEqual(db.getSetting('mention_display'), 'name');
    db.setSetting('mention_display', 'number');
  });
  await test('reset template mengembalikan isi default', () => {
    const t = db.getActiveTemplate();
    db.updateTemplate(t.id, { content: 'diubah' });
    assert.strictEqual(db.getActiveTemplate().content, 'diubah');
    db.resetTemplateToDefault(t.id);
    assert.ok(db.getActiveTemplate().content.includes('Mohon segera lepas Lock Stock'));
  });
  db.close();

  /* ------------------------- INTEGRASI PENUH ---------------------- */
  section('6. Integrasi penuh (Telegram + Admin Menu + WhatsApp)');

  global.__WA_STUB__ = {
    sent: [],
    groups: [
      { id: '120363011111111111@g.us', name: 'IEG BOD' },
      { id: '120363022222222222@g.us', name: 'IEG Warehouse' },
    ],
    autoReady: true, requireQr: false, failStringMentions: false, failSend: false,
    initErrorOnce: null, launches: [], failGetChats: false, failStore: false, storeEmpty: false, detached: false, lockedOnce: false, killed: 0, closed: 0, stuckAfterAuth: false, logoutOnStart: false,
    invites: { AbCdEf123456: { id: '120363033333333333@g.us', name: 'IEG Ops' } },
  };

  const idb = new Database(config.db.path);
  const queue = new MessageQueue({ delayMs: 5 });
  const wa = new WhatsAppService({
    clientId: 'test',
    sessionPath: path.join(os.tmpdir(), 'wa-test-session'),
    healthCheckMs: 0,
    unlockDelayMs: 10,
  });
  const startedAt = Date.now();

  const tg = new TelegramService({
    config, db: idb, whatsapp: wa, queue,
    pipelineFactory: ({ notifyAdmins }) => new Pipeline({
      db: idb, whatsapp: wa, queue, config, notifyAdmins,
      followUpWindowMs: 150, followUpMaxWaitMs: 3000,
    }),
    adminFactory: ({ bot, pipeline }) => new AdminMenu({ bot, db: idb, whatsapp: wa, queue, config, pipeline, startedAt }),
  });
  await tg.start();
  await wa.start();
  const bot = global.__TG_STUB__.bot;

  const ADMIN = 111;
  const OUTSIDER = 999;
  const ADMIN_CHAT = 5001;
  const SOURCE_CHAT = '-100999';

  const send = async (text, from = ADMIN, chatId = ADMIN_CHAT, messageId = Math.floor(Math.random() * 1e9)) => {
    bot.emit('message', { message_id: messageId, chat: { id: chatId, type: 'private' }, from: { id: from }, text });
    await sleep(30);
  };
  const click = async (data, from = ADMIN, chatId = ADMIN_CHAT) => {
    bot.emit('callback_query', { id: `cb${Date.now()}${Math.random()}`, from: { id: from }, data, message: { chat: { id: chatId }, message_id: 42 } });
    await sleep(40);
  };
  const waSent = () => global.__WA_STUB__.sent;

  /**
   * Tunggu sampai benar-benar tenang: follow-up yang terjadwal sudah dikirim
   * DAN antrean WhatsApp kosong. Lebih andal daripada sleep dengan angka tetap.
   */
  const settle = async (timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const pipe = tg.pipeline;
      const quiet = !pipe._pending && !pipe._followUpTimer && queue.size() === 0 && !queue.running;
      if (quiet) { await sleep(20); if (queue.size() === 0 && !queue.running && !pipe._pending) return; }
      await sleep(10);
    }
  };

  await test('WhatsApp stub mencapai status ready', () => assert.strictEqual(wa.isReady(), true));
  await test('Telegram terhubung', () => assert.strictEqual(tg.connected, true));

  bot.clear();
  await test('/start untuk non-admin tidak menampilkan menu admin', async () => {
    await send('/start', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('bukan administrator'));
    assert.ok(!bot.allText().includes('/admin   -'));
  });

  bot.clear();
  await test('/id menampilkan Chat ID & User ID', async () => {
    await send('/id', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('Chat ID : 6001'));
    assert.ok(bot.allText().includes('User ID : 999'));
  });

  bot.clear();
  await test('/admin oleh non-admin -> Access Denied', async () => {
    await send('/admin', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('Access Denied'));
    assert.ok(!bot.allText().includes('ADMIN MENU'));
  });

  bot.clear();
  await test('/admin oleh admin -> menu utama lengkap', async () => {
    await send('/admin');
    const t = bot.allText();
    for (const label of ['Kelola User', 'Template Pesan', 'WhatsApp Group', 'Status Bot', 'Test', 'Pengaturan']) {
      assert.ok(JSON.stringify(bot.last().opts).includes(label), 'tombol hilang: ' + label);
    }
    assert.ok(t.includes('ADMIN MENU'));
  });

  bot.clear();
  await test('callback admin oleh non-admin ditolak di sisi server', async () => {
    await click('m:users', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('Access Denied'));
    assert.ok(!bot.allText().includes('KELOLA USER'));
  });

  bot.clear();
  await test('tambah user: nama -> nomor -> tersimpan', async () => {
    await click('u:add');
    assert.ok(bot.allText().includes('Masukkan nama user'));
    bot.clear();
    await send('Ibu Rika');
    assert.ok(bot.allText().includes('tanpa +'));
    bot.clear();
    await send('081234567890');
    assert.ok(bot.allText().includes('Jangan memakai 0 di depan'), 'nomor 08xx harus ditolak');
    bot.clear();
    await send('+6289876543210');
    assert.ok(bot.allText().includes('Jangan memakai tanda +'), 'nomor +62 harus ditolak');
    bot.clear();
    await send('6289876543210');
    assert.ok(bot.allText().includes('User berhasil ditambahkan'));
    assert.ok(idb.getUserByNumber('6289876543210'));
  });

  bot.clear();
  await test('/batal membatalkan input bertahap', async () => {
    await click('u:add');
    bot.clear();
    await send('/batal');
    assert.ok(bot.allText().includes('Dibatalkan'));
    bot.clear();
    await send('teks biasa yang tidak boleh jadi nama user');
    assert.ok(!bot.allText().includes('Masukkan nomor'));
  });

  const jonathan = idb.getUserByNumber('6281234567890');
  const budi = idb.getUserByNumber('6281111111111');

  bot.clear();
  await test('edit nama user', async () => {
    await click(`u:n:${jonathan.id}`);
    bot.clear();
    await send('Ibu Jonathan');
    assert.strictEqual(idb.getUser(jonathan.id).name, 'Ibu Jonathan');
  });

  bot.clear();
  await test('edit nomor user menolak duplikat', async () => {
    await click(`u:p:${jonathan.id}`);
    bot.clear();
    await send('6289876543210');
    assert.ok(bot.allText().includes('sudah dipakai'));
    await send('/batal');
  });

  bot.clear();
  await test('toggle ACTIVE/INACTIVE', async () => {
    const before = idb.getUser(budi.id).active;
    await click(`u:t:${budi.id}`);
    assert.notStrictEqual(idb.getUser(budi.id).active, before);
    await click(`u:t:${budi.id}`);
    assert.strictEqual(idb.getUser(budi.id).active, before);
  });

  bot.clear();
  await test('hapus user memerlukan konfirmasi', async () => {
    const tmp = idb.createUser('User Sementara', '6285555555555');
    await click(`u:d:${tmp.id}`);
    assert.ok(bot.allText().includes('Hapus user?'));
    assert.ok(idb.getUser(tmp.id), 'user tidak boleh langsung terhapus');
    await click(`u:D:${tmp.id}`);
    assert.strictEqual(idb.getUser(tmp.id), null);
  });

  bot.clear();
  await test('/groups menampilkan daftar target (awalnya kosong)', async () => {
    await send('/groups');
    const t = bot.allText();
    assert.ok(t.includes('WHATSAPP GROUP'));
    assert.ok(t.includes('Belum ada group tujuan'));
    assert.ok(JSON.stringify(bot.last().opts).includes('Cari Otomatis'));
  });

  bot.clear();
  await test('Cari Otomatis menampilkan group dari akun WhatsApp', async () => {
    await click('g:scan');
    const t = bot.allText();
    assert.ok(t.includes('IEG BOD'));
    assert.ok(t.includes('IEG Warehouse'));
    assert.ok(!t.includes('Personal'), 'chat non-group tidak boleh muncul');
  });

  bot.clear();
  await test('menambah group dari hasil pencarian', async () => {
    await click('g:a:0');
    const g = idb.getWaGroupByGid('120363011111111111@g.us');
    assert.ok(g, 'group harus tersimpan');
    assert.strictEqual(g.name, 'IEG BOD');
    assert.strictEqual(g.active, 1);
    assert.strictEqual(idb.listActiveWaGroups().length, 1);
  });

  bot.clear();
  await test('menambah group kedua -> dua target aktif', async () => {
    await click('g:scan');
    await click('g:a:1');
    assert.strictEqual(idb.listActiveWaGroups().length, 2);
    const t = bot.allText();
    assert.ok(t.includes('2 aktif'), t.slice(0, 200));
  });

  await test('pesan diteruskan ke KEDUA group (2 forward + 2 mention)', async () => {
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8801);
    await settle();
    const sent = waSent();
    const forwards = sent.filter((m) => m.text.startsWith('[FORWARDED'));
    const mentions = sent.filter((m) => m.mentions.length > 0);
    assert.strictEqual(forwards.length, 2, 'satu forward per group');
    assert.strictEqual(mentions.length, 2, 'satu mention per group');
    const tujuan = [...new Set(sent.map((m) => m.chatId))].sort();
    assert.deepStrictEqual(tujuan, ['120363011111111111@g.us', '120363022222222222@g.us']);
  });

  await test('peringatan terpecah tetap 1 mention PER group', async () => {
    global.__WA_STUB__.sent = [];
    await send('(bagian 1/2) dengan stok tersedia di bawah stok ter-reserve', ADMIN, SOURCE_CHAT, 8811);
    await send('(bagian 2/2) dengan stok tersedia di bawah stok ter-reserve', ADMIN, SOURCE_CHAT, 8812);
    await settle();
    const sent = waSent();
    assert.strictEqual(sent.filter((m) => m.text.startsWith('[FORWARDED')).length, 4, '2 bagian x 2 group');
    assert.strictEqual(sent.filter((m) => m.mentions.length > 0).length, 2, '1 mention x 2 group');
  });

  bot.clear();
  await test('menonaktifkan satu group -> hanya group aktif yang menerima', async () => {
    const kedua = idb.getWaGroupByGid('120363022222222222@g.us');
    await click(`g:t:${kedua.id}`);
    assert.strictEqual(idb.getWaGroup(kedua.id).active, 0);
    assert.strictEqual(idb.listActiveWaGroups().length, 1);

    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8821);
    await settle();
    const tujuan = [...new Set(waSent().map((m) => m.chatId))];
    assert.deepStrictEqual(tujuan, ['120363011111111111@g.us']);
  });

  bot.clear();
  await test('menghapus group perlu konfirmasi', async () => {
    const kedua = idb.getWaGroupByGid('120363022222222222@g.us');
    await click(`g:d:${kedua.id}`);
    assert.ok(bot.allText().includes('Hapus group tujuan?'));
    assert.ok(idb.getWaGroup(kedua.id), 'belum boleh terhapus');
    await click(`g:D:${kedua.id}`);
    assert.strictEqual(idb.getWaGroup(kedua.id), null);
    assert.strictEqual(idb.listWaGroups().length, 1);
  });

  await test('tanpa group aktif -> pesan tidak diteruskan & dicatat gagal', async () => {
    const satu = idb.getWaGroupByGid('120363011111111111@g.us');
    idb.updateWaGroup(satu.id, { active: 0 });
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8831);
    await settle();
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '8831'), false, 'boleh dicoba lagi nanti');
    idb.updateWaGroup(satu.id, { active: 1 });
  });

  await test('migrasi: target group lama dari settings ikut terbawa', () => {
    const tmpFile = path.join(os.tmpdir(), 'migrasi-group-test.db');
    for (const f of [tmpFile, tmpFile + '-wal', tmpFile + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
    let lama = new Database(tmpFile);
    lama.setSetting('wa_group_id', '120363099999999999@g.us');
    lama.setSetting('wa_group_name', 'Group Lama');
    lama.close();
    lama = new Database(tmpFile);          // buka ulang -> migrasi jalan
    const groups = lama.listActiveWaGroups();
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_id, '120363099999999999@g.us');
    assert.strictEqual(groups[0].name, 'Group Lama');
    lama.close();
    for (const f of [tmpFile, tmpFile + '-wal', tmpFile + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  });

  /* ---- alur otomatis ---- */
  global.__WA_STUB__.sent = [];
  await test('pesan dengan keyword -> 2 pesan WhatsApp (forward + follow-up)', async () => {
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7001);
    await settle();
    const sent = waSent();
    assert.strictEqual(sent.length, 2, `harus 2 pesan, dapat ${sent.length}`);
    assert.ok(sent[0].text.startsWith('[FORWARDED FROM TELEGRAM]'));
    assert.ok(sent[0].text.includes('110 SKU'), 'isi asli Telegram harus utuh');
    assert.strictEqual(sent[0].chatId, '120363011111111111@g.us');
    assert.strictEqual(sent[0].mentions.length, 0);
  });

  await test('pesan follow-up memakai REAL mention (mentions + @nomor di teks)', () => {
    const followUp = waSent()[1];
    assert.ok(followUp.text.startsWith('Dear @'));
    assert.deepStrictEqual(followUp.mentions.sort(), ['6281234567890@c.us', '6289876543210@c.us'].sort());
    for (const jid of followUp.mentions) assert.ok(followUp.text.includes('@' + jid.split('@')[0]));
    assert.ok(followUp.text.includes('Mohon segera lepas Lock Stock'));
    assert.ok(followUp.text.includes('Bot WH'));
  });

  await test('user INACTIVE tidak di-mention', () => {
    const followUp = waSent()[1];
    assert.ok(!followUp.text.includes('6281111111111'), 'Pak Budi (inactive) tidak boleh di-mention');
    assert.ok(!followUp.mentions.includes('6281111111111@c.us'));
  });

  await test('pesan duplikat (message_id sama) tidak dikirim ulang', async () => {
    const before = waSent().length;
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7001);
    await settle();
    assert.strictEqual(waSent().length, before);
  });

  await test('pesan tanpa keyword diabaikan', async () => {
    const before = waSent().length;
    await send('Stock opname selesai.', ADMIN, SOURCE_CHAT, 7002);
    await send('Stok Shopee normal.', ADMIN, SOURCE_CHAT, 7003);
    await settle();
    assert.strictEqual(waSent().length, before);
  });

  await test('chat di luar TELEGRAM_ALLOWED_CHAT_IDS diabaikan', async () => {
    const before = waSent().length;
    await send(TELEGRAM_SAMPLE, ADMIN, '-100888', 7004);
    await settle();
    assert.strictEqual(waSent().length, before);
  });

  await test('jeda antar pesan WhatsApp dipatuhi pada alur nyata', async () => {
    queue.setDelay(150);
    global.__WA_STUB__.sent = [];
    const t0 = Date.now();
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7010);
    await settle();
    const elapsed = Date.now() - t0;
    assert.strictEqual(waSent().length, 2);
    assert.ok(elapsed >= 150, `jeda tidak diterapkan (${elapsed} ms)`);
    queue.setDelay(5);
  });

  await test('WhatsApp belum siap -> tidak ditandai terproses, bisa diulang', async () => {
    global.__WA_STUB__.sent = [];
    wa.ready = false;
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7020);
    await settle();
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '7020'), false);
    wa.ready = true;
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7020);
    await settle();
    assert.strictEqual(waSent().length, 2);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '7020'), true);
  });

  await test('mention mode Contact (fallback versi lama) tetap berhasil', async () => {
    global.__WA_STUB__.sent = [];
    global.__WA_STUB__.failStringMentions = true;
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7030);
    await settle();
    const sent = waSent();
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].mentions.length, 2);
    assert.ok(sent[1].mentions[0].__isContact === true, 'harus jatuh ke mode Contact');
    global.__WA_STUB__.failStringMentions = false;
  });

  /* ---- template ---- */
  bot.clear();
  await test('preview template menampilkan siapa yang di-mention', async () => {
    const tpl = idb.getActiveTemplate();
    await click(`t:p:${tpl.id}`);
    const t = bot.allText();
    assert.ok(t.includes('PREVIEW'));
    assert.ok(t.includes('@Ibu Jonathan'));
    assert.ok(t.includes('@Ibu Rika'));
    assert.ok(t.includes('6281234567890'));
  });

  bot.clear();
  await test('edit template: kirim teks -> konfirmasi -> tersimpan', async () => {
    const tpl = idb.getActiveTemplate();
    await click(`t:e:${tpl.id}`);
    bot.clear();
    await send('Dear {users}\n\nTemplate versi baru untuk pengujian.\n\nTerima kasih.');
    assert.ok(bot.allText().includes('Placeholder {users} ditemukan'));
    await click('tc:save');
    assert.ok(idb.getActiveTemplate().content.includes('Template versi baru'));
  });

  bot.clear();
  await test('edit template dapat dibatalkan', async () => {
    const tpl = idb.getActiveTemplate();
    const before = tpl.content;
    await click(`t:e:${tpl.id}`);
    await send('Dear {users}\nIni tidak boleh tersimpan.');
    await click('tc:cancel');
    assert.strictEqual(idb.getActiveTemplate().content, before);
  });

  bot.clear();
  await test('reset template mengembalikan default', async () => {
    const tpl = idb.getActiveTemplate();
    await click(`t:r:${tpl.id}`);
    assert.ok(idb.getActiveTemplate().content.includes('Mohon segera lepas Lock Stock'));
  });

  bot.clear();
  await test('template tanpa {users} diberi peringatan', async () => {
    const tpl = idb.getActiveTemplate();
    await click(`t:e:${tpl.id}`);
    bot.clear();
    await send('Tidak ada placeholder di sini.');
    assert.ok(bot.allText().includes('tidak akan ada mention'));
    await click('tc:cancel');
  });

  bot.clear();
  await test('Test Template mengirim ke WhatsApp dengan mention', async () => {
    global.__WA_STUB__.sent = [];
    const tpl = idb.getActiveTemplate();
    await click(`t:x:${tpl.id}`);
    await settle();
    assert.strictEqual(waSent().length, 1);
    assert.strictEqual(waSent()[0].mentions.length, 2);
    assert.ok(bot.allText().includes('Hasil pengiriman test'));
  });

  bot.clear();
  await test('menu Test > Test Mention berfungsi', async () => {
    global.__WA_STUB__.sent = [];
    await click('x:mention');
    await settle();
    assert.strictEqual(waSent().length, 1);
  });

  bot.clear();
  await test('menu Test > Simulasi menjalankan alur penuh', async () => {
    global.__WA_STUB__.sent = [];
    await click('x:sim');
    await settle();
    assert.strictEqual(waSent().length, 2);
    assert.ok(waSent()[0].text.includes('[FORWARDED FROM TELEGRAM]'));
  });

  /* ---- status & pengaturan ---- */
  bot.clear();
  await test('/status menampilkan ringkasan', async () => {
    await send('/status');
    const t = bot.allText();
    assert.ok(t.includes('STATUS BOT'));
    assert.ok(t.includes('Telegram:'));
    assert.ok(t.includes('WhatsApp:'));
    assert.ok(t.includes('IEG BOD'));
    assert.ok(t.includes('Active Users: 2'));
    assert.ok(t.includes('Uptime'));
  });

  bot.clear();
  await test('/status oleh non-admin ditolak', async () => {
    await send('/status', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('Access Denied'));
  });

  bot.clear();
  await test('Pengaturan tidak pernah menampilkan token', async () => {
    await click('s:tg');
    const t = bot.allText();
    assert.ok(!t.includes(process.env.TELEGRAM_BOT_TOKEN), 'TOKEN BOCOR!');
    assert.ok(t.includes('••'), 'token harus disamarkan');
    assert.ok(t.includes('dengan stok tersedia di bawah stok ter-reserve'));
  });

  bot.clear();
  await test('WhatsApp Settings menyamarkan nomor akun', async () => {
    await click('s:wa');
    const t = bot.allText();
    assert.ok(t.includes('*'), 'nomor akun harus disamarkan');
  });

  bot.clear();
  await test('ubah Message Delay lewat menu', async () => {
    await click('s:delay');
    bot.clear();
    await send('1000');
    assert.ok(bot.allText().includes('3000 - 600000'), 'nilai < 3000 harus ditolak');
    bot.clear();
    await send('4500');
    assert.strictEqual(queue.delayMs, 4500);
    assert.strictEqual(idb.getSetting('message_delay_ms'), '4500');
    queue.setDelay(5);
  });

  bot.clear();
  await test('toggle format mention', async () => {
    await click('s:mention');
    assert.strictEqual(idb.getSetting('mention_display'), 'name');
    await click('s:mention');
    assert.strictEqual(idb.getSetting('mention_display'), 'number');
  });

  bot.clear();
  await test('toggle forwarding ON/OFF menghentikan penerusan', async () => {
    await click('s:fwd');
    assert.strictEqual(idb.getSetting('forwarding_enabled'), '0');
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7100);
    await settle();
    assert.strictEqual(waSent().length, 0);
    await click('s:fwd');
    assert.strictEqual(idb.getSetting('forwarding_enabled'), '1');
  });

  bot.clear();
  await test('Reload Configuration tidak error', async () => {
    await click('s:reload');
    assert.ok(bot.allText().includes('PENGATURAN'));
    // Reload memuat ulang jeda dari database (4500 ms, disetel uji sebelumnya)
    assert.strictEqual(queue.delayMs, 4500);
    queue.setDelay(5);
  });

  await test('tidak ada jalur WhatsApp -> Telegram (loop prevention)', () => {
    const waSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'whatsapp.js'), 'utf8');
    assert.ok(!/on\(['"]message/.test(waSrc), 'whatsapp.js tidak boleh mendengarkan pesan masuk');
    // Hanya berkas .js. Folder src/daemon berisi berkas Windows Service
    // (WinSW) dan akan melempar EISDIR bila ikut dibaca.
    const dir = path.join(__dirname, '..', 'src');
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => e.name);
    assert.ok(files.length >= 10, 'daftar modul tidak boleh kosong: ' + files.length);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/message_create|message_revoke|client\.on\(['"]message/.test(src), `${f} membaca pesan WhatsApp`);
    }
  });

  await test('kegagalan kirim WhatsApp tidak membuat proses mati', async () => {
    queue.setDelay(5);
    global.__WA_STUB__.failSend = true;
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 7200);
    await drainQueue(queue);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '7200'), false);
    assert.strictEqual(waSent().length, 0);
    global.__WA_STUB__.failSend = false;
  });

  await test('event disconnected tidak mematikan aplikasi & menjadwalkan sambung ulang', async () => {
    wa.client.emit('disconnected', 'TEST');
    await sleep(20);
    assert.strictEqual(wa.isReady(), false);
    assert.strictEqual(wa.state, 'disconnected');
    assert.ok(wa._restartTimer, 'sambung ulang harus dijadwalkan');
    // Batalkan timer supaya tidak mengganggu uji berikutnya
    clearTimeout(wa._restartTimer);
    wa._restartTimer = null;
    wa._restartAttempts = 0;
    wa.ready = true;
    wa.state = 'ready';
  });

  section('6c. Peringatan terpecah -> satu pesan mention');

  const BAGIAN_1 = '(bagian 1/2)  PERINGATAN STOK SHOPEE Ditemukan 108 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).  2026-08-22 06:16:07 WIB';
  const BAGIAN_2 = '(bagian 2/2)  PERINGATAN STOK SHOPEE Ditemukan 108 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).  2026-08-22 06:16:07 WIB';

  await test('dua bagian -> 2 forward, TAPI hanya 1 pesan mention', async () => {
    global.__WA_STUB__.sent = [];
    await send(BAGIAN_1, ADMIN, SOURCE_CHAT, 8101);
    await send(BAGIAN_2, ADMIN, SOURCE_CHAT, 8102);
    await settle();
    const sent = waSent();
    const forwards = sent.filter((m) => m.text.startsWith('[FORWARDED FROM TELEGRAM]'));
    const mentions = sent.filter((m) => m.mentions && m.mentions.length > 0);
    assert.strictEqual(forwards.length, 2, 'kedua bagian harus tetap diteruskan');
    assert.strictEqual(mentions.length, 1, `pesan mention harus SATU, dapat ${mentions.length}`);
    assert.ok(mentions[0].text.startsWith('Dear @'));
  });

  await test('mention dikirim setelah semua bagian (urutan benar)', () => {
    const sent = waSent();
    const idxMention = sent.findIndex((m) => m.mentions && m.mentions.length > 0);
    assert.strictEqual(idxMention, sent.length - 1, 'mention harus jadi pesan terakhir');
  });

  await test('empat bagian pun tetap satu pesan mention', async () => {
    global.__WA_STUB__.sent = [];
    for (let i = 0; i < 4; i += 1) {
      await send(`(bagian ${i + 1}/4) dengan stok tersedia di bawah stok ter-reserve`, ADMIN, SOURCE_CHAT, 8200 + i);
    }
    await settle();
    const mentions = waSent().filter((m) => m.mentions && m.mentions.length > 0);
    assert.strictEqual(waSent().filter((m) => m.text.startsWith('[FORWARDED')).length, 4);
    assert.strictEqual(mentions.length, 1);
  });

  await test('peringatan berikutnya di luar jendela dapat mention sendiri', async () => {
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8301);
    await settle();
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8302);
    await settle();
    const mentions = waSent().filter((m) => m.mentions && m.mentions.length > 0);
    assert.strictEqual(mentions.length, 2, 'dua rentetan terpisah = dua mention');
  });

  await test('placeholder {count} berisi jumlah peringatan yang digabung', async () => {
    const tpl = idb.getActiveTemplate();
    const asli = tpl.content;
    idb.updateTemplate(tpl.id, { content: 'Dear {users}\nAda {count} peringatan.' });
    global.__WA_STUB__.sent = [];
    await send(BAGIAN_1, ADMIN, SOURCE_CHAT, 8401);
    await send(BAGIAN_2, ADMIN, SOURCE_CHAT, 8402);
    await settle();
    const mention = waSent().find((m) => m.mentions && m.mentions.length > 0);
    assert.ok(mention.text.includes('Ada 2 peringatan.'), mention.text);
    idb.updateTemplate(tpl.id, { content: asli });
  });

  await test('flushFollowUp mengirim yang tertunda saat aplikasi berhenti', async () => {
    tg.pipeline.followUpWindowMs = 60000;   // sengaja lama
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8501);
    await sleep(150);
    await drainQueue(queue);
    assert.strictEqual(waSent().filter((m) => m.mentions.length > 0).length, 0, 'belum saatnya dikirim');
    await tg.pipeline.flushFollowUp();
    await drainQueue(queue);
    assert.strictEqual(waSent().filter((m) => m.mentions.length > 0).length, 1);
    tg.pipeline.followUpWindowMs = 25;
  });

  bot.clear();
  await test('jendela follow-up dapat diubah lewat Pengaturan', async () => {
    await click('s:fwin');
    assert.ok(bot.allText().includes('JENDELA FOLLOW-UP'));
    bot.clear();
    await send('999');
    assert.ok(bot.allText().includes('0 - 120'), 'nilai di luar rentang harus ditolak');
    bot.clear();
    await send('30');
    assert.strictEqual(tg.pipeline.followUpWindowMs, 30000);
    assert.strictEqual(idb.getSetting('followup_window_ms'), '30000');
    tg.pipeline.followUpWindowMs = 25;
  });

  await test('jendela 0 = perilaku lama (mention tiap peringatan)', async () => {
    tg.pipeline.followUpWindowMs = 0;
    global.__WA_STUB__.sent = [];
    await send(BAGIAN_1, ADMIN, SOURCE_CHAT, 8601);
    await settle();
    await send(BAGIAN_2, ADMIN, SOURCE_CHAT, 8602);
    await settle();
    const mentions = waSent().filter((m) => m.mentions && m.mentions.length > 0);
    assert.strictEqual(mentions.length, 2);
    tg.pipeline.followUpWindowMs = 25;
  });

  section('6g. Skrip Windows Service');

  const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-service.js'), 'utf8');
  const unSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'uninstall-service.js'), 'utf8');

  await test('memeriksa hak Administrator sebelum memasang', () => {
    assert.ok(svcSrc.includes('punyaHakAdmin'), 'harus ada pemeriksaan hak admin');
    assert.ok(/execFileSync\('net', \['session'\]/.test(svcSrc), 'memakai "net session" untuk mendeteksi elevasi');
    assert.ok(svcSrc.includes('Run as administrator'), 'harus memberi tahu cara membuka prompt admin');
  });

  await test('memverifikasi ke Windows, bukan percaya event library', () => {
    assert.ok(svcSrc.includes('statusService'), 'harus menanyakan status ke Windows');
    assert.ok(/execFileSync\('sc', \['query'/.test(svcSrc), 'memakai sc query untuk memastikan');
    assert.ok(svcSrc.includes('Windows tidak mengenal service'), 'harus melaporkan gagal bila tidak terdaftar');
  });

  await test('mencoba id dengan DAN tanpa .exe, serta menunggu pendaftaran', () => {
    assert.ok(svcSrc.includes("dasar + '.exe'"), 'svc.id tidak memuat .exe - kedua bentuk harus dicoba');
    assert.ok(svcSrc.includes('tungguService'), 'harus menunggu, bukan menanyakan seketika');
    assert.ok(/timeoutMs = \d{5}/.test(svcSrc), 'beri tenggang yang wajar (puluhan detik)');
  });

  await test('menyebut ID service, bukan nama tampilan, untuk net/sc', () => {
    assert.ok(svcSrc.includes("net stop ' + id"), 'perintah net harus memakai ID');
    assert.ok(!svcSrc.includes('net stop "' + "' + SERVICE_NAME"), 'jangan memakai nama tampilan');
  });

  await test('punya jalur cadangan bila node-windows gagal mendaftarkan', () => {
    assert.ok(svcSrc.includes('pasangLangsung'), 'harus ada pendaftaran langsung lewat WinSW');
    assert.ok(svcSrc.includes("['install']"), 'memanggil WinSW install sendiri');
    assert.ok(svcSrc.includes('TANPA SPASI'), 'menyebut jalur berspasi sebagai penyebab');
  });

  await test('tidak menyalakan allowServiceLogon untuk LocalSystem', () => {
    assert.ok(/allowServiceLogon: !!AKUN_KHUSUS/i.test(svcSrc),
      'allowServiceLogon hanya untuk akun khusus - bila tidak, WinSW gagal 1332');
    assert.ok(svcSrc.includes('LookupAccountName'), 'harus menjelaskan penyebabnya');
  });

  await test('membersihkan blok <serviceaccount> yang tidak sah', () => {
    assert.ok(svcSrc.includes('bersihkanXml'), 'harus merapikan XML sebelum mendaftarkan');
    assert.ok(svcSrc.includes('serviceaccount'), 'menyebut blok yang dihapus');
  });

  await test('menyalakan service bila terdaftar tapi belum RUNNING', () => {
    assert.ok(svcSrc.includes('function nyalakan'), 'harus bisa memanggil sc start');
    assert.ok(/execFileSync\('sc', \['start'/.test(svcSrc));
  });

  await test('"alreadyinstalled" diverifikasi ke Windows, bukan dipercaya', () => {
    assert.ok(svcSrc.includes("svc.on('alreadyinstalled'"), 'harus menangani alreadyinstalled');
    assert.ok(svcSrc.includes('mengira service sudah ada karena folder'),
      'harus menjelaskan bahwa penilaian itu berdasarkan berkas, bukan daftar service');
    assert.ok(svcSrc.includes('selesaikan(kandidat'), 'harus lanjut memverifikasi & mendaftarkan');
  });

  await test('ada jaring pengaman bila library diam saja', () => {
    assert.ok(/setTimeout\(/.test(svcSrc), 'harus ada batas waktu');
    assert.ok(svcSrc.includes('Tidak ada kabar dari node-windows'));
  });

  await test('uninstall membersihkan folder daemon yang menyesatkan', () => {
    assert.ok(unSrc.includes('bersihkanDaemon'), 'folder daemon harus ikut dibersihkan');
    assert.ok(unSrc.includes('sudah terpasang'), 'harus menjelaskan alasannya');
  });

  await test('uninstall juga menuntut hak Administrator', () => {
    assert.ok(/execFileSync\('net', \['session'\]/.test(unSrc));
    assert.ok(unSrc.includes('PERLU HAK ADMINISTRATOR'));
  });

  section('6h. Pemeriksaan kesiapan (npm run setup)');

  const setupSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-check.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  await test('seluruh dependency yang dipakai tercatat di package.json', () => {
    const semua = Object.assign({}, pkg.dependencies, pkg.optionalDependencies);
    const wajib = ['whatsapp-web.js', 'node-telegram-bot-api', 'telegram', 'better-sqlite3',
      'dotenv', 'qrcode-terminal', 'qrcode', 'node-windows'];
    for (const d of wajib) {
      assert.ok(semua[d], `${d} harus tercatat agar npm ci memasangnya`);
    }
  });

  await test('better-sqlite3 opsional agar npm ci tidak gagal total', () => {
    assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['better-sqlite3'],
      'binary-nya belum tersedia untuk Node terbaru; kegagalan build tidak boleh membatalkan seluruh pemasangan');
    assert.ok(!(pkg.dependencies || {})['better-sqlite3'],
      'jangan tercatat di dua tempat');
  });

  await test('aplikasi punya driver SQLite pengganti', () => {
    const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8');
    assert.ok(dbSrc.includes("require('node:sqlite')"), 'harus ada fallback ke modul bawaan Node');
    assert.ok(dbSrc.includes("require('better-sqlite3')"), 'utamanya tetap better-sqlite3');
  });

  await test('node-windows dipatok versi persis (bukan rentang)', () => {
    assert.ok(/^\d/.test(pkg.dependencies['node-windows']),
      'versi prarilis sebaiknya dipatok persis agar tidak berubah diam-diam');
  });

  await test('npm run setup terdaftar', () => {
    assert.strictEqual(pkg.scripts.setup, 'node scripts/setup-check.js');
  });

  await test('setup melaporkan driver SQLite yang benar-benar dipakai', () => {
    assert.ok(setupSrc.includes('Driver SQLite yang dipakai'),
      'pengguna harus tahu driver mana yang aktif, terutama di Node 24');
    assert.ok(setupSrc.includes('optionalDependencies'), 'paket opsional tidak boleh dianggap gagal');
  });

  await test('pemeriksaan mencakup semua yang bisa gagal di PC baru', () => {
    for (const bagian of ['cekNode', 'cekDependency', 'cekEnv', 'cekChrome', 'cekData', 'cekService']) {
      assert.ok(setupSrc.includes('function ' + bagian), 'harus memeriksa ' + bagian);
    }
  });

  await test('memberi perintah konkret, bukan sekadar menyatakan kurang', () => {
    assert.ok(setupSrc.includes('winget install -e --id Google.Chrome'), 'Chrome dipasang lewat winget');
    assert.ok(setupSrc.includes('nodejs.org'), 'Node diarahkan ke unduhan versi 22, bukan "LTS" yang kini berarti 24');
    assert.ok(setupSrc.includes('npm ci'), 'menyarankan npm ci agar versi sama persis');
  });

  await test('memperingatkan WA_WEB_VERSION yang tersemat', () => {
    assert.ok(setupSrc.includes('WA_WEB_VERSION'), 'ini pernah memicu LOGOUT - harus diingatkan');
  });

  section('6f. Log ke berkas (wajib untuk mode Windows Service)');

  await test('log ditulis ke berkas, bukan hanya ke konsol', () => {
    const berkas = path.join(os.tmpdir(), 'twb-logtest', 'uji.log');
    try { fs.rmSync(path.dirname(berkas), { recursive: true, force: true }); } catch (e) { /* ignore */ }

    const simpanFile = process.env.LOG_FILE;
    const simpanLevel = process.env.LOG_LEVEL;
    process.env.LOG_FILE = berkas;
    process.env.LOG_LEVEL = 'info';
    delete require.cache[require.resolve('../src/logger')];
    const log = require('../src/logger').scope('UJI');

    log.info('halo dunia', { a: 1 });
    log.error('ada masalah', new Error('contoh'));

    const isi = fs.readFileSync(berkas, 'utf8');
    assert.ok(isi.includes('halo dunia'), isi);
    assert.ok(isi.includes('{"a":1}'), 'objek harus terbaca, bukan [object Object]');
    assert.ok(isi.includes('contoh'), 'pesan error harus ikut tercatat');
    assert.ok(isi.includes('[UJI]'), 'scope harus ikut');

    process.env.LOG_FILE = simpanFile === undefined ? '' : simpanFile;
    if (simpanLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = simpanLevel;
    delete require.cache[require.resolve('../src/logger')];
    fs.rmSync(path.dirname(berkas), { recursive: true, force: true });
  });

  await test('LOG_FILE=off mematikan penulisan berkas', () => {
    const simpan = process.env.LOG_FILE;
    process.env.LOG_FILE = 'off';
    delete require.cache[require.resolve('../src/logger')];
    const log = require('../src/logger');
    assert.strictEqual(log.logFilePath(), null);
    log.info('tidak boleh menulis apa pun');   // tidak boleh melempar error
    process.env.LOG_FILE = simpan === undefined ? '' : simpan;
    delete require.cache[require.resolve('../src/logger')];
  });

  await test('folder log yang tidak bisa dibuat tidak mematikan aplikasi', () => {
    const simpan = process.env.LOG_FILE;
    process.env.LOG_FILE = '/proc/tidak/boleh/ditulis/app.log';
    delete require.cache[require.resolve('../src/logger')];
    const log = require('../src/logger');
    log.warn('aplikasi harus tetap jalan');    // tidak boleh melempar error
    process.env.LOG_FILE = simpan === undefined ? '' : simpan;
    delete require.cache[require.resolve('../src/logger')];
  });

  section('6e. QR lewat Telegram (untuk mode Windows Service)');

  const qrHelper = require('../src/qr');

  await test('QR dikirim ke SEMUA admin saat WhatsApp memintanya', async () => {
    bot.clear();
    const ok = await tg.sendQrToAdmins('DUMMYQRPAYLOAD1234567890');
    assert.strictEqual(ok, true);
    assert.strictEqual(bot.outbox.length, config.telegram.adminIds.length,
      'setiap admin harus menerima satu pesan');
    const tujuan = bot.outbox.map((m) => String(m.chat_id)).sort();
    assert.deepStrictEqual(tujuan, [...config.telegram.adminIds].sort());
  });

  await test('pesan QR memuat petunjuk menautkan perangkat', async () => {
    bot.clear();
    await tg.sendQrToAdmins('DUMMYQRPAYLOAD1234567890');
    const t = bot.allText();
    assert.ok(t.includes('Perangkat Tertaut'), t.slice(0, 200));
    assert.ok(/gambar QR tidak dapat dibuat|SCAN QR/i.test(t));
  });

  await test('tanpa library qrcode tetap memberi instruksi, bukan diam', async () => {
    // Di lingkungan uji library `qrcode` memang tidak terpasang.
    if (qrHelper.canRenderQr()) {
      assert.ok(true, 'qrcode tersedia - jalur gambar yang dipakai');
      return;
    }
    bot.clear();
    await tg.sendQrToAdmins('DUMMYQRPAYLOAD');
    const t = bot.allText();
    assert.ok(t.includes('npm install qrcode'), 'harus memberi tahu cara memasangnya');
    assert.ok(t.includes('npm start'), 'harus menyebut jalan keluar alternatif');
  });

  await test('renderQrPng aman saat library tidak ada', async () => {
    const hasil = await qrHelper.renderQrPng('apa saja');
    assert.ok(hasil === null || Buffer.isBuffer(hasil), 'null atau Buffer, tidak melempar error');
  });

  section('6a. Daftar group tahan-banting (bug getChats whatsapp-web.js)');

  await test('describeError menjelaskan error terminifikasi "r"', () => {
    const e = new Error('r'); e.name = 'r';
    const d = WhatsAppService.describeError(e);
    assert.ok(d.includes('terminifikasi'), d);
    assert.strictEqual(WhatsAppService.describeError(new Error('pesan panjang biasa')), 'Error: pesan panjang biasa');
  });

  await test('getChats gagal -> jatuh ke pembacaan Store', async () => {
    global.__WA_STUB__.failGetChats = true;
    const groups = await wa.listGroups();
    assert.strictEqual(groups.length, 2);
    assert.ok(groups.some((g) => g.id === '120363011111111111@g.us'));
  });

  await test('Store kosong -> error menyebut jalur apa saja yang dicoba', async () => {
    global.__WA_STUB__.failGetChats = true;
    global.__WA_STUB__.storeEmpty = true;
    await assert.rejects(() => wa.listGroups(), (err) => {
      assert.ok(err.message.includes('Store.Chat.getModelsArray'), err.message);
      assert.ok(err.message.includes('Store.GroupMetadata'), err.message);
      return true;
    });
    global.__WA_STUB__.storeEmpty = false;
  });

  bot.clear();
  await test('/wadiag melaporkan isi halaman WhatsApp Web', async () => {
    await send('/wadiag');
    const t = bot.allText();
    assert.ok(t.includes('DIAGNOSA WHATSAPP WEB'));
    assert.ok(t.includes('2.3000.1043270046'), 'versi WhatsApp Web harus dilaporkan');
    assert.ok(t.includes('Store.Chat'));
    assert.ok(t.includes('Percobaan pembacaan daftar group'));
  });

  bot.clear();
  await test('/wadiag ditolak untuk non-admin', async () => {
    await send('/wadiag', OUTSIDER, 6001);
    assert.ok(bot.allText().includes('Access Denied'));
    assert.ok(!bot.allText().includes('DIAGNOSA'));
  });

  await test('keduanya gagal -> error memuat kedua sebab', async () => {
    global.__WA_STUB__.failStore = true;
    await assert.rejects(() => wa.listGroups(), (err) => {
      assert.ok(err.message.includes('getChats:'), err.message);
      assert.ok(err.message.includes('Store:'), err.message);
      assert.strictEqual(err.recoverable, true);
      return true;
    });
  });

  bot.clear();
  await test('Cari Otomatis tetap menawarkan isi manual saat gagal', async () => {
    await click('g:scan');
    const t = bot.allText();
    assert.ok(t.includes('tidak bisa diambil otomatis'), t.slice(0, 200));
    assert.ok(JSON.stringify(bot.last().opts).includes('Tambah Manual'));
  });

  bot.clear();
  await test('isi manual dengan link undangan menyimpan Group ID asli', async () => {
    await click('g:man');
    assert.ok(bot.allText().includes('Undang lewat tautan'));
    bot.clear();
    await send('https://chat.whatsapp.com/AbCdEf123456');
    const g = idb.getWaGroupByGid('120363033333333333@g.us');
    assert.ok(g, 'group dari link undangan harus tersimpan');
    assert.strictEqual(g.name, 'IEG Ops');
    assert.strictEqual(g.active, 1);
    assert.ok(bot.allText().includes('tersimpan dan langsung aktif'));
  });

  bot.clear();
  await test('isi manual dengan Group ID langsung juga diterima', async () => {
    await click('g:man');
    bot.clear();
    await send('120363022222222222@g.us');
    assert.ok(idb.getWaGroupByGid('120363022222222222@g.us'));
  });

  bot.clear();
  await test('masukan ngawur ditolak dengan penjelasan', async () => {
    const sebelum = idb.listWaGroups().length;
    await click('g:man');
    bot.clear();
    await send('grup saya yang itu lho');
    assert.ok(bot.allText().includes('Tidak dikenali'));
    assert.strictEqual(idb.listWaGroups().length, sebelum, 'tidak boleh menambah group');
    await send('/batal');
  });

  bot.clear();
  await test('link undangan tidak sah ditangani tanpa crash', async () => {
    await click('g:man');
    bot.clear();
    await send('https://chat.whatsapp.com/KodeYangTidakAda9');
    assert.ok(bot.allText().includes('Gagal membaca link undangan'));
    await send('/batal');
  });

  await test('setelah pulih, getChats normal dipakai lagi', async () => {
    global.__WA_STUB__.failGetChats = false;
    global.__WA_STUB__.failStore = false;
    const groups = await wa.listGroups();
    assert.strictEqual(groups.length, 2);
  });

  bot.clear();
  await test('sisakan satu group aktif untuk uji berikutnya', () => {
    for (const g of idb.listWaGroups()) {
      if (g.group_id === '120363011111111111@g.us') idb.updateWaGroup(g.id, { active: 1 });
      else idb.deleteWaGroup(g.id);
    }
    assert.strictEqual(idb.listActiveWaGroups().length, 1);
    assert.strictEqual(idb.listActiveWaGroups()[0].group_id, '120363011111111111@g.us');
  });

  section('6d. Halaman WhatsApp Web terlepas (detached frame)');

  await test('isContextLost mengenali error frame terlepas', () => {
    assert.ok(WhatsAppService.isContextLost(new Error("Attempted to use detached Frame 'CA81'.")));
    assert.ok(WhatsAppService.isContextLost(new Error('Execution context was destroyed, most likely because of a navigation')));
    assert.ok(WhatsAppService.isContextLost(new Error('Protocol error (Runtime.callFunctionOn): Target closed')));
    assert.ok(!WhatsAppService.isContextLost(new Error('r')), 'error lain jangan ikut terdeteksi');
  });

  await test('pemeriksaan berkala mendeteksi halaman terlepas lalu memulihkan', async () => {
    const sebelum = wa.recoveries;
    global.__WA_STUB__.detached = true;
    const sehat = await wa.healthCheck();
    global.__WA_STUB__.detached = false;
    await sleep(30);
    assert.strictEqual(sehat, false);
    assert.strictEqual(wa.recoveries, sebelum + 1);
    assert.strictEqual(wa.isReady(), true, 'harus pulih sendiri tanpa scan QR');
  });

  await test('halaman sehat tidak memicu pemulihan', async () => {
    const sebelum = wa.recoveries;
    assert.strictEqual(await wa.healthCheck(), true);
    assert.strictEqual(wa.recoveries, sebelum);
  });

  await test('kirim saat halaman terlepas -> error jelas + pemulihan', async () => {
    const sebelum = wa.recoveries;
    global.__WA_STUB__.detached = true;
    await assert.rejects(
      () => wa.sendText('120363011111111111@g.us', 'halo', []),
      (err) => {
        assert.ok(err.message.includes('terlepas'), err.message);
        assert.ok(err.message.includes('disusulkan'), err.message);
        return true;
      }
    );
    global.__WA_STUB__.detached = false;
    await sleep(40);
    assert.strictEqual(wa.recoveries, sebelum + 1);
    assert.strictEqual(wa.isReady(), true);
  });

  await test('peringatan saat halaman terlepas tidak ditandai terproses', async () => {
    global.__WA_STUB__.detached = true;
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8901);
    await sleep(200);
    global.__WA_STUB__.detached = false;
    await sleep(60);
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '8901'), false, 'harus bisa disusulkan nanti');
    await drainQueue(queue);
  });

  bot.clear();
  await test('/wadiag menjelaskan halaman terlepas dengan bahasa manusia', async () => {
    global.__WA_STUB__.detached = true;
    await send('/wadiag');
    global.__WA_STUB__.detached = false;
    const t = bot.allText();
    assert.ok(t.includes('TERLEPAS'), t.slice(0, 300));
    assert.ok(t.includes('TIDAK perlu scan QR'));
    await sleep(60);
  });

  await test('pemulihan mematikan paksa Chrome lama', async () => {
    const sebelumKill = global.__WA_STUB__.killed;
    global.__WA_STUB__.detached = true;
    await wa.healthCheck();
    global.__WA_STUB__.detached = false;
    await sleep(40);
    assert.ok(global.__WA_STUB__.killed > sebelumKill, 'proses Chrome lama harus dimatikan paksa');
    assert.strictEqual(wa.isReady(), true);
  });

  await test('profil terkunci -> dibuka paksa lalu berhasil, bukan menyerah', async () => {
    const sebelum = wa.recoveries;
    global.__WA_STUB__.lockedOnce = true;   // percobaan pertama ditolak
    global.__WA_STUB__.detached = true;
    await wa.healthCheck();
    global.__WA_STUB__.detached = false;
    await sleep(80);
    assert.strictEqual(wa.recoveries, sebelum + 1);
    assert.strictEqual(wa.isReady(), true, 'harus pulih walau profil sempat terkunci');
    assert.strictEqual(global.__WA_STUB__.lockedOnce, false, 'kunci sudah dilewati');
  });

  await test('isBrowserLocked mengenali pesan profil terkunci', () => {
    assert.ok(WhatsAppService.isBrowserLocked(new Error('The browser is already running for C:\\x. Use a different userDataDir')));
    assert.ok(WhatsAppService.isBrowserLocked(new Error('SingletonLock exists')));
    assert.ok(!WhatsAppService.isBrowserLocked(new Error('r')));
  });

  await test('berkas kunci profil yang tertinggal ikut dibersihkan', () => {
    const dir = path.join(os.tmpdir(), 'wa-lock-test', 'session-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'x');
    fs.writeFileSync(path.join(dir, 'lockfile'), 'x');
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
    const wa9 = new WhatsAppService({
      clientId: 'lock', sessionPath: path.join(os.tmpdir(), 'wa-lock-test'),
      healthCheckMs: 0, unlockDelayMs: 5,
    });
    assert.strictEqual(wa9._clearProfileLocks(), 2);
    assert.ok(fs.existsSync(path.join(dir, 'Preferences')), 'berkas lain jangan ikut terhapus');
    fs.rmSync(path.join(os.tmpdir(), 'wa-lock-test'), { recursive: true, force: true });
  });

  await test('macet di "authenticated" terdeteksi lalu dibangun ulang', async () => {
    const waStuck = new WhatsAppService({
      clientId: 'stuck-test',
      sessionPath: path.join(os.tmpdir(), 'wa-stuck'),
      healthCheckMs: 0, unlockDelayMs: 5, readyTimeoutMs: 60,
    });
    const kejadian = [];
    waStuck.on('stuck', (n) => kejadian.push(n));

    global.__WA_STUB__.stuckAfterAuth = true;
    await waStuck.start();
    assert.strictEqual(waStuck.isReady(), false, 'belum ready - memang macet');

    global.__WA_STUB__.stuckAfterAuth = false;   // percobaan berikutnya berhasil
    await sleep(250);
    assert.deepStrictEqual(kejadian, [1], 'harus memancarkan event stuck sekali');
    assert.strictEqual(waStuck.isReady(), true, 'harus pulih sendiri');
    assert.strictEqual(waStuck.stuckCount, 0, 'penghitung direset setelah ready');
    await waStuck.stop();
  });

  await test('kemajuan loading_screen mengulur batas waktu, bukan memotong', async () => {
    const waSlow = new WhatsAppService({
      clientId: 'slow-test',
      sessionPath: path.join(os.tmpdir(), 'wa-slow'),
      healthCheckMs: 0, unlockDelayMs: 5, readyTimeoutMs: 120,
    });
    global.__WA_STUB__.stuckAfterAuth = true;
    await waSlow.start();
    // Sinkronisasi yang lama tetapi tetap ada kemajuan
    for (let i = 0; i < 4; i += 1) {
      await sleep(60);
      waSlow.client.emit('loading_screen', 20 * (i + 1), 'Memuat pesan');
    }
    assert.strictEqual(waSlow.stuckCount, 0, 'jangan menyerah selama ada kemajuan');
    global.__WA_STUB__.stuckAfterAuth = false;
    await waSlow.stop();
  });

  await test('LOGOUT menghapus sesi lalu menyiapkan login baru', async () => {
    const sesiDir = path.join(os.tmpdir(), 'wa-logout-test');
    fs.mkdirSync(path.join(sesiDir, 'session-x'), { recursive: true });
    fs.writeFileSync(path.join(sesiDir, 'session-x', 'Preferences'), '{}');

    const waOut = new WhatsAppService({
      clientId: 'logout-test', sessionPath: sesiDir,
      healthCheckMs: 0, unlockDelayMs: 5, readyTimeoutMs: 0,
    });
    const kejadian = [];
    waOut.on('logged_out', (r) => kejadian.push(r));

    global.__WA_STUB__.logoutOnStart = true;
    await waOut.start();
    await sleep(400);

    assert.deepStrictEqual(kejadian, ['LOGOUT'], 'harus memancarkan logged_out');
    assert.strictEqual(fs.existsSync(sesiDir), false, 'folder sesi lama harus dihapus');
    assert.strictEqual(waOut.isReady(), true, 'sesi baru langsung disiapkan');
    await waOut.stop();
    fs.rmSync(sesiDir, { recursive: true, force: true });
  });

  await test('LOGOUT tidak diperlakukan sebagai putus koneksi biasa', async () => {
    const sesiDir = path.join(os.tmpdir(), 'wa-logout-test2');
    const waOut = new WhatsAppService({
      clientId: 'logout-test2', sessionPath: sesiDir,
      healthCheckMs: 0, unlockDelayMs: 5, readyTimeoutMs: 0,
    });
    await waOut.start();
    waOut.client.emit('disconnected', 'LOGOUT');
    await sleep(300);
    assert.strictEqual(waOut._restartTimer, null, 'jangan pakai jadwal sambung-ulang biasa');
    assert.strictEqual(waOut.status().loggedOut, false, 'setelah sesi baru siap, tanda logout hilang');
    await waOut.stop();
    fs.rmSync(sesiDir, { recursive: true, force: true });
  });

  await test('putus biasa (bukan LOGOUT) tetap dijadwalkan sambung ulang', async () => {
    const waTmp = new WhatsAppService({
      clientId: 'disc-test', sessionPath: path.join(os.tmpdir(), 'wa-disc'),
      healthCheckMs: 0, unlockDelayMs: 5, readyTimeoutMs: 0,
    });
    await waTmp.start();
    waTmp.client.emit('disconnected', 'NAVIGATION');
    await sleep(30);
    assert.ok(waTmp._restartTimer, 'harus dijadwalkan sambung ulang');
    clearTimeout(waTmp._restartTimer);
    waTmp._restartTimer = null;
    await waTmp.stop();
  });

  await test('setelah pulih, semuanya berjalan normal lagi', async () => {
    global.__WA_STUB__.detached = false;
    if (!wa.isReady()) { await wa.start(); }
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 8911);
    await settle();
    assert.strictEqual(waSent().length, 2);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '8911'), true);
  });

  section('6b. Pencarian browser untuk WhatsApp Web');
  await test('daftar kandidat browser mencakup Chrome dan Edge', () => {
    const paths = WhatsAppService.knownBrowserPaths().join(' ').toLowerCase();
    assert.ok(paths.includes('chrome'));
    assert.ok(paths.includes('msedge'));
  });
  await test('findLocalBrowser memilih path yang benar-benar ada', () => {
    assert.strictEqual(WhatsAppService.findLocalBrowser(['/tidak/ada', process.execPath]), process.execPath);
    assert.strictEqual(WhatsAppService.findLocalBrowser(['/tidak/ada', '/juga/tidak']), null);
  });
  await test('Chromium bawaan hilang -> otomatis memakai browser terpasang', async () => {
    global.__WA_STUB__.initErrorOnce = 'Could not find Chrome (ver. 146.0.7680.31).';
    global.__WA_STUB__.launches = [];
    const wa2 = new WhatsAppService({
      clientId: 'fallback-test',
      sessionPath: path.join(os.tmpdir(), 'wa-fallback'),
      browserFinder: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    await wa2.start();
    assert.strictEqual(wa2.isReady(), true, 'harus pulih memakai browser terpasang');
    assert.ok(String(wa2.chromePath).includes('chrome.exe'));
    assert.deepStrictEqual(global.__WA_STUB__.launches, [null, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']);
    await wa2.stop();
  });
  await test('tanpa browser sama sekali -> tidak crash, dijadwalkan ulang', async () => {
    global.__WA_STUB__.initErrorOnce = 'Could not find Chrome (ver. 146.0.7680.31).';
    const wa3 = new WhatsAppService({
      clientId: 'nofallback-test',
      sessionPath: path.join(os.tmpdir(), 'wa-nofallback'),
      browserFinder: () => null,
    });
    await wa3.start();
    assert.strictEqual(wa3.isReady(), false);
    assert.strictEqual(wa3.state, 'failed');
    await wa3.stop();
  });

  /* ------------- SUMBER MODE AKUN (GramJS, baca saja) ------------- */
  section('7. Sumber mode akun Telegram (GramJS)');
  await drainQueue(queue);
  assert.strictEqual(wa.isReady(), true, 'prasyarat: WhatsApp utama harus siap');

  const gram = require('./stubs/gramjs.stub.js');
  const { toBotApiChatId, chatIdMatches } = TelegramUserSource;
  const SESSION_FILE = process.env.TELEGRAM_USER_SESSION_FILE;

  await test('peer supergroup -> chat id gaya Bot API (-100...)', () => {
    assert.strictEqual(toBotApiChatId({ className: 'PeerChannel', channelId: 1234567890 }), '-1001234567890');
  });
  await test('peer grup biasa -> -id', () => {
    assert.strictEqual(toBotApiChatId({ className: 'PeerChat', chatId: 987654321 }), '-987654321');
  });
  await test('peer user -> id apa adanya', () => {
    assert.strictEqual(toBotApiChatId({ className: 'PeerUser', userId: 5551234 }), '5551234');
  });
  await test('BigInt & string diterima', () => {
    assert.strictEqual(toBotApiChatId(123n), '123');
    assert.strictEqual(toBotApiChatId('-1001'), '-1001');
  });
  await test('pencocokan chat id toleran terhadap awalan -100', () => {
    assert.ok(chatIdMatches('-1001234567890', '1234567890'));
    assert.ok(chatIdMatches('1234567890', '-1001234567890'));
    assert.ok(!chatIdMatches('-1001234567890', '-1009999999999'));
  });

  await test('tanpa sesi -> tidak konek dan memberi instruksi login', async () => {
    try { fs.unlinkSync(SESSION_FILE); } catch (e) { /* ignore */ }
    const src = new TelegramUserSource({ config, pipeline: tg.pipeline });
    const ok = await src.start();
    assert.strictEqual(ok, false);
    assert.strictEqual(src.state, 'no_session');
  });

  fs.writeFileSync(SESSION_FILE, 'STUBSESSION', 'utf8');
  const userSrc = new TelegramUserSource({ config, pipeline: tg.pipeline });

  await test('dengan sesi -> terhubung sebagai akun', async () => {
    const ok = await userSrc.start();
    assert.strictEqual(ok, true);
    assert.strictEqual(userSrc.connected, true);
    assert.ok(userSrc.status().account.includes('joe_ieg'));
  });

  await test('pesan bot lain di grup sumber diteruskan (2 pesan WhatsApp)', async () => {
    global.__WA_STUB__.sent = [];
    await gram.emitMessage({
      id: 9001,
      message: TELEGRAM_SAMPLE,
      peerId: { className: 'PeerChannel', channelId: 999 },   // -100999 = SOURCE_CHAT
    });
    await settle();
    assert.strictEqual(waSent().length, 2);
    assert.ok(waSent()[0].text.includes('[FORWARDED FROM TELEGRAM]'));
    assert.strictEqual(waSent()[1].mentions.length, 2);
  });

  await test('/help dikelompokkan per bot, berurutan 1-4', async () => {
    bot.outbox.length = 0;
    await send('/help');
    const teks = bot.outbox[bot.outbox.length - 1].text;
    const urut = [
      '*1. FORWARDER TELEGRAM -> WHATSAPP*',
      '*2. LAPORAN FULFILMENT DASHBOARD*',
      '*3. LAPORAN STOK MENIPIS*',
      '*4. PERINGATAN LOCK STOCK*',
    ];
    let posisi = -1;
    for (const judul of urut) {
      const i = teks.indexOf(judul);
      assert.ok(i > posisi, `"${judul}" tidak ada atau urutannya salah`);
      posisi = i;
    }
    // Tiap perintah harus berada di bawah judul kelompoknya sendiri.
    assert.ok(teks.indexOf('/ocsstatus') > teks.indexOf(urut[1]));
    assert.ok(teks.indexOf('/ocsstatus') < teks.indexOf(urut[2]));
    assert.ok(teks.indexOf('/stokjam') > teks.indexOf(urut[2]));
    assert.ok(teks.indexOf('/stokjam') < teks.indexOf(urut[3]));
    assert.ok(teks.indexOf('/lockwa') > teks.indexOf(urut[3]));
  });

  await test('kelompok /help dipisah baris kosong, tidak menempel jadi satu blok', async () => {
    bot.outbox.length = 0;
    await send('/help');
    const teks = bot.outbox[bot.outbox.length - 1].text;
    for (const judul of ['*1. FORWARDER', '*2. LAPORAN FULFILMENT', '*3. LAPORAN STOK', '*4. PERINGATAN LOCK']) {
      const i = teks.indexOf(judul);
      assert.ok(teks.slice(i - 2, i) === '\n\n', `harus ada baris kosong sebelum ${judul}`);
    }
  });

  await test('penanda Markdown /help berpasangan - kalau tidak, Telegram menolak pesannya', async () => {
    bot.outbox.length = 0;
    await send('/help');
    const pesan = bot.outbox[bot.outbox.length - 1];
    assert.strictEqual(pesan.opts.parse_mode, 'Markdown');
    for (const tanda of ['*', '_']) {
      const jumlah = pesan.text.split(tanda).length - 1;
      assert.strictEqual(jumlah % 2, 0,
        `jumlah "${tanda}" ganjil (${jumlah}) - Telegram akan menolak seluruh pesan /help`);
    }
  });

  await test('bukan admin hanya melihat bagian umum', async () => {
    bot.outbox.length = 0;
    await send('/help', OUTSIDER, 7777);
    const teks = bot.outbox[bot.outbox.length - 1].text;
    assert.ok(teks.includes('Anda bukan administrator'));
    for (const rahasia of ['/lockwa', '/stokjam', '/ocson', '/admin']) {
      assert.ok(!teks.includes(rahasia), `${rahasia} tidak boleh terlihat oleh non-admin`);
    }
  });

  await test('pesan yang sama dua kali tidak dikirim ulang', async () => {
    global.__WA_STUB__.sent = [];
    await gram.emitMessage({ id: 9001, message: TELEGRAM_SAMPLE, peerId: { className: 'PeerChannel', channelId: 999 } });
    await settle();
    assert.strictEqual(waSent().length, 0);
  });

  await test('pesan tanpa keyword diabaikan', async () => {
    global.__WA_STUB__.sent = [];
    await gram.emitMessage({ id: 9002, message: 'Stock opname selesai.', peerId: { className: 'PeerChannel', channelId: 999 } });
    await settle();
    assert.strictEqual(waSent().length, 0);
  });

  await test('pesan dari chat lain diabaikan', async () => {
    global.__WA_STUB__.sent = [];
    await gram.emitMessage({ id: 9003, message: TELEGRAM_SAMPLE, peerId: { className: 'PeerChannel', channelId: 777 } });
    await settle();
    assert.strictEqual(waSent().length, 0);
  });

  await test('pesan tanpa teks (media) tidak menimbulkan error', async () => {
    global.__WA_STUB__.sent = [];
    await gram.emitMessage({ id: 9004, message: '', peerId: { className: 'PeerChannel', channelId: 999 } });
    await gram.emitMessage({ id: 9005, peerId: { className: 'PeerChannel', channelId: 999 } });
    await settle();
    assert.strictEqual(waSent().length, 0);
  });

  await test('JAMINAN READ-ONLY: tidak ada pemanggilan kirim/join di modul akun', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram-user.js'), 'utf8');
    const code = src.replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of ['sendMessage', 'sendFile', 'forwardMessages', 'joinChannel',
      'inviteToChannel', 'editMessage', 'deleteMessages', 'markAsRead', 'sendReaction']) {
      assert.ok(!code.includes(forbidden), `modul akun memanggil ${forbidden}`);
    }
  });

  await test('skrip login & daftar chat juga tidak mengirim apa pun', () => {
    for (const f of ['login-telegram.js', 'list-chats.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
      for (const forbidden of ['sendMessage', 'forwardMessages', 'joinChannel', 'inviteToChannel']) {
        assert.ok(!src.includes(forbidden), `${f} memanggil ${forbidden}`);
      }
    }
  });

  await test('sesi kedaluwarsa ditangani tanpa membuat proses mati', async () => {
    await userSrc.stop();
    gram.__state().failConnect = true;
    const src2 = new TelegramUserSource({ config, pipeline: tg.pipeline });
    const ok = await src2.start();
    assert.strictEqual(ok, false);
    assert.strictEqual(src2.state, 'failed');
    gram.__state().failConnect = false;
  });

  await test('mode user: bot tidak ikut menyuapi pipeline (tidak dobel)', async () => {
    const original = config.usesBotSource;
    Object.defineProperty(config, 'usesBotSource', { value: false, configurable: true });
    global.__WA_STUB__.sent = [];
    await send(TELEGRAM_SAMPLE, ADMIN, SOURCE_CHAT, 9500);
    await sleep(100);
    assert.strictEqual(waSent().length, 0, 'bot tidak boleh meneruskan saat TELEGRAM_SOURCE=user');
    Object.defineProperty(config, 'usesBotSource', { value: original, configurable: true });
  });

  /* --------- KETAHANAN 24 JAM: sambung ulang & susulan pesan --------- */
  section('7b. Ketahanan 24 jam (sambung ulang & susulan pesan)');

  const nowSec = () => Math.floor(Date.now() / 1000);
  let waSiap = true;
  const src2 = new TelegramUserSource({
    config, pipeline: tg.pipeline, healthCheckMs: 0, isReady: () => waSiap,
  });

  await test('start memproses pesan yang tertinggal (susulan)', async () => {
    gram.__state().history = [
      { id: 9601, message: TELEGRAM_SAMPLE, date: nowSec() - 60 },
      { id: 9602, message: 'Stock opname selesai.', date: nowSec() - 30 },
    ];
    global.__WA_STUB__.sent = [];
    const ok = await src2.start();
    assert.strictEqual(ok, true);
    await settle();
    assert.strictEqual(waSent().length, 2, 'pesan tertinggal harus diteruskan');
    assert.strictEqual(src2.caughtUp, 1);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9601'), true);
  });

  await test('susulan DITUNDA bila WhatsApp belum siap (pesan tidak hilang)', async () => {
    waSiap = false;
    gram.__state().history = [{ id: 9650, message: TELEGRAM_SAMPLE, date: nowSec() - 60 }];
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 0);
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(src2.catchUpTertunda, true, 'harus ditandai tertunda');
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9650'), false, 'jangan ditandai terproses');
  });

  await test('begitu WhatsApp siap, susulan yang tertunda ikut terkirim', async () => {
    waSiap = true;
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 1, 'pesan yang tadi tertunda harus menyusul');
    assert.strictEqual(waSent().length, 2, 'forward + mention');
    assert.strictEqual(src2.catchUpTertunda, false);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9650'), true);
  });

  await test('susulan tidak mengirim ulang pesan yang sudah diproses', async () => {
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 0);
    assert.strictEqual(waSent().length, 0);
  });

  await test('susulan melewati pesan yang terlalu lama', async () => {
    gram.__state().history = [{ id: 9610, message: TELEGRAM_SAMPLE, date: nowSec() - 10 * 3600 }];
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp({ limit: 10, maxAgeMinutes: 60 });
    await settle();
    assert.strictEqual(n, 0);
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9610'), false);
  });

  await test('susulan gagal tidak membuat aplikasi mati', async () => {
    gram.__state().failGetMessages = true;
    const n = await src2.catchUp();
    assert.strictEqual(n, 0);
    gram.__state().failGetMessages = false;
  });

  await test('chat tidak dikenali saat susulan ditangani rapi', async () => {
    gram.__state().failEntity = true;
    const n = await src2.catchUp();
    assert.strictEqual(n, 0);
    gram.__state().failEntity = false;
  });

  /* ---- setelah mati listrik: hanya peringatan TERAKHIR yang dikirim ---- */

  const diteruskan = () => waSent().filter((m) => String(m.text).includes('[FORWARDED FROM TELEGRAM]'));

  await test('susulan hanya mengirim peringatan TERAKHIR yang belum terkirim', async () => {
    gram.__state().history = [
      { id: 9701, message: TELEGRAM_SAMPLE, date: nowSec() - 300 },
      { id: 9702, message: 'Laporan harian selesai.', date: nowSec() - 240 },
      { id: 9703, message: TELEGRAM_SAMPLE, date: nowSec() - 180 },
      { id: 9704, message: TELEGRAM_SAMPLE, date: nowSec() - 60 },
    ];
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 1, 'hanya satu pesan yang boleh diteruskan');
    const fw = diteruskan();
    assert.strictEqual(fw.length, 1, 'hanya satu pesan forward ke WhatsApp');
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9704'), true, 'yang terakhir harus terkirim');
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9701'), true, 'yang lama ditandai terproses');
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9703'), true, 'yang lama ditandai terproses');
  });

  await test('peringatan lama yang dilewati tidak muncul lagi di susulan berikutnya', async () => {
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 0);
    assert.strictEqual(waSent().length, 0);
  });

  await test('pesan tanpa keyword tidak ikut ditandai terproses saat susulan', () => {
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9702'), false,
      'pesan yang tidak memenuhi kriteria tidak boleh disentuh');
  });

  await test('satu peringatan tertinggal tetap dikirim seperti biasa', async () => {
    gram.__state().history = [{ id: 9710, message: TELEGRAM_SAMPLE, date: nowSec() - 30 }];
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp();
    await settle();
    assert.strictEqual(n, 1);
    assert.strictEqual(diteruskan().length, 1);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9710'), true);
  });

  await test('CATCHUP_ONLY_LATEST=false mengembalikan perilaku lama (kirim semua)', async () => {
    gram.__state().history = [
      { id: 9721, message: TELEGRAM_SAMPLE, date: nowSec() - 200 },
      { id: 9722, message: TELEGRAM_SAMPLE, date: nowSec() - 100 },
    ];
    global.__WA_STUB__.sent = [];
    const n = await src2.catchUp({ onlyLatest: false });
    await settle();
    assert.strictEqual(n, 2, 'kedua pesan harus diteruskan');
    assert.strictEqual(diteruskan().length, 2);
  });

  await test('pipeline.lewati menandai terproses tanpa mengirim apa pun', async () => {
    global.__WA_STUB__.sent = [];
    const hasil = tg.pipeline.lewati(SOURCE_CHAT, 9799, 'uji');
    await settle();
    assert.strictEqual(hasil.action, 'skipped');
    assert.strictEqual(waSent().length, 0);
    assert.strictEqual(idb.isProcessed(SOURCE_CHAT, '9799'), true);
  });

  await test('layakDiteruskan memakai kriteria yang sama dengan handle', () => {
    assert.strictEqual(tg.pipeline.layakDiteruskan(SOURCE_CHAT, 9801, TELEGRAM_SAMPLE), true);
    assert.strictEqual(tg.pipeline.layakDiteruskan(SOURCE_CHAT, 9802, 'tanpa keyword'), false,
      'keyword tidak cocok');
    assert.strictEqual(tg.pipeline.layakDiteruskan('-100777', 9803, TELEGRAM_SAMPLE), false,
      'chat di luar allowlist');
    assert.strictEqual(tg.pipeline.layakDiteruskan(SOURCE_CHAT, 9799, TELEGRAM_SAMPLE), false,
      'sudah pernah diproses');
  });

  await test('koneksi mati terdeteksi lalu disambung ulang otomatis', async () => {
    gram.__state().history = [];
    const before = src2.reconnects;
    const events = [];
    src2.on('down', (r) => events.push('down:' + r));
    src2.on('up', () => events.push('up'));

    src2.client.connected = false;          // simulasi PC tidur / internet mati
    await src2._checkHealth();

    assert.strictEqual(src2.reconnects, before + 1);
    assert.strictEqual(src2.connected, true, 'harus pulih sendiri');
    assert.ok(events.some((e) => e.startsWith('down:')), events.join(','));
    assert.ok(events.includes('up'), events.join(','));
  });

  await test('ping gagal juga memicu sambung ulang', async () => {
    const before = src2.reconnects;
    gram.__state().failGetMe = true;
    const p = src2._checkHealth();
    gram.__state().failGetMe = false;      // jaringan pulih saat menyambung ulang
    await p;
    assert.strictEqual(src2.reconnects, before + 1);
    assert.strictEqual(src2.connected, true);
  });

  await test('transport bawaan memakai WSS port 443 (ramah firewall)', () => {
    const opts = gram.__state().lastClientOptions || {};
    assert.strictEqual(opts.useWSS, true, 'harus memakai WSS agar tidak lewat port 80');
    assert.strictEqual(opts.autoReconnect, true);
    assert.ok(opts.connectionRetries >= 100, 'percobaan sambung ulang harus banyak');
    assert.ok(src2.status().transport.includes('443'));
  });

  await test('ping lambat dicatat tanpa memutus koneksi', async () => {
    const before = src2.slowPings;
    const asli = src2.client.getMe.bind(src2.client);
    src2.client.getMe = async () => { await sleep(30); return asli(); };
    const aslinya = Date.now;
    let n = 0;
    Date.now = () => aslinya() + (n++ >= 1 ? 6000 : 0);   // pura-pura lambat 6 detik
    await src2._checkHealth();
    Date.now = aslinya;
    src2.client.getMe = asli;
    assert.strictEqual(src2.slowPings, before + 1);
    assert.strictEqual(src2.connected, true, 'lambat bukan berarti putus');
  });

  await test('koneksi sehat tidak memicu sambung ulang', async () => {
    const before = src2.reconnects;
    await src2._checkHealth();
    assert.strictEqual(src2.reconnects, before);
    assert.ok(src2.lastHealthyAt > 0);
  });

  await test('status melaporkan jumlah sambung ulang & pesan susulan', () => {
    const st = src2.status();
    assert.ok(st.reconnects >= 2);
    // 1 saat start + 1 yang tadi tertunda + 1 "hanya yang terakhir"
    // + 1 peringatan tunggal + 2 saat onlyLatest dimatikan
    assert.strictEqual(st.caughtUp, 6, 'penghitung susulan bersifat kumulatif');
    assert.strictEqual(st.catchUpTertunda, false);
    assert.strictEqual(st.connected, true);
  });

  await test('getMessages/getEntity tetap operasi BACA (read-only terjaga)', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram-user.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of ['sendMessage', 'sendFile', 'forwardMessages', 'joinChannel',
      'inviteToChannel', 'editMessage', 'deleteMessages', 'markAsRead', 'sendReaction']) {
      assert.ok(!code.includes(forbidden), `modul akun memanggil ${forbidden}`);
    }
  });

  await src2.stop();

  try { fs.unlinkSync(SESSION_FILE); } catch (e) { /* ignore */ }

  await tg.stop();
  await wa.stop();
  idb.close();


  /* ------------------------- LAPORAN OCS -------------------------- *
   * Seluruh uji di bawah ini murni offline: klien OCS diganti obyek
   * palsu, WhatsApp diganti perekam. Tidak ada koneksi ke ocs.iegsystem.id.
   * --------------------------------------------------------------- */

  const OcsClient = require('../src/ocs-client');
  const OcsScheduler = require('../src/ocs-scheduler');
  const laporan = require('../src/ocs-report');
  const Queue = require('../src/queue');

  const CONTOH = {
    filter: { dateType: 'dueDate', shop: 'All', channel: 'All', area: 'All' },
    summary: {
      TotalInTransit: 3, BreachedSla: 4, AtRiskSla: 2, AtRiskSla12: 5,
      InstanBelumKirim: 1, NoDueTime: 0, CompletedInRange: 6576, AvgTotalCycleHours: 4.6935,
    },
    statusBuckets: [
      { Key: 'awaiting_payment', Label: 'Awaiting Payment', Count: 503, SortOrder: 1 },
      { Key: 'packing', Label: 'Packing', Count: 0, SortOrder: 2 },
      { Key: 'manifest', Label: 'Manifest', Count: 12, SortOrder: 3 },
    ],
    aging: [
      { Bucket: '0-2 jam', SortOrder: 1, Count: 1966, BreachedSla: 4 },
      { Bucket: '2-6 jam', SortOrder: 2, Count: 0, BreachedSla: 0 },
    ],
    throughput: [
      { Day: '2026-08-26', Role: 'manifester', TotalCount: 8104, CompletedCount: 8104 },
      { Day: '2026-08-26', Role: 'packer', TotalCount: 2027, CompletedCount: 2027 },
    ],
    leaderboard: [
      { Role: 'manifester', OperatorId: 'A', OperatorName: 'RICKY', TotalCount: 3751, CompletedCount: 3751 },
      { Role: 'packer', OperatorId: 'B', OperatorName: 'mesin 01', TotalCount: 2027, CompletedCount: 2027 },
    ],
    cycle: [{
      Day: '2026-08-26', Orders: 6576, AvgCreateToAssignHours: 3.918,
      AvgAssignToPackHours: 1.265, AvgPackToManifestHours: 0.502,
      AvgManifestToShipHours: 0.529, AvgTotalCycleHours: 4.693,
    }],
    errors: [],
  };

  await test('rentang "Hari Ini" memakai batas hari WIB, bukan UTC', () => {
    const now = new Date('2026-08-26T04:20:00.000Z'); // 11:20 WIB
    const r = laporan.todayRange(now, 420);
    assert.strictEqual(r.from, '2026-08-25T17:00:00.000Z', 'from = 00:00 WIB hari ini');
    assert.strictEqual(r.to, '2026-08-26T17:00:00.000Z', 'to = 00:00 WIB besok');
  });

  await test('rentang hari benar juga sesaat setelah tengah malam WIB', () => {
    const now = new Date('2026-08-25T17:05:00.000Z'); // 00:05 WIB tanggal 26
    const r = laporan.todayRange(now, 420);
    assert.strictEqual(r.from, '2026-08-25T17:00:00.000Z');
    assert.strictEqual(r.to, '2026-08-26T17:00:00.000Z');
  });

  await test('pesan laporan memuat angka SLA, WIP, throughput, dan cycle', () => {
    const teks = laporan.renderReport(CONTOH, { now: new Date('2026-08-26T04:20:00.000Z'), tzOffsetMinutes: 420 });
    assert.ok(teks.includes('26 Agu 2026'), 'tanggal lokal');
    assert.ok(teks.includes('11:20 WIB'), 'jam lokal');
    assert.ok(teks.includes('SLA terlewat: *4*'));
    assert.ok(teks.includes('Awaiting Payment: 503'));
    assert.ok(!teks.includes('Packing: 0'), 'tahap kosong tidak ditampilkan');
    assert.ok(teks.includes('0-2 jam: 1.966 (4 lewat SLA)'));
    assert.ok(teks.includes('manifester: 8.104'));
    assert.ok(teks.includes('RICKY'));
    assert.ok(teks.includes('4,7 jam'), 'rata-rata cycle dibulatkan');
  });

  await test('laporan tetap tersusun walau sebagian data gagal diambil', () => {
    const rusak = { filter: {}, summary: null, statusBuckets: null, aging: null,
      throughput: null, leaderboard: null, cycle: null, errors: ['summary: HTTP 500'] };
    const teks = laporan.renderReport(rusak, { now: new Date('2026-08-26T04:20:00.000Z') });
    assert.ok(teks.includes('SLA terlewat: *0*'), 'nilai kosong menjadi 0');
    assert.ok(teks.includes('Sebagian data gagal diambil'), 'ada keterangan galat');
  });

  await test('decodeExp membaca klaim exp dari JWT', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1787798143 })).toString('base64');
    assert.strictEqual(OcsClient.decodeExp(`x.${payload}.y`), 1787798143);
    assert.strictEqual(OcsClient.decodeExp('bukan-jwt'), 0);
  });

  await test('query string OCS di-encode dengan benar', () => {
    const qs = OcsClient.buildQuery({ from: '2026-08-25T17:00:00.000Z', shop: 'All', kosong: null });
    assert.ok(qs.includes('from=2026-08-25T17%3A00%3A00.000Z'));
    assert.ok(qs.includes('shop=All'));
    assert.ok(!qs.includes('kosong'), 'nilai null dibuang');
  });

  /* --- penjadwal: db & WhatsApp palsu, tanpa jaringan --- */
  function dbPalsu(setting = {}) {
    const store = { ...setting };
    return {
      listActiveWaGroups: () => [{ id: 1, group_id: '123@g.us', name: 'DAILY E-COMMERCE', active: 1 }],
      listWaGroups: () => [{ id: 1, group_id: '123@g.us', name: 'DAILY E-COMMERCE', active: 1 }],
      getSetting: (k, d = null) => (k in store ? store[k] : d),
      setSetting: (k, v) => { store[k] = String(v); },
      _store: store,
    };
  }
  function configPalsu(extra = {}) {
    return {
      ocs: {
        enabled: true, intervalMinutes: 60, alignToHour: false, activeHours: null,
        tzOffsetMinutes: 420, tzLabel: 'WIB', dateType: 'dueDate', shop: 'All',
        channel: 'All', area: 'All', shift: 'All', role: 'all', topOperators: 3,
        judul: 'FULFILMENT DASHBOARD', onlyWhenProblem: false,
        ambang: { breachedSla: 1, atRiskSla: 1, instan: 1 }, ...extra,
      },
    };
  }

  await test('penjadwal mengirim satu laporan ke tiap group aktif', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid, teks) => { terkirim.push({ gid, teks }); } };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu(),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'sent');
    assert.strictEqual(terkirim.length, 1, 'satu group aktif = satu pesan');
    assert.strictEqual(terkirim[0].gid, '123@g.us');
    assert.ok(terkirim[0].teks.includes('SLA terlewat'));
  });

  await test('OCS_GROUP_IDS membatasi laporan ke group tertentu saja', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid) => { terkirim.push(gid); } };
    const isi = [
      { id: 1, group_id: '111@g.us', name: 'DAILY E-COMMERCE', active: 1 },
      { id: 2, group_id: '222@g.us', name: 'IEG x Marketing', active: 1 },
    ];
    const dbDua = {
      listActiveWaGroups: () => isi.filter((g) => g.active),
      listWaGroups: () => isi,
      getSetting: (k, d = null) => d,
      setSetting: () => {},
    };
    const sched = new OcsScheduler({
      db: dbDua, whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ groupIds: ['111@g.us'] }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'sent');
    assert.deepStrictEqual(terkirim, ['111@g.us'], 'hanya group yang dipilih');
  });

  await test('OCS_GROUP_IDS boleh diisi nama group, bukan hanya JID', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid) => { terkirim.push(gid); } };
    const isi = [
      { id: 1, group_id: '111@g.us', name: 'DAILY E-COMMERCE', active: 1 },
      { id: 2, group_id: '222@g.us', name: 'IEG x Marketing', active: 1 },
    ];
    const dbDua = {
      listActiveWaGroups: () => isi.filter((g) => g.active),
      listWaGroups: () => isi,
      getSetting: (k, d = null) => d,
      setSetting: () => {},
    };
    const sched = new OcsScheduler({
      db: dbDua, whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ groupIds: ['ieg x marketing'] }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    await sched.runOnce();
    assert.deepStrictEqual(terkirim, ['222@g.us']);
  });

  await test('nama group yang salah tulis memberi pesan galat yang jelas', async () => {
    // Nilai berbentuk JID selalu diterima apa adanya (group boleh belum
    // terdaftar). Yang bisa salah tulis adalah NAMA group.
    const waPalsu = { isReady: () => true, sendText: async () => { throw new Error('tidak boleh dipanggil'); } };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ groupIds: ['GROUP YANG TIDAK ADA'] }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'failed');
    assert.ok(/tidak dikenal/.test(hasil.reason), hasil.reason);
    assert.ok(/GROUP YANG TIDAK ADA/.test(hasil.reason), 'sebutkan nilai yang salah');
  });

  await test('group khusus laporan menerima OCS walau TIDAK aktif untuk forwarding', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid) => { terkirim.push(gid); } };
    const isi = [
      { id: 1, group_id: '111@g.us', name: 'DAILY E-COMMERCE', active: 1 },
      { id: 2, group_id: '333@g.us', name: 'LAPORAN FULFILMENT', active: 0 },
    ];
    const dbCampur = {
      listActiveWaGroups: () => isi.filter((g) => g.active),
      listWaGroups: () => isi,
      getSetting: (k, d = null) => d,
      setSetting: () => {},
    };
    const sched = new OcsScheduler({
      db: dbCampur, whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ groupIds: ['333@g.us'] }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'sent');
    assert.deepStrictEqual(terkirim, ['333@g.us'], 'hanya group laporan, bukan group forwarding');
  });

  await test('JID yang belum terdaftar sama sekali tetap bisa dijadikan tujuan', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid) => { terkirim.push(gid); } };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ groupIds: ['999888777@g.us'] }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'sent');
    assert.deepStrictEqual(terkirim, ['999888777@g.us']);
  });

  await test('penjadwal tidak mengirim saat WhatsApp belum siap', async () => {
    const waPalsu = { isReady: () => false, sendText: async () => { throw new Error('tidak boleh dipanggil'); } };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu(), client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'failed');
    assert.ok(/belum tersambung/.test(hasil.reason));
  });

  await test('tombol mati di settings menghentikan pengiriman terjadwal', async () => {
    const waPalsu = { isReady: () => true, sendText: async () => { throw new Error('tidak boleh dipanggil'); } };
    const sched = new OcsScheduler({
      db: dbPalsu({ ocs_enabled: '0' }), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu(), client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'skipped');
    assert.strictEqual(hasil.reason, 'dimatikan');
  });

  await test('perintah manual (/ocs) menembus tombol mati dan jam aktif', async () => {
    const terkirim = [];
    const waPalsu = { isReady: () => true, sendText: async (gid, teks) => { terkirim.push(teks); } };
    const sched = new OcsScheduler({
      db: dbPalsu({ ocs_enabled: '0' }), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ activeHours: { mulai: 3, sampai: 4 } }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const hasil = await sched.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'sent');
    assert.strictEqual(terkirim.length, 1);
  });

  await test('jam aktif dihitung dalam waktu lokal, termasuk yang melewati tengah malam', () => {
    const buat = (jamAktif) => new OcsScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true, sendText: async () => {} },
      queue: new Queue({ delayMs: 0 }), config: configPalsu({ activeHours: jamAktif }),
      client: { fetchFulfilment: async () => CONTOH },
    });
    const siang = buat({ mulai: 7, sampai: 21 });
    assert.strictEqual(siang.dalamJamAktif(new Date('2026-08-26T04:20:00.000Z')), true, '11:20 WIB');
    assert.strictEqual(siang.dalamJamAktif(new Date('2026-08-25T22:00:00.000Z')), false, '05:00 WIB');

    const malam = buat({ mulai: 22, sampai: 6 });
    assert.strictEqual(malam.dalamJamAktif(new Date('2026-08-25T22:00:00.000Z')), true, '05:00 WIB');
    assert.strictEqual(malam.dalamJamAktif(new Date('2026-08-26T04:20:00.000Z')), false, '11:20 WIB');

    const penuh = buat(null);
    assert.strictEqual(penuh.dalamJamAktif(new Date()), true, 'tanpa batas jam');
  });

  await test('mode hanya-saat-bermasalah menahan laporan yang aman', async () => {
    const aman = JSON.parse(JSON.stringify(CONTOH));
    aman.summary.BreachedSla = 0; aman.summary.AtRiskSla = 0; aman.summary.InstanBelumKirim = 0;
    const waPalsu = { isReady: () => true, sendText: async () => { throw new Error('tidak boleh dipanggil'); } };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({ onlyWhenProblem: true }),
      client: { fetchFulfilment: async () => aman },
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'skipped');
    assert.ok(hasil.text, 'teks tetap tersedia untuk pemeriksaan manual');
  });

  await test('klien OCS tidak pernah menulis ke OCS (hanya GET dan endpoint Auth)', () => {
    const kode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ocs-client.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const post = kode.match(/_request\('POST', '([^']+)'/g) || [];
    for (const p of post) {
      assert.ok(/\/Auth\/(Login|Refresh|Logout)/.test(p), `POST ke endpoint non-Auth: ${p}`);
    }
    assert.ok(!/'(PUT|DELETE|PATCH)'/.test(kode), 'tidak ada metode yang mengubah data');
  });



  /* ------------------- PERINGKAT OPERATOR (BULAN) ------------------ */

  const CONTOH_BULAN = {
    from: '2026-07-31T17:00:00.000Z',   // 1 Agu 00:00 WIB
    to: '2026-08-26T17:00:00.000Z',     // 27 Agu 00:00 WIB
    leaderboard: [
      { Role: 'manifester', OperatorName: 'RICKY FEBRIANSYAH', CompletedCount: 90000 },
      { Role: 'packer', OperatorName: 'mesin 01', CompletedCount: 80000 },
      { Role: 'packer', OperatorName: 'MESIN 02', CompletedCount: 70000 },
      { Role: 'packer', OperatorName: 'BUDI', CompletedCount: 4600 },
      { Role: 'picker', OperatorName: 'SYSTEM', CompletedCount: 99999 },
      { Role: 'picker', OperatorName: 'SITI', CompletedCount: 4140 },
      { Role: 'packer', OperatorName: 'AGUS', CompletedCount: 2300 },
      { Role: 'picker', OperatorName: 'NOL', CompletedCount: 0 },
    ],
    throughput: [
      // 23 hari operasi: 1-23 Agustus
      ...Array.from({ length: 23 }, (_, i) => ({
        Day: `2026-08-${String(i + 1).padStart(2, '0')}`, Role: 'packer',
        TotalCount: 100, CompletedCount: 100,
      })),
      // hari libur - ada barisnya tetapi nol, tidak boleh ikut jadi pembagi
      { Day: '2026-08-24', Role: 'packer', TotalCount: 0, CompletedCount: 0 },
      // peran lain di hari yang sama sekali berbeda - tidak boleh menambah hari
      { Day: '2026-08-25', Role: 'manifester', TotalCount: 50, CompletedCount: 50 },
    ],
    errors: [],
  };

  await test('rentang bulan berjalan = tanggal 1 s/d akhir hari ini (waktu lokal)', () => {
    const r = laporan.monthToDateRange(new Date('2026-08-26T04:20:00.000Z'), 420);
    assert.strictEqual(r.from, '2026-07-31T17:00:00.000Z', '1 Agu 00:00 WIB');
    assert.strictEqual(r.to, '2026-08-26T17:00:00.000Z', 'akhir hari ini');
  });

  await test('hari operasi hanya menghitung hari yang benar-benar ada hasilnya', () => {
    const hari = laporan.hitungHariOperasi(CONTOH_BULAN.throughput, ['packer', 'picker']);
    assert.strictEqual(hari, 23, 'hari nol dan peran lain tidak ikut dihitung');
  });

  await test('peringkat menyaring peran, membuang mesin, dan memakai rata-rata harian', () => {
    const hasil = laporan.ringkasOperator(CONTOH_BULAN.leaderboard, {
      roles: ['packer', 'picker'], kecuali: ['mesin', 'system'], top: 10, hariOperasi: 23,
    });
    const nama = hasil.map((o) => o.nama);
    assert.ok(!nama.includes('RICKY FEBRIANSYAH'), 'manifester tidak ikut');
    assert.ok(!nama.some((n) => /mesin/i.test(n)), 'mesin dibuang, termasuk huruf besar');
    assert.ok(!nama.includes('NOL'), 'operator tanpa hasil tidak ditampilkan');
    assert.deepStrictEqual(nama, ['BUDI', 'SITI', 'AGUS'], 'urut menurun berdasar rata-rata');
    assert.strictEqual(Math.round(hasil[0].rata), 200, '4600 / 23 hari');
  });

  await test('akun SYSTEM dan mesin sama-sama disingkirkan dari peringkat', () => {
    const hasil = laporan.ringkasOperator(CONTOH_BULAN.leaderboard, {
      roles: ['packer', 'picker'], kecuali: ['mesin', 'system'], top: 10, hariOperasi: 23,
    });
    const nama = hasil.map((o) => o.nama);
    assert.ok(!nama.includes('SYSTEM'), 'SYSTEM tidak boleh ikut walau angkanya tertinggi');
    assert.ok(!nama.some((n) => /mesin/i.test(n)), 'mesin tetap disingkirkan');
    assert.deepStrictEqual(nama, ['BUDI', 'SITI', 'AGUS']);
  });

  await test('peringkat dibatasi sesuai OCS_TOP_OPERATORS', () => {
    const hasil = laporan.ringkasOperator(CONTOH_BULAN.leaderboard, {
      roles: ['packer', 'picker'], kecuali: ['mesin', 'system'], top: 2, hariOperasi: 23,
    });
    assert.strictEqual(hasil.length, 2);
  });

  await test('pesan menampilkan peringkat bulan berjalan lengkap dengan periodenya', () => {
    const data = { ...CONTOH, bulan: CONTOH_BULAN };
    const teks = laporan.renderReport(data, {
      now: new Date('2026-08-26T04:20:00.000Z'), tzOffsetMinutes: 420,
      topOperators: 10, leaderboardRoles: ['packer', 'picker'], leaderboardExclude: ['mesin', 'system'],
    });
    assert.ok(teks.includes('TOP 2 PACKER - RATA-RATA/HARI'), teks);
    assert.ok(teks.includes('TOP 1 PICKER - RATA-RATA/HARI'), teks);
    assert.ok(teks.includes('1-26 Agu 2026, 23 hari operasi (dari data)'), 'label periode + dasar');
    assert.ok(teks.includes('1. BUDI: 200/hari - total 4.600'));
    assert.ok(!/mesin/i.test(teks.slice(teks.indexOf('TOP 2 PACKER'))), 'mesin tidak muncul di daftar');
  });

  await test('dua bagian terpisah: satu peringkat untuk tiap peran', () => {
    const data = { ...CONTOH, bulan: CONTOH_BULAN };
    const teks = laporan.renderReport(data, {
      now: new Date('2026-08-26T04:20:00.000Z'), tzOffsetMinutes: 420,
      topOperators: 10, leaderboardRoles: ['picker', 'packer'], leaderboardExclude: ['mesin', 'system'],
    });
    const posPicker = teks.indexOf('TOP 1 PICKER');
    const posPacker = teks.indexOf('TOP 2 PACKER');
    assert.ok(posPicker > 0 && posPacker > 0, 'kedua bagian ada');
    assert.ok(posPicker < posPacker, 'urutan mengikuti OCS_LEADERBOARD_ROLES');
    const bagianPicker = teks.slice(posPicker, posPacker);
    assert.ok(bagianPicker.includes('SITI'), 'picker berisi picker');
    assert.ok(!bagianPicker.includes('BUDI'), 'packer tidak bocor ke bagian picker');
  });

  await test('pembagi kalender menghitung tanggal 1 s/d hari ini', () => {
    const p = laporan.tentukanPembagi({
      mode: 'calendar', now: new Date('2026-08-26T04:20:00.000Z'), off: 420, offDays: [],
    });
    assert.strictEqual(p.hari, 26);
    assert.strictEqual(p.dasar, 'kalender');
  });

  await test('pembagi kalender bisa mengecualikan hari libur mingguan', () => {
    // Agustus 2026: tanggal 2, 9, 16, 23 jatuh hari Minggu
    const p = laporan.tentukanPembagi({
      mode: 'calendar', now: new Date('2026-08-26T04:20:00.000Z'), off: 420, offDays: [0],
    });
    assert.strictEqual(p.hari, 22, '26 hari dikurangi 4 hari Minggu');
  });

  await test('pembagi boleh disetel angka tetap', () => {
    const p = laporan.tentukanPembagi({ mode: '23', throughput: [], roles: [] });
    assert.strictEqual(p.hari, 23);
    assert.strictEqual(p.dasar, 'disetel manual');
  });

  await test('pembagi auto memakai hari yang ada datanya', () => {
    const p = laporan.tentukanPembagi({
      mode: 'auto', throughput: CONTOH_BULAN.throughput, roles: ['packer'],
    });
    assert.strictEqual(p.hari, 23);
    assert.strictEqual(p.dasar, 'dari data');
  });

  await test('pembagi tidak pernah nol walau data throughput kosong', () => {
    const p = laporan.tentukanPembagi({ mode: 'auto', throughput: [], roles: ['packer'] });
    assert.strictEqual(p.hari, 1, 'menghindari pembagian dengan nol');
  });

  await test('tanpa data bulan, peringkat kembali memakai angka hari ini', () => {
    const teks = laporan.renderReport(CONTOH, {
      now: new Date('2026-08-26T04:20:00.000Z'), tzOffsetMinutes: 420,
      topOperators: 10, leaderboardRoles: [], leaderboardExclude: [],
    });
    assert.ok(teks.includes('- HARI INI*'), teks);
    assert.ok(teks.includes('RICKY'));
  });

  await test('penjadwal menarik rentang bulan terpisah untuk peringkat operator', async () => {
    const diminta = [];
    const waPalsu = { isReady: () => true, sendText: async () => {} };
    const clientPalsu = {
      fetchFulfilment: async (f) => { diminta.push(['harian', f.from, f.to]); return CONTOH; },
      fetchOperatorRange: async (f) => { diminta.push(['bulanan', f.from, f.to]); return CONTOH_BULAN; },
    };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({
        leaderboard: { period: 'month', roles: ['packer', 'picker'], exclude: ['mesin', 'system'] },
      }),
      client: clientPalsu,
    });
    const hasil = await sched.runOnce();
    assert.strictEqual(hasil.status, 'sent');
    assert.strictEqual(diminta.length, 2, 'dua permintaan: harian + bulanan');
    assert.strictEqual(diminta[0][0], 'harian');
    assert.strictEqual(diminta[1][0], 'bulanan');
    // Rentang bulanan mulai dari tanggal 1 waktu lokal. Pada TANGGAL 1 itu
    // sendiri kedua rentang memang sama - dan itu benar, bukan kesalahan.
    const awalBulan = laporan.monthToDateRange(new Date(), 420).from;
    assert.strictEqual(diminta[1][1], awalBulan, 'bulanan mulai dari tanggal 1 waktu lokal');
    assert.ok(diminta[1][1] <= diminta[0][1], 'bulanan tidak pernah mulai setelah harian');
    assert.ok(hasil.text.includes('RATA-RATA/HARI'));
  });

  await test('period=today membuat penjadwal tidak menarik data bulanan', async () => {
    let bulananDiminta = 0;
    const waPalsu = { isReady: () => true, sendText: async () => {} };
    const sched = new OcsScheduler({
      db: dbPalsu(), whatsapp: waPalsu, queue: new Queue({ delayMs: 0 }),
      config: configPalsu({
        leaderboard: { period: 'today', roles: ['packer', 'picker'], exclude: ['mesin', 'system'] },
      }),
      client: {
        fetchFulfilment: async () => CONTOH,
        fetchOperatorRange: async () => { bulananDiminta += 1; return CONTOH_BULAN; },
      },
    });
    await sched.runOnce();
    assert.strictEqual(bulananDiminta, 0, 'tidak boleh ada permintaan tambahan');
  });

  /* --------------------- PENGAMAN SHUTDOWN ------------------------ */

  const { pasangPengamanShutdown } = require('../src/shutdown-guard');

  await test('shutdown yang menggantung dihentikan paksa setelah tenggat', async () => {
    let keluar = 0;
    const p = pasangPengamanShutdown(1000, () => { keluar += 1; });
    assert.strictEqual(keluar, 0, 'belum boleh keluar sebelum tenggat');
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(keluar, 1, 'proses dihentikan paksa tepat sekali');
    p.batalkan();
  });

  await test('shutdown yang selesai tepat waktu membatalkan pengaman', async () => {
    let keluar = 0;
    const p = pasangPengamanShutdown(1000, () => { keluar += 1; });
    p.batalkan();
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(keluar, 0, 'tidak boleh keluar paksa setelah dibatalkan');
  });

  await test('tenggat shutdown tidak pernah lebih pendek dari 1 detik', () => {
    const p = pasangPengamanShutdown(0, () => {});
    assert.ok(p.timer, 'timer tetap dipasang');
    p.batalkan();
  });

  await test('pengaman shutdown tidak menahan proses tetap hidup (unref)', () => {
    const p = pasangPengamanShutdown(60000, () => {});
    assert.ok(p.timer.hasRef === undefined || p.timer.hasRef() === false, 'timer harus unref');
    p.batalkan();
  });

  /* ---------------------- LAPORAN STOK MENIPIS --------------------- *
   * Murni offline: klien OCS diganti obyek palsu, WhatsApp perekam.
   * ---------------------------------------------------------------- */
  section('11. Laporan Stok Menipis (View V2 + Order per SKU)');

  const SR = require('../src/stock-report');
  const StockScheduler = require('../src/stock-scheduler');

  const OFF = 420;   // WIB
  const SEKARANG = new Date('2026-08-28T01:00:00.000Z');   // 08:00 WIB, 28 Agu

  function stockConfigPalsu(extra = {}) {
    return {
      ocs: { baseUrl: 'x', username: 'u', password: 'p', database: 'd',
        timeoutMs: 20000, tzOffsetMinutes: OFF, tzLabel: 'WIB' },
      stock: {
        enabled: true, hours: [8, 12, 16], groupIds: [], ambang: 1000,
        kategori: 'Sku', hanyaAktif: true, area: '', salesDays: 90, chunkDays: 30,
        platform: 'All', shop: 'All', avgMode: 'winsor', persentil: 95,
        paydayMulai: 25, top: 20, detail: true, judul: 'STOK MENIPIS', ...extra,
      },
    };
  }

  const STOK_CONTOH = [
    { Sku: 'CEPAT-HABIS', Name: 'Serum A', AreaId: 'Pusat', Category: 'Sku', AvailableQty: 300, IsActive: true },
    { Sku: 'AMAN', Name: 'Serum B', AreaId: 'Pusat', Category: 'Sku', AvailableQty: 900, IsActive: true },
    { Sku: 'TAK-LAKU', Name: 'Serum C', AreaId: 'Pusat', Category: 'Sku', AvailableQty: 50, IsActive: true },
    { Sku: 'NONAKTIF', Name: 'Serum D', AreaId: 'Pusat', Category: 'Sku', AvailableQty: 10, IsActive: false },
    { Sku: 'GIMMICK-X', Name: 'Bonus', AreaId: 'Pusat', Category: 'Gimmick', AvailableQty: 10, IsActive: true },
  ];

  /* ----------------------------- tanggal ---------------------------- */

  await test('jendela penjualan = N hari penuh terakhir, hari ini tidak ikut', () => {
    const r = SR.rentangPenjualan(SEKARANG, OFF, 90);
    assert.strictEqual(r.to, '2026-08-27T17:00:00.000Z', 'berakhir 00:00 WIB hari ini');
    assert.strictEqual(r.hari, 90);
    const hari = SR.daftarHari(r.from, r.to, OFF);
    assert.strictEqual(hari.length, 90);
    assert.strictEqual(hari[hari.length - 1], '2026-08-27', 'hari terakhir = kemarin');
    assert.ok(!hari.includes('2026-08-28'), 'hari ini yang masih berjalan tidak ikut');
  });

  await test('jendela tetap benar sesaat setelah tengah malam WIB', () => {
    const r = SR.rentangPenjualan(new Date('2026-08-27T17:05:00.000Z'), OFF, 30);
    const hari = SR.daftarHari(r.from, r.to, OFF);
    assert.strictEqual(hari[hari.length - 1], '2026-08-27');
    assert.strictEqual(hari.length, 30);
  });

  await test('double date dan payday dikenali dengan benar', () => {
    assert.strictEqual(SR.tanggalKembar('2026-12-12'), true);
    assert.strictEqual(SR.tanggalKembar('2026-01-01'), true);
    assert.strictEqual(SR.tanggalKembar('2026-08-26'), false);
    assert.strictEqual(SR.hariGajian('2026-08-25'), true);
    assert.strictEqual(SR.hariGajian('2026-08-31'), true);
    assert.strictEqual(SR.hariGajian('2026-08-24'), false);
    assert.strictEqual(SR.hariPuncak('2026-08-15', {}), false, 'hari biasa');
    assert.strictEqual(SR.hariPuncak('2026-08-26', {}), true, 'tanggal 26 masuk payday');
    assert.strictEqual(SR.hariPuncak('2026-08-22', {}), false);
    assert.strictEqual(SR.hariPuncak('2026-08-22', { paydayMulai: 20 }), true, 'awal payday bisa digeser');
    assert.strictEqual(SR.hariPuncak('2026-08-08', {}), true, 'double date 8.8');
  });

  /* --------------------------- rata-rata ---------------------------- */

  await test('persentil memakai interpolasi linier', () => {
    assert.strictEqual(SR.persentil([10, 20, 30, 40, 50], 50), 30);
    assert.strictEqual(SR.persentil([10, 20], 50), 15);
    assert.strictEqual(SR.persentil([7], 95), 7);
    assert.strictEqual(SR.persentil([], 95), 0);
  });

  await test('winsorize menekan lonjakan 12.12 tanpa membuang harinya', () => {
    const hari = SR.daftarHari('2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0);
    const per = new Map();
    for (const h of hari) per.set(h, 10);
    per.set('2026-06-15', 2000);

    const penuh = SR.hitungRataHarian(per, hari, { mode: 'full' });
    const win = SR.hitungRataHarian(per, hari, { mode: 'winsor', persentil: 95 });

    assert.ok(penuh.rata > 70, `tanpa batas rata-ratanya melonjak (${penuh.rata})`);
    assert.ok(win.rata < 15, `winsor menahan lonjakan (${win.rata})`);
    assert.ok(win.rata >= 10, 'tetapi tidak turun di bawah penjualan harian biasa');
  });

  await test('winsorize memakai hari berpenjualan saja, SKU yang jarang laku tidak ambruk', () => {
    const hari = [];
    for (let i = 1; i <= 90; i += 1) hari.push(`H${String(i).padStart(3, '0')}`);
    const per = new Map();
    for (let i = 1; i <= 5; i += 1) per.set(hari[i], 10);

    const h = SR.hitungRataHarian(per, hari, { mode: 'winsor', persentil: 95, payday: false, doubleDate: false });
    assert.ok(Math.abs(h.rata - (50 / 90)) < 0.001,
      `rata-rata harus 50/90 = 0,56 - bukan ${h.rata}. Nol tidak boleh ikut menghitung persentil.`);
    assert.strictEqual(h.hariJual, 5);
  });

  await test('mode normal membuang payday & double date, mode full tidak', () => {
    const hari = SR.daftarHari('2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 0);
    const per = new Map();
    for (const h of hari) per.set(h, SR.hariPuncak(h, {}) ? 100 : 10);

    const normal = SR.hitungRataHarian(per, hari, { mode: 'normal' });
    const penuh = SR.hitungRataHarian(per, hari, { mode: 'full' });
    assert.strictEqual(Math.round(normal.rata), 10, 'mode normal hanya melihat hari biasa');
    assert.ok(penuh.rata > normal.rata, 'mode full lebih tinggi karena payday ikut');
    assert.strictEqual(Math.round(normal.puncak), 100, 'angka puncak tetap dilaporkan');
  });

  await test('SKU tanpa penjualan menghasilkan rata-rata nol, bukan galat', () => {
    const hari = SR.daftarHari('2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 0);
    const h = SR.hitungRataHarian(new Map(), hari, { mode: 'winsor' });
    assert.strictEqual(h.rata, 0);
    assert.strictEqual(h.hariJual, 0);
  });

  /* ------------------------- penyaringan ---------------------------- */

  await test('saringan membuang SKU nonaktif, kategori lain, dan yang di atas ambang', () => {
    const hasil = SR.saringStok(STOK_CONTOH, { ambang: 1000, kategori: 'Sku', hanyaAktif: true });
    const sku = hasil.map((s) => s.Sku);
    assert.deepStrictEqual(sku.sort(), ['AMAN', 'CEPAT-HABIS', 'TAK-LAKU']);
    assert.ok(!sku.includes('NONAKTIF'), 'status nonaktif dibuang');
    assert.ok(!sku.includes('GIMMICK-X'), 'kategori selain Sku dibuang');
  });

  await test('ambang bisa diubah', () => {
    assert.strictEqual(SR.saringStok(STOK_CONTOH, { ambang: 100 }).length, 1);
  });

  await test('baris dari beberapa Area untuk SKU & hari yang sama dijumlahkan', () => {
    const deret = SR.deretHarian([
      { Date: '2026-08-01T00:00:00', SellerSku: 'A', Area: 'Pusat', Qty: 5 },
      { Date: '2026-08-01T00:00:00', SellerSku: 'A', Area: 'Cabang', Qty: 7 },
      { Date: '2026-08-02T00:00:00', SellerSku: 'A', Area: 'Pusat', Qty: 3 },
    ], OFF);
    assert.strictEqual(deret.get('A').get('2026-08-01'), 12);
    assert.strictEqual(deret.get('A').get('2026-08-02'), 3);
  });

  /* --------------------------- urutan ------------------------------- */

  await test('urutan laporan: sisa hari paling sedikit lebih dulu', () => {
    const hari = SR.daftarHari('2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 0);
    const jual = new Map([
      ['CEPAT-HABIS', new Map(hari.map((h) => [h, 100]))],
      ['AMAN', new Map(hari.map((h) => [h, 10]))],
    ]);
    const baris = SR.susunBaris(SR.saringStok(STOK_CONTOH, {}), jual, hari, { mode: 'full' });
    assert.strictEqual(baris[0].sku, 'CEPAT-HABIS');
    assert.strictEqual(baris[1].sku, 'AMAN');
    assert.strictEqual(baris[2].sku, 'TAK-LAKU', 'SKU tanpa penjualan ditaruh paling belakang');
    assert.strictEqual(baris[2].hariCukup, null);
    assert.strictEqual(Math.round(baris[0].hariCukup), 3);
  });

  /* --------------------------- tampilan ----------------------------- */

  await test('pesan memuat SKU, Available Qty, dan Avg Daily Sales', () => {
    const hari = SR.daftarHari('2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 0);
    const jual = new Map([['CEPAT-HABIS', new Map(hari.map((h) => [h, 100]))]]);
    const baris = SR.susunBaris(SR.saringStok(STOK_CONTOH, {}), jual, hari, { mode: 'full' });
    const teks = SR.renderStockReport({ baris, rentang: { hari: 10 } }, {
      now: SEKARANG, tzOffsetMinutes: OFF, tzLabel: 'WIB', top: 20, ambang: 1000,
    });
    assert.ok(teks.includes('28 Agu 2026'), 'tanggal lokal');
    assert.ok(teks.includes('08:00 WIB'), 'jam lokal');
    assert.ok(teks.includes('CEPAT-HABIS'));
    assert.ok(teks.includes('Stok *300*'), 'Available Qty');
    assert.ok(teks.includes('Avg *100*/hari'), 'Avg Daily Sales');
    assert.ok(teks.includes('3 hari') || teks.includes('3,0 hari'), 'sisa hari');
  });

  await test('pesan tidak pernah melewati batas panjang WhatsApp', () => {
    const hari = SR.daftarHari('2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 0);
    const banyak = [];
    const jual = new Map();
    for (let i = 0; i < 400; i += 1) {
      const sku = `SKU-PANJANG-SEKALI-NOMOR-${String(i).padStart(4, '0')}`;
      banyak.push({ Sku: sku, Name: 'x', Category: 'Sku', IsActive: true, AvailableQty: 100 + i });
      jual.set(sku, new Map(hari.map((h) => [h, 20])));
    }
    const baris = SR.susunBaris(banyak, jual, hari, { mode: 'full' });
    const teks = SR.renderStockReport({ baris, rentang: { hari: 10 } }, {
      now: SEKARANG, tzOffsetMinutes: OFF, top: 400,
    });
    assert.ok(teks.length < 4096, `panjang pesan ${teks.length} harus di bawah 4096`);
    assert.ok(teks.includes('SKU lain di bawah ambang'), 'sisanya diberi keterangan');
  });

  await test('stok aman menghasilkan pesan yang jelas, bukan pesan kosong', () => {
    const teks = SR.renderStockReport({ baris: [], rentang: { hari: 90 } }, { now: SEKARANG, tzOffsetMinutes: OFF });
    assert.ok(teks.includes('Stok aman'));
  });

  /* --------------------------- penjadwal ---------------------------- */

  function clientStokPalsu(catat = {}) {
    return {
      fetchLowStock: async (f) => { catat.stok = f; return STOK_CONTOH; },
      fetchOrderPerSkuRange: async (f) => {
        catat.jual = f;
        return {
          baris: [
            { Date: '2026-08-26T00:00:00', SellerSku: 'CEPAT-HABIS', Area: 'Pusat', Qty: 100 },
            { Date: '2026-08-27T00:00:00', SellerSku: 'CEPAT-HABIS', Area: 'Pusat', Qty: 100 },
          ],
          errors: [],
        };
      },
    };
  }

  await test('jam kirim dihitung dalam waktu lokal', () => {
    const s = new StockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    assert.ok(s.jatuhTempo(new Date('2026-08-28T01:00:00.000Z')), '08:00 WIB termasuk jam kirim');
    assert.ok(s.jatuhTempo(new Date('2026-08-28T05:00:00.000Z')), '12:00 WIB termasuk jam kirim');
    assert.strictEqual(s.jatuhTempo(new Date('2026-08-28T02:00:00.000Z')), null, '09:00 WIB bukan jam kirim');
  });

  await test('toleransi menit: aplikasi yang hidup pukul 08:03 tetap mengirim', () => {
    const s = new StockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    assert.ok(s.jatuhTempo(new Date('2026-08-28T01:03:00.000Z')), '08:03 masih dalam toleransi');
    assert.strictEqual(s.jatuhTempo(new Date('2026-08-28T01:30:00.000Z')), null, '08:30 sudah lewat');
  });

  await test('satu jam kirim hanya menghasilkan satu pesan walau dicek berkali-kali', () => {
    const db = dbPalsu();
    const s = new StockScheduler({
      db, whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    const t = new Date('2026-08-28T01:00:00.000Z');
    const pertama = s.jatuhTempo(t);
    assert.ok(pertama);
    db.setSetting('stock_last_fired', pertama.kunci);
    assert.strictEqual(s.jatuhTempo(t), null, 'jam yang sama tidak diulang setelah restart');
    assert.ok(s.jatuhTempo(new Date('2026-08-28T05:00:00.000Z')), 'jam berikutnya tetap jalan');
  });

  await test('pengaturan dari Menu Admin menang atas .env', () => {
    const db = dbPalsu({ stock_hours: '6,18', stock_threshold: '500', stock_top: '5', stock_avg_mode: 'full' });
    const s = new StockScheduler({
      db, whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    const o = s.opsi();
    assert.deepStrictEqual(o.hours, [6, 18]);
    assert.strictEqual(o.ambang, 500);
    assert.strictEqual(o.top, 5);
    assert.strictEqual(o.avgMode, 'full');
  });

  await test('setOpsi menolak nilai yang tidak masuk akal', () => {
    const s = new StockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    assert.throws(() => s.setOpsi('hours', 'pagi'), /jam 0-23/);
    assert.throws(() => s.setOpsi('ambang', '-5'), /lebih dari 0/);
    assert.throws(() => s.setOpsi('avgMode', 'ngawur'), /winsor/);
    assert.strictEqual(s.setOpsi('hours', '7, 13 ,19'), 'Jam kirim: 07:00, 13:00, 19:00');
    assert.strictEqual(s.setOpsi('ambang', '2.000'), 'ambang = 2.000');
  });

  await test('penjadwal menarik stok dan penjualan lalu mengirim satu pesan', async () => {
    const catat = {};
    const terkirim = [];
    const s = new StockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks) => { terkirim.push({ gid, teks }); } },
      config: stockConfigPalsu(), client: clientStokPalsu(catat),
    });
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'sent');
    assert.strictEqual(terkirim.length, 1);
    assert.strictEqual(terkirim[0].gid, '123@g.us');
    assert.ok(terkirim[0].teks.includes('CEPAT-HABIS'));
    assert.strictEqual(catat.stok.ambang, 1000, 'ambang diteruskan ke OCS');
    assert.strictEqual(catat.stok.kategori, 'Sku');
    assert.strictEqual(catat.stok.hanyaAktif, true);
    assert.strictEqual(catat.jual.chunkDays, 30, 'permintaan penjualan dipecah');
  });

  await test('data penjualan yang berat hanya ditarik sekali per hari (cache)', async () => {
    let panggilan = 0;
    const client = clientStokPalsu();
    const asli = client.fetchOrderPerSkuRange;
    client.fetchOrderPerSkuRange = async (f) => { panggilan += 1; return asli(f); };
    const s = new StockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: stockConfigPalsu(), client,
    });
    await s.runOnce({ paksa: true });
    await s.runOnce({ paksa: true });
    assert.strictEqual(panggilan, 1, 'laporan kedua memakai cache, bukan menarik ulang 90 hari');
  });

  await test('tombol mati menghentikan pengiriman terjadwal, /stok tetap jalan', async () => {
    const db = dbPalsu({ stock_enabled: '0' });
    const terkirim = [];
    const s = new StockScheduler({
      db, queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => { terkirim.push(1); } },
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    assert.strictEqual(s.enabled(), false);
    const dilewati = await s.runOnce();
    assert.strictEqual(dilewati.status, 'skipped');
    assert.strictEqual(terkirim.length, 0);
    const dipaksa = await s.runOnce({ paksa: true });
    assert.strictEqual(dipaksa.status, 'sent');
  });

  await test('group tujuan bisa dipilih, termasuk group yang tidak aktif', async () => {
    const db = dbPalsu();
    db.listActiveWaGroups = () => [{ group_id: 'aktif@g.us', name: 'FORWARD' }];
    db.listWaGroups = () => [
      { group_id: 'aktif@g.us', name: 'FORWARD' },
      { group_id: 'khusus@g.us', name: 'LAPORAN STOK' },
    ];
    const terkirim = [];
    const s = new StockScheduler({
      db, queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid) => { terkirim.push(gid); } },
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    s.setOpsi('groups', 'LAPORAN STOK');
    await s.runOnce({ paksa: true });
    assert.deepStrictEqual(terkirim, ['khusus@g.us'], 'hanya group yang dipilih, walau tidak aktif');
  });

  await test('nama group yang salah tulis memberi pesan galat yang jelas', async () => {
    const s = new StockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    s.setOpsi('groups', 'GROUP YANG TIDAK ADA');
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'failed');
    assert.ok(/tidak dikenal/.test(hasil.reason), hasil.reason);
  });

  await test('laporan stok yang dilewati juga mencatat alasannya', async () => {
    const s = new StockScheduler({
      db: dbPalsu({ stock_enabled: '0' }), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    await s.runOnce();
    assert.ok(s.lastSkip && /tombol MATI/.test(s.lastSkip.alasan));
    assert.ok(/Terakhir dilewati:/.test(s.ringkasanStatus()));
  });

  await test('/stokstatus memperingatkan bila jam kirim masih kosong', () => {
    const s = new StockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: stockConfigPalsu({ hours: [] }), client: clientStokPalsu(),
    });
    const teks = s.ringkasanStatus();
    assert.ok(/jam kirim belum disetel/.test(teks), teks);
    assert.ok(/stokjam/.test(teks));
  });

  await test('laporan stok tidak dikirim saat WhatsApp belum siap', async () => {
    const s = new StockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => false, sendText: async () => { throw new Error('tidak boleh dipanggil'); } },
      config: stockConfigPalsu(), client: clientStokPalsu(),
    });
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'failed');
    assert.ok(/WhatsApp belum tersambung/.test(hasil.reason));
  });

  await test('pengambilan stok & penjualan tetap hanya membaca (GET)', () => {
    const kode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ocs-client.js'), 'utf8');
    for (const fn of ['fetchLowStock', 'fetchOrderPerSku', 'fetchOrderPerSkuRange']) {
      assert.ok(kode.includes(fn), `${fn} harus ada`);
    }
    const potong = kode.slice(kode.indexOf('fetchLowStock'));
    assert.ok(!/_request\('(POST|PUT|DELETE|PATCH)'/.test(potong),
      'bagian stok tidak boleh menulis apa pun ke OCS');
  });

  /* --------------------- PERINGATAN LOCK STOCK --------------------- *
   * Murni offline: klien OCS palsu, WhatsApp perekam.
   * ---------------------------------------------------------------- */
  section('12. Peringatan Lock Stock (reserve melebihi stok tersedia)');

  const LR = require('../src/lock-report');
  const LockScheduler = require('../src/lock-scheduler');

  const STOK_LOCK = [
    { Sku: 'POWER-MINIPORE-SERUM', AreaId: 'Pusat', AvailableQty: 432, ReserveQty: 456, IsActive: true, IsUnderReserve: true },
    { Sku: 'BDL-NCO-00000000098', AreaId: 'Pusat', AvailableQty: 749, ReserveQty: 850, IsActive: true, IsUnderReserve: true },
    { Sku: 'BOUNCYBLUSH-ROSEATE-2', AreaId: 'Pusat', AvailableQty: 1444, ReserveQty: 1445, IsActive: true, IsUnderReserve: true },
    { Sku: 'FYNE-EXTRAIT-TOBACCO', AreaId: 'Pusat', AvailableQty: 5, ReserveQty: 9, IsActive: true, IsUnderReserve: true },
    { Sku: 'SKU-AMAN', AreaId: 'Pusat', AvailableQty: 100, ReserveQty: 1, IsActive: true, IsUnderReserve: false },
    { Sku: 'SKU-PAS', AreaId: 'Pusat', AvailableQty: 50, ReserveQty: 50, IsActive: true, IsUnderReserve: false },
  ];

  const RACK_CONTOH = [
    { SellerSku: 'POWER-MINIPORE-SERUM', AreaId: 'Pusat', ShopCode: 'Hanasui' },
    { SellerSku: 'BOUNCYBLUSH-ROSEATE-2', AreaId: 'Pusat', ShopCode: 'Hanasui' },
    { SellerSku: 'FYNE-EXTRAIT-TOBACCO', AreaId: 'Pusat', ShopCode: 'FYNE' },
    // SKU yang sama terdaftar di dua shop - barang sama, dua toko.
    { SellerSku: 'BALMTINT-SASSY-3', AreaId: 'Pusat', ShopCode: 'Hanasui' },
    { SellerSku: 'BALMTINT-SASSY-3', AreaId: 'Pusat', ShopCode: 'NCO' },
  ];

  function lockConfigPalsu(extra = {}) {
    return {
      ocs: { baseUrl: 'x', username: 'u', password: 'p', database: 'd',
        timeoutMs: 20000, tzOffsetMinutes: 420, tzLabel: 'WIB' },
      lock: {
        enabled: true, intervalMinutes: 60, jitterMinutes: 7, activeHours: null,
        groupIds: [], shops: ['NCO', 'Hanasui', 'FYNE', 'EOMMA'],
        hanyaAktif: true, kategori: '', area: '', rackCacheMinutes: 180,
        onlyOnChange: false, monospace: true, maxSku: 34, maxBaris: 40, ...extra,
      },
    };
  }

  function clientLockPalsu(catat = {}) {
    catat.rack = 0;
    return {
      fetchUnderReserve: async (f) => { catat.filter = f; return (catat.stok || STOK_LOCK); },
      fetchSkuRack: async () => { catat.rack += 1; return RACK_CONTOH; },
    };
  }

  /* -------------------------- deteksi ------------------------------- */

  await test('hanya SKU dengan reserve MELEBIHI tersedia yang diambil', () => {
    const hasil = LR.saringTerkunci(STOK_LOCK);
    const sku = hasil.map((s) => s.Sku);
    assert.strictEqual(hasil.length, 4);
    assert.ok(!sku.includes('SKU-AMAN'));
    assert.ok(!sku.includes('SKU-PAS'), 'reserve sama dengan tersedia belum ter-lock');
  });

  await test('angka dihitung ulang sendiri, tidak bergantung bendera IsUnderReserve', () => {
    // Bendera mengatakan aman, tetapi angkanya jelas ter-lock.
    const bohong = [{ Sku: 'X', AvailableQty: 1, ReserveQty: 99, IsUnderReserve: false }];
    assert.strictEqual(LR.saringTerkunci(bohong).length, 1);
  });

  /* ------------------------ pencarian shop -------------------------- */

  await test('shop diambil dari Master Sku Rack', () => {
    const peta = LR.petaShop(RACK_CONTOH);
    assert.deepStrictEqual(peta.get('POWER-MINIPORE-SERUM'), ['Hanasui']);
    assert.deepStrictEqual(peta.get('FYNE-EXTRAIT-TOBACCO'), ['FYNE']);
  });

  await test('SKU yang terdaftar di dua shop masuk ke daftar KEDUANYA', () => {
    const peta = LR.petaShop(RACK_CONTOH);
    assert.deepStrictEqual(peta.get('BALMTINT-SASSY-3').sort(), ['Hanasui', 'NCO']);
    const grup = LR.kelompokkanPerShop(
      [{ Sku: 'BALMTINT-SASSY-3', AreaId: 'Pusat', AvailableQty: 1, ReserveQty: 5 }], peta);
    assert.strictEqual(grup.get('NCO').length, 1);
    assert.strictEqual(grup.get('Hanasui').length, 1);
    assert.strictEqual(grup.get('NCO')[0].banyakShop, true, 'ditandai agar bisa dijelaskan di pesan');
  });

  await test('bundle yang belum ada di master ditebak dari kode SKU', () => {
    assert.strictEqual(LR.tebakShop('BDL-NCO-00000000098'), 'NCO');
    assert.strictEqual(LR.tebakShop('BDL-HANASUI-0000001580'), 'Hanasui');
    assert.strictEqual(LR.tebakShop('FYNE-EXTRAIT-FOUGEROYALE'), 'FYNE');
  });

  await test('tebakan hanya menerima potongan utuh, bukan sekadar mengandung huruf', () => {
    assert.strictEqual(LR.tebakShop('NCOBALM-SESUATU'), null, 'NCOBALM bukan NCO');
    assert.strictEqual(LR.tebakShop('SERUM-BIASA-01'), null);
  });

  await test('SKU yang tidak ketemu di mana pun tetap dilaporkan, tidak hilang diam-diam', () => {
    const grup = LR.kelompokkanPerShop(
      [{ Sku: 'ENTAH-APA-INI', AreaId: 'Pusat', AvailableQty: 0, ReserveQty: 3 }],
      LR.petaShop(RACK_CONTOH));
    assert.ok(grup.has(LR.TANPA_SHOP));
    assert.strictEqual(grup.get(LR.TANPA_SHOP)[0].sku, 'ENTAH-APA-INI');
  });

  await test('urutan dalam satu shop: selisih terbesar lebih dulu', () => {
    const grup = LR.kelompokkanPerShop(LR.saringTerkunci(STOK_LOCK), LR.petaShop(RACK_CONTOH));
    const hanasui = grup.get('Hanasui').map((b) => b.sku);
    assert.deepStrictEqual(hanasui, ['POWER-MINIPORE-SERUM', 'BOUNCYBLUSH-ROSEATE-2'],
      'selisih 24 di atas selisih 1');
  });

  await test('TANPA SHOP selalu di urutan paling akhir', () => {
    const grup = LR.kelompokkanPerShop([
      { Sku: 'ENTAH', AreaId: 'Pusat', AvailableQty: 0, ReserveQty: 9 },
      { Sku: 'POWER-MINIPORE-SERUM', AreaId: 'Pusat', AvailableQty: 0, ReserveQty: 1 },
    ], LR.petaShop(RACK_CONTOH));
    assert.strictEqual([...grup.keys()].pop(), LR.TANPA_SHOP);
  });

  /* --------------------------- tampilan ----------------------------- */

  await test('pesan mengikuti format yang diminta, lengkap dengan tabel lurus', () => {
    const grup = LR.kelompokkanPerShop(LR.saringTerkunci(STOK_LOCK), LR.petaShop(RACK_CONTOH));
    const hasil = LR.renderLockAlert(
      { shop: 'Hanasui', baris: grup.get('Hanasui'), pic: { nama: 'Ibu Sandra' } },
      { now: new Date('2026-08-31T12:49:30.000Z'), tzOffsetMinutes: 420 }
    );
    const t = hasil.text;
    assert.ok(t.startsWith('*Dear Ibu Sandra*'), t.slice(0, 40));
    assert.ok(t.includes('PERINGATAN LOCK STOCK'));
    assert.ok(t.includes('Ditemukan 2 SKU *_Shoop Hanasui_*'));
    assert.ok(t.includes('(Area: Pusat)'));
    assert.ok(t.includes('2026-08-31 19:49:30 WIB'), 'waktu lokal WIB, bukan UTC');
    assert.ok(t.includes('SKU'), 'ada kepala tabel');
    assert.ok(t.includes('Resv'));
    assert.ok(t.includes('Avail'));
    assert.ok(t.includes('*Mohon segera lepas Lock Stock sebelum terjadi Oversell.*'));
    assert.ok(t.includes('_Sent by BOT-WRH_'));
  });

  await test('kolom tabel lurus - lebarnya mengikuti isi terpanjang', () => {
    const teks = LR.tabelSku([
      { sku: 'PENDEK', resv: 1, avail: 0 },
      { sku: 'SKU-YANG-JAUH-LEBIH-PANJANG', resv: 123456, avail: 99 },
    ], { monospace: false });
    const baris = teks.split('\n');
    const lebar = baris.map((b) => b.length);
    assert.ok(lebar.every((l) => l === lebar[0]), `semua baris harus sama panjang: ${JSON.stringify(lebar)}`);
  });

  await test('tabel dibungkus monospace agar angkanya tidak bergeser di WhatsApp', () => {
    const teks = LR.tabelSku([{ sku: 'A', resv: 1, avail: 0 }], {});
    assert.ok(teks.startsWith('```'), 'harus diawali blok monospace');
    assert.ok(teks.endsWith('```'));
  });

  await test('SKU yang terlalu panjang dipotong agar tabel tetap terbaca', () => {
    const teks = LR.tabelSku([{ sku: 'X'.repeat(80), resv: 1, avail: 0 }], { monospace: false, maxSku: 20 });
    assert.ok(teks.includes('~'), 'potongan ditandai');
    assert.ok(!teks.includes('X'.repeat(21)));
  });

  await test('PIC dengan nomor menghasilkan mention WhatsApp sungguhan', () => {
    const hasil = LR.renderLockAlert(
      { shop: 'NCO', baris: [{ sku: 'A', area: 'Pusat', avail: 0, resv: 1 }],
        pic: { nama: 'Ibu Manda', nomor: '6281234567890' } },
      { now: new Date() }
    );
    assert.ok(hasil.text.includes('*Dear Ibu Manda @6281234567890*'),
      'teks harus memuat @nomor - WhatsApp tidak mengenali mention dari nama');
    assert.deepStrictEqual(hasil.mentions, ['6281234567890@c.us']);
  });

  await test('PIC tanpa nomor tetap disapa, hanya tanpa mention', () => {
    const hasil = LR.renderLockAlert(
      { shop: 'NCO', baris: [{ sku: 'A', area: 'Pusat', avail: 0, resv: 1 }], pic: { nama: 'Ibu Manda' } },
      { now: new Date() }
    );
    assert.ok(hasil.text.includes('*Dear Ibu Manda*'));
    assert.deepStrictEqual(hasil.mentions, []);
  });

  /* --------------------------- penjadwal ---------------------------- */

  await test('jeda acak tetap di sekitar jeda dasar dan tidak pernah tertebak', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    const contoh = [];
    for (let i = 0; i < 60; i += 1) contoh.push(s.jedaBerikutnya());
    const min = Math.min(...contoh);
    const max = Math.max(...contoh);
    assert.ok(min >= 53 * 60000, `jeda terpendek ${min / 60000} menit, harus >= 53`);
    assert.ok(max <= 68 * 60000, `jeda terpanjang ${max / 60000} menit, harus <= 68`);
    assert.ok(new Set(contoh).size > 30, 'nilainya harus benar-benar bervariasi, bukan pola tetap');
  });

  await test('jitter 0 tetap menggeser detiknya saja', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu({ jitterMinutes: 0 }), client: clientLockPalsu(),
    });
    const j = s.jedaBerikutnya();
    assert.ok(j >= 60 * 60000 && j < 61 * 60000, `${j / 60000} menit`);
  });

  await test('jeda tidak pernah lebih pendek dari satu menit', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu({ intervalMinutes: 5, jitterMinutes: 60 }), client: clientLockPalsu(),
    });
    for (let i = 0; i < 40; i += 1) assert.ok(s.jedaBerikutnya() >= 60000);
  });

  await test('satu putaran menghasilkan satu pesan PER SHOP', async () => {
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks, m) => { terkirim.push({ gid, teks, m }); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'sent');
    assert.strictEqual(terkirim.length, 3, 'NCO, Hanasui, FYNE');
    const shops = terkirim.map((t) => t.teks.match(/Shoop (\S+)_\*/)[1]);
    assert.deepStrictEqual(shops, ['NCO', 'Hanasui', 'FYNE'], 'urutan mengikuti daftar shop');
  });

  await test('PIC bawaan sesuai daftar yang diminta', async () => {
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks) => { terkirim.push(teks); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    await s.runOnce({ paksa: true });
    assert.ok(terkirim.some((t) => t.includes('Dear Ibu Manda') && t.includes('Shoop NCO')));
    assert.ok(terkirim.some((t) => t.includes('Dear Ibu Sandra') && t.includes('Shoop Hanasui')));
    assert.ok(terkirim.some((t) => t.includes('Dear Bpk. Reza') && t.includes('Shoop FYNE')));
  });

  await test('satu shop bisa punya BANYAK PIC, semuanya di-mention', async () => {
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks, m) => { terkirim.push({ teks, m }); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'Ibu Manda, Bpk. Andi');
    s.setPicNomor('NCO', '6281111111111, 6282222222222');
    await s.runOnce({ paksa: true });
    const nco = terkirim.find((t) => t.teks.includes('Shoop NCO'));
    assert.ok(nco.teks.includes('*Dear Ibu Manda @6281111111111 & Bpk. Andi @6282222222222*'),
      nco.teks.split('\n')[0]);
    assert.deepStrictEqual(nco.m, ['6281111111111@c.us', '6282222222222@c.us']);
  });

  await test('PIC tanpa nomor tetap ikut disapa bersama yang punya nomor', async () => {
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks, m) => { terkirim.push({ teks, m }); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'Ibu Manda, Bpk. Andi, Sdr. Rio');
    s.setPicNomor('NCO', '6281111111111, kosong, 6283333333333');
    await s.runOnce({ paksa: true });
    const nco = terkirim.find((t) => t.teks.includes('Shoop NCO'));
    assert.ok(nco.teks.includes('Ibu Manda @6281111111111, Bpk. Andi & Sdr. Rio @6283333333333'),
      nco.teks.split('\n')[0]);
    assert.deepStrictEqual(nco.m, ['6281111111111@c.us', '6283333333333@c.us'],
      'hanya yang punya nomor yang di-mention');
  });

  await test('mengganti nama PIC tidak mengacaukan nomor orang lain', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'Ibu Manda, Bpk. Andi');
    s.setPicNomor('NCO', '6281111111111, 6282222222222');
    s.setPicNama('NCO', 'Ibu Manda, Bpk. Budi');       // orang ke-2 diganti
    const daftar = s.picMap().NCO;
    assert.strictEqual(daftar[0].nomor, '6281111111111', 'nomor orang ke-1 tetap');
    assert.strictEqual(daftar[1].nama, 'Bpk. Budi');
    assert.strictEqual(daftar[1].nomor, '6282222222222', 'nomor mengikuti posisi');
  });

  await test('mengurangi daftar PIC membuang sisanya, dan dikatakan terus terang', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'A, B, C');
    const pesan = s.setPicNama('NCO', 'A');
    assert.strictEqual(s.picMap().NCO.length, 1);
    assert.ok(/2 PIC sebelumnya dihapus/.test(pesan), pesan);
  });

  await test('nomor lebih banyak daripada nama ditolak, bukan diam-diam dibuang', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'Ibu Manda');
    assert.throws(() => s.setPicNomor('NCO', '6281111111111, 6282222222222'),
      /hanya 1 nama PIC/);
  });

  await test('nomor yang salah tulis menyebut orang KE-BERAPA yang bermasalah', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('NCO', 'A, B');
    assert.throws(() => s.setPicNomor('NCO', '6281111111111, 081234567890'), /nomor ke-2/);
  });

  await test('pengaturan PIC lama (satu obyek) tetap terbaca setelah pembaruan', () => {
    const db = dbPalsu({ lock_pic: JSON.stringify({ NCO: { nama: 'Ibu Manda', nomor: '6281111111111' } }) });
    const s = new LockScheduler({
      db, whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    const daftar = s.picMap().NCO;
    assert.ok(Array.isArray(daftar), 'bentuk lama harus diubah menjadi array');
    assert.strictEqual(daftar.length, 1);
    assert.strictEqual(daftar[0].nama, 'Ibu Manda');
    assert.strictEqual(daftar[0].nomor, '6281111111111');
  });

  await test('nomor yang sama untuk dua PIC tidak di-mention dua kali', () => {
    const hasil = LR.sapaanPic([
      { nama: 'Ibu Manda', nomor: '628111' },
      { nama: 'Bpk. Andi', nomor: '628111' },
    ]);
    assert.deepStrictEqual(hasil.jids, ['628111@c.us']);
    assert.ok(hasil.teks.includes('Ibu Manda') && hasil.teks.includes('Bpk. Andi'));
  });

  await test('PIC bisa diganti dan nomornya dipakai sebagai mention', async () => {
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async (gid, teks, m) => { terkirim.push({ teks, m }); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    s.setPicNama('nco', 'Ibu Amanda');
    s.setPicNomor('NCO', '6281299998888');
    await s.runOnce({ paksa: true });
    const nco = terkirim.find((t) => t.teks.includes('Shoop NCO'));
    assert.ok(nco.teks.includes('Dear Ibu Amanda @6281299998888'));
    assert.deepStrictEqual(nco.m, ['6281299998888@c.us']);
  });

  await test('nomor PIC yang salah tulis ditolak dengan penjelasan', () => {
    const s = new LockScheduler({
      db: dbPalsu(), whatsapp: { isReady: () => true }, queue: new Queue({ delayMs: 0 }),
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    assert.throws(() => s.setPicNomor('NCO', '+6281234567890'), /tanda \+/);
    assert.throws(() => s.setPicNomor('NCO', '081234567890'), /0 di depan/);
    assert.throws(() => s.setPicNomor('SHOP-HANTU', '6281234567890'), /tidak dikenal/);
    assert.ok(/Semua nomor PIC NCO dihapus/.test(s.setPicNomor('NCO', 'hapus')));
  });

  await test('Master Sku Rack tidak ditarik ulang tiap putaran', async () => {
    const catat = {};
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu(), client: clientLockPalsu(catat),
    });
    await s.runOnce({ paksa: true });
    await s.runOnce({ paksa: true });
    await s.runOnce({ paksa: true });
    assert.strictEqual(catat.rack, 1, 'master hanya ditarik sekali selama cache masih hidup');
  });

  await test('tidak ada temuan -> tidak ada pesan sama sekali', async () => {
    const catat = { stok: [{ Sku: 'AMAN', AvailableQty: 10, ReserveQty: 0 }] };
    const terkirim = [];
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => { terkirim.push(1); } },
      config: lockConfigPalsu(), client: clientLockPalsu(catat),
    });
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'clear');
    assert.strictEqual(terkirim.length, 0);
  });

  await test('mode "hanya bila berubah" menahan pesan yang isinya sama persis', async () => {
    const db = dbPalsu();
    const terkirim = [];
    const s = new LockScheduler({
      db, queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => { terkirim.push(1); } },
      config: lockConfigPalsu({ onlyOnChange: true }), client: clientLockPalsu(),
    });
    await s.runOnce();
    const setelahPertama = terkirim.length;
    assert.ok(setelahPertama > 0);
    const kedua = await s.runOnce();
    assert.strictEqual(kedua.status, 'skipped');
    assert.strictEqual(terkirim.length, setelahPertama, 'tidak ada tambahan pesan');
  });

  await test('angka reserve yang berubah dianggap perubahan, walau SKU-nya sama', async () => {
    const db = dbPalsu();
    const catat = {};
    const terkirim = [];
    const s = new LockScheduler({
      db, queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => { terkirim.push(1); } },
      config: lockConfigPalsu({ onlyOnChange: true }), client: clientLockPalsu(catat),
    });
    catat.stok = [{ Sku: 'POWER-MINIPORE-SERUM', AreaId: 'Pusat', AvailableQty: 432, ReserveQty: 456 }];
    await s.runOnce();
    const sebelum = terkirim.length;
    catat.stok = [{ Sku: 'POWER-MINIPORE-SERUM', AreaId: 'Pusat', AvailableQty: 432, ReserveQty: 900 }];
    const kedua = await s.runOnce();
    assert.strictEqual(kedua.status, 'sent');
    assert.ok(terkirim.length > sebelum);
  });

  await test('tombol mati menghentikan penjadwal, /lock tetap jalan', async () => {
    const s = new LockScheduler({
      db: dbPalsu({ lock_enabled: '0' }), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    assert.strictEqual((await s.runOnce()).status, 'skipped');
    assert.strictEqual((await s.runOnce({ paksa: true })).status, 'sent');
  });

  /* --- kenapa jadwal diam padahal /lock berhasil --- */

  await test('putaran terjadwal yang dilewati SELALU tercatat alasannya', async () => {
    const s = new LockScheduler({
      db: dbPalsu({ lock_enabled: '0' }), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    assert.strictEqual(s.lastSkip, null);
    await s.runOnce();
    assert.ok(s.lastSkip, 'harus mencatat alasannya, bukan diam');
    assert.ok(/tombol MATI/.test(s.lastSkip.alasan), s.lastSkip.alasan);
    assert.ok(/lockon/.test(s.lastSkip.alasan), 'alasannya harus menyebut cara memperbaikinya');
  });

  await test('/lockstatus menjelaskan kenapa jadwal tidak mengirim apa pun', async () => {
    const s = new LockScheduler({
      db: dbPalsu({ lock_enabled: '0' }), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    await s.runOnce();
    const teks = s.ringkasanStatus();
    assert.ok(teks.includes('Lock stock: MATI'));
    assert.ok(/tombol sedang MATI/.test(teks), teks);
    assert.ok(/Terakhir dilewati:/.test(teks), 'sebutkan kapan & kenapa dilewati');
    assert.ok(/lockon/.test(teks));
  });

  await test('di luar jam aktif juga dicatat, bukan diam-diam', async () => {
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      // jam aktif 7-8 pagi saja; uji ini dijalankan di luar rentang itu
      config: lockConfigPalsu({ activeHours: { mulai: 7, sampai: 8 } }),
      client: clientLockPalsu(),
    });
    const palsuJam = new Date('2026-09-01T05:00:00.000Z');   // 12:00 WIB
    s.dalamJamAktif = () => s.constructor.prototype.dalamJamAktif.call(s, palsuJam);
    const hasil = await s.runOnce();
    assert.strictEqual(hasil.status, 'skipped');
    assert.ok(/jam aktif/.test(s.lastSkip.alasan), s.lastSkip.alasan);
  });

  await test('pemeriksaan PERTAMA datang beberapa menit setelah start, bukan satu jam', () => {
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu({ firstRunMinutes: 3 }), client: clientLockPalsu(),
    });
    const pertama = s.jedaPertama();
    assert.ok(pertama >= 3 * 60000 && pertama < 4 * 60000,
      `${pertama / 60000} menit - harus 3-4 menit, bukan sejeda penuh`);
    assert.ok(pertama < s.jedaBerikutnya(), 'putaran pertama jauh lebih cepat daripada jeda biasa');
  });

  await test('start() memasang jadwal dan mengumumkan keadaan tombolnya', () => {
    const s = new LockScheduler({
      db: dbPalsu({ lock_enabled: '0' }), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => true, sendText: async () => {} },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    assert.strictEqual(s.timer, null);
    s.start();
    assert.ok(s.timer, 'timer harus terpasang');
    assert.ok(s.nextRunAt > Date.now(), 'waktu pemeriksaan berikutnya harus terisi');
    assert.ok(s.ringkasanStatus().includes('Penjadwal: jalan'));
    s.stop();
    assert.strictEqual(s.timer, null);
  });

  await test('lock stock tidak dikirim saat WhatsApp belum siap', async () => {
    const s = new LockScheduler({
      db: dbPalsu(), queue: new Queue({ delayMs: 0 }),
      whatsapp: { isReady: () => false, sendText: async () => { throw new Error('tidak boleh dipanggil'); } },
      config: lockConfigPalsu(), client: clientLockPalsu(),
    });
    const hasil = await s.runOnce({ paksa: true });
    assert.strictEqual(hasil.status, 'failed');
    assert.ok(/WhatsApp belum tersambung/.test(hasil.reason));
  });

  await test('pengambilan lock stock tetap hanya membaca (GET)', () => {
    const kode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ocs-client.js'), 'utf8');
    const potong = kode.slice(kode.indexOf('fetchUnderReserve'));
    assert.ok(!/_request\('(POST|PUT|DELETE|PATCH)'/.test(potong),
      'bagian lock stock tidak boleh menulis apa pun ke OCS');
  });

  /* ------------------------------ hasil --------------------------- */
  console.log('\n==========================================');
  console.log(`  HASIL: ${pass} lulus, ${fail} gagal`);
  console.log('==========================================\n');
  if (fail > 0) {
    for (const f of failures) console.log(`- ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('Uji gagal dijalankan:', err);
  process.exit(1);
});
