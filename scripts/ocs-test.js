'use strict';

/**
 * Uji koneksi ke IEG OCS TANPA mengirim apa pun ke WhatsApp.
 *
 *   npm run ocs:test           - login, ambil data, cetak pesan laporan
 *   npm run ocs:test -- --raw  - cetak juga JSON mentah tiap bagian
 *
 * Jalankan ini lebih dulu setiap kali mengubah filter di .env.
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const OcsClient = require(path.join(__dirname, '..', 'src', 'ocs-client'));
const { renderReport, todayRange } = require(path.join(__dirname, '..', 'src', 'ocs-report'));

const RAW = process.argv.includes('--raw');

function garis(judul) {
  console.log('\n' + '='.repeat(60));
  if (judul) console.log('  ' + judul);
  console.log('='.repeat(60));
}

async function main() {
  const o = config.ocs;

  garis('UJI KONEKSI IEG OCS');
  console.log('Base URL   :', o.baseUrl);
  console.log('Database   :', o.database);
  console.log('Username   :', o.username || '(kosong)');
  console.log('Password   :', o.password ? '*'.repeat(Math.min(8, o.password.length)) : '(kosong)');
  console.log('Zona waktu :', `UTC+${o.tzOffsetMinutes / 60} (${o.tzLabel})`);
  console.log('Filter     :', JSON.stringify({
    dateType: o.dateType, shop: o.shop, channel: o.channel,
    area: o.area, shift: o.shift, role: o.role,
  }));

  if (!o.username || !o.password || !o.database) {
    console.error('\nOCS_USERNAME / OCS_PASSWORD / OCS_DATABASE belum lengkap di file .env.');
    process.exit(1);
  }

  const client = new OcsClient({
    baseUrl: o.baseUrl,
    username: o.username,
    password: o.password,
    database: o.database,
    timeoutMs: o.timeoutMs,
  });

  garis('1. LOGIN');
  const mulaiLogin = Date.now();
  await client.login();
  console.log(`Berhasil dalam ${Date.now() - mulaiLogin} ms.`);
  if (client.tokenExp) {
    console.log('Token berlaku sampai:', new Date(client.tokenExp * 1000).toISOString());
  }

  garis('2. AMBIL DATA DASHBOARD');
  const rentang = todayRange(new Date(), o.tzOffsetMinutes);
  console.log('from :', rentang.from);
  console.log('to   :', rentang.to);

  const mulaiAmbil = Date.now();
  const data = await client.fetchFulfilment({
    from: rentang.from,
    to: rentang.to,
    dateType: o.dateType,
    shop: o.shop,
    channel: o.channel,
    area: o.area,
    shift: o.shift,
    role: o.role,
  });
  console.log(`Selesai dalam ${Date.now() - mulaiAmbil} ms.`);

  for (const nama of ['summary', 'statusBuckets', 'funnel', 'aging', 'throughput', 'leaderboard', 'cycle']) {
    const v = data[nama];
    const info = v === null || v === undefined
      ? 'GAGAL / kosong'
      : Array.isArray(v) ? `${v.length} baris` : 'obyek';
    console.log(`  - ${nama.padEnd(14)}: ${info}`);
  }
  if (data.errors.length > 0) {
    console.log('\nBagian yang gagal:');
    for (const e of data.errors) console.log('  !', e);
  }

  if (RAW) {
    garis('JSON MENTAH');
    console.log(JSON.stringify(data, null, 2));
  }

  garis('3. PESAN YANG AKAN DIKIRIM KE WHATSAPP');
  const teks = renderReport(data, {
    now: new Date(),
    tzOffsetMinutes: o.tzOffsetMinutes,
    tzLabel: o.tzLabel,
    topOperators: o.topOperators,
    judul: o.judul,
  });
  console.log('');
  console.log(teks);
  console.log('');
  console.log(`(${teks.length} karakter - batas WhatsApp sekitar 4096)`);

  await client.logout();
  garis('SELESAI - tidak ada pesan WhatsApp yang dikirim');
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  console.error('\nPeriksa: kredensial di .env, koneksi internet mesin ini, dan apakah');
  console.error('ocs.iegsystem.id dapat dibuka dari browser di komputer yang sama.');
  process.exit(1);
});
