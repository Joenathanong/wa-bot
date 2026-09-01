# Telegram → WhatsApp Notification Bridge

Bot notifikasi internal: menerima pesan dari **Telegram Bot**, menyaringnya dengan
**satu keyword**, lalu meneruskannya ke **satu WhatsApp Group** melalui
`whatsapp-web.js`, dan mengirim pesan follow-up dengan **REAL WhatsApp mention**
kepada user yang dikelola lewat **Admin Menu Telegram**.

---

## 1. Overview

```
Sumber pesan  →  Bot Telegram sendiri   (TELEGRAM_SOURCE=bot)
              →  ATAU akun Telegram Anda (TELEGRAM_SOURCE=user, baca saja)
     ↓  pesan masuk
Cek Chat ID (TELEGRAM_ALLOWED_CHAT_IDS)
     ↓
Filter keyword: "dengan stok tersedia di bawah stok ter-reserve"
     ↓  ditemukan?            tidak → IGNORE (tidak ada pesan WhatsApp)
     ↓  ya
Cek duplikat (chat_id + message_id)
     ↓
Pesan 1 → WhatsApp Group : [FORWARDED FROM TELEGRAM] + isi asli
     ↓  (jeda MESSAGE_DELAY_MS)
Pesan 2 → WhatsApp Group : template + REAL mention semua user ACTIVE
     ↓
Catat message_id sebagai terproses
```

> ⚠️ **Penting:** Telegram **tidak pernah** mengirimkan pesan dari **bot lain**
> ke bot Anda di dalam sebuah Grup — ini aturan platform, bukan masalah konfigurasi.
> Bila peringatan stok dikirim oleh bot milik orang/tim lain, gunakan
> `TELEGRAM_SOURCE=user` (lihat bab 5b). Bot Anda tetap dipakai untuk Admin Menu.

**Satu arah saja.** Aplikasi tidak pernah membaca pesan WhatsApp untuk dikirim ke
Telegram, sehingga loop `Telegram → WhatsApp → Telegram` tidak mungkin terjadi.

Bukan WhatsApp Business API / Cloud API / Twilio / WATI / Qontak — murni
`whatsapp-web.js` di atas WhatsApp Web.

---

## 2. Architecture

```
telegram-wa-bridge/
├── src/
│   ├── index.js        # entry point, wiring, graceful shutdown
│   ├── config.js       # baca .env + validasi
│   ├── logger.js       # log berlevel (debug/info/warn/error)
│   ├── database.js     # SQLite: schema, migrasi, seed, seluruh query
│   ├── filter.js       # SATU keyword, case-insensitive
│   ├── queue.js        # antrean serial + jeda + retry
│   ├── whatsapp.js     # whatsapp-web.js: QR, sesi, group, REAL mention
│   ├── render.js       # template {users} + pembentukan JID mention
│   ├── qr.js           # gambar QR untuk dikirim lewat Telegram
│   ├── pipeline.js     # alur Telegram → WhatsApp
│   ├── telegram.js     # sumber "bot": polling, perintah, routing
│   ├── telegram-user.js# sumber "user": MTProto/GramJS, READ-ONLY
│   └── admin.js        # Admin Menu (inline keyboard) + state input
├── scripts/
│   ├── setup-check.js    # periksa kesiapan (npm run setup)
│   ├── login-telegram.js # login akun Telegram sekali (npm run tg:login)
│   ├── list-chats.js     # cari Chat ID grup sumber (npm run tg:chats)
│   ├── diagnose-network.js # uji jaringan ke Telegram (npm run tg:diag)
│   ├── reset-wa-session.js # hapus sesi WhatsApp (npm run wa:reset)
│   ├── install-service.js  # pasang Windows Service (npm run service:install)
│   ├── uninstall-service.js
│   ├── service-status.js   # status service + ekor log (npm run service:status)
│   └── backup-db.js        # salin database ke folder backups/
├── test/
│   ├── run-tests.js    # 187 uji otomatis (tanpa koneksi nyata)
│   └── stubs/          # tiruan library untuk pengujian
├── data/
│   ├── bot.db                  # database SQLite (dibuat otomatis)
│   └── telegram-user.session   # sesi akun Telegram (RAHASIA, dibuat tg:login)
├── ecosystem.config.js # konfigurasi PM2
├── MIGRASI.md          # panduan pindah ke PC Windows baru
├── .env.example
├── .gitignore
└── package.json
```

**Pembagian tanggung jawab**

| Modul | Tanggung jawab |
|---|---|
| `filter.js` | Satu-satunya tempat keyword didefinisikan |
| `pipeline.js` | Urutan langkah forward + follow-up + anti-duplikat |
| `queue.js` | Menjamin pengiriman WhatsApp **serial**, tidak paralel |
| `render.js` | Mengubah `{users}` menjadi teks `@nomor` + daftar JID |
| `whatsapp.js` | Satu-satunya modul yang menyentuh whatsapp-web.js |
| `admin.js` | Seluruh Admin Menu + otorisasi di sisi server |
| `telegram-user.js` | Membaca grup lewat akun Telegram. **Tidak punya satu pun fungsi kirim** |

**Skema database** (`data/bot.db`, dibuat & dimigrasi otomatis)

| Tabel | Isi |
|---|---|
| `users` | Nama + nomor WhatsApp yang di-mention, beserta status aktif |
| `templates` | Isi pesan follow-up |
| `wa_groups` | Daftar WhatsApp Group tujuan — **boleh lebih dari satu** |
| `settings` | Konfigurasi yang dapat diubah lewat Admin Menu |
| `processed_messages` | Proteksi duplikat per `chat_id` + `message_id` |

---

## 3. Requirements

- **Node.js 18 atau lebih baru** (disarankan Node 20/22 LTS) — cek: `node -v`
- **Google Chrome** terpasang (opsional; Puppeteer membawa Chromium sendiri)
- Koneksi internet stabil (WhatsApp Web butuh sesi yang terus terhubung)
- Satu nomor WhatsApp yang akan dipakai sebagai "pengirim bot"
  → nomor ini **harus sudah menjadi anggota** WhatsApp Group tujuan
