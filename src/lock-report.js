'use strict';

/**
 * Peringatan LOCK STOCK.
 *
 * Mendeteksi SKU yang stok ter-reserve-nya MELEBIHI stok tersedia
 * (ReserveQty > AvailableQty) - keadaan yang berujung oversell bila
 * tidak segera dilepas.
 *
 * Modul ini murni hitungan dan penyusunan teks; tidak menyentuh jaringan
 * maupun database, sehingga seluruh aturannya bisa diuji offline.
 *
 * ===================== PENCARIAN SHOP =====================
 * Data stok (View V2) tidak memuat Shop, jadi Shop dicari bertingkat.
 *
 *   1. Master Sku Rack (/MasterData/GetSkuRack -> SellerSku + ShopCode).
 *      Satu SKU BOLEH terdaftar di lebih dari satu shop (barang sama
 *      dijual dua toko, bin & SAP code identik). SKU seperti itu masuk ke
 *      daftar KEDUA shop, karena keduanya sama-sama bisa kena oversell.
 *
 *   2. Untuk BUNDLE: lewat komponennya. Bundle adalah barang virtual dan
 *      tidak punya rak, jadi tidak pernah ada di Sku Rack. Master Bundle
 *      (/MasterData/GetBundle) memberi daftar SellerSku penyusunnya, dan
 *      SellerSku itulah yang dicari di Sku Rack.
 *
 *      Diperiksa ke data sungguhan (1.807 bundle): cara ini memetakan
 *      100% bundle, dan TIDAK PERNAH bertentangan dengan nama shop di
 *      kode bundle-nya (0 perbedaan). 210 bundle komponennya menunjuk
 *      lebih dari satu shop - 209 di antaranya hanya karena komponennya
 *      terdaftar di dua shop, bukan bundle campuran. Untuk kasus itu,
 *      bila kode bundle menyebut salah satu shop tersebut, shop itulah
 *      yang dipakai; sisanya (1 bundle yang memang campuran) dikirim ke
 *      semua shop yang terlibat.
 *
 *   3. Tebakan dari nama SKU, untuk yang tidak tertutup dua cara di atas.
 *      Hanya potongan UTUH antar tanda hubung yang diterima.
 *
 *   4. Kalau tetap tidak ketemu: masuk keranjang "TANPA SHOP" supaya
 *      tidak pernah ada SKU yang hilang diam-diam.
 * ==========================================================
 */

const { joinNatural } = require('./render');

const SHOP_BAWAAN = ['NCO', 'Hanasui', 'FYNE', 'EOMMA'];
const TANPA_SHOP = 'TANPA SHOP';

/**
 * Kategori yang MEMANG tidak pernah ada di Master Sku Rack.
 *
 * Bundle adalah barang virtual - gabungan beberapa SKU fisik - sehingga
 * tidak punya rak dan tidak pernah didaftarkan di Sku Rack. Dicek ke OCS:
 * nol dari 677 baris master berawalan "BDL-". Jadi shop bundle SELALU
 * datang dari kodenya, dan itu keadaan normal, bukan data yang kurang.
 * Menegur soal ini di tiap pesan hanya jadi kebisingan.
 */
const KATEGORI_TANPA_RACK = ['bundle'];

const PIC_BAWAAN = {
  NCO: 'Ibu Manda',
  Hanasui: 'Ibu Sandra',
  FYNE: 'Bpk. Reza',
  EOMMA: 'Bpk. Maulana',
};

/* -------------------------------- PIC ---------------------------------- */

/**
 * Satu shop boleh punya lebih dari satu PIC.
 *
 * Menerima tiga bentuk sekaligus supaya pengaturan lama tetap terbaca:
 *   - array  : [{nama, nomor}, ...]           (bentuk sekarang)
 *   - obyek  : {nama, nomor}                  (bentuk lama, satu PIC)
 *   - teks   : "Ibu Manda"                    (jaga-jaga)
 * Selalu mengembalikan array, dan PIC tanpa nama dibuang.
 */
function normalisasiPic(nilai) {
  if (!nilai) return [];
  const daftar = Array.isArray(nilai) ? nilai : [nilai];
  return daftar
    .map((p) => (typeof p === 'string' ? { nama: p, nomor: '' } : p))
    .filter((p) => p && String(p.nama || '').trim())
    .map((p) => ({
      nama: String(p.nama).trim(),
      nomor: String(p.nomor || '').replace(/\D/g, ''),
    }));
}

