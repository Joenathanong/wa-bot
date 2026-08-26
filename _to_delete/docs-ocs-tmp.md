
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
| `OCS_INTERVAL_MINUTES` | `60` | Jeda antar laporan |
| `OCS_ALIGN_TO_HOUR` | `true` | Laporan jatuh di menit `:00` |
| `OCS_ACTIVE_HOURS` | `7-21` | Jam kerja saja. Kosongkan = 24 jam |
| `OCS_TZ_OFFSET_MINUTES` | `420` | 420 = WIB, 480 = WITA, 540 = WIT |
| `OCS_DATE_TYPE` | `dueDate` | `dueDate` = Batas Kirim, `createdDate` = Tanggal Pesanan |
| `OCS_SHOP` / `OCS_CHANNEL` / `OCS_AREA` / `OCS_SHIFT` / `OCS_ROLE` | `All` / `all` | Filter, sama persis dengan halaman web |
| `OCS_TOP_OPERATORS` | `3` | Jumlah operator teratas di pesan. `0` = jangan tampilkan |
| `OCS_TITLE` | `FULFILMENT DASHBOARD` | Judul pesan |
| `OCS_ONLY_WHEN_PROBLEM` | `false` | `true` = kirim hanya bila ada masalah |
| `OCS_ALERT_BREACHED_SLA` | `1` | Ambang SLA terlewat untuk mode di atas |
| `OCS_ALERT_AT_RISK` | `1` | Ambang order mendekati SLA |
| `OCS_ALERT_INSTAN` | `1` | Ambang instan belum dikirim |

### 21.4 Uji dulu sebelum dijadwalkan

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

### 21.5 Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/ocs` | Ambil data dan kirim laporan **sekarang** (menembus tombol mati dan jam aktif) |
| `/ocsstatus` | Jadwal, waktu keberhasilan terakhir, jumlah terkirim/gagal |
| `/ocson` | Nyalakan laporan berkala |
| `/ocsoff` | Matikan laporan berkala (tersimpan di database, bertahan setelah restart) |

`/ocson` dan `/ocsoff` menulis ke tabel `settings` (kunci `ocs_enabled`),
sehingga nilainya menang atas `OCS_ENABLED` di `.env`.

### 21.6 Isi pesan

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

### 21.7 Kalau gagal

| Gejala | Sebab yang paling sering |
|---|---|
| `Login OCS gagal (HTTP 401)` | Username/password/database salah. Coba login manual di browser |
| `getaddrinfo EAI_AGAIN` | Mesin tidak bisa menghubungi ocs.iegsystem.id (DNS/firewall kantor) |
| `Waktu tunggu habis` | OCS lambat - naikkan `OCS_TIMEOUT_MS` |
| `belum ada WhatsApp Group aktif` | Buka `/groups` di Telegram lalu aktifkan satu group |
| `WhatsApp belum tersambung` | Sesi WhatsApp sedang dipulihkan - laporan berikutnya akan normal |

Kegagalan laporan dikirim sebagai notifikasi ke admin Telegram, dan detailnya
selalu ada di log aplikasi.
