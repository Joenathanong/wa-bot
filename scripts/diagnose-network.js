'use strict';

/**
 * Diagnosa jaringan ke Telegram.
 *
 *   npm run tg:diag
 *
 * Menjawab pertanyaan: "Error TIMEOUT itu salah aplikasi atau salah jaringan?"
 * Semua pemeriksaan hanya membaca/menyambung; tidak ada yang dikirim.
 */

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const config = require('../src/config');

const DC = [
  { name: 'DC1  (Miami)', host: '149.154.175.50' },
  { name: 'DC2  (Amsterdam)', host: '149.154.167.51' },
  { name: 'DC4  (Amsterdam)', host: '149.154.167.91' },
  { name: 'DC5  (Singapura)', host: '91.108.56.130' },
];

const ok = (t) => `  OK    ${t}`;
const bad = (t) => `  GAGAL ${t}`;

function tcpTest(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { /* abaikan */ }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - t0 }));
    socket.once('timeout', () => finish({ ok: false, error: `tidak menjawab dalam ${timeoutMs} ms` }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

function tlsTest(host, port = 443, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const ms = Date.now() - t0;
      try { socket.end(); } catch (e) { /* abaikan */ }
      finish({ ok: true, ms });
    });
    socket.once('timeout', () => { try { socket.destroy(); } catch (e) {} finish({ ok: false, error: `tidak menjawab dalam ${timeoutMs} ms` }); });
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
  });
}

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  DIAGNOSA JARINGAN KE TELEGRAM');
  console.log('==========================================================');
  console.log('');

  const catatan = [];

  /* 1. DNS */
  console.log('1. DNS');
  for (const host of ['api.telegram.org', 'telegram.org']) {
    try {
      const t0 = Date.now();
      const addr = await dns.lookup(host);
      console.log(ok(`${host} -> ${addr.address} (${Date.now() - t0} ms)`));
    } catch (err) {
      console.log(bad(`${host} -> ${err.code || err.message}`));
      catatan.push('DNS gagal. PC tidak punya internet, atau DNS kantor memblokir Telegram.');
    }
  }

  /* 2. Bot API (HTTPS 443) */
  console.log('');
  console.log('2. Bot API (HTTPS port 443)');
  const api = await tlsTest('api.telegram.org', 443);
  console.log(api.ok ? ok(`api.telegram.org:443 (${api.ms} ms)`) : bad(`api.telegram.org:443 -> ${api.error}`));
  if (!api.ok) catatan.push('Bot Telegram tidak akan bisa jalan: port 443 ke api.telegram.org tertutup.');

  /* 3. MTProto port 80 vs 443 */
  console.log('');
  console.log('3. Server MTProto (dipakai mode akun)');
  let ok80 = 0;
  let ok443 = 0;
  for (const dc of DC) {
    const [p80, p443] = await Promise.all([tcpTest(dc.host, 80), tcpTest(dc.host, 443)]);
    if (p80.ok) ok80 += 1;
    if (p443.ok) ok443 += 1;
    const f80 = p80.ok ? `80 OK ${String(p80.ms).padStart(4)} ms` : `80 GAGAL (${p80.error})`;
    const f443 = p443.ok ? `443 OK ${String(p443.ms).padStart(4)} ms` : `443 GAGAL (${p443.error})`;
    console.log(`  ${dc.name.padEnd(18)} ${f80.padEnd(28)} ${f443}`);
  }

  console.log('');
  console.log('==========================================================');
  console.log('  KESIMPULAN');
  console.log('==========================================================');
  console.log('');

  const pakaiWSS = config.telegramUser.useWSS !== false;
  console.log(`  Setelan saat ini : TELEGRAM_USE_WSS=${pakaiWSS ? 'true (port 443)' : 'false (port 80)'}`);
  console.log(`  Port 80  tembus : ${ok80}/${DC.length} server`);
  console.log(`  Port 443 tembus : ${ok443}/${DC.length} server`);
  console.log('');

  if (ok443 === 0 && ok80 === 0) {
    console.log('  Semua jalur ke Telegram tertutup. Ini masalah jaringan/firewall,');
    console.log('  bukan aplikasi. Hubungi tim IT dan minta izinkan 149.154.160.0/20');
    console.log('  dan 91.108.4.0/22 pada port 443.');
  } else if (ok443 > ok80) {
    console.log('  Port 443 jauh lebih andal daripada port 80 di jaringan ini.');
    console.log(pakaiWSS
      ? '  Setelan Anda sudah benar (TELEGRAM_USE_WSS=true). Pertahankan.'
      : '  SARAN: setel TELEGRAM_USE_WSS=true di .env lalu restart aplikasi.');
  } else if (ok80 > 0 && ok443 === 0) {
    console.log('  Hanya port 80 yang tembus. Setel TELEGRAM_USE_WSS=false di .env.');
  } else {
    console.log('  Kedua port tembus. Bila TIMEOUT masih sering muncul, kemungkinan');
    console.log('  jaringan padat/tidak stabil, bukan diblokir. Aplikasi akan');
    console.log('  menyambung ulang sendiri dan menyusulkan pesan yang terlewat.');
  }

  if (catatan.length > 0) {
    console.log('');
    for (const c of catatan) console.log('  ! ' + c);
  }
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('Diagnosa gagal:', err.message);
  process.exit(1);
});