/**
 * Susun sapaan "Ibu Manda @628111 & Bpk. Andi @628222" beserta daftar JID.
 * Nomor yang sama tidak pernah di-mention dua kali.
 */
function sapaanPic(nilai) {
  const daftar = normalisasiPic(nilai);
  const bagian = [];
  const jids = [];
  const sudah = new Set();
  for (const p of daftar) {
    if (p.nomor) {
      bagian.push(`${p.nama} @${p.nomor}`);
      const jid = `${p.nomor}@c.us`;
      if (!sudah.has(jid)) { sudah.add(jid); jids.push(jid); }
    } else {
      bagian.push(p.nama);
    }
  }
  return { teks: joinNatural(bagian), jids, jumlah: daftar.length };
}

/* ---------------------------- pencarian shop --------------------------- */

/** Master Sku Rack -> Map<SellerSku, string[]> (bisa lebih dari satu shop). */
function petaShop(rack) {
  const peta = new Map();
  for (const r of rack || []) {
    const sku = r && (r.SellerSku || r.Sku || r.sku);
    const shop = r && (r.ShopCode || r.Shop || r.shop);
    if (!sku || !shop) continue;
    if (!peta.has(sku)) peta.set(sku, []);
    const daftar = peta.get(sku);
    if (!daftar.includes(shop)) daftar.push(shop);
  }
  return peta;
}

/**
 * Tebak shop dari nama SKU, dipakai bila master tidak memuatnya.
 * Hanya menerima potongan UTUH antar tanda hubung, sehingga
 * "BDL-NCO-000123" cocok NCO, tetapi "NCOBALM" tidak.
 */
function tebakShop(sku, daftarShop = SHOP_BAWAAN) {
  const bagian = String(sku || '').split(/[-_\s]+/).map((s) => s.toLowerCase());
  for (const shop of daftarShop) {
    if (bagian.includes(String(shop).toLowerCase())) return shop;
  }
  return null;
}

/** Master Bundle -> Map<BundleSku, SellerSku[]> komponennya. */
function petaBundle(bundle) {
  const peta = new Map();
  for (const b of bundle || []) {
    const sku = b && (b.BundleSku || b.bundleSku);
    if (!sku) continue;
    const item = (b.Items || b.items || [])
      .map((i) => i && (i.SellerSku || i.sellerSku))
      .filter(Boolean);
    if (item.length > 0) peta.set(sku, item);
  }
  return peta;
}

/**
 * Tentukan shop satu SKU beserta ASAL keterangannya.
 * @returns {{shops: string[], asal: 'master'|'bundle'|'kode'|null}}
 */
function cariShop(sku, opsi = {}) {
  const rack = opsi.petaRack || new Map();
  const bundle = opsi.petaBundle || new Map();
  const daftarShop = opsi.daftarShop || SHOP_BAWAAN;

  const langsung = rack.get(sku);
  if (langsung && langsung.length > 0) return { shops: langsung.slice(), asal: 'master' };

  const komponen = bundle.get(sku);
  if (komponen && komponen.length > 0) {
    const kumpul = [];
    for (const k of komponen) {
      for (const shop of rack.get(k) || []) if (!kumpul.includes(shop)) kumpul.push(shop);
    }
    if (kumpul.length === 1) return { shops: kumpul, asal: 'bundle' };
    if (kumpul.length > 1) {
      // Komponennya menunjuk beberapa shop. Hampir selalu karena satu
      // komponen terdaftar di dua shop, bukan karena bundle-nya campuran -
      // jadi bila kode bundle menyebut salah satunya, itu yang dipakai.
      const dariKode = tebakShop(sku, daftarShop);
      if (dariKode && kumpul.includes(dariKode)) return { shops: [dariKode], asal: 'bundle' };
      return { shops: kumpul, asal: 'bundle' };
    }
  }

  const tebakan = tebakShop(sku, daftarShop);
  if (tebakan) return { shops: [tebakan], asal: 'kode' };
  return { shops: [], asal: null };
}

