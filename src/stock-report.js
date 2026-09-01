'use strict';

/**
 * Perhitungan dan penyusunan pesan "Stok Menipis".
 *
 * Modul ini MURNI hitungan - tidak menyentuh jaringan maupun database,
 * sehingga seluruh aturannya bisa diuji tanpa menghubungi OCS.
 *
 * ============================ AVG DAILY SALES ============================
 * Angka ini menjawab satu pertanyaan: "stok segini cukup untuk berapa hari?"
 *
 * Karena itu SEMUA hari ikut dihitung, termasuk payday (tanggal 25-31) dan
 * double date (1.1, 2.2, ... 12.12). Membuang hari-hari itu berarti membuang
 * seperempat bulan yang justru paling ramai - rata-ratanya jadi terlalu
 * rendah dan peringatan datang terlambat, padahal stok tetap habis di
 * tanggal 27.
 *
 * Yang dijinakkan bukan HARINYA, melainkan LONJAKANNYA (winsorize):
 *
 *   1. Susun penjualan harian sepanjang jendela (hari tanpa penjualan = 0).
 *   2. Hitung persentil ke-95 dari HARI YANG ADA PENJUALANNYA saja.
 *      (Nol tidak ikut. Kalau nol ikut, SKU yang lakunya jarang tapi banyak
 *      akan dapat batas mendekati nol dan rata-ratanya ambruk.)
 *   3. Hari yang melebihi batas itu DIHITUNG SEBESAR BATAS, bukan dibuang.
 *   4. Rata-rata = total (setelah dibatasi) / jumlah hari dalam jendela.
 *
 * Hasilnya tidak bias ke bawah seperti "kecualikan payday", dan tidak bisa
 * diangkat 2-3x oleh satu 12.12 seperti rata-rata polos. Bonus: lonjakan
 * yang tidak ada di daftar tanggal mana pun - flash sale dadakan, live
 * TikTok, campaign - ikut tertangani.
 *
 * Mode lain tersedia untuk pembanding: 'full' (tanpa batas sama sekali),
 * 'normal' (buang double date + payday), dan 'median'.
 * =======================================================================
 */

const { sapaanPic } = require('./lock-report');

const HARI_MS = 24 * 3600 * 1000;

/* ------------------------------ tanggal -------------------------------- */

/** Geser ke waktu lokal, lalu baca komponennya lewat getUTC*. */
function keLokal(date, offsetMinutes) {
  return new Date(new Date(date).getTime() + offsetMinutes * 60000);
}

/** Tengah malam waktu lokal, dikembalikan sebagai Date UTC sungguhan. */
function awalHariLokal(date, offsetMinutes) {
  const l = keLokal(date, offsetMinutes);
  const t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  return new Date(t - offsetMinutes * 60000);
}

/** "2026-08-26" menurut waktu lokal. */
function kunciHari(date, offsetMinutes) {
  const l = keLokal(date, offsetMinutes);
  return `${l.getUTCFullYear()}-${dua(l.getUTCMonth() + 1)}-${dua(l.getUTCDate())}`;
}

function dua(n) { return String(n).padStart(2, '0'); }

/**
 * Jendela penjualan: `hari` hari PENUH terakhir, berakhir kemarin.
 * Hari ini sengaja tidak ikut karena masih berjalan - memasukkannya akan
 * menarik rata-rata ke bawah setiap pagi.
 */
function rentangPenjualan(now, offsetMinutes, hari) {
  const n = Math.max(1, Math.round(Number(hari) || 90));
  const akhir = awalHariLokal(now, offsetMinutes);         // 00:00 hari ini
  const awal = new Date(akhir.getTime() - n * HARI_MS);
  return { from: awal.toISOString(), to: akhir.toISOString(), hari: n };
}

/**
 * Gabungan daftar hari dari BEBERAPA rentang, tanpa duplikat.
 * Dipakai supaya pembagi rata-rata hanya memuat hari yang datanya
 * benar-benar berhasil ditarik.
 */
function daftarHariGabungan(rentang, offsetMinutes) {
  const set = new Set();
  for (const r of rentang || []) {
    for (const h of daftarHari(r.from, r.to, offsetMinutes)) set.add(h);
  }
  return [...set].sort();
}

/** Daftar kunci hari "YYYY-MM-DD" di dalam jendela. */
function daftarHari(from, to, offsetMinutes) {
  const hasil = [];
  let t = new Date(from).getTime();
  const batas = new Date(to).getTime();
  while (t < batas) {
    hasil.push(kunciHari(new Date(t + 12 * 3600 * 1000), offsetMinutes));
    t += HARI_MS;
  }
  return hasil;
}

/** 1.1, 2.2, 3.3 ... 12.12 */
function tanggalKembar(kunci) {
  const [, b, t] = String(kunci).split('-').map((v) => parseInt(v, 10));
  return b === t;
}

