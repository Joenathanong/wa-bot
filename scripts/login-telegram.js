'use strict';

/**
 * Login SEKALI ke akun Telegram Anda dan simpan sesinya.
 *
 *   npm run tg:login
 *
 * Sesi disimpan ke data/telegram-user.session (tidak pernah masuk Git).
 * Setelah ini aplikasi tidak akan pernah meminta kode lagi.
 *
 * Skrip ini HANYA login dan membaca identitas Anda. Tidak mengirim pesan,
 * tidak bergabung ke grup, tidak mengubah apa pun pada akun Anda.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../src/config');

/** Tanya satu baris. hidden=true menyamarkan ketikan dengan tanda bintang. */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      let shown = false;
      rl._writeToOutput = function (chunk) {
        if (!shown) { rl.output.write(question); shown = true; return; }
        if (chunk && chunk.indexOf(question) === 0) return;
        rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(String(answer).trim());
    });
  });
}

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  LOGIN AKUN TELEGRAM (mode baca saja)');
  console.log('==========================================================');
  console.log('');

  if (!config.telegramUser.apiId || !config.telegramUser.apiHash) {
    console.error('TELEGRAM_API_ID / TELEGRAM_API_HASH belum diisi di file .env');
    console.error('');
    console.error('Cara mendapatkannya:');
    console.error('  1. Buka https://my.telegram.org  (login dengan nomor Telegram Anda)');
    console.error('  2. Pilih "API development tools"');
    console.error('  3. Isi App title & Short name bebas, misal: IEG Stock Bridge / iegbridge');
    console.error('  4. Salin api_id dan api_hash ke file .env');
    process.exit(1);
  }

  let TelegramClient;
  let StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch (err) {
    console.error('Library GramJS belum terpasang. Jalankan dulu: npm install');
    process.exit(1);
  }

  const sessionFile = config.telegramUser.sessionFile;
  let existing = '';
  try { existing = fs.readFileSync(sessionFile, 'utf8').trim(); } catch (e) { /* belum ada */ }
  if (existing) {
    const again = await ask('Sesi lama sudah ada. Login ulang dan menimpanya? (y/N): ');
    if (again.toLowerCase() !== 'y') { console.log('Dibatalkan.'); process.exit(0); }
  }

  const client = new TelegramClient(new StringSession(''), config.telegramUser.apiId, config.telegramUser.apiHash, {
    connectionRetries: 5,
  });
  try { client.setLogLevel('error'); } catch (e) { /* versi lama */ }

  console.log('Masukkan nomor dengan kode negara, contoh: +6281234567890');
  console.log('');

  await client.start({
    phoneNumber: async () => ask('Nomor telepon: '),
    phoneCode: async () => ask('Kode yang dikirim Telegram: '),
    password: async () => ask('Password 2FA (kosongkan bila tidak dipakai): ', true),
    onError: (err) => console.error('  ! ' + err.message),
  });

  const me = await client.getMe();
  const session = client.session.save();

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, session, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('OK - Login berhasil sebagai ' + (me.username ? '@' + me.username : me.firstName));
  console.log('     Sesi disimpan di: ' + sessionFile);
  console.log('');
  console.log('     PERINGATAN: file itu setara akses penuh ke akun Telegram Anda.');
  console.log('     Jangan pernah di-commit, di-zip, atau dikirim ke siapa pun.');
  console.log('');
  console.log('Langkah berikutnya:  npm run tg:chats   (cari Chat ID grup sumber)');
  console.log('');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error('Login gagal:', err.message);
  process.exit(1);
});