/** Baris stok yang benar-benar ter-lock: reserve melebihi tersedia. */
function saringTerkunci(stok) {
  return (stok || []).filter((s) => {
    if (!s || !s.Sku) return false;
    const avail = Number(s.AvailableQty) || 0;
    const resv = Number(s.ReserveQty) || 0;
    return resv > avail;
  });
}

/**
 * Kelompokkan baris terkunci menjadi Map<shop, baris[]>.
 * Urutan shop mengikuti daftarShop, "TANPA SHOP" selalu paling akhir.
 */
function kelompokkanPerShop(baris, peta, daftarShop = SHOP_BAWAAN, opsi = {}) {
  const grup = new Map();
  const tambah = (shop, row) => {
    if (!grup.has(shop)) grup.set(shop, []);
    grup.get(shop).push(row);
  };

  for (const s of baris) {
    const row = {
      sku: s.Sku,
      nama: s.Name || '',
      area: s.AreaId || '',
      avail: Number(s.AvailableQty) || 0,
      resv: Number(s.ReserveQty) || 0,
    };
    row.selisih = row.resv - row.avail;

    row.kategori = s.Category || '';
    row.tanpaRack = KATEGORI_TANPA_RACK.includes(String(row.kategori).toLowerCase());

    const { shops, asal } = cariShop(s.Sku, {
      petaRack: peta, petaBundle: opsi.petaBundle, daftarShop,
    });
    row.asal = asal;
    row.ditebak = asal === 'kode';
    row.dariBundle = asal === 'bundle';

    if (shops.length === 0) { tambah(TANPA_SHOP, { ...row }); continue; }
    row.banyakShop = shops.length > 1;
    for (const shop of shops) tambah(shop, { ...row });
  }

  // Selisih terbesar lebih dulu - itu yang paling berisiko oversell.
  for (const daftar of grup.values()) {
    daftar.sort((a, b) => b.selisih - a.selisih || a.sku.localeCompare(b.sku));
  }

  const urut = [];
  for (const shop of daftarShop) if (grup.has(shop)) urut.push([shop, grup.get(shop)]);
  for (const [shop, daftar] of grup) {
    if (!daftarShop.includes(shop) && shop !== TANPA_SHOP) urut.push([shop, daftar]);
  }
  if (grup.has(TANPA_SHOP)) urut.push([TANPA_SHOP, grup.get(TANPA_SHOP)]);
  return new Map(urut);
}

/* ------------------------------ tampilan ------------------------------- */

function pad(n) { return String(n).padStart(2, '0'); }