/** Payday: tanggal 25 sampai akhir bulan. */
function hariGajian(kunci, mulai = 25) {
  const t = parseInt(String(kunci).split('-')[2], 10);
  return t >= mulai;
}

function hariPuncak(kunci, opsi = {}) {
  const pakaiKembar = opsi.doubleDate !== false;
  const pakaiGajian = opsi.payday !== false;
  return (pakaiKembar && tanggalKembar(kunci)) || (pakaiGajian && hariGajian(kunci, opsi.paydayMulai || 25));
}

/* ------------------------------ statistik ------------------------------ */

/** Persentil dengan interpolasi linier. Data harus sudah urut menaik. */
function persentil(urut, p) {
  if (!urut || urut.length === 0) return 0;
  if (urut.length === 1) return urut[0];
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (urut.length - 1);
  const bawah = Math.floor(pos);
  const atas = Math.ceil(pos);
  if (bawah === atas) return urut[bawah];
  return urut[bawah] + (urut[atas] - urut[bawah]) * (pos - bawah);
}

function median(nilai) {
  const urut = nilai.slice().sort((a, b) => a - b);
  return persentil(urut, 50);
}

/**
 * Hitung rata-rata harian satu SKU.
 *
 * @param {Map<string,number>|Object} perHari  kunci "YYYY-MM-DD" -> qty
 * @param {string[]} hariList  seluruh hari dalam jendela
 * @param {{mode?: string, persentil?: number, payday?: boolean,
 *          doubleDate?: boolean, paydayMulai?: number}} opsi
 * @returns {{rata: number, normal: number, puncak: number, total: number,
 *            hariJual: number, batas: number|null}}
 */
function hitungRataHarian(perHari, hariList, opsi = {}) {
  const ambil = (k) => {
    const v = perHari instanceof Map ? perHari.get(k) : perHari[k];
    return Number(v) || 0;
  };
  const mode = String(opsi.mode || 'winsor').toLowerCase();
  const p = Number.isFinite(opsi.persentil) ? opsi.persentil : 95;

  const nilai = hariList.map(ambil);
  const total = nilai.reduce((a, b) => a + b, 0);
  const hariJual = nilai.filter((v) => v > 0).length;

  // Angka pembanding yang selalu ikut ditampilkan.
  const hariNormal = hariList.filter((k) => !hariPuncak(k, opsi));
  const hariRamai = hariList.filter((k) => hariPuncak(k, opsi));
  const normal = hariNormal.length > 0
    ? hariNormal.reduce((a, k) => a + ambil(k), 0) / hariNormal.length : 0;
  const puncak = hariRamai.length > 0
    ? hariRamai.reduce((a, k) => a + ambil(k), 0) / hariRamai.length : 0;

  const dasar = { normal, puncak, total, hariJual, batas: null };

  if (hariList.length === 0) return { ...dasar, rata: 0 };

  if (mode === 'full') {
    return { ...dasar, rata: total / hariList.length };
  }
  if (mode === 'normal') {
    return { ...dasar, rata: normal };
  }
  if (mode === 'median') {
    return { ...dasar, rata: median(nilai) };
  }

  // winsor (bawaan): batasi hari ekstrem, JANGAN buang harinya.
  const jual = nilai.filter((v) => v > 0).sort((a, b) => a - b);
  if (jual.length === 0) return { ...dasar, rata: 0 };
  const batas = persentil(jual, p);
  const dibatasi = nilai.reduce((a, v) => a + Math.min(v, batas), 0);
  return { ...dasar, rata: dibatasi / hariList.length, batas };
}

/* --------------------------- penyusun data ----------------------------- */

/**
 * Ubah baris mentah /Report/OrderPerSkuReport menjadi
 * Map<sku, Map<hari, qty>>. Baris SKU yang sama pada hari yang sama
 * (misalnya dari beberapa Area) dijumlahkan.
 */
function deretHarian(baris, offsetMinutes) {
  const hasil = new Map();
  for (const r of baris || []) {
    const sku = r && (r.SellerSku || r.Sku || r.sku);
    if (!sku) continue;
    const tanggal = r.Date || r.date;
    if (!tanggal) continue;
    // Date dari OCS sudah waktu lokal tanpa zona ("2026-08-26T00:00:00"),
    // jadi cukup ambil 10 karakter pertama.
    const kunci = /^\d{4}-\d{2}-\d{2}/.test(String(tanggal))
      ? String(tanggal).slice(0, 10)
      : kunciHari(tanggal, offsetMinutes);
    const qty = Number(r.Qty || r.qty) || 0;
    if (!hasil.has(sku)) hasil.set(sku, new Map());
    const m = hasil.get(sku);
    m.set(kunci, (m.get(kunci) || 0) + qty);
  }
  return hasil;
}

