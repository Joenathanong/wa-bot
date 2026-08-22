'use strict';

/**
 * Tampilkan daftar grup/channel akun Telegram Anda beserta Chat ID-nya,
 * untuk diisikan ke TELEGRAM_ALLOWED_CHAT_IDS.
 *
 *   npm run tg:chats
 *
 * Hanya membaca daftar dialog. Tidak mengirim apa pun.
 */

const config = require('../src/config');
const TelegramUserSource = require('../src/telegram-user');

async function main() {
  const src = new TelegramUserSource({ config, pipeline: { handle: async () => {} } });
  const ok = await src.start();
  if (!ok) {
    console.error('Tidak dapat terhubung. Jalankan dulu: npm run tg:login');
    process.exit(1);
  }

  const chats = await src.listChats(200);
  const groups = chats.filter((c) => c.isGroup || c.isChannel);

  console.log('');
  console.log('=== GRUP & CHANNEL ===');
  if (groups.length === 0) {
    console.log('(tidak ada)');
  } else {
    for (const c of groups) {
      const jenis = c.isChannel && !c.isGroup ? 'Channel' : 'Grup   ';
      console.log(String(c.rawId).padStart(16) + '  [' + jenis + ']  ' + c.title);
    }
  }

  console.log('');
  console.log('Salin ID grup sumber peringatan stok ke file .env:');
  console.log('  TELEGRAM_ALLOWED_CHAT_IDS=<id di atas>');
  console.log('');
  console.log('Lalu jalankan aplikasi: npm start');
  console.log('');

  await src.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
