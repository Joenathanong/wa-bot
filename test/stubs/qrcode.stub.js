module.exports = { generate: (data, opts) => { if (!global.__QUIET_QR__) console.log('[stub-qr]', String(data).slice(0, 12) + '...'); } };