/** "2026-08-31 19:49:30" menurut waktu lokal. */
function waktuLokal(date, offsetMinutes) {
  const l = new Date(new Date(date).getTime() + offsetMinutes * 60000);
  return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())} `
    + `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`;
}

function angka(n) { return String(Math.round(Number(n) || 0)); }

/**
 * Tabel SKU / Resv / Avail dengan lebar kolom mengikuti isinya.
 * Dibungkus blok monospace supaya kolomnya benar-benar lurus di WhatsApp -
 * tanpa itu, font proporsional membuat angkanya bergeser-geser.
 */
function tabelSku(baris, opsi = {}) {
  const monospace = opsi.monospace !== false;
  const maxSku = Math.max(0, Number(opsi.maxSku) || 34);

  const potong = (s) => (s.length > maxSku ? `${s.slice(0, maxSku - 1)}~` : s);
  const isi = baris.map((b) => ({
    sku: potong(String(b.sku)),
    resv: angka(b.resv),
    avail: angka(b.avail),
  }));

  const lSku = Math.max(3, ...isi.map((r) => r.sku.length));
  const lResv = Math.max(4, ...isi.map((r) => r.resv.length));
  const lAvail = Math.max(5, ...isi.map((r) => r.avail.length));

  const garis = [];
  garis.push(`${'SKU'.padEnd(lSku)}  ${'Resv'.padStart(lResv)}  ${'Avail'.padStart(lAvail)}`);
  for (const r of isi) {
    garis.push(`${r.sku.padEnd(lSku)}  ${r.resv.padStart(lResv)}  ${r.avail.padStart(lAvail)}`);
  }
  const teks = garis.join('\n');
  return monospace ? '```\n' + teks + '\n```' : teks;
}

const TEMPLATE_BAWAAN = [
  '*Dear {pic}*',
  '',
  '⚠️ PERINGATAN LOCK STOCK',
  'Ditemukan {count} SKU *_Shoop {shop}_* dengan stok tersedia di bawah stok ter-reserve (Area: {area}).',
  '🕒 {datetime} {tz}',
  '{table}',
  '',
  '*Mohon segera lepas Lock Stock sebelum terjadi Oversell.*',
  '',
  'Terima kasih.',
  '',
  '_Sent by BOT-WRH_',
].join('\n');

/**
 * Susun satu pesan untuk satu shop.
 *
 * PIC disapa dengan nama DAN di-mention sungguhan. WhatsApp hanya
 * mengenali mention bila teks memuat "@<nomor>" dan JID-nya ikut dikirim,
 * jadi {pic} menjadi "Ibu Manda @6281234567890".
 *
 * Satu shop boleh punya beberapa PIC: "Ibu Manda @628111 & Bpk. Andi @628222".
 * PIC yang belum ada nomornya tetap ikut disapa, hanya tanpa mention.
 *
 * @param {{shop: string, baris: Array,
 *          pic?: Array<{nama: string, nomor?: string}>|{nama: string, nomor?: string}}} data
 * @returns {{text: string, mentions: string[], shop: string, jumlah: number}}
 */
function renderLockAlert(data, opsi = {}) {
  const off = Number.isFinite(opsi.tzOffsetMinutes) ? opsi.tzOffsetMinutes : 420;
  const tz = opsi.tzLabel || 'WIB';
  const now = opsi.now || new Date();
  const baris = data.baris || [];

  const { teks: sapaanTeks, jids: mentions } = sapaanPic(data.pic);
  const sapaan = sapaanTeks || 'Tim';

  const area = Array.from(new Set(baris.map((b) => b.area).filter(Boolean)));
  const template = opsi.template || TEMPLATE_BAWAAN;

  let teks = String(template)
    .split('{pic}').join(sapaan)
    .split('{count}').join(String(baris.length))
    .split('{shop}').join(data.shop)
    .split('{area}').join(area.length > 0 ? area.join(', ') : '-')
    .split('{datetime}').join(waktuLokal(now, off))
    .split('{tz}').join(tz)
    .split('{table}').join(tabelSku(baris, opsi));

  // Keterangan tambahan hanya muncul bila memang relevan.
  const catatan = [];
  if (baris.some((b) => b.banyakShop)) {
    catatan.push('_Sebagian SKU terdaftar di lebih dari satu shop, jadi ikut dikirim ke PIC shop lain._');
  }
  // Hanya tegur bila ada SKU BIASA yang belum terdaftar - itu memang celah
  // data yang perlu ditutup. Bundle sengaja tidak disebut: bundle tidak
  // punya rak, jadi selamanya tidak akan ada di Master Sku Rack dan
  // peringatan itu akan muncul di hampir setiap pesan tanpa guna.
  if (baris.some((b) => b.ditebak && !b.tanpaRack)) {
    catatan.push('_Sebagian SKU belum terdaftar di Master Sku Rack - shopnya disimpulkan_'
      + '\n_dari kode SKU. Daftarkan di /master/sku-rack agar pasti benar._');
  }
  if (data.shop === TANPA_SHOP) {
    catatan.push('_SKU ini tidak ditemukan di Master Sku Rack maupun Master Bundle,_'
      + '\n_dan kode shopnya tidak terbaca. Mohon dicek manual._');
  }
  if (catatan.length > 0) teks += `\n\n${catatan.join('\n')}`;

  return { text: teks, mentions, shop: data.shop, jumlah: baris.length };
}

/** Ringkasan singkat untuk log dan untuk balasan di Telegram. */
function ringkasan(grup) {
  const bagian = [];
  for (const [shop, baris] of grup) bagian.push(`${shop}: ${baris.length}`);
  return bagian.length > 0 ? bagian.join(' | ') : 'tidak ada';
}

module.exports = {
  SHOP_BAWAAN,
  TANPA_SHOP,
  KATEGORI_TANPA_RACK,
  PIC_BAWAAN,
  TEMPLATE_BAWAAN,
  normalisasiPic,
  sapaanPic,
  petaShop,
  petaBundle,
  cariShop,
  tebakShop,
  saringTerkunci,
  kelompokkanPerShop,
  tabelSku,
  renderLockAlert,
  waktuLokal,
  ringkasan,
};