- Satu Telegram Bot Token dari [@BotFather](https://t.me/BotFather) — untuk Admin Menu
- Bila memakai `TELEGRAM_SOURCE=user`: `api_id` dan `api_hash` gratis dari
  [my.telegram.org](https://my.telegram.org), serta akun Telegram yang sudah
  menjadi anggota grup sumber peringatan

---

## 4. Installation

Kebutuhan sistem bisa dipasang lewat perintah (Windows 10/11 modern):

```powershell
winget install -e --id Google.Chrome
winget install -e --id Git.Git          # opsional, untuk Git Bash
```

**Node.js: pasang versi 22.** Sejak Node 24 menjadi LTS, `OpenJS.NodeJS.LTS`
memberi Node 24, dan `better-sqlite3` belum punya binary siap pakai untuk versi
itu. Unduh Node 22.x dari <https://nodejs.org/en/download>, atau:

```powershell
winget install -e --id OpenJS.NodeJS.LTS --version 22.21.1
```

Node 24 tetap bisa dipakai: `better-sqlite3` berstatus **opsional**, dan bila
gagal dipasang aplikasi otomatis memakai `node:sqlite` bawaan Node. Jalankan
`npm run setup` untuk melihat driver mana yang aktif.

Tutup jendela terminal, buka yang baru agar PATH terbaca, lalu:

```bash
cd C:\bot\telegram-wa-bridge
npm ci          # memakai package-lock.json - versi persis sama
npm run setup   # periksa apa lagi yang kurang
```

Pakai `npm install` bila `package-lock.json` belum ada; setelah itu `npm ci`
selalu menghasilkan pemasangan yang identik. Seluruh kebutuhan Node — termasuk
`node-windows` (Windows Service) dan `qrcode` (QR lewat Telegram) — sudah
tercatat di `package.json`, jadi tidak ada yang perlu dipasang terpisah.

**`npm run setup`** memeriksa Node, dependency, `.env`, Chrome, database, sesi
WhatsApp/Telegram, dan status service sekaligus, lalu menuliskan daftar
pekerjaan yang tersisa beserta perintahnya. Jalankan berulang sampai
menjawab **SIAP**.

`npm install` mengunduh Chromium untuk Puppeteer (±150–300 MB) — biarkan sampai selesai.

Jika `better-sqlite3` gagal di-build di Windows:

```bash
npm install --build-from-source=false better-sqlite3
```

Aplikasi tetap berjalan tanpa `better-sqlite3` bila Node Anda versi 22.5+
(otomatis memakai modul `node:sqlite` bawaan). Pesan di log akan
memberitahukan driver mana yang dipakai.

---

## 5. Environment configuration

```bash
copy .env.example .env      # Windows CMD
cp .env.example .env        # Git Bash
```

Isi `.env`:

```env
TELEGRAM_BOT_TOKEN=8123456789:AAH_token_dari_BotFather
ADMIN_TELEGRAM_IDS=123456789
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
MESSAGE_DELAY_MS=3000
NODE_ENV=production
```

| Variabel | Wajib | Keterangan |
|---|---|---|
| `TELEGRAM_SOURCE` | ya | `bot`, `user`, atau `both` — lihat bab 5b |
| `TELEGRAM_BOT_TOKEN` | ya | Token dari @BotFather (Admin Menu) |
| `TELEGRAM_API_ID` | bila `user`/`both` | Dari my.telegram.org |
| `TELEGRAM_API_HASH` | bila `user`/`both` | Dari my.telegram.org |
| `ADMIN_TELEGRAM_IDS` | ya | User ID Telegram yang boleh membuka `/admin`, pisah koma |
| `TELEGRAM_ALLOWED_CHAT_IDS` | sangat disarankan | Chat/Group ID sumber notifikasi. **Kosong = semua chat diproses** |
| `MESSAGE_DELAY_MS` | tidak | Jeda antar pesan WhatsApp, minimal `3000` |
| `NODE_ENV` | tidak | `production` |
| `LOG_LEVEL` | tidak | `debug` untuk menelusuri masalah |
| `LOG_FILE` | tidak | Berkas log, bawaan `data/app.log`; `off` untuk mematikan |
| `CHROME_PATH` | tidak | Path chrome.exe bila Chromium bawaan bermasalah |
| `WA_WEB_VERSION` | tidak | Sematkan build WhatsApp Web tertentu (lihat bab 13) |
| `TELEGRAM_USE_WSS` | tidak | `true` (bawaan) = WSS port 443; `false` = TCP port 80 |
| `TELEGRAM_CONNECTION_RETRIES` | tidak | Percobaan sambung ulang GramJS, bawaan `100` |
| `TELEGRAM_RETRY_DELAY_MS` | tidak | Jeda antar percobaan, bawaan `3000` |
| `GRAMJS_LOG_LEVEL` | tidak | `error` (bawaan) / `none` untuk membungkam log GramJS |
| `WA_READY_TIMEOUT_MS` | tidak | Batas menunggu status ready, bawaan `120000`; `0` = tanpa batas |
| `HEALTH_CHECK_MS` | tidak | Jeda pemeriksaan koneksi, bawaan `60000` |
| `CATCHUP_LIMIT` | tidak | Jumlah pesan terakhir yang diperiksa saat pulih, bawaan `25` |
| `CATCHUP_MAX_AGE_MINUTES` | tidak | Umur maksimal pesan susulan, bawaan `180` |
| `CATCHUP_ONLY_LATEST` | tidak | `true` (bawaan) = setelah restart hanya peringatan **terakhir** yang dikirim |
| `FOLLOWUP_WINDOW_MS` | tidak | Jendela penggabungan pesan mention, bawaan `15000` |
| `FOLLOWUP_MAX_WAIT_MS` | tidak | Batas atas penantian follow-up, bawaan `120000` |
| `DB_PATH` | tidak | Default `data/bot.db` |

**Nomor user WhatsApp, template pesan, dan Group ID TIDAK disimpan di `.env`** —
semuanya ada di SQLite dan diubah lewat Admin Menu.

### Cara mendapatkan ID

1. Jalankan aplikasi, buka chat pribadi dengan bot Anda, kirim `/id`
   → dapat **User ID** Anda → isikan ke `ADMIN_TELEGRAM_IDS`.
2. Tambahkan bot ke grup/kanal sumber peringatan stok, kirim `/id` di sana
   → dapat **Chat ID** (biasanya diawali `-100`) → isikan ke `TELEGRAM_ALLOWED_CHAT_IDS`.
3. Restart aplikasi.

> Bila bot berada di grup Telegram, matikan **Group Privacy** di @BotFather
> (`/setprivacy` → Disable) agar bot dapat membaca semua pesan grup.

---

## 5b. Mode akun Telegram (membaca pesan dari bot lain)

**Kapan bab ini berlaku:** peringatan stok dikirim oleh **bot milik orang/tim lain**
ke sebuah **Grup Telegram**. Bot Anda sendiri tidak akan pernah menerimanya —
Telegram memang tidak meneruskan pesan antar-bot di grup. Solusinya membaca grup
itu dengan **akun Telegram Anda sendiri** lewat MTProto (library GramJS).

### Jaminan read-only

Modul `src/telegram-user.js` hanya memanggil `connect`, `getMe`, `addEventHandler`,
`iterDialogs`, dan `disconnect`. Tidak ada `sendMessage`, `forwardMessages`,
`joinChannel`, `inviteToChannel`, `editMessage`, `deleteMessages`, maupun
`markAsRead`. Ada uji otomatis yang memindai berkas ini dan **gagal** bila salah
satu fungsi tersebut muncul, jadi jaminan ini ikut terjaga saat kode berubah.

### Risiko akun — apa adanya

Telegram menyatakan sendiri bahwa *"all accounts that log in using unofficial
Telegram API clients are automatically put under observation"*, dan bahwa ban
permanen menyasar **flooding, spamming, dan pemalsuan counter**. Membaca satu grup
yang akun Anda memang sudah jadi anggotanya, tanpa pernah mengirim, ada di ujung
paling aman dari spektrum itu — polanya mirip membiarkan Telegram Desktop terbuka.
Risikonya rendah, tetapi tidak nol. Pengaman yang sudah diterapkan:

- read-only keras (lihat di atas)
- `api_id`/`api_hash` milik Anda sendiri — bukan sample id yang memicu `API_ID_PUBLISHED_FLOOD`
- satu sesi persisten dengan koneksi panjang, bukan polling berulang
- gunakan nomor SIM asli, bukan nomor virtual/VoIP
- biarkan aplikasi Telegram resmi tetap ikut login (pola pemakaian normal)

Cek status akun kapan saja dengan mengirim pesan ke [@SpamBot](https://t.me/SpamBot).
Bila akun sempat dibatasi, banding dikirim ke recover@telegram.org.

### Langkah pemasangan

**1. Ambil api_id & api_hash**

- Buka <https://my.telegram.org> dan login dengan nomor Telegram Anda
- Pilih **API development tools**
- App title / Short name bebas, misal `IEG Stock Bridge` / `iegbridge`
- Salin `api_id` dan `api_hash` ke `.env`

**2. Isi `.env`**

```env
TELEGRAM_SOURCE=user
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
TELEGRAM_BOT_TOKEN=...        # tetap perlu, untuk Admin Menu
ADMIN_TELEGRAM_IDS=...
```

**3. Login sekali**

```bash
npm run tg:login
```

Masukkan nomor (`+6281234567890`), lalu kode yang dikirim Telegram, lalu password
2FA bila ada. Sesi disimpan ke `data/telegram-user.session`.

> File sesi itu **setara akses penuh ke akun Telegram Anda**. Sudah masuk
> `.gitignore` — jangan pernah di-commit, di-zip, atau dikirim ke siapa pun.

**4. Cari Chat ID grup sumber**

```bash
npm run tg:chats
```

Akan tampil daftar seperti:

```
  -1001234567890  [Grup   ]  Alert Stok Ecommerce
  -1009876543210  [Channel]  Pengumuman IEG
```

Salin ID grup yang memuat peringatan stok ke `.env`:

```env
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
```

**5. Jalankan**

```bash
npm start
```

Log yang benar:

```
Sumber : AKUN Telegram (baca saja)
[INFO ] [TGUSER] Terhubung sebagai akun Telegram @nama - MODE BACA SAJA
[INFO ] [TGUSER] Mendengarkan pesan masuk (termasuk pesan dari bot lain).
```

Status pembaca akun juga tampil di `/status` dan di ⚙️ Pengaturan → 🔑 Telegram Settings.

Dalam mode ini, bot Anda **tidak** ikut meneruskan pesan (mencegah kiriman dobel
bila bot kebetulan juga ada di grup itu) — bot murni melayani Admin Menu.

---

## 6. Running application

```bash
npm start
```

Log yang sehat terlihat seperti ini:

```
[INFO ] [DB] Database baru dibuat: ...\data\bot.db
[INFO ] [APP] Jeda antar pesan WhatsApp: 3000 ms
[INFO ] [TG] Telegram connected sebagai @nama_bot (id 8123456789)
[INFO ] [WA] WhatsApp QR generated - silakan scan ...
[INFO ] [WA] WhatsApp authenticated
[INFO ] [WA] WhatsApp ready - tersambung sebagai 6281...@c.us
[INFO ] [APP] Aplikasi berjalan.
```

Hentikan dengan `Ctrl+C` (shutdown rapi: polling berhenti, sesi ditutup, DB ditutup).

---

## 7. WhatsApp QR login

**Ini satu-satunya langkah yang harus Anda lakukan secara manual.**

1. Jalankan `npm start`.
2. Tunggu 10–40 detik sampai muncul QR code ASCII di terminal.
3. Di HP: **WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat**.
4. Scan QR di terminal.
5. Tunggu sampai muncul `WhatsApp ready`.

Sesi tersimpan di folder `.wwebjs_auth/`. **Restart berikutnya tidak akan
meminta scan QR lagi** selama sesi masih valid dan folder itu tidak dihapus.

Jika QR tidak muncul di terminal (misal saat berjalan di bawah PM2), lihat
`pm2 logs telegram-wa-bridge`.

Login ulang dari nol: hentikan aplikasi → hapus folder `.wwebjs_auth` → jalankan lagi.

---

## 8. Telegram configuration

**Bila `TELEGRAM_SOURCE=user`** (peringatan dikirim bot lain), bot Anda tidak perlu
dimasukkan ke grup sumber sama sekali — cukup chat pribadi dengan Anda untuk Admin
Menu. Ikuti bab 5b untuk sisi akun, lalu lewati langkah "tambahkan bot ke grup" di
bawah.

- Buat bot: chat @BotFather → `/newbot` → salin token ke `.env`.
- Matikan privacy grup: @BotFather → `/setprivacy` → pilih bot → **Disable**.
- Tambahkan bot ke grup/kanal sumber peringatan stok.
- Kirim `/id` di grup itu, salin Chat ID ke `TELEGRAM_ALLOWED_CHAT_IDS`.
- Restart aplikasi.

Perintah yang tersedia:

| Perintah | Akses | Fungsi |
|---|---|---|
| `/start`, `/help` | semua | Bantuan singkat |
| `/id` | semua | Tampilkan Chat ID & User ID |
| `/status` | admin | Status koneksi & statistik |
| `/admin` | admin | Buka Admin Menu |
| `/groups` | admin | Daftar & pilih WhatsApp Group |
| `/wadiag` | admin | Diagnosa mengapa daftar group tidak terbaca |
| `/keyword` | admin | Tampilkan keyword aktif |
| `/batal` | admin | Batalkan input yang sedang berjalan |

---

## 9. Admin Menu

Kirim `/admin` ke bot (chat pribadi):

```
🤖 TELEGRAM → WHATSAPP BOT
⚙️ ADMIN MENU

[👥 Kelola User]     [📝 Template Pesan]
[📱 WhatsApp Group]  [📊 Status Bot]
[🧪 Test]            [⚙️ Pengaturan]
```

Non-admin menerima:

```
⛔ Access Denied
Anda tidak memiliki akses administrator.
```

Otorisasi diperiksa **di sisi server pada setiap callback**, bukan sekadar
menyembunyikan tombol.

---

## 10. Add WhatsApp user

`/admin` → **👥 Kelola User** → **➕ Tambah User**

1. Bot: "Masukkan nama user." → ketik mis. `Ibu Jonathan`
2. Bot: "Masukkan nomor WhatsApp tanpa +." → ketik `6281234567890`
3. Bot: "✅ User berhasil ditambahkan."

Aturan nomor:

| Format | Status |
|---|---|
| `6281234567890` | ✅ BENAR |
| `+6281234567890` | ❌ ditolak (jangan pakai `+`) |
| `081234567890` | ❌ ditolak (pakai kode negara `62`) |

Ketik `/batal` kapan saja untuk membatalkan.

---

## 11. Edit WhatsApp user

`/admin` → **👥 Kelola User** → tekan `✏️ <nama>`

```
👤 EDIT USER
Nama:  Ibu Jonathan
Nomor: 6281234567890
Status: ACTIVE 🟢

[✏️ Ubah Nama]  [📱 Ubah Nomor]
[🔘 Jadikan INACTIVE]
[💾 Selesai]    [🗑️ Hapus]
```

- **Ubah Nomor** menolak nomor yang sudah dipakai user lain.
- **INACTIVE** = user tetap tersimpan tetapi **tidak di-mention**.
- **Hapus** selalu meminta konfirmasi:

```
⚠️ Hapus user?
Ibu Jonathan
6281234567890
[✅ Ya, Hapus]  [❌ Batal]
```

---

## 12. Edit template

`/admin` → **📝 Template Pesan** → **✏️ Edit**

Bot menampilkan template saat ini, lalu meminta template baru (boleh beberapa
baris). Setelah dikirim, bot menampilkan preview dan tombol:

```
[💾 Simpan Template]  [❌ Batal]
```

Template default:

```
Dear {users}

Sesuai informasi diatas, terdapat lock stock yang lebih besar daripada stock saat ini.
Mohon segera lepas Lock Stock sebelum terjadi Oversell.

Note: Pesan ini dikirim oleh Bot WH

Terima kasih.
```

Placeholder yang tersedia:

| Placeholder | Diganti dengan |
|---|---|
| `{users}` | Seluruh user **ACTIVE** sebagai REAL mention |
| `{count}` | Jumlah pesan peringatan yang digabung dalam satu follow-up |
| `{datetime}` | `2026-08-21 21:14:43` |
| `{date}` | `2026-08-21` |
| `{time}` | `21:14:43` |

**🔄 Reset** mengembalikan template ke isi default di atas.

### Peringatan yang terpecah menjadi beberapa pesan

Bot pengirim kerap memecah satu peringatan menjadi beberapa pesan:

```
(bagian 1/2)  PERINGATAN STOK SHOPEE Ditemukan 108 SKU dengan stok tersedia ...
(bagian 2/2)  PERINGATAN STOK SHOPEE Ditemukan 108 SKU dengan stok tersedia ...
```

Keduanya memuat keyword, jadi keduanya **diteruskan** — isinya memang berbeda.
Tetapi pesan mention hanya dikirim **satu kali**: setelah peringatan pertama
diteruskan, bot menunggu **jendela follow-up** (bawaan 15 detik). Setiap
peringatan baru yang masuk memperpanjang penantian. Begitu tenang, satu pesan
mention dikirim untuk seluruh rentetan.

Hasil di WhatsApp Group:

```
[FORWARDED FROM TELEGRAM]
(bagian 1/2) PERINGATAN STOK SHOPEE ...

[FORWARDED FROM TELEGRAM]
(bagian 2/2) PERINGATAN STOK SHOPEE ...

Dear @Ibu Jonathan & @Ibu Rika          ← hanya SEKALI
Sesuai informasi diatas, ...
```

Atur lewat Admin Menu → ⚙️ Pengaturan → **⏳ Jendela Follow-up**, atau di `.env`:

```env
FOLLOWUP_WINDOW_MS=15000
FOLLOWUP_MAX_WAIT_MS=120000
```

`FOLLOWUP_WINDOW_MS=0` mengembalikan perilaku lama (satu mention untuk setiap
peringatan). `FOLLOWUP_MAX_WAIT_MS` membatasi penantian maksimal bila peringatan
terus berdatangan tanpa jeda.

---

## 13. Select WhatsApp Group

Aplikasi mendukung **beberapa group tujuan sekaligus**. Setiap peringatan
diteruskan ke **semua** group yang berstatus aktif, masing-masing dengan pesan
mention-nya sendiri.

`/groups` atau `/admin` → **📱 WhatsApp Group**

```
📱 WHATSAPP GROUP

Pesan dikirim ke SEMUA group bertanda 🟢 (2 aktif).

🟢 IEG BOD
   120363011111111111@g.us
🟢 Testing
   120363410765694312@g.us
⚪ IEG Warehouse
   120363022222222222@g.us

[🟢 IEG BOD]        [🗑️]
[🟢 Testing]        [🗑️]
[⚪ IEG Warehouse]  [🗑️]
[✍️ Tambah Manual]  [🔍 Cari Otomatis]
[⬅️ Kembali]
```

- Ketuk **nama group** untuk mengaktifkan/menonaktifkan. Group nonaktif tetap
  tersimpan tetapi tidak menerima pesan — berguna untuk mematikan sementara
  satu tujuan tanpa kehilangan ID-nya.
- 🗑️ menghapus permanen (selalu dengan konfirmasi).
- **🔍 Cari Otomatis** memuat daftar group dari akun WhatsApp lalu Anda ketuk
  yang ingin ditambahkan.
- **✍️ Tambah Manual** dipakai bila pencarian otomatis gagal (lihat di bawah).

Tidak ada Group ID yang di-hard-code; semuanya tersimpan di tabel `wa_groups`
pada SQLite dan berlaku langsung tanpa restart.

> Versi lama aplikasi hanya menyimpan satu group di tabel `settings`. Saat
> diperbarui, group itu **otomatis dipindahkan** ke daftar baru dan tetap aktif —
> tidak ada yang perlu Anda isi ulang.

### Bila daftar group gagal dimuat

Pada build WhatsApp Web terbaru, `getChats()` bawaan `whatsapp-web.js` kerap
melempar error terminifikasi seperti `r: r` — bug upstream yang belum diperbaiki.
**Pengiriman pesan tetap berfungsi normal**, yang bermasalah hanya pengambilan
daftar chat. Aplikasi ini menanganinya bertingkat:

1. `client.getChats()` — cara resmi
2. bila gagal, membaca halaman WhatsApp Web langsung lewat beberapa jalur
   berurutan: `Store.Chat.getModelsArray`, `Store.Chat.models`,
   `Store.GroupMetadata`, `Store.ChatCollection`, `WWebJS.getChats`
3. bila semuanya gagal, tombol **✍️ Tambah Manual** tetap tersedia

Untuk melihat apa yang sebenarnya tersedia di build WhatsApp Web Anda, jalankan
perintah admin **`/wadiag`** (atau tombol 🩺 Diagnosa di menu Cari Otomatis). Ia
melaporkan versi WhatsApp Web, kunci `window.Store` yang terbaca, dan hasil tiap
jalur pembacaan satu per satu — berguna untuk menargetkan perbaikan tanpa menebak.

**Tambah Manual** menerima dua bentuk:

- **Link undangan group** (paling mudah) — di WhatsApp: buka group → ketuk nama
  group → *Undang lewat tautan* → Salin tautan → tempel ke bot. Bot menerjemahkan
  link itu menjadi Group ID sebenarnya, jadi Anda tidak perlu tahu ID-nya.
- **Group ID langsung**, misal `120363011111111111@g.us`.

Cara lain: sematkan build WhatsApp Web yang masih cocok dengan `whatsapp-web.js`,
tambahkan di `.env` lalu restart:

```env
WA_WEB_VERSION=2.3000.1015901307
```

Daftar versi yang tersedia ada di
<https://github.com/wppconnect-team/wa-version/tree/main/html>.

## 14. Test mention

`/admin` → **🧪 Test** → **🔔 Test Mention**
(atau **📝 Template Pesan** → **🧪 Test**)

Bot langsung mengirim template aktif ke WhatsApp Group dengan REAL mention —
tanpa perlu menunggu pesan Telegram.

**👀 Preview** menampilkan hasil template di Telegram beserta daftar siapa saja
yang akan di-mention, tanpa mengirim apa pun ke WhatsApp.

### Penting: bagaimana REAL mention bekerja

WhatsApp hanya mengenali mention jika **teks pesan memuat `@<nomor>`** dan JID
nomor tersebut ikut dikirim pada opsi `mentions`. Aplikasi WhatsApp penerima yang
menampilkannya sebagai nama kontak. Menulis `@Ibu Jonathan` sebagai teks biasa
**tidak akan pernah** menjadi mention.

Karena itu `{users}` menghasilkan:

```
Dear @6281234567890 & @6289876543210
```

dan dikirim bersama `mentions: ['6281234567890@c.us', '6289876543210@c.us']`.
Di layar penerima, WhatsApp menampilkannya sebagai `@Ibu Jonathan & @Ibu Rika`
(bila nomor tersimpan di kontak) dan yang bersangkutan **menerima notifikasi mention**.

Bila ingin nama tetap terbaca walau nomor tidak tersimpan di kontak penerima:
`/admin` → **⚙️ Pengaturan** → **🔤 Format Mention** → hasilnya menjadi
`Dear Ibu Jonathan @6281234567890 & Ibu Rika @6289876543210`.

Syarat agar mention berbunyi: nomor tersebut **harus anggota WhatsApp Group** itu.

---

## 15. Test forwarding

Dua cara:

1. **Simulasi** — `/admin` → **🧪 Test** → **📨 Simulasi Pesan Telegram**.
   Menjalankan seluruh alur (forward + follow-up) dengan pesan contoh.
2. **Sungguhan** — kirim pesan berikut ke chat Telegram sumber:

   ```
   PERINGATAN STOK SHOPEE
   Ditemukan 110 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).
   ```

Yang **diteruskan** (mengandung keyword, case-insensitive):

- `⚠️ PERINGATAN STOK SHOPEE Ditemukan 110 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).`
- `PERINGATAN TOKOPEDIA — Ditemukan SKU dengan stok tersedia di bawah stok ter-reserve.`
- `DENGAN STOK TERSEDIA DI BAWAH STOK TER-RESERVE`

Yang **diabaikan**:

- `Stock opname selesai.`
- `Stok Shopee normal.`
- `Stok tersedia di atas stok ter-reserve.`
- `Stock hampir habis.`

Hasil di **setiap** WhatsApp Group aktif:

```
Pesan 1
[FORWARDED FROM TELEGRAM]

PERINGATAN STOK SHOPEE
Ditemukan 110 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).

--- jeda 3 detik ---

Pesan 2  (satu kali saja, walau peringatan terpecah beberapa bagian)
Dear @Ibu Jonathan & @Ibu Rika        ← REAL mention

Sesuai informasi diatas, terdapat lock stock yang lebih besar daripada stock saat ini.
Mohon segera lepas Lock Stock sebelum terjadi Oversell.

Note: Pesan ini dikirim oleh Bot WH

Terima kasih.
```

---

## 16. PM2 deployment

```bash
npm install -g pm2

# jalankan (memakai ecosystem.config.js)
pm2 start ecosystem.config.js

# scan QR pertama kali - lihat log
pm2 logs telegram-wa-bridge

# simpan daftar proses
pm2 save
```

Agar hidup otomatis setelah Windows restart:

```bash
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

Di Linux: `pm2 startup` lalu jalankan perintah yang ditampilkan, kemudian `pm2 save`.

> **Login QR pertama lebih mudah dilakukan tanpa PM2.** Jalankan `npm start`,
> scan QR, tunggu `WhatsApp ready`, tekan `Ctrl+C`, baru jalankan PM2 —
> sesi di `.wwebjs_auth/` akan dipakai ulang.

### Agar benar-benar hidup 24 jam di Windows

PM2 saja tidak cukup — penyebab paling sering aplikasi "mati semalam" adalah
**PC tertidur** atau **adapter jaringan dimatikan penghemat daya**. Jalankan
Command Prompt **sebagai Administrator**:

```cmd
:: jangan pernah tidur / hibernate saat tersambung listrik
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0

:: layar boleh mati, itu tidak menghentikan aplikasi
powercfg /change monitor-timeout-ac 10
```

Lalu matikan penghemat daya kartu jaringan:
**Device Manager → Network adapters → klik kanan adapter → Properties →
Power Management → hilangkan centang** *"Allow the computer to turn off this
device to save power"*.

Terakhir, pastikan PM2 ikut hidup setelah Windows restart (lihat perintah
`pm2-startup install` di atas) dan akun Windows-nya **auto-login**, karena PM2
di Windows berjalan di sesi pengguna.

### Kalau koneksi tetap putus

Aplikasi sudah dirancang untuk selamat dari putus koneksi:

- Koneksi akun Telegram diperiksa tiap 60 detik; bila mati, disambung ulang sendiri.
- WhatsApp menyambung ulang bertahap (15 dtk, 30 dtk, … maksimal 5 menit).
- Setiap kali koneksi pulih, setiap kali WhatsApp mencapai status *ready*, dan
  setiap kali aplikasi dijalankan, bot memeriksa pesan terakhir di chat sumber
  dan **meneruskan yang sempat terlewat**
  (bawaan: 25 pesan terakhir, maksimal 3 jam ke belakang). Proteksi duplikat
  memastikan tidak ada pesan yang terkirim dua kali.
- Admin menerima pemberitahuan Telegram saat koneksi putus, saat pulih, dan
  berapa pesan susulan yang ikut diteruskan.

> Saat aplikasi baru dijalankan, Telegram tersambung lebih dulu (beberapa detik)
> daripada WhatsApp yang masih memuat browser. Susulan **ditunda** sampai WhatsApp
> benar-benar *ready*, lalu dijalankan otomatis — sehingga peringatan yang datang
> di celah beberapa detik itu tidak hilang. Log menandainya dengan
> `Susulan DITUNDA: WhatsApp belum siap.`

Atur lewat `.env` bila perlu:

```env
HEALTH_CHECK_MS=60000
CATCHUP_LIMIT=25
CATCHUP_MAX_AGE_MINUTES=180
CATCHUP_ONLY_LATEST=true
```

#### Setelah mati listrik: hanya peringatan terakhir yang dikirim

Bila aplikasi mati beberapa jam lalu hidup kembali, di grup Telegram bisa
menumpuk banyak peringatan yang belum sempat diteruskan. Mengirim semuanya
sekaligus hanya membanjiri WhatsApp Group dengan angka stok yang sudah basi.

Dengan `CATCHUP_ONLY_LATEST=true` (bawaan), susulan bekerja begini:

1. Ambil pesan terakhir tiap chat (sebanyak `CATCHUP_LIMIT`).
2. Saring dengan **kriteria yang sama persis** seperti jalur biasa: chat ada
   di `TELEGRAM_ALLOWED_CHAT_IDS`, keyword cocok, umur pesan masih di dalam
   `CATCHUP_MAX_AGE_MINUTES`, dan belum pernah diteruskan.
3. Dari sisa itu, **hanya yang paling baru** yang dikirim ke WhatsApp.
4. Peringatan lama yang ikut tersaring ditandai sudah diproses, sehingga
   tidak muncul lagi pada susulan berikutnya.

Pesan yang **tidak** memenuhi kriteria (tanpa keyword, chat lain) tidak
disentuh sama sekali. Isi `CATCHUP_ONLY_LATEST=false` bila ingin kembali
menerima seluruh peringatan tertinggal satu per satu.

Di log terlihat sebagai:

```
Susulan chat -1001234567890: 4 peringatan tertinggal, hanya yang terakhir (msg 9704) yang dikirim.
Dilewati (susulan - bukan peringatan terakhir): chat -1001234567890 msg 9701 - tidak dikirim ke WhatsApp.
```

### Memahami `Error: TIMEOUT ... _updateLoop`

Baris ini **bukan** sekadar log idle. GramJS mengirim ping ke Telegram setiap
**9 detik** dengan batas tunggu **10 detik** dan 3 kali percobaan; `Error: TIMEOUT`
berarti ping tidak dijawab dalam 10 detik. Setelah tiga kali gagal, GramJS
menyambung ulang sendiri.

Penyebab paling sering di jaringan kantor: MTProto lewat **TCP polos di port 80**.
Trafik itu tidak terlihat seperti HTTP biasa, sehingga firewall/proxy kerap
mencekik atau membuangnya — persis yang terlihat pada
`connect ETIMEDOUT 91.108.56.174:80`.

Karena itu aplikasi ini memakai **WSS (port 443)** sebagai bawaan: menyerupai
HTTPS biasa dan jauh lebih lolos. Cek jaringan Anda dengan:

```bash
npm run tg:diag
```

Skrip itu menguji DNS, HTTPS ke `api.telegram.org`, lalu menyambung ke empat
server MTProto pada port 80 dan 443, lalu memberi kesimpulan setelan mana yang
cocok untuk jaringan Anda. Semuanya hanya menyambung dan membaca.

Bila hasilnya port 80 justru lebih baik, ubah di `.env`:

```env
TELEGRAM_USE_WSS=false
```

Status koneksi juga terlihat di `/status`: transport yang dipakai, ping terakhir
dalam milidetik, berapa kali sambung ulang, dan berapa kali ping terhitung lambat.

Bila baris GramJS terlalu berisik walau koneksi sehat, setel `GRAMJS_LOG_LEVEL=none`
di `.env` — pemantauan aplikasi sendiri tetap berjalan dan tetap memberi tahu admin
lewat Telegram saat koneksi benar-benar putus.

Perintah harian:

```bash
pm2 status
pm2 logs telegram-wa-bridge --lines 100
pm2 restart telegram-wa-bridge
pm2 stop telegram-wa-bridge
pm2 flush                     # bersihkan log
```

---

## 16b. Windows Service (alternatif PM2, disarankan)

PM2 di Windows berjalan di **sesi pengguna**: bot ikut mati bila Anda logout,
dan butuh auto-login agar hidup setelah restart. Windows Service tidak punya
batasan itu.

| | PM2 | Windows Service |
|---|---|---|
| Boleh logout / ganti user | ❌ ikut mati | ✅ tetap jalan |
| Perlu auto-login Windows | ✅ ya | ❌ tidak |
| Hidup sebelum ada yang login | ❌ tidak | ✅ ya |
| QR WhatsApp | di terminal | dikirim ke Telegram |

### Pemasangan

```bash
npm install node-windows        # sekali saja
```

Lalu buka **Command Prompt sebagai Administrator** — ini wajib:

1. Tekan tombol Windows, ketik `cmd`
2. Klik kanan **Command Prompt** → **Run as administrator**
3. Masuk ke folder project dan pasang:

```cmd
cd /d "C:\Users\EJI\Claude\Projects\INV IEG\telegram-wa-bridge"
npm run service:install
```

> Git Bash biasa **tidak cukup**. Tanpa hak Administrator, Windows menolak
> pendaftaran service secara diam-diam. Skrip ini memeriksanya lebih dulu dan
> menolak berjalan, lalu setelah memasang ia bertanya balik ke Windows lewat
> `sc query` — jadi laporan "berhasil" benar-benar berarti terpasang.

Skrip memeriksa `.env` lebih dulu, memasang service bernama
**Telegram WA Bridge**, lalu menjalankannya.

Perintah `net` dan `sc` memakai **ID service**, bukan nama tampilannya.
ID-nya adalah nama tanpa spasi ditambah `.exe`:

```cmd
net stop telegramwabridge.exe
net start telegramwabridge.exe
sc query telegramwabridge.exe
```

Memakai nama tampilan akan ditolak dengan *"The service name is invalid"*.
Lewat `services.msc`, cari entri **Telegram WA Bridge** dan kelola dari sana.

Menghapusnya:

```cmd
npm run service:uninstall
```

Data, sesi WhatsApp, dan `.env` tidak ikut terhapus.

### QR saat berjalan sebagai service

Service tidak punya terminal, jadi QR tidak bisa ditampilkan di layar. Bot
mengirimkannya sebagai **gambar ke seluruh admin lewat Telegram** — pindai
langsung dari layar HP atau komputer lain. Perlu library gambar QR:

```bash
npm install qrcode
```

Bila belum terpasang, bot tetap memberi tahu admin dan menyebutkan cara
memindai lewat `npm start`.

> **Cara paling mulus:** scan QR dulu lewat `npm start` di terminal, tunggu
> `WhatsApp ready`, tekan `Ctrl+C`, baru pasang service. Sesi sudah tersimpan
> sehingga service langsung jalan tanpa perlu QR sama sekali.

### Perbedaan shell: cmd, PowerShell, Git Bash

Perintah service berbeda di tiap shell. Yang paling sering menjebak:

| Maksud | Command Prompt | PowerShell | Git Bash |
|---|---|---|---|
| Pindah folder | `cd /d "C:\path"` | `cd "C:\path"` | `cd "/c/path"` |
| Jalankan exe di folder ini | `program.exe` | `.\program.exe` | `./program.exe` |
| Service Control | `sc query x` | **`sc.exe query x`** | `sc query x` |
| Matikan proses | `taskkill /F /IM chrome.exe` | `taskkill /F /IM chrome.exe` | `taskkill //F //IM chrome.exe` |

> Di PowerShell, `sc` adalah alias untuk `Set-Content` — bukan Service Control.
> Menulis `sc query ...` di sana tidak menghasilkan error yang jelas, hanya
> perilaku yang membingungkan. Selalu tulis **`sc.exe`**.

Cek apakah jendela sudah Administrator:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

`True` berarti sudah. Cara teraman menghindari semua perbedaan ini: pakai
`npm run service:install` dan `npm run service:status` dari folder project —
keduanya jalan sama di ketiga shell.

### Bila service tidak pernah terdaftar

Gejalanya: pemasangan terlihat berjalan, folder `src/daemon/` terbuat, aplikasi
bahkan sempat jalan — tetapi `sc query telegramwabridge.exe` menjawab
*"The specified service does not exist"*. Yang jalan tadi hanyalah proses anak
dari skrip install, bukan service sungguhan; ia mati begitu skrip selesai.

Penyebab tersering: **jalur project mengandung spasi**. Helper elevasi bawaan
`node-windows` kerap gagal diam-diam pada jalur seperti
`C:\Users\EJI\Claude\Projects\INV IEG\...`.

Skrip ini sudah punya jalur cadangan — bila node-windows gagal, ia mendaftarkan
sendiri lewat WinSW. Bila tetap gagal, daftarkan manual dari Command Prompt
**sebagai Administrator**:

```cmd
cd /d "C:\Users\EJI\Claude\Projects\INV IEG\telegram-wa-bridge\src\daemon"
telegramwabridge.exe install
sc start telegramwabridge.exe
```

Kalau masih menolak, pindahkan project ke jalur tanpa spasi
(mis. `C:\bot\telegram-wa-bridge`) lalu ulangi `npm run service:install`.

Periksa kapan saja dengan:

```bash
npm run service:status
```

Perintah itu menampilkan status service sekaligus 25 baris terakhir
`data/app.log`.

### Bila Chrome gagal jalan sebagai service

Service berjalan sebagai **LocalSystem**. Pada sebagian mesin, Chrome menolak
dijalankan dari akun itu. Solusinya jalankan service sebagai akun Windows biasa
— tambahkan di `.env` lalu pasang ulang service:

```env
SERVICE_ACCOUNT=nama_user_windows
SERVICE_PASSWORD=sandi_windows
```

Akun tersebut perlu hak **Log on as a service**
(`secpol.msc` → Local Policies → User Rights Assignment → Log on as a service).

### Log

Karena service tidak punya terminal, aplikasi menulis lognya sendiri ke
**`data/app.log`** (berputar pada 5 MB, satu berkas cadangan `app.log.1`).
Ini sumber informasi utama saat berjalan sebagai service:

```bash
tail -f data/app.log            # Git Bash
powershell Get-Content data\app.log -Wait -Tail 50
```

Matikan dengan `LOG_FILE=off`, atau arahkan ke tempat lain lewat `LOG_FILE=`.

Pembungkus service (`node-windows`) juga menulis lognya sendiri ke
`src/daemon/`. Isinya lebih teknis dan berguna bila service gagal jalan sama
sekali — misalnya `node.exe` tidak ditemukan.

### Bila service jalan tapi bot diam

1. Buka `data/app.log`. Kalau kosong, prosesnya tidak pernah sampai berjalan —
   periksa `src/daemon/`.
2. Kirim `/status` ke bot. Ini menjawab apakah Telegram dan WhatsApp tersambung.
3. Belum pernah scan QR di mesin ini? Periksa Telegram — QR dikirim ke sana.

---

## 17. Restart

| Situasi | Tindakan |
|---|---|
| Ubah `.env` | `pm2 restart telegram-wa-bridge`, atau `net stop`/`net start` bila memakai Windows Service |
| Ubah user / template / group | **Tidak perlu restart** — langsung berlaku |
| Ubah jeda pesan | Lewat Admin Menu → langsung berlaku |
| WhatsApp terputus | Otomatis menyambung ulang (15 dtk, 30 dtk, … maks 5 menit) |
| Akun Telegram terputus | Diperiksa tiap 60 dtk, disambung ulang otomatis, pesan tertinggal disusulkan |
| Ganti nomor WhatsApp bot | Stop → hapus `.wwebjs_auth` → start → scan QR baru |

Restart **tidak pernah menghapus** `data/bot.db`.

---

## 18. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `TELEGRAM_BOT_TOKEN belum diisi` | `.env` belum dibuat/diisi. Salin dari `.env.example` |
| Bot diam padahal ada pesan dari **bot lain** | Batas platform Telegram — bot tidak bisa membaca pesan bot lain. Pakai `TELEGRAM_SOURCE=user` (bab 5b) |
| Bot diam di grup Telegram (pesan dari manusia) | Group Privacy masih aktif → @BotFather `/setprivacy` → Disable, lalu keluarkan & masukkan lagi bot ke grup |
| `Belum ada sesi akun Telegram` | Jalankan `npm run tg:login` |
| `AUTH_KEY_UNREGISTERED` / sesi kedaluwarsa | Sesi dicabut (mis. Anda logout perangkat di app Telegram). Jalankan ulang `npm run tg:login` |
| `API_ID_PUBLISHED_FLOOD` | `api_id` bukan milik Anda. Ambil sendiri di my.telegram.org |
| `PHONE_CODE_INVALID` | Kode salah/kedaluwarsa. Ulangi `npm run tg:login` |
| Akun kena status "limited" | Cek ke [@SpamBot](https://t.me/SpamBot), banding ke recover@telegram.org |
| Chat ID tidak cocok | Aplikasi mentoleransi bentuk `-100xxx` maupun `xxx`. Pastikan ID diambil dari `npm run tg:chats` |
| Pesan tidak diteruskan | Cek `TELEGRAM_ALLOWED_CHAT_IDS` (kirim `/id` di chat sumber); cek `/status`; cek Forwarding di Pengaturan |
| QR tidak muncul | Tunggu 40 detik; cek `pm2 logs`; pastikan Chromium terunduh saat `npm install` |
| `Could not find Chrome (ver. ...)` | Chromium bawaan Puppeteer belum terunduh. Aplikasi otomatis mencoba Chrome/Edge yang sudah terpasang; bila tetap gagal lihat bagian **Browser WhatsApp Web** di bawah |
| `browser folder exists but the executable is missing` | Unduhan sebelumnya terputus. Hapus folder itu lalu unduh ulang (lihat di bawah) |
| `The browser is already running for ...` | Proses Chrome lama masih mengunci folder sesi. Aplikasi menutup paksa & membersihkan kunci sendiri; bila tetap muncul jalankan `taskkill /F /IM chrome.exe` lalu start ulang |
| `disconnected: LOGOUT` | Sesi dicabut. Hapus `WA_WEB_VERSION` dari `.env` bila baru diset, lalu `npm run wa:reset` dan scan QR baru |
| `EBUSY: resource busy or locked, unlink ...` | Chrome masih memegang berkas sesi saat dibersihkan. Aplikasi menutup paksa lebih dulu sekarang; bila tetap muncul jalankan `npm run wa:reset` |
| Berhenti di `WhatsApp authenticated` | Injeksi WhatsApp Web menggantung. Aplikasi membangun ulang otomatis setelah 120 detik; bila berulang setel `WA_WEB_VERSION` |
| `sc query: service does not exist` (1060) | Service tidak terpasang. Ulangi `npm run service:install` dari Command Prompt **sebagai Administrator** |
| `LookupAccountName failed: 1332` + `Failed to set logon as a service right` | XML service memuat akun tidak sah (`MESIN\LocalSystem`). Skrip versi baru membersihkannya sendiri — ulangi `npm run service:install`. Manual: hapus blok `<serviceaccount>` dari XML di `src/daemon/` lalu install lagi |
| `Service dengan nama ini sudah ada` padahal `sc query` bilang tidak ada | node-windows menilainya dari folder `src/daemon`, bukan daftar service. Versi baru skrip memverifikasi ke Windows lalu mendaftarkan sendiri — cukup ulangi `npm run service:install` |
| PowerShell: `cd /d` ditolak | `/d` khusus cmd. Di PowerShell cukup `cd "C:\path"` |
| PowerShell: `sc` berperilaku aneh | `sc` adalah alias `Set-Content`. Tulis `sc.exe query ...` |
| `bash: telegramwabridge.exe: command not found` | Di Git Bash program lokal butuh `./` di depan: `./telegramwabridge.exe install` |
| `net stop: The service name is invalid` | Pakai ID service, bukan nama tampilan: `net stop telegramwabridge.exe` |
| `taskkill: Invalid argument/option - 'F:/'` | Anda memakai Git Bash. Pakai garis miring ganda: `taskkill //F //IM chrome.exe` |
| `Attempted to use detached Frame` | Halaman WhatsApp Web memuat ulang. Aplikasi memulihkan sendiri dalam ~30 detik tanpa scan QR — lihat bagian di atas |
| `Failed to launch the browser process` | Isi `CHROME_PATH` di `.env` dengan path `chrome.exe` |
| `WhatsApp authentication failed` | Hapus folder `.wwebjs_auth` lalu jalankan ulang & scan QR |
| Sering `disconnected` | HP pengirim harus online berkala; jangan buka WhatsApp Web di browser lain dengan nomor yang sama |
| `getaddrinfo ENOTFOUND api.telegram.org` | PC kehilangan internet (sering karena tertidur). Lihat **Agar benar-benar hidup 24 jam di Windows** di bab 16 |
| `Error: TIMEOUT ... _updateLoop` | Ping 10 detik ke Telegram tidak dijawab. Jalankan `npm run tg:diag`; biasanya port 80 dicekik firewall → pastikan `TELEGRAM_USE_WSS=true` |
| `[WebSocket connection failed attempt: N]` | GramJS sedang menyambung ulang. Wajar sesekali; bila terus-menerus jalankan `npm run tg:diag` |
| Pesan mention terkirim 2x untuk satu peringatan | Peringatan terpecah jadi beberapa bagian. Naikkan **⏳ Jendela Follow-up** di Pengaturan (bawaan 15 detik) |
| Pesan mention terasa lambat | Turunkan `FOLLOWUP_WINDOW_MS`; `0` = kirim langsung tiap peringatan |
| Pesan semalam tidak diteruskan | Naikkan `CATCHUP_MAX_AGE_MINUTES` di `.env` agar jendela susulan lebih panjang |
| Mention tidak berbunyi | Nomor belum menjadi anggota Group tujuan, atau salah format (harus `62…`, tanpa `+`, tanpa `0`) |
| Mention tampil sebagai nomor, bukan nama | Normal — nama muncul bila nomor tersimpan di kontak penerima. Gunakan Format Mention = nama + nomor |
| `Target WhatsApp Group belum dipilih` | `/groups` → tekan `Use: <nama group>` |
| `Gagal mengambil daftar group: r` | Bug upstream whatsapp-web.js pada WhatsApp Web terbaru. Pakai **✍️ Isi Manual** dengan link undangan group, atau setel `WA_WEB_VERSION` — lihat bab 13 |
| `better-sqlite3` gagal build (`gyp ERR! find Python`) | Wajar di Node 24 — binary siap pakainya belum ada. Paket ini opsional; aplikasi otomatis memakai `node:sqlite` bawaan Node. Ingin memakainya? Pasang Node 22 LTS |
| Pesan terkirim dobel | Tidak mungkin dari aplikasi ini (anti-duplikat per `chat_id + message_id`). Periksa apakah ada dua instance berjalan: `pm2 status` |

### `WhatsApp disconnected: LOGOUT` — sesi dicabut

Ini **bukan** putus koneksi biasa: sesinya benar-benar hilang dan menyambung
ulang dengan sesi lama percuma. Dua penyebab tersering:

1. **Perangkat tertaut dilepas dari HP.** Menghapus "perangkat tertaut" milik bot
   di WhatsApp HP akan mencabut sesinya. Jangan lakukan itu kecuali memang ingin
   login ulang.
2. **`WA_WEB_VERSION` yang disematkan terlalu lama.** WhatsApp menolak klien web
   usang dan memaksa logout. Bila baru saja menyetel variabel ini lalu muncul
   LOGOUT, **hapus baris itu dari `.env`** dan jalankan ulang.

Aplikasi menanganinya otomatis: browser ditutup paksa (agar berkas profil dilepas
dan tidak muncul `EBUSY: resource busy or locked`), folder sesi dihapus, lalu
QR baru ditampilkan di terminal. Admin juga diberi tahu lewat Telegram bahwa
peringatan stok tidak akan diteruskan sampai QR dipindai.

Bila perlu dibersihkan manual:

```bash
# hentikan aplikasi (Ctrl+C) lebih dulu
taskkill //F //IM chrome.exe      # Git Bash; di CMD pakai satu garis miring
npm run wa:reset
npm start                          # lalu scan QR yang muncul
```

`npm run wa:reset` hanya menghapus sesi WhatsApp. Data user, template, dan daftar
group di `data/bot.db` tetap utuh.

> **Catatan penting soal `WA_WEB_VERSION`:** jangan menyematkannya kalau tidak
> sedang bermasalah. Pinning hanya dipakai sebagai upaya terakhir ketika
> WhatsApp macet di `authenticated`, dan pilih build yang **tidak terlalu jauh**
> di belakang versi terbaru.

### Macet di `authenticated`, tidak pernah `ready`

Kadang log berhenti tepat setelah:

```
[INFO ] [WA] WhatsApp authenticated
```

dan `WhatsApp ready` tidak pernah muncul. Penyebabnya injeksi internal
`whatsapp-web.js` menggantung karena build WhatsApp Web tidak cocok — sekeluarga
dengan bug `getChats: r`. Bot diam total tanpa satu pun pesan error.

Aplikasi ini menjaganya: bila `ready` tak kunjung datang dalam
`WA_READY_TIMEOUT_MS` (bawaan 120 detik), koneksi dibangun ulang otomatis dan
admin diberi tahu lewat Telegram. Setiap kemajuan `loading_screen` mengulur batas
waktu, jadi sinkronisasi yang memang lama tidak ikut dipotong.

Bila terus berulang, sematkan build WhatsApp Web yang cocok di `.env`:

```env
WA_WEB_VERSION=2.3000.1015901307
```

Bila perlu bersihkan sisa proses Chrome lebih dulu. **Di Git Bash** garis miring
tunggal akan diterjemahkan menjadi path, jadi pakai garis miring ganda:

```bash
taskkill //F //IM chrome.exe
```

Di Command Prompt biasa, satu garis miring sudah benar:

```cmd
taskkill /F /IM chrome.exe
```

### Halaman WhatsApp Web terlepas (`detached Frame`)

WhatsApp Web kadang memuat ulang dirinya sendiri — setelah pembaruan, setelah
menganggur lama, atau ketika sesi dipindahkan. Bila itu terjadi, Puppeteer
kehilangan pegangan ke halaman lama dan **semua** panggilan gagal dengan pesan
seperti:

```
Attempted to use detached Frame 'CA81E69EF89524A061BBDC707F9991E3'.
Execution context was destroyed, most likely because of a navigation
Protocol error (Runtime.callFunctionOn): Target closed
```

Berbahayanya: status bot tetap tampak 🟢 hijau padahal **pengiriman pesan pun
ikut gagal**. Karena itu aplikasi ini:

- memeriksa halaman setiap 60 detik (`HEALTH_CHECK_MS`);
- mendeteksi pola error di atas pada pemeriksaan, saat mengirim, dan saat
  membaca daftar group;
- membangun ulang klien WhatsApp secara otomatis. Sesi `.wwebjs_auth` tetap
  dipakai sehingga **tidak perlu scan QR ulang**;
- memberi tahu admin lewat Telegram, dan menampilkan jumlah pemulihan di `/status`.

Peringatan yang gagal terkirim saat itu **tidak** ditandai terproses, sehingga
ikut disusulkan begitu koneksi pulih.

Saat memulihkan, aplikasi menutup Chrome lama **secara paksa** (`destroy()` saja
tidak cukup bila halaman sudah terlepas — prosesnya tetap hidup dan mengunci
folder profil) lalu membersihkan berkas kunci yang tertinggal
(`SingletonLock`, `lockfile`, dan sejenisnya). Tanpa itu percobaan berikutnya
ditolak dengan:

```
The browser is already running for ...\.wwebjs_auth\session-telegram-wa-bridge.
Use a different `userDataDir` or stop the running browser first.
```

Bila pesan itu tetap muncul setelah beberapa percobaan, ada Chrome lain yang
memegang folder sesi. Hentikan aplikasi, lalu di Command Prompt:

```cmd
taskkill /F /IM chrome.exe
```

dan jalankan ulang.

### Browser WhatsApp Web

`whatsapp-web.js` menjalankan WhatsApp Web di dalam Chromium lewat Puppeteer.
Bila Chromium bawaannya tidak ada, aplikasi **otomatis mencari Chrome atau Edge
yang sudah terpasang** di komputer dan memakainya, sambil menuliskan path-nya di log.
Kalau tidak ada satu pun, tempuh salah satu cara berikut.

**Cara 1 — unduh Chromium bawaan**

```bash
npx puppeteer browsers install chrome
```

Bila muncul `browser folder exists but the executable is missing`, berarti unduhan
sebelumnya terputus. Hapus foldernya dulu, lalu ulangi:

```bash
# Git Bash
rm -rf ~/.cache/puppeteer/chrome

# Command Prompt Windows
rmdir /s /q "%USERPROFILE%\.cache\puppeteer\chrome"
```

**Cara 2 — pakai Chrome/Edge yang sudah ada** (tanpa unduhan, cocok bila jaringan
kantor memblokir)

Tambahkan satu baris ke `.env`:

```env
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Alternatif Edge (hampir selalu ada di Windows):

```env
CHROME_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Cek dulu berkasnya benar-benar ada:

```bash
ls "/c/Program Files/Google/Chrome/Application/chrome.exe"
ls "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
```

---

Log lebih detail: set `LOG_LEVEL=debug` di `.env` lalu restart.

---

## 19. Backup database

Seluruh data (user, template, group, riwayat anti-duplikat) ada di satu file:
`data/bot.db`.

```bash
npm run db:backup     # menyalin ke backups/bot-YYYYMMDD-HHMMSS.db
```

Atau manual (hentikan aplikasi lebih dulu agar salinan konsisten):

```bash
copy data\bot.db D:\backup\bot-20260821.db
```

Restore: hentikan aplikasi → timpa `data/bot.db` dengan file backup → jalankan lagi.

**Jangan** ikut membackup `data/telegram-user.session` ke tempat yang dibagikan —
file itu kredensial akun Telegram Anda. Bila hilang, cukup jalankan `npm run tg:login` lagi.

Disarankan backup mingguan, dan selalu sebelum update aplikasi.

Catatan: `data/`, `.env`, `.wwebjs_auth/`, dan `node_modules/` **tidak pernah**
masuk Git (lihat `.gitignore`).

---

## 20. Security considerations

- **Tidak ada kredensial di dalam kode.** Token, admin ID, dan allowed chat ID
  hanya di `.env`; nomor user, template, dan Group ID hanya di SQLite.
- **Token tidak pernah ditampilkan** di Admin Menu — hanya `••••••••`.
  Nomor akun WhatsApp bot ditampilkan tersamar (`6281****890`).
- **Otorisasi di sisi server** pada setiap perintah dan setiap callback tombol.
  Menyembunyikan tombol tidak dianggap pengamanan.
- **Sesi WhatsApp** (`.wwebjs_auth/`) dan **sesi akun Telegram**
  (`data/telegram-user.session`) setara akses penuh ke akun masing-masing —
  jangan pernah di-commit, di-zip, atau dikirim ke siapa pun. Keduanya sudah
  masuk `.gitignore`.
- **Mode akun bersifat read-only** dan dikunci oleh uji otomatis: modul akun
  tidak boleh memuat fungsi kirim/join/forward apa pun.
- **Chat allowlist** membatasi sumber pesan; isi selalu di produksi.
- **Anti-duplikat** mencegah pesan yang sama terkirim dua kali.
- **Beberapa group tujuan**: pesan tetap dikirim serial lewat satu antrean dengan
  jeda, jadi menambah group tidak menaikkan risiko pola pengiriman mencurigakan —
  hanya memperpanjang antrean.
- **Rate limit** (minimal 3 detik, antrean serial) menjaga akun dari pola
  pengiriman yang mencurigakan. Aplikasi ini untuk notifikasi internal
  bervolume rendah — **jangan** dipakai untuk broadcast massal.
- **Satu arah** — tidak ada pembacaan pesan WhatsApp, sehingga tidak ada loop
  dan tidak ada data WhatsApp yang keluar ke Telegram.
- `whatsapp-web.js` adalah library tidak resmi. Gunakan nomor perusahaan khusus
  bot, bukan nomor pribadi.

---

## Pengujian

```bash
npm test
```

Menjalankan 187 uji otomatis (filter, validasi nomor, template & mention, antrean
& jeda, database, integrasi penuh Admin Menu, banyak group tujuan,
ketahanan daftar group,
pencarian browser WhatsApp, penggabungan peringatan terpecah,
sambung ulang & susulan pesan, serta
sumber mode akun termasuk pemeriksaan jaminan read-only) memakai stub — **tidak** ada
koneksi ke WhatsApp maupun Telegram sungguhan, dan `data/bot.db` produksi tidak
tersentuh (uji memakai file sementara).

---

## Keyword

Satu-satunya pemicu forwarding, didefinisikan di `src/filter.js`:

```js
const KEYWORD = 'dengan stok tersedia di bawah stok ter-reserve';
messageText.toLowerCase().includes(KEYWORD.toLowerCase());
```

Tidak ada keyword lain. Tidak ada syarat tambahan berupa "PERINGATAN STOK SHOPEE",
"Pusat", jumlah SKU, tanggal, emoji, Markdown, maupun HTML.

---

## 21. Laporan berkala IEG OCS (Fulfilment Dashboard)

Selain meneruskan peringatan dari Telegram, aplikasi ini dapat menarik data
**Fulfilment Dashboard** dari https://ocs.iegsystem.id secara berkala lalu
mengirim ringkasannya ke WhatsApp Group yang sama.

### 21.1 Cara kerja

1. Login ke OCS: `POST /Auth/Login` dengan `{username, password, companydb}`
   dan mendapat **JWT** (`Token`).
2. Setiap permintaan data memakai header `Authorization: Bearer <token>`.
   Bila token kedaluwarsa (HTTP 401), aplikasi memanggil `POST /Auth/Refresh`
   memakai cookie lalu mengulang permintaan **satu kali**. Bila itu pun gagal,
   aplikasi login ulang dari awal.
3. Data diambil dari tujuh endpoint (seluruhnya **GET**, tidak ada yang
   mengubah data di OCS):

   | Bagian | Endpoint |
   |---|---|
   | Ringkasan SLA | `/FulfilmentDashboard/Summary` |
   | WIP per tahap | `/FulfilmentDashboard/StatusBuckets` |
   | Funnel status | `/FulfilmentDashboard/PipelineFunnel` |
   | Aging order | `/FulfilmentDashboard/Aging` |
   | Throughput | `/FulfilmentDashboard/Throughput` |
   | Leaderboard | `/FulfilmentDashboard/Leaderboard` |
   | Cycle time | `/FulfilmentDashboard/CycleTime` |

4. Hasilnya disusun menjadi satu pesan lalu masuk **antrean yang sama** dengan
   jalur Telegram, sehingga tidak pernah ada dua pengiriman WhatsApp bersamaan.

Bagian yang gagal diambil tidak menggagalkan seluruh laporan - bagian itu
ditandai di kaki pesan dan sisanya tetap dikirim.

### 21.2 Rentang tanggal

Preset **Hari Ini** ditiru persis seperti tombol di halaman web:

```
from = 00:00 waktu lokal hari ini   -> dikirim sebagai UTC
to   = 00:00 waktu lokal besok      -> dikirim sebagai UTC
```

Contoh untuk WIB (UTC+7) pada 26 Agustus 2026:
`from=2026-08-25T17:00:00.000Z`, `to=2026-08-26T17:00:00.000Z`.

Zona waktu diatur lewat `OCS_TZ_OFFSET_MINUTES` (420 = WIB). Batas hari
**tidak** memakai UTC, sehingga laporan pukul 00:30 WIB tetap melaporkan
hari yang benar.

### 21.3 Pengaturan di .env

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `OCS_ENABLED` | `false` | Nyalakan fitur ini |
| `OCS_BASE_URL` | `https://ocs.iegsystem.id` | Alamat OCS |
| `OCS_USERNAME` / `OCS_PASSWORD` | - | Kredensial login |
| `OCS_DATABASE` | `EJI_WMS` | Isian **Database** di halaman login |
| `OCS_GROUP_IDS` | kosong | Kosong = semua group aktif. Diisi = group khusus laporan (JID atau nama, dipisah koma) |
| `OCS_INTERVAL_MINUTES` | `60` | Jeda antar laporan |
| `OCS_ALIGN_TO_HOUR` | `true` | Laporan jatuh di menit `:00` |
| `OCS_ACTIVE_HOURS` | `7-21` | Jam kerja saja. Kosongkan = 24 jam |
| `OCS_TZ_OFFSET_MINUTES` | `420` | 420 = WIB, 480 = WITA, 540 = WIT |
| `OCS_DATE_TYPE` | `dueDate` | `dueDate` = Batas Kirim, `createdDate` = Tanggal Pesanan |
| `OCS_SHOP` / `OCS_CHANNEL` / `OCS_AREA` / `OCS_SHIFT` / `OCS_ROLE` | `All` / `all` | Filter, sama persis dengan halaman web |
| `OCS_TOP_OPERATORS` | `10` | Jumlah operator teratas di pesan. `0` = jangan tampilkan |
| `OCS_LEADERBOARD_PERIOD` | `month` | `month` = rata-rata per hari bulan berjalan, `today` = hanya hari ini |
| `OCS_LEADERBOARD_ROLES` | `packer,picker` | Peran yang masuk peringkat. Kosongkan = semua peran |
| `OCS_LEADERBOARD_EXCLUDE` | `mesin` | Buang operator yang namanya memuat kata ini |
| `OCS_TITLE` | `FULFILMENT DASHBOARD` | Judul pesan |
| `OCS_ONLY_WHEN_PROBLEM` | `false` | `true` = kirim hanya bila ada masalah |
| `OCS_ALERT_BREACHED_SLA` | `1` | Ambang SLA terlewat untuk mode di atas |
| `OCS_ALERT_AT_RISK` | `1` | Ambang order mendekati SLA |
| `OCS_ALERT_INSTAN` | `1` | Ambang instan belum dikirim |

### 21.4 Group khusus laporan (opsional)

Bila laporan per jam sebaiknya tidak bercampur dengan peringatan stok, kirimkan
ke group tersendiri:

1. Buat group WhatsApp baru, masukkan nomor bot sebagai anggota.
2. Di Telegram: `/groups` ▸ **✍️ Tambah Manual** ▸ tempel link undangan group.
   Bot akan menampilkan **JID**-nya (`1203...@g.us`).
3. Matikan tombolnya menjadi ⚪ supaya group itu **tidak** menerima peringatan
   stok dari Telegram.
4. Isi JID tadi ke `OCS_GROUP_IDS` di `.env`, lalu jalankan ulang aplikasi.

Group yang disebut di `OCS_GROUP_IDS` **tidak harus aktif** - bahkan boleh belum
pernah didaftarkan sama sekali, asalkan yang ditulis berupa JID dan nomor bot
sudah menjadi anggota group tersebut.

### 21.5 Uji dulu sebelum dijadwalkan

```cmd
npm run ocs:test
```

Perintah ini login, mengambil seluruh bagian dashboard, dan **mencetak pesan
yang akan dikirim** ke layar. Tidak ada satu pun pesan WhatsApp yang terkirim.
Tambahkan `-- --raw` untuk melihat JSON mentah tiap bagian:

```cmd
npm run ocs:test -- --raw
```

Jalankan ini setiap kali mengubah filter di `.env`.

### 21.6 Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/ocs` | Ambil data dan kirim laporan **sekarang** (menembus tombol mati dan jam aktif) |
| `/ocsstatus` | Jadwal, waktu keberhasilan terakhir, jumlah terkirim/gagal |
| `/ocson` | Nyalakan laporan berkala |
| `/ocsoff` | Matikan laporan berkala (tersimpan di database, bertahan setelah restart) |

`/ocson` dan `/ocsoff` menulis ke tabel `settings` (kunci `ocs_enabled`),
sehingga nilainya menang atas `OCS_ENABLED` di `.env`.

### 21.7 Isi pesan

```
*FULFILMENT DASHBOARD - HARI INI*
Rabu, 26 Agu 2026 - 11:00 WIB
Filter: Batas Kirim | Channel All | Shop All | Area All

*SLA & PENGIRIMAN*
- SLA terlewat: *4*
- Mendekati SLA (<=6 jam): 0
- ...

*WIP PER TAHAP*      (tahap dengan jumlah 0 tidak ditampilkan)
*AGING ORDER*
*THROUGHPUT (SELESAI)*
*TOP 3 OPERATOR*
*RATA-RATA PER TAHAP*
```

### 21.9 Peringkat operator

Bagian peringkat memakai rentang waktunya sendiri, terpisah dari sisa laporan:

- Sisa laporan (SLA, WIP, aging, cycle) = **hari ini**
- Peringkat operator = **bulan berjalan**, tanggal 1 pukul 00:00 waktu lokal
  sampai akhir hari ini

Angka yang diurutkan adalah **rata-rata per hari operasi**, bukan total. Pembagi
`hari operasi` hanya menghitung hari yang benar-benar ada hasilnya di
`/FulfilmentDashboard/Throughput`, sehingga hari libur atau gudang tutup tidak
menurunkan rata-rata secara tidak adil.

```
*TOP 10 PACKER & PICKER - RATA-RATA/HARI*
_1-26 Agu 2026, 23 hari operasi_
1. BUDI (packer): 200/hari - total 4.600
```

Penyaringan dilakukan di sisi aplikasi, bukan lewat parameter `role` milik OCS,
supaya beberapa peran bisa digabung sekaligus. Nama peran harus sama persis
dengan yang dipakai OCS - jalankan `npm run ocs:test` dan lihat baris
**"Peran yang ADA"** untuk memastikannya.

### 21.8 Kalau gagal

| Gejala | Sebab yang paling sering |
|---|---|
| `Login OCS gagal (HTTP 401)` | Username/password/database salah. Coba login manual di browser |
| `getaddrinfo EAI_AGAIN` | Mesin tidak bisa menghubungi ocs.iegsystem.id (DNS/firewall kantor) |
| `Waktu tunggu habis` | OCS lambat - naikkan `OCS_TIMEOUT_MS` |
| `belum ada WhatsApp Group aktif` | Buka `/groups` di Telegram lalu aktifkan satu group |
| `WhatsApp belum tersambung` | Sesi WhatsApp sedang dipulihkan - laporan berikutnya akan normal |

Kegagalan laporan dikirim sebagai notifikasi ke admin Telegram, dan detailnya
selalu ada di log aplikasi.

---

## 22. Laporan Stok Menipis

Menarik dua halaman OCS lalu menggabungkannya menjadi satu daftar
"SKU apa yang sebentar lagi habis":

| Sumber | Halaman OCS | Dipakai untuk |
|---|---|---|
| `GET /odata/DTO_WmsItemStockLiteV2` | Stocks > View V2 | SKU, Available Qty, Category, Status |
| `GET /Report/OrderPerSkuReport` | Report > Order > Sku | penjualan harian per SKU |

Keduanya **hanya dibaca**. Tidak ada satu pun permintaan yang mengubah
data di OCS, dan ada uji otomatis yang menjaganya tetap begitu.

### 22.1 Penyaringan - DOI, bukan jumlah stok

Kriteria utamanya **DOI** (Days of Inventory):

```
DOI = Available Qty / rata-rata penjualan harian
```

Bawaannya menampilkan SKU dengan **DOI di bawah 7 hari** (`/stokdoi 7`).

Kenapa bukan ambang jumlah seperti sebelumnya? Dari 392 SKU aktif
kategori Sku di data Anda:

| | |
|---|---|
| Di bawah 1.000 (kriteria lama) | 233 |
| Di atas 1.000 (tidak pernah terlihat) | 159 |

Ambang jumlah salah di dua arah sekaligus. **233 SKU terlalu banyak** -
laporan hanya memuat 20, dan sebagian besar sisanya barang lambat yang
stok 300-nya cukup untuk berbulan-bulan. Sementara **159 SKU di atas
1.000 tidak pernah muncul**, padahal SKU yang laku 500/hari dengan stok
2.000 akan habis dalam 4 hari - justru yang paling mendesak.

DOI menjawab pertanyaan yang sebenarnya: *kapan habis*.

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `STOCK_DOI_MAX` | `7` | Tampilkan SKU dengan DOI di bawah sekian hari. `0` = matikan |
| `STOCK_THRESHOLD` | `0` | Batas jumlah stok. `0` = tanpa batas. Bisa dihidupkan lagi kapan saja |
| `STOCK_MIN_AVG` | `0` | Abaikan SKU yang rata-ratanya di bawah ini. `0` = tampilkan semua |
| `STOCK_SALES_DAYS` | `30` | Jendela penjualan. Pakai kelipatan ~30 (30/60/90) |
| `STOCK_CHUNK_DAYS` | `15` | Besar tiap permintaan ke OCS. Turunkan bila masih 504 |
| `STOCK_CATEGORY` | `Sku` | Kategori di View V2 |
| `STOCK_ACTIVE_ONLY` | `true` | Hanya status aktif |

Dua hal yang perlu diketahui tentang perilakunya:

- **SKU tanpa penjualan tidak pernah muncul.** DOI-nya tak terhingga -
  stoknya memang rendah, tetapi tidak ada yang membelinya sehingga tidak
  akan habis. Menampilkannya hanya jadi alarm palsu.
- **SKU yang lakunya sangat jarang bisa memenuhi kriteria.** Barang yang
  laku 5 pcs dalam 90 hari lalu stoknya habis akan dapat DOI 0 dan naik
  ke urutan teratas, padahal dampaknya kecil. `STOCK_MIN_AVG=1`
  (`/stokminavg 1`) menyingkirkannya. Bawaannya mati supaya tidak ada
  data yang disembunyikan tanpa Anda minta.

### 22.2 Avg Daily Sales - kenapa payday TIDAK dibuang

Angka ini menjawab satu pertanyaan: *stok segini cukup untuk berapa hari?*

Karena itu semua hari ikut dihitung, termasuk payday (tanggal 25-31) dan
double date (1.1 sampai 12.12). Membuang hari-hari itu berarti membuang
hampir seperempat bulan yang justru paling ramai: rata-ratanya jadi
terlalu rendah dan peringatan datang **terlambat**, padahal stok tetap
habis di tanggal 27.

Yang dijinakkan bukan harinya, melainkan **lonjakannya** (winsorize):

1. Susun penjualan harian sepanjang jendela; hari tanpa penjualan = 0.
2. Hitung persentil ke-95 dari **hari yang ada penjualannya saja**.
   Nol tidak ikut - kalau ikut, SKU yang lakunya jarang tapi banyak akan
   dapat batas mendekati nol dan rata-ratanya ambruk.
3. Hari yang melebihi batas itu **dihitung sebesar batas**, bukan dibuang.
4. Rata-rata = total (setelah dibatasi) / jumlah hari dalam jendela.

| Cara | Kelemahannya |
|---|---|
| Kecualikan payday & double date | Puncak dibuang, lembah disisakan - rata-rata terlalu rendah, alert telat |
| Tanpa filter sama sekali | Satu 12.12 bisa mengangkat rata-rata SKU lambat 2-3x |
| **Winsorize P95** (bawaan) | Lonjakan ditekan, hari tetap utuh - tidak bias ke atas maupun ke bawah |

Bonus: cara ini tidak butuh daftar tanggal sama sekali, sehingga flash
sale dadakan, live TikTok, dan campaign ikut tertangani - bukan hanya
tanggal yang kebetulan kita ingat.

Mode lain tetap tersedia untuk pembanding lewat `/stokmode`:
`full` (tanpa batas), `normal` (buang payday & double date), `median`.

Angka `normal` dan `puncak` selalu ikut ditampilkan di pesan supaya
perilaku tiap SKU tetap kelihatan.

**Jendela hari: 30 hari, bukan 90.** Berakhir kemarin; hari ini tidak
ikut karena masih berjalan dan akan menarik rata-rata ke bawah tiap pagi.

Tiga alasannya:

1. **Cocokkan jendela dengan horizon keputusannya.** Angka ini menjawab
   "habis dalam 7 hari ke depan?" - pertanyaan jangka pendek. Permintaan
   minggu lalu jauh lebih menentukan daripada permintaan tiga bulan lalu.
   Kalau penjualan sebuah SKU naik dua kali lipat sebulan yang lalu,
   rata-rata 90 hari baru menunjukkan sekitar **1,3x** - bukan 2x -
   sehingga konsumsinya diremehkan sepertiga dan peringatan datang
   terlambat. Untuk peringatan stok habis, terlambat adalah kegagalan
   yang justru sedang dicegah.
2. **Panjangnya harus kelipatan ~30 hari.** Permintaan e-commerce
   Indonesia berayun mengikuti siklus bulanan: puncak gajian (25-31) dan
   lembah tanggal tua (20-24). Jendela 30, 60, atau 90 hari memuat siklus
   itu secara utuh sehingga seimbang. Jendela 45 hari **tidak** - hasilnya
   berubah-ubah tergantung tanggal berapa laporan dijalankan.
3. **Lonjakan sudah ditangani terpisah.** Alasan klasik memakai jendela
   panjang adalah mengencerkan lonjakan; di sini winsorize sudah
   melakukannya tanpa perlu mengorbankan kepekaan terhadap tren.

Yang dikorbankan: SKU yang lakunya bergelombang (20 pcs sekali sebulan)
menjadi lebih berisik dalam 30 hari. Naikkan ke `60` atau `90` lewat
`/stokhari` bila itu terasa mengganggu, dan bandingkan sendiri dengan
`npm run stock:test -- --jendela`.

**Pemecahan permintaan.** OCS menjawab `504 Gateway Timeout` untuk
rentang 90 hari, dan **kadang gagal juga untuk 30 hari** (teramati
langsung: Agustus berhasil, Juli gagal pada rentang 30 hari yang sama).
Karena itu `STOCK_CHUNK_DAYS` bawaannya **15 hari**. Hasilnya di-cache
per jendela tanggal - beberapa laporan dalam satu hari hanya menarik data
berat itu **sekali**.

**Potongan yang gagal dikeluarkan dari pembagi.** Kalau satu potongan
gagal, penjualannya hilang - dan bila harinya tetap ikut dihitung,
rata-rata jatuh sebanding dengan bagian yang hilang. Rata-rata 90 hari
yang kehilangan satu potongan 30 hari akan turun sepertiga, tepat pada
saat data sedang bermasalah, tanpa ada yang menyadarinya. Aplikasi
karena itu hanya menghitung hari yang datanya benar-benar sampai, dan
menulis peringatan di log bila jumlahnya kurang dari yang diminta.

### 22.3 Jam kirim

Berbeda dengan laporan Fulfilment yang berjalan tiap sekian menit,
laporan ini terkirim pada **jam tertentu**: `/stokjam 8,12,16`.

Penjadwal berdetak tiap menit lalu memeriksa apakah jam sekarang termasuk
jam kirim dan belum pernah terkirim pada jam itu hari ini. Ada toleransi
10 menit, jadi aplikasi yang baru hidup pukul 08:03 tetap mengirim
laporan pukul 8. Penanda "sudah terkirim" disimpan di database, sehingga
restart pukul 08:20 **tidak** menghasilkan laporan kedua.

### 22.4 Perintah Telegram

Semua tersimpan di database dan menang atas `.env`, jadi tidak perlu
mengedit berkas maupun me-restart service.

| Perintah | Fungsi |
|---|---|
| `/stok` | Ambil data dan kirim laporan **sekarang** (menembus tombol mati) |
| `/stokstatus` | Seluruh pengaturan + waktu keberhasilan terakhir |
| `/stokon`, `/stokoff` | Nyalakan / matikan pengiriman terjadwal |
| `/stokjam 8,12,16` | Jam kirim, waktu lokal |
| `/stokdoi 7` | Tampilkan SKU yang stoknya cukup kurang dari sekian hari |
| `/stokambang 0` | Batas jumlah stok. `0` = tanpa batas |
| `/stokminavg 0` | Abaikan SKU yang lakunya di bawah sekian/hari |
| `/stokpic <Nama>` | PIC laporan stok. Boleh lebih dari satu, pisah koma |
| `/stokwa <Nomor>` | Nomor PIC untuk mention, urut sesuai namanya |
| `/stoktop 20` | Jumlah SKU yang ditampilkan |
| `/stokhari 90` | Jendela hari untuk rata-rata penjualan |
| `/stokmode winsor` | `winsor`, `full`, `normal`, atau `median` |
| `/stokgroup <JID atau nama>` | Group tujuan. Kosongkan = semua group aktif |

`/stokgroup` menerima JID (`1203...@g.us`) maupun nama group yang sudah
terdaftar di `/groups`, dipisah koma. Group tujuan **tidak harus aktif**,
sehingga sebuah group khusus laporan stok bisa menerima laporan ini tanpa
ikut menerima peringatan stok dari Telegram: daftarkan lewat Admin Menu
lalu matikan tombolnya (⚪).

### 22.5 Uji dulu sebelum dijadwalkan

```cmd
npm run stock:test
```

Login, tarik data, dan **cetak pesannya ke layar**. Tidak ada satu pun
pesan WhatsApp yang terkirim.

```cmd
npm run stock:test -- --banding
npm run stock:test -- --sku HANASUI-TONE-UP-SERUM-SUNSCREEN
```

`--banding` menjajarkan keempat mode rata-rata untuk 15 SKU teratas.
Bacanya: `full` jauh di atas `winsor` berarti SKU itu punya lonjakan
ekstrem; `normal` jauh di bawah `winsor` berarti penjualannya memang
bertumpu di payday.

`--jendela` menarik jendela 30, 60, dan 90 hari lalu menjajarkannya:
berapa SKU yang kena kriteria di masing-masing, SKU mana yang hanya
muncul di salah satunya, dan rata-rata 10 SKU teratas di ketiganya.
Kalau angka 30 hari jauh di atas 90 hari berarti permintaan sedang naik
dan jendela panjang akan membuat peringatan terlambat.

`--sku` membedah satu SKU hari per hari, menandai hari puncak dengan `*`,
lalu menghitung keempat mode beserta batas P95-nya.

### 22.6 Group tujuan & PIC

Laporan stok punya **setelan sendiri**, terpisah penuh dari lock stock
maupun forwarder Telegram:

| | Laporan stok | Lock stock |
|---|---|---|
| Group tujuan | `/stokgroup` (`stock_groups`) | `/lockgroup` (`lock_groups`) |
| PIC | `/stokpic`, `/stokwa` (`stock_pic`) | `/lockpic`, `/lockwa` (`lock_pic`) |

PIC laporan stok berupa **daftar datar** - tidak dipecah per Shop -
karena laporan ini memang tidak berhubungan dengan Shop. Boleh lebih
dari satu orang, dipisah koma, dan nomornya dipasangkan menurut urutan:

```
/stokpic Ibu Ani, Bpk. Budi
/stokwa  6281234567890, 6289876543210
```

Aturan komanya sama persis dengan `/lockpic` (lihat bab 23.4). Tanpa PIC,
laporan tetap terkirim - hanya tanpa sapaan dan tanpa mention.

### 22.7 Isi pesan

```
*Dear Ibu Ani @6281234567890 & Bpk. Budi @6289876543210*

*STOK MENIPIS*
Selasa, 1 Sep 2026 - 08:00 WIB
Kriteria: DOI < 7 hari
Kategori Sku | Status aktif
Rata-rata 90 hari (semua hari, lonjakan dibatasi P95)

*12 SKU perlu perhatian* - 12 paling mendesak:

1. NCO-EDP-ONYX
   Stok *900* | Avg *300*/hari -> 3,0 hari
   normal 280 - puncak 410
2. HANASUI-TONE-UP-SERUM
   Stok *2.726* | Avg *500*/hari -> 5,5 hari
```

Urutannya **paling mendesak dulu** - sisa hari paling sedikit di atas.
SKU yang stoknya rendah tetapi tidak ada penjualannya sama sekali ditaruh
paling belakang; stoknya memang rendah, tetapi tidak ada yang membelinya.
Pesan dipotong otomatis agar tidak pernah melewati batas WhatsApp.

### 21b. Diagnosa koneksi WhatsApp

```cmd
npm run wa:diag
```

Mengumpulkan dalam satu perintah semua yang dibutuhkan untuk menentukan
kenapa WhatsApp tidak pernah siap. Tidak menyambung ke WhatsApp dan tidak
mengubah apa pun - aman dijalankan sementara service berjalan.

Yang diperiksa:

1. **Pengaturan** - `CHROME_PATH`, `WA_WEB_VERSION`, `WA_READY_TIMEOUT_MS`
2. **Folder sesi** - ukuran, keberadaan `Default/`, dan **berkas kunci**
   (`SingletonLock`) yang menandakan Chrome lama masih memegang folder
3. **Proses Chrome** yang sedang berjalan
4. **Jaringan** ke `web.whatsapp.com` dan `ocs.iegsystem.id`
5. **Riwayat log** - berapa kali QR dibuat, authenticated, ready, macet,
   logout; dan **tahap macet terakhir**

Ditutup dengan daftar temuan beserta penanganannya. Kalau tetap buntu,
kirimkan seluruh keluarannya.

**Tiga penyebab yang paling sering, dan bedanya:**

| Di log tertulis | Artinya | Penanganan |
|---|---|---|
| `macet di "qr"` | Tidak ada yang memindai QR | **Tidak sembuh sendiri.** Pindai QR yang dikirim ke chat admin Telegram |
| `macet di "authenticated"` | Build WhatsApp Web tidak cocok | Setel `WA_WEB_VERSION` (bab 13) |
| `The browser is already running` | Chrome lama memegang folder sesi | `taskkill /F /IM chrome.exe /T` lalu restart service |

Yang ketiga pernah terjadi di mesin ini: **31 percobaan gagal
berturut-turut** dengan pesan itu, dan baru berhasil setelah proses
Chrome lamanya mati sendiri. Kalau pesan itu muncul, jangan menunggu.

### 22.8 Kalau gagal

| Gejala | Sebab yang paling sering |
|---|---|
| `504` / `Waktu tunggu habis` saat menarik penjualan | Rentang sekali tarik terlalu besar - turunkan `STOCK_CHUNK_DAYS` ke 15 |
| `tujuan tidak dikenal: ...` | Nama group di `/stokgroup` salah tulis. Cek `/groups` |
| `belum ada WhatsApp Group aktif` | `/stokgroup` kosong dan tidak ada group aktif |
| Laporan tidak pernah datang | `/stokstatus` - cek "Jam kirim" sudah disetel dan statusnya AKTIF |
| Semua Avg 0 | Jendela hari jatuh di periode tanpa data. Cek `npm run stock:test` bagian 3 |
| Laporan kosong terus | DOI 7 hari mungkin terlalu ketat. Naikkan dengan `/stokdoi 14`, atau lihat "Lima SKU terdekat" di `npm run stock:test` |
| Laporan penuh barang tidak penting | Nyalakan `/stokminavg 1` untuk menyingkirkan SKU yang lakunya sangat jarang |

---

## 23. Peringatan Lock Stock

Memeriksa SKU yang **stok ter-reserve-nya melebihi stok tersedia**
(`ReserveQty > AvailableQty`) - keadaan yang berujung oversell bila tidak
segera dilepas. Berjalan sebagai penjadwal sendiri, terpisah dari jalur
forward Telegram maupun dari laporan OCS dan laporan stok.

| Sumber | Halaman OCS | Dipakai untuk |
|---|---|---|
| `GET /odata/DTO_WmsItemStockLiteV2` | Stocks > View V2 | SKU, Available Qty, Reserve Qty |
| `GET /MasterData/GetSkuRack` | Master > Sku Rack | pemetaan Seller SKU -> Shop |
| `GET /MasterData/GetBundle` | Master > Bundle | isi bundle -> Seller SKU komponennya |

Keduanya hanya dibaca; ada uji otomatis yang menjaganya tetap begitu.

### 23.1 Kenapa "service sendiri" tetap satu proses

WhatsApp hanya mengizinkan **satu sesi per nomor**. Windows Service kedua
yang berdiri sendiri berarti nomor WhatsApp kedua beserta HP-nya dan scan
QR sendiri. Karena itu modul ini berdiri sendiri di dalam aplikasi yang
sama: penjadwal, pengaturan, dan perintah Telegram terpisah, tetapi sesi
WhatsApp dan **antrean pengiriman** dipakai bersama - dan antrean bersama
itulah yang menjamin tidak pernah ada dua pengiriman berbarengan.

### 23.2 Jeda acak

Permintaan yang jatuh di detik yang sama persis tiap jam adalah pola mesin
yang paling mudah dikenali. Setiap putaran karena itu menjadwalkan putaran
berikutnya sendiri pada:

```
jeda dasar  +/- acak(0..LOCK_JITTER_MINUTES menit)  + acak(0..59 detik)
```

Angka acaknya dari `crypto.randomInt`, bukan `Math.random`, supaya tidak
membentuk deret yang bisa ditebak. Dengan bawaan 60 menit +/- 7 menit,
jarak antar pemeriksaan berkisar 53-68 menit dan tidak pernah berulang.
Jeda tidak pernah lebih pendek dari satu menit, berapa pun jitternya.

Lihat contohnya:

```cmd
npm run lock:test -- --jeda
```

### 23.3 Pencarian Shop - tiga lapis

Data stok tidak memuat Shop, jadi Shop dicari dari Master Sku Rack:

1. **Master Sku Rack** (`SellerSku` -> `ShopCode`). Satu SKU **boleh**
   terdaftar di lebih dari satu shop - barang yang sama dijual dua toko,
   bin dan SAP code-nya identik. SKU seperti itu masuk ke daftar **kedua**
   shop, karena keduanya sama-sama bisa kena oversell, dan pesannya diberi
   keterangan.
2. **Bundle: lewat komponennya.** Bundle adalah barang virtual - gabungan
   beberapa SKU fisik - sehingga tidak punya rak dan **tidak akan pernah
   ada di Master Sku Rack** (dicek ke OCS: nol dari 677 baris master
   berawalan `BDL-`). Master Bundle memberi daftar Seller SKU
   penyusunnya, dan Seller SKU itulah yang dicari di Sku Rack:

   ```
   BDL-HANASUI-0000001580
     -> GIMMICK-CHEEK-BLUSH-PINK                  -> Hanasui
     -> DAILY-COVER-TWO-WAY-CAKE-N12-LIGHT-IVORY  -> Hanasui
     -> DAILY-MATTE-SERUM-CUSHION-N12-CLASSY-IVORY-> Hanasui
   ```

   Diperiksa ke data sungguhan (1.807 bundle):

   | | |
   |---|---|
   | Bundle yang berhasil dipetakan lewat komponen | **1.807 (100%)** |
   | Bundle yang hasilnya berbeda dari nama shop di kodenya | **0** |
   | Bundle yang komponennya menunjuk lebih dari satu shop | 210 |
   | ...hanya karena komponennya terdaftar di 2 shop | 209 |
   | ...bundle yang benar-benar campur shop | 1 |
   | Bundle yang kodenya tidak menyebut shop sama sekali | 2 |

   Untuk 209 kasus itu, bila kode bundle menyebut salah satu shop yang
   terlibat, shop itulah yang dipakai - supaya peringatannya tidak
   dikirim ke dua PIC padahal yang menjual cuma satu. Satu bundle yang
   memang campuran tetap dikirim ke semua shop terkait.

3. **Tebakan dari kode SKU**, untuk yang tidak tertutup dua cara di atas.
   Hanya potongan **utuh** antar tanda hubung yang diterima, jadi
   `NCOBALM` tidak dibaca sebagai NCO. Hanya SKU yang sampai di lapis ini
   yang memicu teguran "belum terdaftar" di pesan - itu celah data
   sungguhan yang layak ditutup di `/master/sku-rack`.
4. **Keranjang "TANPA SHOP"**. Kalau tetap tidak ketemu, SKU-nya tetap
   dilaporkan dengan keterangan - tidak pernah ada SKU yang hilang
   diam-diam.

Kedua master (Sku Rack ~700 baris, Bundle ~1.800 baris) disimpan
sementara selama `LOCK_RACK_CACHE_MINUTES` supaya tidak ditarik ulang
tiap jam. Bila Master Bundle gagal diambil, peringatan **tetap dikirim** -
shop bundle hanya turun ke tebakan dari kodenya.

### 23.4 PIC per Shop

Satu pesan per shop, disapa ke PIC-nya masing-masing:

| Shop | PIC bawaan |
|---|---|
| NCO | Ibu Manda |
| Hanasui | Ibu Sandra |
| FYNE | Bpk. Reza |
| EOMMA | Bpk. Maulana |

```
/lockpic NCO Ibu Manda
/lockwa  NCO 6281234567890
```

`/lockwa` membuat PIC di-**mention sungguhan**, sehingga HP-nya berbunyi
walau group di-mute. WhatsApp hanya mengenali mention bila teks memuat
`@<nomor>`, jadi sapaannya menjadi `*Dear Ibu Manda @6281234567890*`;
aplikasi WhatsApp penerima yang menampilkannya sebagai nama kontak.
Tanpa nomor, PIC tetap disapa dengan namanya, hanya tanpa mention.

Nomor ditulis dengan kode negara, tanpa `+` dan tanpa `0` di depan.

#### Satu shop dengan lebih dari satu PIC

Pisahkan dengan koma. Nomor dipasangkan **menurut urutan** dengan namanya:

```
/lockpic NCO Ibu Manda, Bpk. Andi
/lockwa  NCO 6281234567890, 6289876543210
```

Hasilnya:

```
*Dear Ibu Manda @6281234567890 & Bpk. Andi @6289876543210*
```

Keduanya di-mention sungguhan. Untuk tiga orang atau lebih formatnya
menjadi `A, B & C`.

Aturan yang perlu diingat:

- **`/lockpic` mengganti SELURUH daftar**, bukan menambah. Menulis
  `/lockpic NCO Ibu Manda` pada shop yang tadinya punya dua PIC akan
  menyisakan satu orang - dan bot mengatakannya terus terang di balasannya.
- **Nomor mengikuti posisi nama.** Mengganti nama orang ke-2 tidak
  mengacaukan nomor orang ke-1.
- **Melewati satu orang:** tulis `kosong` di posisinya, misalnya
  `/lockwa NCO 6281234567890, kosong, 6283333333333`. Orang ke-2 tetap
  disapa, hanya tidak di-mention.
- **Nomor lebih banyak daripada nama akan ditolak**, bukan dibuang
  diam-diam. Tambahkan namanya dulu lewat `/lockpic`.
- Nomor yang sama untuk dua PIC hanya di-mention sekali.
- `/lockwa NCO hapus` membuang **semua** nomor di shop itu; namanya tetap.

Cek hasilnya kapan saja dengan `/lockstatus`.

### 23.5 Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/lock` | Periksa dan kirim **sekarang** (menembus tombol mati) |
| `/lockstatus` | Pengaturan, PIC, temuan terakhir, jadwal berikutnya |
| `/lockon`, `/lockoff` | Nyalakan / matikan pemeriksaan berkala |
| `/lockpic <Shop> <Nama>` | Nama PIC. Boleh lebih dari satu, pisah koma |
| `/lockwa <Shop> <Nomor>` | Nomor PIC untuk mention, urut sesuai namanya |
| `/lockjeda 60 7` | Jeda 60 menit, digeser acak +/- 7 menit |
| `/lockgroup <JID atau nama>` | Group tujuan. Kosongkan = semua group aktif |
| `/lockulang on\|off` | `off` = jangan ulangi pesan yang isinya sama persis |

### 23.6 Pesan yang sama tiap jam

Lock stock bisa bertahan berjam-jam. Bawaannya pesan tetap dikirim tiap
putaran (`/lockulang on`), tetapi bila PIC mulai terganggu:

```
/lockulang off
```

Aplikasi lalu menyimpan sidik jari isi peringatan - **termasuk angkanya**,
sehingga reserve yang bertambah tetap dianggap perubahan walau daftar
SKU-nya sama - dan hanya mengirim ulang bila ada yang berubah. Begitu
semua lock terlepas, sidik jarinya dikosongkan, jadi kemunculan berikutnya
selalu dikirim.

### 23.7 Uji dulu

```cmd
npm run lock:test
npm run lock:test -- --rack
npm run lock:test -- --jeda
```

Login, periksa, dan **cetak pesannya ke layar**. Tidak ada satu pun pesan
WhatsApp yang terkirim. Bagian 4 menampilkan asal shop tiap SKU
(`master` / `tebakan dari kode SKU` / `TIDAK KETEMU`) - itu tempat pertama
yang dilihat kalau ada SKU yang masuk ke shop yang salah.

`--rack` menampilkan daftar SKU yang terdaftar di lebih dari satu shop,
plus statistik bundle. Untuk bundle, bagian 4 juga merinci komponennya
satu per satu beserta shop tiap komponen.

### 23.8 Contoh pesan

```
*Dear Ibu Sandra @6281234567890*

⚠️ PERINGATAN LOCK STOCK
Ditemukan 4 SKU *_Shoop Hanasui_* dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).
🕒 2026-08-31 19:49:30 WIB
SKU                       Resv  Avail
BDL-NCO-00000000103       2550   2268
BDL-NCO-00000000098        850    749
POWER-MINIPORE-SERUM       456    432
BOUNCYBLUSH-ROSEATE-2     1445   1444

*Mohon segera lepas Lock Stock sebelum terjadi Oversell.*

Terima kasih.

_Sent by BOT-WRH_
```

Urutannya **selisih terbesar lebih dulu** - itu yang paling berisiko
oversell. Tabelnya dibungkus blok monospace agar kolomnya benar-benar
lurus; tanpa itu font proporsional WhatsApp membuat angkanya bergeser.

### 23.9 Kalau gagal

| Gejala | Sebab yang paling sering |
|---|---|
| SKU masuk ke shop yang salah | Belum terdaftar di Master Sku Rack sehingga ditebak dari kodenya. Cek `npm run lock:test` bagian 4 |
| Muncul "sebagian SKU belum terdaftar" | Ada SKU berkategori Sku yang belum ada di `/master/sku-rack`. Bundle tidak pernah memicu pesan ini |
| Banyak SKU jadi "TANPA SHOP" | Master Sku Rack belum lengkap - daftarkan SKU-nya di `/master/sku-rack` |
| PIC tidak menerima notifikasi | Nomornya belum diisi (`/lockwa`), atau nomornya bukan anggota group tersebut |
| Kolom tabel tidak lurus | `LOCK_MONOSPACE=false`. Kembalikan ke `true` |
| Pesan datang terlalu sering | Turunkan dengan `/lockjeda`, atau matikan pengulangan dengan `/lockulang off` |
| **`/lock` berhasil tapi jadwal diam** | Hampir selalu tombolnya masih MATI. `/lock` memakai mode paksa sehingga menembus tombol; jadwal tidak. Jalankan `/lockstatus` - baris "Lock stock:" dan "Terakhir dilewati:" menjelaskannya, lalu `/lockon` |
| Jadwal diam setelah service sering di-restart | Sudah tidak terjadi sejak `LOCK_FIRST_RUN_MINUTES` ada: pemeriksaan pertama datang ~3 menit setelah hidup, bukan satu jeda penuh |

### 23.10 Kalau jadwal diam padahal `/lock` berhasil

`/lock` berjalan dengan mode **paksa**: menembus tombol on/off dan jam
aktif. Jadwal tidak. Jadi "manual bisa, otomatis tidak" hampir selalu
berarti salah satu penjaga itu sedang menutup jalan.

Jalankan `/lockstatus` dan baca tiga baris ini:

```
Lock stock: MATI              <- ini penyebabnya; /lockon
Penjadwal: jalan              <- kalau TIDAK JALAN, LOCK_ENABLED belum true
Terakhir dilewati: 14:03 WIB - tombol MATI - nyalakan dengan /lockon
```

Sejak versi ini, **setiap** putaran terjadwal yang memutuskan tidak
mengirim menulis alasannya ke log:

```
[INFO ] [LOCK] Putaran terjadwal dilewati: tombol MATI - nyalakan dengan /lockon.
```

Sebelumnya baris itu tidak ada sama sekali - jadwal diam, log bersih,
dan tidak ada satu pun petunjuk. Itu kelemahan yang sudah diperbaiki.
