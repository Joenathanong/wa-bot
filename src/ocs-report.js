'use strict';

/**
 * Ubah data mentah Fulfilment Dashboard menjadi satu pesan WhatsApp.
 * Murni fungsi - tidak menyentuh jaringan - sehingga mudah diuji.
 */

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** Waktu lokal (menit offset) dari sebuah Date UTC. */
function toLocal(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60000);
}

/** Awal hari lokal, dikembalikan sebagai Date UTC sungguhan. */
function startOfLocalDay(date, offsetMinutes) {
  const l = toLocal(date, offsetMinutes);
  const awalLokal = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  return new Date(awalLokal - offsetMinutes * 60000);
}

/**
 * Rentang "Hari Ini" persis seperti tombol preset di dashboard:
 * from = 00:00 waktu lokal, to = 00:00 hari berikutnya.
 */
function todayRange(now, offsetMinutes) {
  const from = startOfLocalDay(now, offsetMinutes);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Rentang BULAN BERJALAN: tanggal 1 pukul 00:00 waktu lokal sampai akhir
 * hari ini (yaitu 00:00 besok), supaya hari yang sedang berjalan ikut terhitung.
 */
function monthToDateRange(now, offsetMinutes) {
  const l = toLocal(now, offsetMinutes);
  const awalBulanLokal = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1);
  const from = new Date(awalBulanLokal - offsetMinutes * 60000);
  const to = new Date(startOfLocalDay(now, offsetMinutes).getTime() + 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function tanggalLokal(date, offsetMinutes) {
  const l = toLocal(date, offsetMinutes);
  return `${HARI[l.getUTCDay()]}, ${l.getUTCDate()} ${BULAN[l.getUTCMonth()]} ${l.getUTCFullYear()}`;
}

function jamLokal(date, offsetMinutes, label = 'WIB') {
  const l = toLocal(date, offsetMinutes);
  const jj = String(l.getUTCHours()).padStart(2, '0');
  const mm = String(l.getUTCMinutes()).padStart(2, '0');
  return `${jj}:${mm} ${label}`;
}

/** "1-26 Agu 2026" dari sepasang ISO string. */
function labelPeriode(from, to, offsetMinutes) {
  const a = toLocal(new Date(from), offsetMinutes);
  // `to` bersifat eksklusif (00:00 hari berikutnya) - mundurkan 1 ms
  const b = toLocal(new Date(new Date(to).getTime() - 1), offsetMinutes);
  const bulanSama = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  if (bulanSama) {
    return `${a.getUTCDate()}-${b.getUTCDate()} ${BULAN[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${a.getUTCDate()} ${BULAN[a.getUTCMonth()]} - ${b.getUTCDate()} ${BULAN[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

function angka(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('id-ID');
}

function jam(n, digit = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v.toFixed(digit).replace('.', ',') + ' jam';
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function samakan(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Berapa HARI OPERASI yang benar-benar ada datanya dalam rentang.
 * Dipakai sebagai pembagi rata-rata, supaya hari libur / gudang tutup tidak
 * menurunkan angka rata-rata operator secara tidak adil.
 */
function hitungHariOperasi(throughput, roles = []) {
  const peran = arr(roles).map(samakan).filter(Boolean);
  const hari = new Set();
  for (const t of arr(throughput)) {
    if (peran.length > 0 && !peran.includes(samakan(t.Role))) continue;
    if (Number(t.CompletedCount) > 0) hari.add(String(t.Day || '').slice(0, 10));
  }
  return hari.size;
}

/**
 * Jumlah hari kalender bulan berjalan (tanggal 1 s/d hari ini), dikurangi
 * hari libur mingguan bila diatur. 0=Minggu, 1=Senin, ... 6=Sabtu.
 */
function hitungHariKalender(now, offsetMinutes, offDays = []) {
  const l = toLocal(now, offsetMinutes);
  const libur = arr(offDays).map(Number).filter((n) => Number.isFinite(n));
  let n = 0;
  for (let d = 1; d <= l.getUTCDate(); d += 1) {
    const hari = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), d)).getUTCDay();
    if (!libur.includes(hari)) n += 1;
  }
  return n;
}

/**
 * Tentukan PEMBAGI rata-rata harian.
 *
 * mode:
 *   auto     - hitung hari berbeda yang ada datanya di Throughput. Tepat bila
 *              endpoint itu memang mencakup seluruh rentang; bisa terlalu kecil
 *              bila OCS membatasi Throughput ke beberapa hari terakhir saja.
 *   calendar - tanggal 1 s/d hari ini, dikurangi hari libur mingguan (offDays)
 *   <angka>  - dipakai apa adanya
 *
 * @returns {{hari: number, dasar: string}}
 */
function tentukanPembagi(opts = {}) {
  const mode = samakan(opts.mode) || 'auto';

  const tetap = Number(mode);
  if (Number.isFinite(tetap) && tetap > 0) {
    return { hari: Math.round(tetap), dasar: 'disetel manual' };
  }
  if (mode === 'calendar' || mode === 'kalender') {
    const n = hitungHariKalender(opts.now || new Date(), opts.off || 0, opts.offDays);
    return { hari: Math.max(1, n), dasar: 'kalender' };
  }
  const n = hitungHariOperasi(opts.throughput, opts.roles);
  return { hari: Math.max(1, n), dasar: 'dari data' };
}

/**
 * Saring dan urutkan leaderboard.
 *
 * @param {Array} leaderboard data mentah /FulfilmentDashboard/Leaderboard
 * @param {{roles?: string[], kecuali?: string[], top?: number, hariOperasi?: number}} opts
 *   roles       - hanya peran ini (kosong = semua peran)
 *   kecuali     - buang operator yang namanya MEMUAT salah satu kata ini
 *                 (contoh "mesin", supaya mesin packing tidak ikut peringkat)
 *   hariOperasi - pembagi rata-rata; <=1 berarti tidak ada pembagian
 */
function ringkasOperator(leaderboard, opts = {}) {
  const peran = arr(opts.roles).map(samakan).filter(Boolean);
  const kecuali = arr(opts.kecuali).map(samakan).filter(Boolean);
  const top = Number.isFinite(opts.top) ? opts.top : 10;
  const hariOperasi = Math.max(1, Number(opts.hariOperasi) || 1);

  return arr(leaderboard)
    .filter((o) => peran.length === 0 || peran.includes(samakan(o.Role)))
    .filter((o) => {
      const nama = samakan(o.OperatorName || o.OperatorId);
      return !kecuali.some((k) => nama.includes(k));
    })
    .map((o) => ({
      nama: o.OperatorName || o.OperatorId || '-',
      peran: o.Role || '-',
      total: Number(o.CompletedCount) || 0,
      rata: (Number(o.CompletedCount) || 0) / hariOperasi,
    }))
    .filter((o) => o.total > 0)
    .sort((a, b) => b.rata - a.rata)
    .slice(0, Math.max(0, top));
}

/**
 * @param {object} data hasil OcsClient.fetchFulfilment (opsional + data.bulan)
 * @param {object} opts {now, tzOffsetMinutes, tzLabel, topOperators, judul,
 *                       leaderboardRoles, leaderboardExclude}
 * @returns {string} teks pesan WhatsApp
 */
function renderReport(data, opts = {}) {
  const now = opts.now || new Date();
  const off = Number.isFinite(opts.tzOffsetMinutes) ? opts.tzOffsetMinutes : 420;
  const tz = opts.tzLabel || 'WIB';
  const topOperators = Number.isFinite(opts.topOperators) ? opts.topOperators : 10;
  const judul = opts.judul || 'FULFILMENT DASHBOARD';
  const peranOperator = arr(opts.leaderboardRoles);
  const kecualiOperator = arr(opts.leaderboardExclude);

  const baris = [];
  const filter = data.filter || {};

  baris.push(`*${judul} - HARI INI*`);
  baris.push(`${tanggalLokal(now, off)} - ${jamLokal(now, off, tz)}`);
  baris.push(
    `Filter: ${labelDateType(filter.dateType)} | Channel ${filter.channel || 'All'}` +
    ` | Shop ${filter.shop || 'All'} | Area ${filter.area || 'All'}`
  );

  /* ------------------------------ SLA ------------------------------ */
  const s = data.summary || {};
  baris.push('');
  baris.push('*SLA & PENGIRIMAN*');
  baris.push(`- SLA terlewat: *${angka(s.BreachedSla)}*`);
  baris.push(`- Mendekati SLA (<=6 jam): ${angka(s.AtRiskSla)}`);
  baris.push(`- Mendekati SLA (<=12 jam): ${angka(s.AtRiskSla12)}`);
  baris.push(`- Instan belum dikirim: ${angka(s.InstanBelumKirim)}`);
  baris.push(`- Tanpa batas kirim: ${angka(s.NoDueTime)}`);
  baris.push(`- In transit: ${angka(s.TotalInTransit)}`);
  baris.push(`- Selesai hari ini: *${angka(s.CompletedInRange)}*`);
  baris.push(`- Rata-rata cycle: ${jam(s.AvgTotalCycleHours)}`);

  /* ---------------------------- pipeline --------------------------- */
  const buckets = arr(data.statusBuckets)
    .slice()
    .sort((a, b) => (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0))
    .filter((b) => Number(b.Count) > 0);
  if (buckets.length > 0) {
    baris.push('');
    baris.push('*WIP PER TAHAP*');
    for (const b of buckets) {
      baris.push(`- ${b.Label || b.Key}: ${angka(b.Count)}`);
    }
  }

  /* ------------------------------ aging ---------------------------- */
  const aging = arr(data.aging)
    .slice()
    .sort((a, b) => (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0))
    .filter((a) => Number(a.Count) > 0 || Number(a.BreachedSla) > 0);
  if (aging.length > 0) {
    baris.push('');
    baris.push('*AGING ORDER*');
    for (const a of aging) {
      const lewat = Number(a.BreachedSla) > 0 ? ` (${angka(a.BreachedSla)} lewat SLA)` : '';
      baris.push(`- ${a.Bucket}: ${angka(a.Count)}${lewat}`);
    }
  }

  /* --------------------------- throughput -------------------------- */
  const perPeran = new Map();
  for (const t of arr(data.throughput)) {
    const peran = t.Role || 'lainnya';
    perPeran.set(peran, (perPeran.get(peran) || 0) + (Number(t.CompletedCount) || 0));
  }
  if (perPeran.size > 0) {
    baris.push('');
    baris.push('*THROUGHPUT HARI INI (SELESAI)*');
    for (const [peran, jumlah] of Array.from(perPeran.entries()).sort((a, b) => b[1] - a[1])) {
      baris.push(`- ${peran}: ${angka(jumlah)}`);
    }
  }

  /* -------------------------- leaderboard -------------------------- */
  if (topOperators > 0) {
    const bulan = data.bulan && arr(data.bulan.leaderboard).length > 0 ? data.bulan : null;
    const sumber = bulan ? bulan.leaderboard : data.leaderboard;

    // Satu bagian TERPISAH untuk tiap peran, supaya packer dan picker tidak
    // saling menutupi dalam satu peringkat. Tanpa daftar peran: satu bagian
    // gabungan seperti semula.
    const bagian = peranOperator.length > 0 ? peranOperator.map((r) => [r]) : [[]];

    for (const roles of bagian) {
      const pembagi = bulan
        ? tentukanPembagi({
          mode: opts.leaderboardDays,
          throughput: bulan.throughput,
          roles,
          now,
          off,
          offDays: opts.leaderboardOffDays,
        })
        : { hari: 1, dasar: 'hari ini' };

      const operator = ringkasOperator(sumber, {
        roles,
        kecuali: kecualiOperator,
        top: topOperators,
        hariOperasi: bulan ? pembagi.hari : 1,
      });
      if (operator.length === 0) continue;

      const labelPeran = roles.length > 0 ? String(roles[0]).toUpperCase() : 'OPERATOR';
      baris.push('');
      if (bulan) {
        baris.push(`*TOP ${operator.length} ${labelPeran} - RATA-RATA/HARI*`);
        baris.push(`_${labelPeriode(bulan.from, bulan.to, off)}, ${pembagi.hari} hari operasi (${pembagi.dasar})_`);
        operator.forEach((o, i) => {
          baris.push(`${i + 1}. ${o.nama}: ${angka(o.rata)}/hari - total ${angka(o.total)}`);
        });
      } else {
        baris.push(`*TOP ${operator.length} ${labelPeran} - HARI INI*`);
        operator.forEach((o, i) => {
          baris.push(`${i + 1}. ${o.nama}: ${angka(o.total)}`);
        });
      }
    }
  }

  /* --------------------------- cycle time -------------------------- */
  const cycle = arr(data.cycle)[0];
  if (cycle) {
    baris.push('');
    baris.push('*RATA-RATA PER TAHAP*');
    baris.push(`- Buat -> assign: ${jam(cycle.AvgCreateToAssignHours)}`);
    baris.push(`- Assign -> packing: ${jam(cycle.AvgAssignToPackHours)}`);
    baris.push(`- Packing -> manifest: ${jam(cycle.AvgPackToManifestHours)}`);
    baris.push(`- Manifest -> kirim: ${jam(cycle.AvgManifestToShipHours)}`);
    if (cycle.Orders !== undefined) baris.push(`- Order dihitung: ${angka(cycle.Orders)}`);
  }

  /* --------------------------- keterangan -------------------------- */
  const galat = arr(data.errors).length + (data.bulan ? arr(data.bulan.errors).length : 0);
  if (galat > 0) {
    baris.push('');
    baris.push(`_Sebagian data gagal diambil: ${galat} bagian. Cek log aplikasi._`);
  }

  return baris.join('\n');
}

function labelDateType(v) {
  if (v === 'createdDate') return 'Tanggal Pesanan';
  return 'Batas Kirim';
}

/** Apakah laporan perlu dikirim, berdasarkan ambang batas peringatan. */
function adaMasalah(data, ambang = {}) {
  const s = (data && data.summary) || {};
  const batasSla = Number.isFinite(ambang.breachedSla) ? ambang.breachedSla : 1;
  const batasRisiko = Number.isFinite(ambang.atRiskSla) ? ambang.atRiskSla : 1;
  const batasInstan = Number.isFinite(ambang.instan) ? ambang.instan : 1;
  return (
    Number(s.BreachedSla) >= batasSla ||
    Number(s.AtRiskSla) >= batasRisiko ||
    Number(s.InstanBelumKirim) >= batasInstan
  );
}

module.exports = {
  renderReport,
  todayRange,
  monthToDateRange,
  startOfLocalDay,
  tanggalLokal,
  jamLokal,
  labelPeriode,
  hitungHariOperasi,
  hitungHariKalender,
  tentukanPembagi,
  ringkasOperator,
  angka,
  jam,
  adaMasalah,
};
