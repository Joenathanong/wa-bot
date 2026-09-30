'use strict';

/**
 * Pemisah GROUP TUJUAN antar-jalur.
 *
 * Dua jalur mengirim ke WhatsApp dengan cara yang berbeda:
 *
 *   1. FORWARDER TELEGRAM -> WHATSAPP
 *      Tujuannya = SELURUH group yang berstatus AKTIF (hijau) di /groups.
 *      Tidak pernah disebut satu per satu.
 *
 *   4. PERINGATAN LOCK STOCK
 *      Tujuannya = daftar yang DISEBUT di setelan lock_groups (/lockgroup).
 *
 * Karena yang satu memakai "semua yang aktif" dan yang lain "yang disebut",
 * satu group yang sama bisa masuk ke dua-duanya tanpa ada yang menyadari:
 * pesanan PAKET INSTANT dan peringatan lock stock menumpuk di ruang yang
 * sama, mention-nya bercampur, dan PIC berhenti membacanya.
 *
 * Berkas ini satu-satunya tempat yang tahu kedua daftar itu sekaligus,
 * sehingga "apakah mereka sama?" bisa dijawab dengan pasti - oleh perintah
 * /tujuan, oleh pemeriksaan saat start, maupun oleh Pipeline saat memilih
 * tujuan forward.
 */

/**
 * Jalur selain Forwarder yang tujuannya DISEBUT satu per satu.
 *
 * Daftar ini satu-satunya tempat jalur baru perlu didaftarkan: pemisahan,
 * ringkasan /tujuan, tanda 🔒 di /groups, dan pengaman saat mengaktifkan
 * group semuanya membacanya dari sini. Menambah jalur ke-6 nanti cukup
 * menambah satu baris - bukan menyebar aturan yang sama ke lima berkas.
 */
const JALUR = [
  {
    key: 'lock',
    kunci: 'lock_groups',
    config: 'lock',
    judul: '4. PERINGATAN LOCK STOCK',
    perintah: '/lockgroup',
  },
  {
    key: 'doi',
    kunci: 'doi_groups',
    config: 'doi',
    judul: '5. MONITORING DOI',
    perintah: '/doigroup',
  },
];

const KUNCI_LOCK_GROUPS = 'lock_groups';

