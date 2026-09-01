'use strict';

/**
 * Uji laporan "Stok Menipis" TANPA mengirim apa pun ke WhatsApp.
 *
 *   npm run stock:test                 - ambil data lalu cetak pesannya
 *   npm run stock:test -- --banding    - bandingkan keempat mode rata-rata
 *   npm run stock:test -- --sku ACNE-PACKAGE   - bedah satu SKU hari per hari
 *
 * Jalankan ini dulu setiap kali mengubah ambang, jendela hari, atau mode.
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const OcsClient = require(path.join(__dirname, '..', 'src', 'ocs-client'));
const R = require(path.join(__dirname, '..', 'src', 'stock-report'));

const argv = process.argv.slice(2);
const BANDING = argv.includes('--banding');
const iSku = argv.indexOf('--sku');
const SKU = iSku >= 0 ? argv[iSku + 1] : null;

function garis(judul) {
  console.log('\n' + '='.repeat(64));
  if (judul) console.log('  ' + judul);
  console.log('='.repeat(64));
}

async function main() {
  const o = config.stock;
  const c = config.ocs;
  const off = c.tzOffsetMinutes;

  garis('UJI LAPORAN STOK MENIPIS');
  console.log('Ambang      : stok <', o.ambang);
  console.log('Kategori    :', o.kategori, '| hanya aktif:', o.hanyaAktif, '| area:', o.area || '(semua)');
  console.log('Jendela     :', o.salesDays, 'hari, dipecah per', o.chunkDays, 'hari');
  console.log('Mode        :', o.avgMode, `(P${o.persentil})`);
  console.log('Jam kirim   :', o.hours.map((j) => String(j).padStart(2, '0') + ':00').join(', ') || '(belum disetel)');

  if (!c.username || !c.password || !c.database) {
    console.error('\nOCS_USERNAME / OCS_PASSWORD / OCS_DATABASE belum lengkap di .env.');
    process.exit(1);
  }

  const client = new OcsClient({
    baseUrl: c.baseUrl, username: c.username, password: c.password,
    database: c.database, timeoutMs: Math.max(60000, c.timeoutMs),
  });

  garis('1. LOGIN');
  const t0 = Date.now();
  await client.login();
  console.log(`Berhasil dalam ${Date.now() - t0} ms.`);

  garis('2. DAFTAR STOK (Stocks > View V2)');
  const t1 = Date.now();
  const stokMentah = await client.fetchLowStock({
    ambang: o.ambang, kategori: o.kategori, hanyaAktif: o.hanyaAktif, area: o.area,
  });
  const stok = R.saringStok(stokMentah, o);
  console.log(`${stokMentah.length} baris dari OCS, ${stok.length} lolos saringan (${Date.now() - t1} ms).`);
  if (stok.length > 0) {
    console.log('Contoh:', JSON.stringify(stok[0]));
  }

  garis('3. PENJUALAN PER SKU (Report > Order > Sku)');
  const rentang = R.rentangPenjualan(new Date(), off, o.salesDays);
  const hariList = R.daftarHari(rentang.from, rentang.to, off);
  console.log('from  :', rentang.from);
  console.log('to    :', rentang.to);
  console.log('hari  :', hariList.length, `(${hariList[0]} s/d ${hariList[hariList.length - 1]})`);

  const t2 = Date.now();
  const hasil = await client.fetchOrderPerSkuRange({
    from: rentang.from, to: rentang.to, chunkDays: o.chunkDays,
    platform: o.platform, shop: o.shop, area: o.area || 'All',
  });
  const penjualan = R.deretHarian(hasil.baris, off);
  console.log(`${hasil.baris.length} baris, ${penjualan.size} SKU (${Math.round((Date.now() - t2) / 1000)} detik).`);
  if (hasil.errors.length > 0) {
    console.log('\nBagian yang gagal:');
    for (const e of hasil.errors) console.log('  !', e);
  }

  const hariAda = new Set();
  for (const m of penjualan.values()) for (const k of m.keys()) hariAda.add(k);
  console.log(`Hari yang benar-benar ada datanya: ${hariAda.size} dari ${hariList.length}.`);
  const kosong = hariList.filter((h) => !hariAda.has(h));
  if (kosong.length > 0 && kosong.length <= 15) {
    console.log('Hari tanpa penjualan sama sekali:', kosong.join(', '));
  }

  const puncak = hariList.filter((h) => R.hariPuncak(h, o));
  console.log(`Hari puncak dalam jendela (payday >=${o.paydayMulai} & double date): ${puncak.length}`);

  /* ---------------------- bedah satu SKU ---------------------- */
  if (SKU) {
    garis(`4. BEDAH SKU: ${SKU}`);
    const per = penjualan.get(SKU);
    if (!per) {
      console.log('SKU ini tidak punya penjualan sama sekali di jendela tersebut.');
    } else {
      const nilai = hariList.map((h) => per.get(h) || 0);
      console.log('Penjualan harian:');
      hariList.forEach((h, i) => {
        if (nilai[i] === 0) return;
        console.log(`  ${h}${R.hariPuncak(h, o) ? ' *' : '  '} ${String(nilai[i]).padStart(7)}`);
      });
      console.log('  (* = hari puncak)');
      for (const m of ['winsor', 'full', 'normal', 'median']) {
        const h = R.hitungRataHarian(per, hariList, { mode: m, persentil: o.persentil, paydayMulai: o.paydayMulai });
        console.log(`  ${m.padEnd(7)}: ${h.rata.toFixed(2)}/hari` +
          (h.batas !== null ? `  (batas P${o.persentil} = ${h.batas.toFixed(1)})` : ''));
      }
    }
  }

  /* --------------------- banding antar mode -------------------- */
  if (BANDING) {
    garis('5. PERBANDINGAN MODE RATA-RATA');
    const mode = ['winsor', 'full', 'normal', 'median'];
    const baris = mode.map((m) => ({
      m, b: R.susunBaris(stok, penjualan, hariList, { mode: m, persentil: o.persentil, paydayMulai: o.paydayMulai }),
    }));
    console.log('SKU'.padEnd(34) + 'Stok'.padStart(8) + mode.map((m) => m.padStart(10)).join(''));
    const utama = baris[0].b.filter((x) => x.rata > 0).slice(0, 15);
    for (const u of utama) {
      const nilai = baris.map((x) => {
        const f = x.b.find((y) => y.sku === u.sku);
        return (f ? f.rata : 0).toFixed(1).padStart(10);
      }).join('');
      console.log(u.sku.slice(0, 33).padEnd(34) + String(u.qty).padStart(8) + nilai);
    }
    console.log('\nBaca: "full" jauh di atas "winsor" berarti SKU itu punya lonjakan ekstrem.');
    console.log('"normal" jauh di bawah "winsor" berarti penjualannya memang bertumpu di payday.');
  }

  /* ------------------------ pesan jadi ------------------------- */
  garis('6. PESAN YANG AKAN DIKIRIM KE WHATSAPP');
  const barisAkhir = R.susunBaris(stok, penjualan, hariList, {
    mode: o.avgMode, persentil: o.persentil, paydayMulai: o.paydayMulai,
  });
  const teks = R.renderStockReport(
    { baris: barisAkhir, rentang, errors: hasil.errors },
    {
      now: new Date(), tzOffsetMinutes: off, tzLabel: c.tzLabel,
      top: o.top, ambang: o.ambang, kategori: o.kategori,
      mode: o.avgMode, persentil: o.persentil, detail: o.detail, judul: o.judul,
    }
  );
  console.log('');
  console.log(teks);
  console.log('');
  console.log(`(${teks.length} karakter - batas WhatsApp sekitar 4096)`);

  await client.logout();
  garis('SELESAI - tidak ada pesan WhatsApp yang dikirim');
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  console.error('\nPeriksa: kredensial di .env, koneksi ke ocs.iegsystem.id dari mesin ini,');
  console.error('dan apakah rentang harinya terlalu panjang (OCS menjawab 504 bila sekali tarik terlalu besar -');
  console.error('turunkan STOCK_CHUNK_DAYS, misalnya menjadi 15).');
  process.exit(1);
});
