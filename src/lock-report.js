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
 * Data stok (View V2) tidak memuat Shop, jadi Shop dicari dari master
 * Sku Rack (/MasterData/GetSkuRack -> SellerSku + ShopCode).
 *
 * Tiga lapis, berurutan:
 *   1. Master Sku Rack. Satu SKU BOLEH terdaftar di lebih dari satu shop
 *      (barang sama dijual dua toko, bin & SAP code identik). SKU seperti
 *      itu masuk ke daftar KEDUA shop, karena keduanya sama-sama bisa
 *      kena oversell.
 *   2. Tebakan dari nama SKU. Bundle seperti "BDL-HANASUI-0000001580"
 *      tidak ada di master, tetapi nama shopnya jelas tertulis.
 *   3. Kalau tetap tidak ketemu: masuk keranjang "TANPA SHOP" supaya
 *      tidak pernah ada SKU yang hilang diam-diam.
 * ==========================================================
 */

const { joinNatural } = require('./render');

const SHOP_BAWAAN = ['NCO', 'Hanasui', 'FYNE', 'EOMMA'];
const TANPA_SHOP = 'TANPA SHOP';

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
function kelompokkanPerShop(baris, peta, daftarShop = SHOP_BAWAAN) {
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

    const dariMaster = peta.get(s.Sku);
    if (dariMaster && dariMaster.length > 0) {
      row.banyakShop = dariMaster.length > 1;
      for (const shop of dariMaster) tambah(shop, { ...row });
      continue;
    }
    const tebakan = tebakShop(s.Sku, daftarShop);
    if (tebakan) {
      tambah(tebakan, { ...row, ditebak: true });
      continue;
    }
    tambah(TANPA_SHOP, { ...row });
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
  if (baris.some((b) => b.ditebak)) {
    catatan.push('_Shop sebagian SKU disimpulkan dari kode SKU karena belum terdaftar di Master Sku Rack._');
  }
  if (data.shop === TANPA_SHOP) {
    catatan.push('_SKU ini belum terdaftar di Master Sku Rack dan kode shopnya tidak terbaca._');
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
  PIC_BAWAAN,
  TEMPLATE_BAWAAN,
  normalisasiPic,
  sapaanPic,
  petaShop,
  tebakShop,
  saringTerkunci,
  kelompokkanPerShop,
  tabelSku,
  renderLockAlert,
  waktuLokal,
  ringkasan,
};
