# Stub pengujian

File di folder ini adalah **tiruan (stub)** dari library luar dan hanya dipakai
oleh `npm test`. Aplikasi produksi TIDAK pernah memuat file ini.

- `wwebjs.stub.js`   - tiruan whatsapp-web.js (Client, LocalAuth)
- `telegram.stub.js` - tiruan node-telegram-bot-api
- `qrcode.stub.js`   - tiruan qrcode-terminal

Dengan stub ini seluruh alur (filter, antrean, Admin Menu, mention, anti-duplikat)
dapat diuji tanpa menyambung ke WhatsApp Web maupun Telegram sungguhan.
