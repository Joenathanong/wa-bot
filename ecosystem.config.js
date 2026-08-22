/**
 * Konfigurasi PM2.
 * Jalankan:  pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name: 'telegram-wa-bridge',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',        // WAJIB fork - sesi WhatsApp tidak boleh di-cluster
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '800M',
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