/** Saring daftar stok sesuai kriteria. Dipakai sebagai jaring pengaman
 *  kedua - penyaringan utama sudah dilakukan di sisi OCS lewat OData. */
function saringStok(stok, opsi = {}) {
  const ambang = Number.isFinite(opsi.ambang) ? opsi.ambang : 1000;
  const kategori = String(opsi.kategori || 'Sku').toLowerCase();
  const hanyaAktif = opsi.hanyaAktif !== false;
  const area = String(opsi.area || '').trim().toLowerCase();

  return (stok || []).filter((s) => {
    if (!s || !s.Sku) return false;
    if (hanyaAktif && s.IsActive !== true) return false;
    if (kategori && String(s.Category || '').toLowerCase() !== kategori) return false;
    if (area && String(s.AreaId || '').toLowerCase() !== area) return false;
    // ambang 0 (atau kosong) berarti TANPA batas jumlah - saringan
    // sesungguhnya dikerjakan oleh DOI, bukan oleh angka stok.
    if (!ambang) return true;
    return Number(s.AvailableQty) < ambang;
  });
}

/**
 * Saring berdasarkan DOI (Days of Inventory) = stok / rata-rata harian.
 *
 * Ini kriteria yang menjawab pertanyaan sebenarnya - "kapan habis" -
 * dan bukan sekadar "stoknya sedikit". SKU yang laku 500/hari dengan
 * stok 2.000 akan habis 4 hari lagi; ambang jumlah tidak pernah bisa
 * menangkapnya, DOI bisa.
 *
 * SKU tanpa penjualan (hariCukup null) TIDAK ikut: stoknya memang
 * rendah, tetapi tidak ada yang membelinya sehingga tidak akan habis.
 *
 * @param {Array} baris hasil susunBaris
 * @param {{doiMax?: number, minAvg?: number}} opsi
 */
function saringDoi(baris, opsi = {}) {
  const doiMax = Number(opsi.doiMax) || 0;
  const minAvg = Number(opsi.minAvg) || 0;
  return (baris || []).filter((b) => {
    if (minAvg > 0 && b.rata < minAvg) return false;
    if (doiMax <= 0) return true;
    if (b.hariCukup === null) return false;
    return b.hariCukup < doiMax;
  });
}

/**
 * Gabungkan stok + penjualan menjadi baris laporan yang sudah terurut.
 * Urutan: paling mendesak dulu (sisa hari paling sedikit). SKU tanpa
 * penjualan sama sekali ditaruh paling belakang - stoknya rendah, tetapi
 * memang tidak ada yang membelinya.
 */
function susunBaris(stok, penjualan, hariList, opsi = {}) {
  const baris = (stok || []).map((s) => {
    const per = penjualan.get(s.Sku) || new Map();
    const h = hitungRataHarian(per, hariList, opsi);
    const qty = Number(s.AvailableQty) || 0;
    return {
      sku: s.Sku,
      nama: s.Name || '',
      area: s.AreaId || '',
      qty,
      rata: h.rata,
      normal: h.normal,
      puncak: h.puncak,
      total: h.total,
      hariJual: h.hariJual,
      hariCukup: h.rata > 0 ? qty / h.rata : null,
    };
  });

  baris.sort((a, b) => {
    if (a.hariCukup === null && b.hariCukup === null) return a.qty - b.qty;
    if (a.hariCukup === null) return 1;
    if (b.hariCukup === null) return -1;
    return a.hariCukup - b.hariCukup;
  });
  return baris;
}

/* ------------------------------ tampilan ------------------------------- */

const NAMA_HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const NAMA_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function tanggalLokal(date, off) {
  const l = keLokal(date, off);
  return `${NAMA_HARI[l.getUTCDay()]}, ${l.getUTCDate()} ${NAMA_BULAN[l.getUTCMonth()]} ${l.getUTCFullYear()}`;
}

function jamLokal(date, off, label) {
  const l = keLokal(date, off);
  return `${dua(l.getUTCHours())}:${dua(l.getUTCMinutes())} ${label || ''}`.trim();
}

function angka(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 10) return v.toFixed(1).replace('.', ',');
  return Math.round(v).toLocaleString('id-ID');
}

function hari(n) {
  if (n === null || !Number.isFinite(n)) return '-';
  if (n < 10) return `${n.toFixed(1).replace('.', ',')} hari`;
  return `${Math.round(n)} hari`;
}

/** Angka tanpa nol di belakang koma: 2 -> "2", 1.5 -> "1,5". */
function rapi(n) {
  const v = Number(n) || 0;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');
}

