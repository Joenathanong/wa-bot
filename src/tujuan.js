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

/**
 * Pilihan mentah tujuan lock stock (boleh JID, boleh NAMA group),
 * persis seperti yang dibaca LockScheduler.opsi().groupIds.
 */
function pilihanLock(db, config) {
  const dasar = (config && config.lock && Array.isArray(config.lock.groupIds))
    ? config.lock.groupIds.join(',')
    : '';
  return daftarDariTeks(ambilSetting(db, KUNCI_LOCK_GROUPS, dasar));
}

/**
 * Pilihan lock yang sudah diterjemahkan menjadi JID.
 * Nama group dicocokkan tanpa peduli besar-kecil huruf; nama yang tidak
 * terdaftar di /groups sengaja dibuang - ia tidak menunjuk group mana pun,
 * jadi tidak mungkin bentrok dengan tujuan Forwarder.
 */
function jidLock(db, config) {
  const pilihan = pilihanLock(db, config);
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

  baris.push('', '4. PERINGATAN LOCK STOCK');
  if (!peta.lockDisetel) {
    baris.push('  (belum disetel - peringatan tidak terkirim)');
    baris.push('  Setel dengan: /lockgroup <link / JID / nama group>');
  } else if (namaLock.length === 0) {
    baris.push(`  (tujuan tidak dikenal: ${pilihanLock(db, config).join(', ')})`);
  } else {
    for (const n of namaLock) baris.push(`  • ${n}`);
  }

  baris.push('');
  if (!peta.lockDisetel) {
    baris.push('Status: BEDA - lock stock belum punya tujuan sama sekali.');
  } else if (peta.bentrok.length === 0) {
    baris.push('Status: ✅ BEDA - kedua jalur mengirim ke group yang berlainan.');
  } else {
    const nama = peta.bentrok.map((g) => g.name).join(', ');
    const bisa = peta.forwarder.length > peta.bentrok.length;
    baris.push(`Status: ⚠️ SAMA - group "${nama}" dipakai kedua jalur.`);
    baris.push('');
    baris.push(bisa
      ? 'Group itu akan dinonaktifkan otomatis dari /groups supaya Forwarder '
        + 'berhenti mengirim ke sana.'
      : 'Ini satu-satunya group aktif, jadi TIDAK dipisah otomatis - forward '
        + 'pesanan tidak boleh berhenti. Pilih salah satu:\n'
        + '  a) /lockgroup <group lain>  - pindahkan peringatan lock stock, atau\n'
        + '  b) tambah group baru di /groups lalu nonaktifkan yang ini.');
  }
  return baris.join('\n');
}

module.exports = {
  KUNCI_LOCK_GROUPS,
  pilihanLock,
  jidLock,
  petaTujuan,
  bentrok,
  tujuanForwarder,
  tujuanForwarderRinci,
  pisahkanOtomatis,
  ringkasan,
};
