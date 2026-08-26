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
    assert.strictEqual(st.caughtUp, 2, 'satu saat start + satu yang tadi tertunda');
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
      listActiveWaGroups: () => [{ id: 1, group_id: '123@g.us', name: 'DAILY E-COMMERCE' }],
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
