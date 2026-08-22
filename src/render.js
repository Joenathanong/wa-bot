'use strict';

/**
 * Rendering template + pembentukan REAL WhatsApp mention.
 *
 * CATATAN TEKNIS PENTING
 * ----------------------
 * WhatsApp hanya mengenali mention bila teks pesan memuat "@<nomor>"
 * (mis. "@6281234567890") DAN JID nomor tersebut ikut dikirim pada
 * opsi `mentions`. Aplikasi WhatsApp penerima yang menampilkannya
 * sebagai "@Ibu Jonathan" (memakai nama kontak). Menulis "@Ibu Jonathan"
 * di teks TIDAK akan pernah menjadi mention sungguhan.
 *
 * Karena itu {users} diganti dengan "@<nomor>", bukan "@<nama>".
 * Setelan `mention_display = name` menambahkan nama di depan nomor
 * ("Ibu Jonathan @6281234567890") bila ingin tetap terbaca jelas.
 */

/** Ubah nomor WhatsApp (tanpa +) menjadi JID WhatsApp. */
function numberToJid(number) {
  const digits = String(number).replace(/\D/g, '');
  return `${digits}@c.us`;
}

/**
 * Validasi nomor WhatsApp sesuai aturan: hanya angka, tanpa +, tanpa 0 di depan.
 * @returns {{ok: boolean, value?: string, error?: string}}
 */
function validateWhatsappNumber(raw) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { ok: false, error: 'Nomor tidak boleh kosong.' };

  if (input.startsWith('+')) {
    return {
      ok: false,
      error: `Jangan memakai tanda +. Tulis "${input.replace(/\D/g, '')}" saja.`,
    };
  }

  const cleaned = input.replace(/[\s\-().]/g, '');
  if (!/^\d+$/.test(cleaned)) {
    return { ok: false, error: 'Nomor hanya boleh berisi angka. Contoh: 6281234567890' };
  }

  if (cleaned.startsWith('0')) {
    return {
      ok: false,
      error: `Jangan memakai 0 di depan. Gunakan kode negara, contoh: 62${cleaned.replace(/^0+/, '')}`,
    };
  }

  if (cleaned.length < 8 || cleaned.length > 15) {
    return { ok: false, error: 'Panjang nomor tidak wajar (harus 8-15 digit). Contoh: 6281234567890' };
  }

  return { ok: true, value: cleaned };
}

/** Gabungkan daftar teks: "A", "A & B", "A, B & C" */
function joinNatural(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/**
 * Bentuk potongan teks mention + daftar JID.
 * @param {Array<{name: string, whatsapp_number: string}>} users
 * @param {'number'|'name'} mentionDisplay
 */
function buildMentions(users, mentionDisplay = 'number') {
  const jids = [];
  const parts = [];
  for (const u of users) {
    const digits = String(u.whatsapp_number).replace(/\D/g, '');
    if (!digits) continue;
    jids.push(`${digits}@c.us`);
    parts.push(mentionDisplay === 'name' ? `${u.name} @${digits}` : `@${digits}`);
  }
  return { text: joinNatural(parts), jids };
}

function timestampParts(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`,
  };
}

/**
 * Render template menjadi pesan WhatsApp siap kirim.
 * @returns {{text: string, mentions: string[], users: Array, hasUsers: boolean}}
 */
function renderTemplate(content, users, options = {}) {
  const mentionDisplay = options.mentionDisplay === 'name' ? 'name' : 'number';
  const list = Array.isArray(users) ? users : [];
  const { text: mentionText, jids } = buildMentions(list, mentionDisplay);
  const ts = timestampParts(options.now || new Date());

  const count = Number(options.count || 1);
  const text = String(content)
    .split('{users}').join(mentionText || '(belum ada user aktif)')
    .split('{count}').join(String(count))
    .split('{datetime}').join(`${ts.date} ${ts.time}`)
    .split('{date}').join(ts.date)
    .split('{time}').join(ts.time);

  return { text, mentions: jids, users: list, hasUsers: jids.length > 0 };
}

/**
 * Versi terbaca-manusia untuk preview di Telegram: memakai nama,
 * bukan nomor, supaya admin tahu siapa saja yang akan di-mention.
 */
function renderPreviewForTelegram(content, users, options = {}) {
  const list = Array.isArray(users) ? users : [];
  const names = joinNatural(list.map((u) => `@${u.name}`));
  const ts = timestampParts(options.now || new Date());
  return String(content)
    .split('{users}').join(names || '(belum ada user aktif)')
    .split('{count}').join(String(options.count || 1))
    .split('{datetime}').join(`${ts.date} ${ts.time}`)
    .split('{date}').join(ts.date)
    .split('{time}').join(ts.time);
}

module.exports = {
  numberToJid,
  validateWhatsappNumber,
  buildMentions,
  renderTemplate,
  renderPreviewForTelegram,
  joinNatural,
};