/** Kalimat kriteria yang sedang berlaku, apa adanya. */
function kriteria(opsi, ambang) {
  const bagian = [];
  const doi = Number(opsi.doiMax) || 0;
  if (doi > 0) bagian.push(`DOI < ${rapi(doi)} hari`);
  if (ambang > 0) bagian.push(`stok < ${angka(ambang)}`);
  // Dipakai apa adanya: "min 2/hari", bukan "min 2,0/hari".
  if (Number(opsi.minAvg) > 0) bagian.push(`min ${rapi(opsi.minAvg)}/hari`);
  return bagian.length > 0 ? bagian.join(' | ') : 'seluruh SKU';
}

function namaMode(mode, p) {
  const m = String(mode || 'winsor').toLowerCase();
  if (m === 'full') return 'semua hari, tanpa batas';
  if (m === 'normal') return 'tanpa payday & double date';
  if (m === 'median') return 'median harian';
  return `semua hari, lonjakan dibatasi P${p}`;
}

/**
 * Susun pesan WhatsApp.
 *
 * @param {{baris: Array, totalKandidat: number, rentang: Object, errors?: string[]}} data
 * @param {Object} opsi
 */
function renderStockReport(data, opsi = {}) {
  const off = Number.isFinite(opsi.tzOffsetMinutes) ? opsi.tzOffsetMinutes : 420;
  const label = opsi.tzLabel || 'WIB';
  const now = opsi.now || new Date();
  const top = Math.max(1, Number(opsi.top) || 20);
  const ambang = Number.isFinite(opsi.ambang) ? opsi.ambang : 1000;
  const batasPesan = Math.max(500, Number(opsi.batasPesan) || 3800);

  const semua = data.baris || [];
  const L = [];

  const { teks: sapaan, jids: mentions } = sapaanPic(opsi.pic);
  if (sapaan) {
    L.push(`*Dear ${sapaan}*`);
    L.push('');
  }

  L.push(`*${opsi.judul || 'STOK MENIPIS'}*`);
  L.push(`${tanggalLokal(now, off)} - ${jamLokal(now, off, label)}`);
  L.push(`Kriteria: ${kriteria(opsi, ambang)}`);
  L.push(`Kategori ${opsi.kategori || 'Sku'} | Status aktif`);
  L.push(`Rata-rata ${data.rentang ? data.rentang.hari : '-'} hari (${namaMode(opsi.mode, opsi.persentil || 95)})`);
  L.push('');

  if (semua.length === 0) {
    L.push('Tidak ada SKU yang memenuhi kriteria. Stok aman.');
    return jadikan(L, mentions, opsi);
  }

  L.push(`*${semua.length} SKU perlu perhatian* - ${Math.min(top, semua.length)} paling mendesak:`);
  L.push('');

  let ditampilkan = 0;
  for (const b of semua.slice(0, top)) {
    const potongan = [];
    potongan.push(`${ditampilkan + 1}. ${b.sku}`);
    potongan.push(`   Stok *${angka(b.qty)}* | Avg *${angka(b.rata)}*/hari -> ${hari(b.hariCukup)}`);
    if (opsi.detail !== false && b.total > 0) {
      potongan.push(`   normal ${angka(b.normal)} - puncak ${angka(b.puncak)}`);
    }
    const calon = potongan.join('\n');
    if (L.join('\n').length + calon.length + 120 > batasPesan) break;
    L.push(calon);
    ditampilkan += 1;
  }

  const sisa = semua.length - ditampilkan;
  if (sisa > 0) {
    L.push('');
    L.push(`_...dan ${angka(sisa)} SKU lain yang memenuhi kriteria._`);
  }

  L.push('');
  L.push('_Avg = rata-rata harian; hari puncak tidak dibuang, hanya dibatasi._');
  L.push('_normal = rata-rata hari biasa | puncak = payday & double date._');

  if (data.errors && data.errors.length > 0) {
    L.push('');
    L.push(`_Sebagian data gagal diambil: ${data.errors.join(' | ')}_`);
  }

  return jadikan(L, mentions, opsi);
}

/**
 * renderStockReport dipakai di dua tempat dengan kebutuhan berbeda:
 * skrip uji hanya ingin teksnya, penjadwal butuh daftar mention juga.
 * Bentuk lama (string) dipertahankan supaya pemanggil lama tidak rusak.
 */
function jadikan(baris, mentions, opsi) {
  const teks = baris.join('\n');
  return opsi.denganMention ? { text: teks, mentions } : teks;
}

module.exports = {
  renderStockReport,
  rentangPenjualan,
  daftarHari,
  daftarHariGabungan,
  deretHarian,
  saringStok,
  saringDoi,
  susunBaris,
  kriteria,
  hitungRataHarian,
  persentil,
  median,
  tanggalKembar,
  hariGajian,
  hariPuncak,
  kunciHari,
  awalHariLokal,
  tanggalLokal,
  jamLokal,
  angka,
  hari,
  namaMode,
};