function daftarDariTeks(teks) {
  return String(teks == null ? '' : teks)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ambilSetting(db, kunci, bawaan = null) {
  if (!db || typeof db.getSetting !== 'function') return bawaan;
  const v = db.getSetting(kunci, null);
  return (v === null || v === undefined || v === '') ? bawaan : v;
}

function semuaGroup(db) {
  if (!db || typeof db.listWaGroups !== 'function') return [];
  try { return db.listWaGroups() || []; } catch (e) { return []; }
}

function groupAktif(db) {
  if (!db || typeof db.listActiveWaGroups !== 'function') return [];
  try { return db.listActiveWaGroups() || []; } catch (e) { return []; }
}

function cariJalur(key) {
  const j = JALUR.find((x) => x.key === key);
  if (!j) throw new Error(`jalur "${key}" tidak dikenal`);
  return j;
}

/**
 * Pilihan mentah tujuan sebuah jalur (boleh JID, boleh NAMA group),
 * persis seperti yang dibaca penjadwalnya sendiri lewat opsi().groupIds.
 */
function pilihanJalur(db, config, key) {
  const j = cariJalur(key);
  const bagian = config && config[j.config];
  const dasar = (bagian && Array.isArray(bagian.groupIds)) ? bagian.groupIds.join(',') : '';
  return daftarDariTeks(ambilSetting(db, j.kunci, dasar));
}

/**
 * Pilihan sebuah jalur yang sudah diterjemahkan menjadi JID.
 * Nama group dicocokkan tanpa peduli besar-kecil huruf; nama yang tidak
 * terdaftar di /groups sengaja dibuang - ia tidak menunjuk group mana pun,
 * jadi tidak mungkin bentrok dengan tujuan Forwarder.
 */
function jidJalur(db, config, key) {
  const pilihan = pilihanJalur(db, config, key);
  if (pilihan.length === 0) return [];
  const semua = semuaGroup(db);
  const hasil = [];
  for (const p of pilihan) {
    const cocok = semua.find((g) => String(g.group_id) === p
      || String(g.name || '').toLowerCase() === p.toLowerCase());
    if (cocok) hasil.push(String(cocok.group_id));
    else if (/@g\.us$/i.test(p)) hasil.push(p);
  }
  return [...new Set(hasil)];
}

/** Seluruh JID yang sudah dipesan jalur mana pun selain Forwarder. */
function jidSemuaJalur(db, config) {
  const hasil = [];
  for (const j of JALUR) {
    for (const jid of jidJalur(db, config, j.key)) {
      if (!hasil.includes(jid)) hasil.push(jid);
    }
  }
  return hasil;
}

/* Nama lama, dipertahankan supaya pemanggil yang sudah ada tidak perlu ikut
   diubah. jidLock kini berarti "seluruh jalur bertujuan-tetap", karena
   itulah yang dibutuhkan setiap pemakainya: tanda 🔒 di /groups, pengaman
   pengaktifan group, dan penyingkiran tujuan Forwarder. */
function pilihanLock(db, config) {
  const hasil = [];
  for (const j of JALUR) hasil.push(...pilihanJalur(db, config, j.key));
  return hasil;
}

function jidLock(db, config) {
  return jidSemuaJalur(db, config);
}

/**
 * Gambaran lengkap kedua tujuan sekaligus.
 * @returns {{forwarder: Array, lock: string[], bentrok: Array, lockDisetel: boolean}}
 */
function petaTujuan(db, config) {
  const forwarder = groupAktif(db).map((g) => ({
    rowId: g.id,
    id: String(g.group_id),
    name: g.name || g.group_id,
  }));
  const lock = jidLock(db, config);
  const bentrok = forwarder.filter((g) => lock.includes(g.id));
  return { forwarder, lock, bentrok, lockDisetel: pilihanLock(db, config).length > 0 };
}

/** Apakah kedua jalur saat ini memakai group yang sama? */
function bentrok(db, config) {
  return petaTujuan(db, config).bentrok;
}

/**
 * Tujuan FORWARDER setelah group milik lock stock disingkirkan.
 *
 * Aturan "jangan sampai nol": bila SELURUH group aktif ternyata juga tujuan
 * lock stock, daftar aslinya dikembalikan apa adanya. Menghentikan forward
 * pesanan PAKET INSTANT - jalur yang membuat driver menunggu di gudang -
 * hanya karena salah setel adalah kerusakan yang jauh lebih besar daripada
 * dua jalur yang menumpuk. Keadaan itu dilaporkan ke admin, bukan didiamkan.
 *
 * @returns {{groups: Array, disingkirkan: Array, tidakBisaDipisah: boolean}}
 */
function tujuanForwarderRinci(db, config) {
  const { forwarder, bentrok: b } = petaTujuan(db, config);
  if (b.length === 0) return { groups: forwarder, disingkirkan: [], tidakBisaDipisah: false };
  const sisa = forwarder.filter((g) => !b.some((x) => x.id === g.id));
  if (sisa.length === 0) return { groups: forwarder, disingkirkan: [], tidakBisaDipisah: true };
  return { groups: sisa, disingkirkan: b, tidakBisaDipisah: false };
}

/** Versi ringkas untuk Pipeline. */
function tujuanForwarder(db, config) {
  return tujuanForwarderRinci(db, config).groups;
}

/**
 * Pisahkan otomatis: group yang menjadi tujuan lock stock dinonaktifkan
 * dari /groups supaya Forwarder berhenti mengirim ke sana.
 *
 * TIDAK dilakukan bila itu satu-satunya group aktif - lihat alasannya di
 * tujuanForwarderRinci().
 *
 * @returns {{dipisah: Array, tidakBisaDipisah: boolean, sisa: number}}
 */
function pisahkanOtomatis(db, config) {
  const { forwarder, bentrok: b } = petaTujuan(db, config);
  if (b.length === 0) return { dipisah: [], tidakBisaDipisah: false, sisa: forwarder.length };

  const sisa = forwarder.filter((g) => !b.some((x) => x.id === g.id));
  if (sisa.length === 0) return { dipisah: [], tidakBisaDipisah: true, sisa: 0 };

  const dipisah = [];
  for (const g of b) {
    if (g.rowId === undefined || g.rowId === null) continue;
    if (!db || typeof db.updateWaGroup !== 'function') continue;
    try {
      db.updateWaGroup(g.rowId, { active: 0 });
      dipisah.push(g);
    } catch (e) { /* biarkan; dilaporkan lewat sisa daftar */ }
  }
  return { dipisah, tidakBisaDipisah: false, sisa: sisa.length };
}

/**
 * Teks untuk /tujuan dan untuk notifikasi admin.
 *
 * Sengaja TANPA format Markdown: nama group ditulis manusia dan kerap memuat
 * _ atau * (mis. "IEG_WH *NCO*"). Satu tanda bintang yang tidak berpasangan
 * membuat Telegram MENOLAK seluruh pesan, sehingga perintah diagnosa ini
 * justru mati persis ketika sedang dibutuhkan.
 */
function ringkasan(db, config) {
  const peta = petaTujuan(db, config);
  const namaLock = peta.lock.map((jid) => {
    const g = semuaGroup(db).find((x) => String(x.group_id) === jid);
    return g ? `${g.name || jid} (${jid})` : jid;
  });

  const baris = [
    '📌 GROUP TUJUAN TIAP JALUR',
    '',
    '1. FORWARDER TELEGRAM -> WHATSAPP',
  ];
  if (peta.forwarder.length === 0) {
    baris.push('  (belum ada group AKTIF di /groups - forward tidak terkirim)');
  } else {
    for (const g of peta.forwarder) baris.push(`  • ${g.name} (${g.id})`);
  }

  for (const j of JALUR) {
    baris.push('', j.judul);
    const pilihan = pilihanJalur(db, config, j.key);
    const jid = jidJalur(db, config, j.key);
    if (pilihan.length === 0) {
      baris.push('  (belum disetel - tidak terkirim)');
      baris.push(`  Setel dengan: ${j.perintah} <link / JID / nama group>`);
    } else if (jid.length === 0) {
      baris.push(`  (tujuan tidak dikenal: ${pilihan.join(', ')})`);
    } else {
      for (const x of jid) {
        const g = semuaGroup(db).find((y) => String(y.group_id) === x);
        baris.push(`  • ${g ? `${g.name || x} (${x})` : x}`);
      }
    }
  }

  // Dua jalur bertujuan-tetap yang menunjuk group yang SAMA tidak tertangkap
  // oleh pemeriksaan Forwarder di atas - keduanya boleh saja tidak aktif di
  // /groups, dan tetap menumpuk di satu ruang.
  const silang = [];
  for (let a = 0; a < JALUR.length; a += 1) {
    for (let b = a + 1; b < JALUR.length; b += 1) {
      const kiri = jidJalur(db, config, JALUR[a].key);
      const kanan = jidJalur(db, config, JALUR[b].key);
      for (const x of kiri) {
        if (kanan.includes(x)) silang.push({ jid: x, a: JALUR[a], b: JALUR[b] });
      }
    }
  }

  baris.push('');
  if (!peta.lockDisetel) {
    baris.push('Status: BEDA - lock stock belum punya tujuan sama sekali.');
  } else if (peta.bentrok.length === 0) {
    baris.push('Status: ✅ BEDA - kedua jalur mengirim ke group yang berlainan.');
  } else {
    const bisa = peta.forwarder.length > peta.bentrok.length;
    // Sebut jalur MANA yang mengklaim group itu. "dipakai kedua jalur" tidak
    // cukup begitu ada lebih dari dua jalur - admin masih harus menebak.
    const rinci = peta.bentrok.map((g) => {
      const pemilik = JALUR
        .filter((j) => jidJalur(db, config, j.key).includes(g.id))
        .map((j) => j.judul);
      return `"${g.name}" (Forwarder + ${pemilik.join(' + ') || 'jalur lain'})`;
    }).join(', ');
    baris.push(`Status: ⚠️ SAMA - ${rinci}.`);
    baris.push('');
    baris.push(bisa
      ? 'Group itu akan dinonaktifkan otomatis dari /groups supaya Forwarder '
        + 'berhenti mengirim ke sana.'
      : 'Ini satu-satunya group aktif, jadi TIDAK dipisah otomatis - forward '
        + 'pesanan tidak boleh berhenti. Pilih salah satu:\n'
        + '  a) pindahkan jalur itu ke group lain, atau\n'
        + '  b) tambah group baru di /groups lalu nonaktifkan yang ini.');
  }

  for (const x of silang) {
    const g = semuaGroup(db).find((y) => String(y.group_id) === x.jid);
    baris.push('');
    baris.push(`⚠️ "${g ? (g.name || x.jid) : x.jid}" dipakai DUA jalur sekaligus: `
      + `${x.a.judul} dan ${x.b.judul}. Pindahkan salah satunya `
      + `(${x.a.perintah} / ${x.b.perintah}).`);
  }
  return baris.join('\n');
}

module.exports = {
  JALUR,
  KUNCI_LOCK_GROUPS,
  pilihanJalur,
  jidJalur,
  jidSemuaJalur,
  pilihanLock,
  jidLock,
  petaTujuan,
  bentrok,
  tujuanForwarder,
  tujuanForwarderRinci,
  pisahkanOtomatis,
  ringkasan,
};
