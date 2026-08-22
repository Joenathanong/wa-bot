'use strict';

const logger = require('./logger').scope('QUEUE');

/**
 * Antrean serial: satu pekerjaan dijalankan pada satu waktu, dengan jeda
 * minimum antar pekerjaan. Mencegah pengiriman WhatsApp secara paralel.
 */
class MessageQueue {
  constructor({ delayMs = 3000, maxRetries = 2 } = {}) {
    this.delayMs = Math.max(0, delayMs);
    this.maxRetries = maxRetries;
    this.items = [];
    this.running = false;
    this.lastRunAt = 0;
    this.stats = { queued: 0, done: 0, failed: 0 };
  }

  setDelay(ms) {
    this.delayMs = Math.max(0, Number(ms) || 0);
    logger.info('Jeda antar pesan diubah menjadi', this.delayMs, 'ms');
  }

  size() {
    return this.items.length;
  }

  /**
   * @param {() => Promise<any>} task
   * @param {string} label
   * @returns {Promise<any>}
   */
  enqueue(task, label = 'task') {
    this.stats.queued += 1;
    return new Promise((resolve, reject) => {
      this.items.push({ task, label, resolve, reject, attempt: 0 });
      logger.debug(`Masuk antrean: ${label} (panjang antrean: ${this.items.length})`);
      this._drain();
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const wait = this.delayMs - (Date.now() - this.lastRunAt);
        if (this.lastRunAt > 0 && wait > 0) await sleep(wait);

        const item = this.items.shift();
        this.lastRunAt = Date.now();
        try {
          const result = await item.task();
          this.stats.done += 1;
          logger.debug(`Selesai: ${item.label}`);
          item.resolve(result);
        } catch (err) {
          if (item.attempt < this.maxRetries) {
            item.attempt += 1;
            logger.warn(`Gagal: ${item.label} (percobaan ${item.attempt}/${this.maxRetries}) - ${err.message}`);
            this.items.unshift(item);
          } else {
            this.stats.failed += 1;
            logger.error(`Gagal permanen: ${item.label} - ${err.message}`);
            item.reject(err);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = MessageQueue;
module.exports.sleep = sleep;
