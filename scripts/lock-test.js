'use strict';

/**
 * Uji peringatan LOCK STOCK TANPA mengirim apa pun ke WhatsApp.
 *
 *   npm run lock:test            - periksa & cetak pesan tiap shop
 *   npm run lock:test -- --rack  - cetak juga ringkasan Master Sku Rack
 *   npm run lock:test -- --jeda  - contoh 20 jeda acak berikutnya
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const OcsClient = require(path.join(__dirname, '..', 'src', 'ocs-client'));
const L = require(path.join(__dirname, '..', 'src', 'lock-report'));
const LockScheduler = require(path.join(__dirname, '..', 'src', 'lock-scheduler'));

const argv = process.argv.slice(2);
const RACK = argv.includes('--rack');
const JEDA = argv.includes('--jeda');

function garis(judul) {
  console.log('\n' + '='.repeat(64));
  if (judul) console.log('  ' + judul);
  console.log('='.repeat(64));
}

async function main() {
  const o = config.lock;
  const c = config.ocs;

  garis('UJI PERINGATAN LOCK STOCK');
  console.log('Shop dikenal :', o.shops.join(', '));
  console.log('Jeda         :', o.intervalMinutes, 'menit, acak +/-', o.jitterMinutes, 'menit');
  console.log('Saringan     : hanya aktif =', o.hanyaAktif,
    '| kategori =', o.kategori || '(semua)', '| area =', o.area || '(semua)');

  if (JEDA) {
    garis('CONTOH JEDA ACAK');
    const s = new LockScheduler({
      db: { getSetting: (k, d) => d, setSetting: () => {} },
      whatsapp: { isReady: () => true }, queue: null, config,
      client: { fetchUnderReserve: async () => [], fetchSkuRack: async () => [] },
    });
    const contoh = [];
    for (let i = 0; i < 20; i += 1) contoh.push((s.jedaBerikutnya() / 60000).toFixed(2));
    console.log('menit:', contoh.join(', '));
    console.log('\nTerlihat acak - tidak pernah jatuh di detik yang sama tiap jam.');
  }

  if (!c.username || !c.password || !c.database) {
    console.error('\nOCS_USERNAME / OCS_PASSWORD / OCS_DATABASE belum lengkap di .env.');
    process.exit(1);
  }

  const client = new OcsClient({
    baseUrl: c.baseUrl, username: c.username, password: c.password,
    database: c.database, timeoutMs: c.timeoutMs,
  });

  garis('1. LOGIN');
  const t0 = Date.now();
  await client.login();
  console.log(`Berhasil dalam ${Date.now() - t0} ms.`);

  garis('2. SKU YANG TER-LOCK (View V2)');
  const stok = await client.fetchUnderReserve({
    hanyaAktif: o.hanyaAktif, kategori: o.kategori, area: o.area,
  });
  const terkunci = L.saringTerkunci(stok);
  console.log(`OCS mengembalikan ${stok.length} baris; ${terkunci.length} benar-benar ter-lock.`);
  for (const s of terkunci) {
    console.log(`  ${String(s.Sku).padEnd(44)} resv ${String(s.ReserveQty).padStart(7)}`
      + `  avail ${String(s.AvailableQty).padStart(7)}  [${s.Category || '-'}]`);
  }
  if (terkunci.length === 0) {
    console.log('\nAman - tidak ada yang perlu diperingatkan saat ini.');
  }

  garis('3. MASTER SKU RACK (pencarian shop)');
  const rack = await client.fetchSkuRack();
  const peta = L.petaShop(rack);
  const perShop = {};
  for (const r of rack) perShop[r.ShopCode] = (perShop[r.ShopCode] || 0) + 1;
  console.log(`${rack.length} baris, ${peta.size} SellerSku unik.`);
  console.log('Baris per shop:', JSON.stringify(perShop));
  const ganda = [...peta.entries()].filter(([, v]) => v.length > 1);
  console.log(`SKU yang terdaftar di lebih dari satu shop: ${ganda.length}`);
  if (RACK && ganda.length > 0) {
    for (const [sku, shops] of ganda) console.log(`  ${sku.padEnd(44)} ${shops.join(' + ')}`);
  }

  garis('4. PENCARIAN SHOP UNTUK TIAP SKU TER-LOCK');
  for (const s of terkunci) {
    const dariMaster = peta.get(s.Sku);
    const tebakan = dariMaster ? null : L.tebakShop(s.Sku, o.shops);
    const asal = dariMaster ? 'master' : (tebakan ? 'tebakan dari kode SKU' : 'TIDAK KETEMU');
    const shop = dariMaster ? dariMaster.join(' + ') : (tebakan || L.TANPA_SHOP);
    console.log(`  ${String(s.Sku).padEnd(44)} -> ${String(shop).padEnd(18)} (${asal})`);
  }

  garis('5. PESAN YANG AKAN DIKIRIM KE WHATSAPP');
  const grup = L.kelompokkanPerShop(terkunci, peta, o.shops);
  console.log('Ringkasan:', L.ringkasan(grup), '\n');

  // PIC dibaca apa adanya dari bawaan - nomor sungguhan hanya ada di
  // database, dan skrip ini sengaja tidak menyentuh database yang sedang
  // dipakai Windows Service.
  for (const [shop, baris] of grup) {
    const hasil = L.renderLockAlert(
      { shop, baris, pic: { nama: L.PIC_BAWAAN[shop] || 'Tim' } },
      { now: new Date(), tzOffsetMinutes: c.tzOffsetMinutes, tzLabel: c.tzLabel,
        monospace: o.monospace, maxSku: o.maxSku }
    );
    console.log('-'.repeat(64));
    console.log(hasil.text);
    console.log('');
  }
  if (grup.size > 0) {
    console.log('-'.repeat(64));
    console.log('\nCatatan: nama PIC di atas adalah bawaan. Nama & nomor yang');
    console.log('sesungguhnya tersimpan di database lewat /lockpic dan /lockwa,');
    console.log('dan mention hanya muncul bila nomornya sudah diisi.');
  }

  await client.logout();
  garis('SELESAI - tidak ada pesan WhatsApp yang dikirim');
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  console.error('\nPeriksa kredensial di .env dan apakah ocs.iegsystem.id bisa dibuka');
  console.error('dari browser di komputer yang sama.');
  process.exit(1);
});
