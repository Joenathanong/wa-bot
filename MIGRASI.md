# Pindah ke PC Windows Baru

> **Matikan bot di PC lama lebih dulu.** Kedua PC punya database sendiri, jadi
> proteksi anti-duplikat tidak saling tahu. Bila keduanya menyala bersamaan,
> setiap peringatan stok terkirim **dua kali** ke WhatsApp Group.
>
> ```cmd
> net stop telegramwabridge.exe
> ```

## 0. Siapkan dulu di PC LAMA (sekali, 1 menit)

Agar PC baru memasang versi dependency yang **persis sama**, pastikan
`package-lock.json` sudah selaras dengan `package.json`:

```bash
npm install          # memperbarui package-lock.json
npm test             # pastikan tetap hijau
```

Berkas `package-lock.json` inilah yang mengunci versi. Dengan membawanya,
PC baru memakai `npm ci` dan mendapat versi yang identik — bukan versi terbaru
yang mungkin berbeda perilaku.

## 1. Pasang kebutuhan lewat perintah (winget)

Windows 10/11 modern sudah membawa `winget`. Buka **PowerShell sebagai
Administrator** di PC baru, lalu:

```powershell
winget install -e --id Google.Chrome
winget install -e --id Git.Git          # opsional, untuk Git Bash
```

**Node.js: pasang versi 22, bukan "LTS".** Sejak Node 24 menjadi LTS, perintah
`winget ... OpenJS.NodeJS.LTS` memberi Node 24 — dan `better-sqlite3` belum
menyediakan binary siap pakai untuk Node 24, sehingga `npm ci` mencoba
mengompilasi dan gagal (butuh Python + Visual Studio Build Tools).

Unduh installer **Node 22.x** dari <https://nodejs.org/en/download> (pilih
versi 22 di daftar), atau lewat winget dengan versi eksplisit:

```powershell
winget install -e --id OpenJS.NodeJS.LTS --version 22.21.1
```

> Kalau terlanjur memakai Node 24, aplikasi **tetap jalan**: `better-sqlite3`
> sekarang berstatus opsional, dan bila gagal dipasang, aplikasi otomatis
> memakai modul SQLite bawaan Node (`node:sqlite`). Yang hilang hanya sedikit
> kecepatan baca-tulis database — tidak terasa pada volume notifikasi ini.

Tutup jendela itu, lalu buka terminal **baru** supaya PATH terbaca. Periksa:

```powershell
node -v     # v22.x
npm -v      # 10.x
```

Kalau `winget` tidak tersedia, unduh manual dari nodejs.org dan google.com/chrome.

> Semua kebutuhan lain — termasuk `node-windows` untuk Windows Service dan
> `qrcode` untuk QR lewat Telegram — sudah tercatat di `package.json`, jadi
> ikut terpasang oleh satu perintah `npm ci` di langkah 3.

## 2. Salin folder project

Letakkan di jalur **tanpa spasi**, misalnya `C:\bot\telegram-wa-bridge`.
Ini bukan sekadar kerapian: jalur berspasi pernah menyulitkan pemasangan
Windows Service.

| | Berkas | Alasan |
|---|---|---|
| ✓ | `src/ scripts/ test/` | kode aplikasi |
| ✓ | `package.json` **dan** `package-lock.json` | mengunci versi dependency |
| ✓ | `.env` | token, admin ID, chat sumber |
| ✓ | `data/bot.db` | user, template, daftar WhatsApp Group |
| ✓ | `data/telegram-user.session` | sesi akun Telegram; portabel antar PC |
| ✗ | `node_modules/` | dibangun ulang oleh `npm ci` |
| ✗ | `.wwebjs_auth/` `.wwebjs_cache/` | profil Chrome PC lama — menyalinnya memicu LOGOUT |
| ✗ | `src/daemon/` | berkas Windows Service milik PC lama |
| ✗ | `data/app.log` | log lama, tidak perlu |

## 3. Pasang dan periksa

```powershell
cd C:\bot\telegram-wa-bridge
npm ci
npm run setup
```

`npm ci` memasang **persis** versi yang terkunci di `package-lock.json`.
(`npm install` boleh dipakai bila `package-lock.json` tidak terbawa, tetapi
versinya bisa bergeser.)

Peringatan `deprecated` dan laporan *vulnerabilities* boleh diabaikan. Kegagalan
membangun `better-sqlite3` juga tidak masalah — paket itu opsional dan ada
penggantinya. **Jangan** jalankan `npm audit fix --force`; itu merusak
`whatsapp-web.js`.

`npm run setup` memeriksa semuanya sekaligus — Node, dependency, `.env`,
Chrome, database, sesi, dan status service — lalu menuliskan daftar apa yang
masih perlu dikerjakan beserta perintahnya. Ulangi perintah ini setiap selesai
satu langkah sampai ia menjawab **SIAP**.

Hal yang biasanya perlu disesuaikan di `.env`:

- `CHROME_PATH` — hapus saja bila Chrome dipasang normal; aplikasi mencarinya sendiri.
- Pastikan **tidak ada** baris `WA_WEB_VERSION`.

## 4. Jalankan dan scan QR

```powershell
npm test        # harus lulus semua
npm start       # QR muncul di terminal
```

Di HP: **WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat**.
Tunggu `WhatsApp ready`, lalu `Ctrl+C`.

Bila sesi akun Telegram ditolak: `npm run tg:login`.

## 5. Pasang sebagai Windows Service

Dengan cara ini bot tetap jalan walau Anda logout atau berganti user, dan
**auto-login Windows tidak diperlukan**.

Command Prompt / PowerShell **sebagai Administrator**:

```powershell
cd C:\bot\telegram-wa-bridge
npm run service:install
```

Verifikasi:

```powershell
npm run service:status
```

Perintah `net`/`sc` memakai **ID service** (`telegramwabridge.exe`), bukan nama
tampilannya. Di PowerShell tulis `sc.exe`, karena `sc` di sana alias `Set-Content`:

```powershell
net stop telegramwabridge.exe
net start telegramwabridge.exe
sc.exe query telegramwabridge.exe
```

### Alternatif: PM2

Hanya bila Windows Service bermasalah. PM2 menuntut auto-login dan ikut mati
saat logout.

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start ecosystem.config.js
pm2 save
```

## 6. Setelan Windows agar tahan 24 jam

Command Prompt **sebagai Administrator**:

```cmd
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

Device Manager → Network adapters → klik kanan adapter → Properties →
Power Management → hilangkan centang *"Allow the computer to turn off this
device to save power"*.

## 7. Daftar periksa akhir

- [ ] Bot di PC lama dimatikan (`net stop telegramwabridge.exe`)
- [ ] `npm run setup` menjawab **SIAP**
- [ ] `npm test` lulus semua
- [ ] QR dipindai, log menampilkan `WhatsApp ready`
- [ ] `/status` menampilkan Telegram dan WhatsApp hijau
- [ ] Test Mention masuk ke seluruh group tujuan
- [ ] Perangkat tertaut PC lama dilepas dari HP
- [ ] Service terpasang, `npm run service:status` menunjukkan RUNNING
- [ ] Logout lalu login Windows: `/status` tetap hijau
- [ ] PC direstart sekali, bot hidup sendiri tanpa disentuh

Bila ada yang meleset, README bab 18 memuat Troubleshooting untuk setiap pesan
error yang pernah muncul. Skrip penolong: `npm run setup` (kesiapan),
`npm run service:status` (service + log), `npm run tg:diag` (jaringan Telegram),
`npm run wa:reset` (mulai sesi WhatsApp dari nol).
