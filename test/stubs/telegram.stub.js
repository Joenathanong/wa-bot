/* STUB untuk pengujian otomatis - bukan bagian dari aplikasi produksi. */
const EventEmitter = require('events');

class TelegramBot extends EventEmitter {
  constructor(token, options) {
    super();
    this.token = token;
    this.options = options;
    this.outbox = [];
    this.answers = [];
    if (!global.__TG_STUB__) global.__TG_STUB__ = {};
    global.__TG_STUB__.bot = this;
  }
  async getMe() { return { id: 777, username: 'stub_bot' }; }
  async sendMessage(chatId, text, opts = {}) {
    const m = { chat_id: chatId, text, opts, message_id: this.outbox.length + 1000 };
    this.outbox.push(m);
    return { message_id: m.message_id, chat: { id: chatId }, text };
  }
  async sendPhoto(chatId, buffer, opts = {}, fileOpts = {}) {
    const m = {
      chat_id: chatId, photo: true,
      bytes: buffer && buffer.length ? buffer.length : 0,
      text: (opts && opts.caption) || '', opts, fileOpts,
      message_id: this.outbox.length + 2000,
    };
    this.outbox.push(m);
    return { message_id: m.message_id };
  }
  async editMessageText(text, opts = {}) {
    const m = { edit: true, chat_id: opts.chat_id, message_id: opts.message_id, text, opts };
    this.outbox.push(m);
    return m;
  }
  async answerCallbackQuery(id, opts = {}) { this.answers.push({ id, ...opts }); return true; }
  async stopPolling() { return true; }

  /* ---- helper pengujian ---- */
  last() { return this.outbox[this.outbox.length - 1]; }
  clear() { this.outbox = []; this.answers = []; }
  allText() { return this.outbox.map((m) => m.text).join('\n---\n'); }
}

module.exports = TelegramBot;
