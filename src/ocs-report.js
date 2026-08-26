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

function angka(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('id-ID');
}

function jam(n, digit = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v.toFixed(digit).replace('.', ',') + ' jam';
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * @param {object} data hasil OcsClient.fetchFulfilment
 * @param {object} opts {now, tzOffsetMinutes, tzLabel, topOperators, judul}
 * @returns {string} teks pesan WhatsApp
 */
function renderReport(data, opts = {}) {
  const now = opts.now || new Date();
  const off = Number.isFinite(opts.tzOffsetMinutes) ? opts.tzOffsetMinutes : 420;
  const tz = opts.tzLabel || 'WIB';
  const topOperators = Number.isFinite(opts.topOperators) ? opts.topOperators : 3;
  const judul = opts.judul || 'FULFILMENT DASHBOARD';

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
    baris.push('*THROUGHPUT (SELESAI)*');
    for (const [peran, jumlah] of Array.from(perPeran.entries()).sort((a, b) => b[1] - a[1])) {
      baris.push(`- ${peran}: ${angka(jumlah)}`);
    }
  }

  /* -------------------------- leaderboard -------------------------- */
  if (topOperators > 0) {
    const operator = arr(data.leaderboard)
      .slice()
      .sort((a, b) => (Number(b.CompletedCount) || 0) - (Number(a.CompletedCount) || 0))
      .slice(0, topOperators);
    if (operator.length > 0) {
      baris.push('');
      baris.push(`*TOP ${operator.length} OPERATOR*`);
      operator.forEach((o, i) => {
        const nama = o.OperatorName || o.OperatorId || '-';
        baris.push(`${i + 1}. ${nama} (${o.Role || '-'}): ${angka(o.CompletedCount)}`);
      });
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
  if (arr(data.errors).length > 0) {
    baris.push('');
    baris.push(`_Sebagian data gagal diambil: ${data.errors.length} bagian. Cek log aplikasi._`);
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
  startOfLocalDay,
  tanggalLokal,
  jamLokal,
  angka,
  jam,
  adaMasalah,
};
