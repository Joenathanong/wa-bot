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
const { renderReport, todayRange, monthToDateRange, hitungHariKalender } = require(path.join(__dirname, '..', 'src', 'ocs-report'));

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

  /* --- peringkat operator: rentang bulan berjalan --- */
  if (String(o.leaderboard.period).toLowerCase() === 'month') {
    garis('3. PERINGKAT OPERATOR (BULAN BERJALAN)');
    const rb = monthToDateRange(new Date(), o.tzOffsetMinutes);
    console.log('from :', rb.from);
    console.log('to   :', rb.to);
    data.bulan = await client.fetchOperatorRange({
      from: rb.from, to: rb.to,
      shop: o.shop, channel: o.channel, area: o.area, shift: o.shift,
    });

    const semua = Array.isArray(data.bulan.leaderboard) ? data.bulan.leaderboard : [];
    const peranAda = [...new Set(semua.map((x) => x.Role))];
    console.log('Baris leaderboard :', semua.length);
    console.log('Peran yang ADA    :', peranAda.join(', ') || '(kosong)');
    console.log('Peran yang DIMINTA:', o.leaderboard.roles.join(', ') || '(semua)');
    const tidakCocok = o.leaderboard.roles.filter(
      (r) => !peranAda.some((a) => String(a).toLowerCase() === r.toLowerCase()));
    if (tidakCocok.length > 0) {
      console.log('  ! Peran berikut tidak ditemukan di data:', tidakCocok.join(', '));
      console.log('    Perbaiki OCS_LEADERBOARD_ROLES di .env sesuai daftar "Peran yang ADA".');
    }
    console.log('Dikecualikan      :', o.leaderboard.exclude.join(', ') || '(tidak ada)');
    for (const e of data.bulan.errors) console.log('  !', e);

    /* ---- DIAGNOSA PEMBAGI: apakah Throughput mencakup seluruh bulan? ---- */
    const tp = Array.isArray(data.bulan.throughput) ? data.bulan.throughput : [];
    const hariSemua = [...new Set(tp.map((x) => String(x.Day || '').slice(0, 10)))].sort();
    console.log('');
    console.log('  -- pembagi rata-rata --');
    console.log('  Baris throughput   :', tp.length);
    console.log('  Rentang tanggalnya :', hariSemua.length ? `${hariSemua[0]} s/d ${hariSemua[hariSemua.length - 1]}` : '(kosong)');
    console.log('  Hari berbeda       :', hariSemua.length);
    console.log('  Hari kalender 1-hari ini :', hitungHariKalender(new Date(), o.tzOffsetMinutes, o.leaderboard.offDays));

    for (const peran of o.leaderboard.roles) {
      const sama = (a) => String(a || '').toLowerCase() === peran.toLowerCase();
      const hariPeran = [...new Set(tp.filter((x) => sama(x.Role) && Number(x.CompletedCount) > 0)
        .map((x) => String(x.Day || '').slice(0, 10)))];
      const totalTp = tp.filter((x) => sama(x.Role))
        .reduce((n, x) => n + (Number(x.CompletedCount) || 0), 0);
      const totalLb = semua.filter((x) => sama(x.Role))
        .reduce((n, x) => n + (Number(x.CompletedCount) || 0), 0);
      const selisih = totalLb > 0 ? Math.round((totalTp / totalLb) * 100) : 0;
      console.log(`  [${peran}] hari operasi ${hariPeran.length} | total throughput ${totalTp.toLocaleString('id-ID')}`
        + ` | total leaderboard ${totalLb.toLocaleString('id-ID')} (${selisih}%)`);
    }
    console.log('');
    console.log('  Bila persentase di atas jauh di bawah 100%, artinya Throughput hanya');
    console.log('  mengembalikan sebagian hari sedangkan Leaderboard mencakup sebulan penuh.');
    console.log('  Dalam kasus itu setel OCS_LEADERBOARD_DAYS=calendar (atau angka tetap)');
    console.log('  di .env supaya rata-rata harian tidak menggelembung.');
  }

  if (RAW) {
    garis('JSON MENTAH');
    console.log(JSON.stringify(data, null, 2));
  }

  garis('4. PESAN YANG AKAN DIKIRIM KE WHATSAPP');
  const teks = renderReport(data, {
    now: new Date(),
    tzOffsetMinutes: o.tzOffsetMinutes,
    tzLabel: o.tzLabel,
    topOperators: o.topOperators,
    judul: o.judul,
    leaderboardRoles: o.leaderboard.roles,
    leaderboardExclude: o.leaderboard.exclude,
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
