/* STUB GramJS untuk pengujian - bukan bagian dari aplikasi produksi. */

function state() {
  if (!global.__GRAM_STUB__) {
    global.__GRAM_STUB__ = {
      handlers: [], connected: false, failConnect: false, failGetMe: false,
      failEntity: false, failGetMessages: false,
      me: { username: 'joe_ieg', firstName: 'Joe' }, dialogs: [], history: [],
    };
  }
  return global.__GRAM_STUB__;
}

class StringSession {
  constructor(str) { this.str = str || ''; }
  save() { return this.str || 'STUBSESSION'; }
}

class NewMessage {
  constructor(opts) { this.opts = opts || {}; }
}

class TelegramClient {
  constructor(session, apiId, apiHash, opts) {
    this.session = session;
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.opts = opts;
    state().lastClientOptions = opts;
    state().handlers = [];
  }
  setLogLevel() {}
  get connected() { return state().connected; }
  set connected(v) { state().connected = v; }
  async getEntity(x) {
    if (state().failEntity) throw new Error('stub: entity tidak ditemukan');
    return { id: x };
  }
  async getMessages(entity, opts = {}) {
    if (state().failGetMessages) throw new Error('stub: getMessages gagal');
    return state().history.slice(0, opts.limit || 10);
  }
  async connect() {
    if (state().failConnect) throw new Error('stub: sesi kedaluwarsa');
    state().connected = true;
    return true;
  }
  async start() { state().connected = true; return true; }
  async getMe() {
    if (state().failGetMe) throw new Error('stub: koneksi mati');
    return state().me;
  }
  addEventHandler(cb, event) { state().handlers.push({ cb, event }); }
  async *iterDialogs() { for (const d of state().dialogs) yield d; }
  async disconnect() { state().connected = false; }
  async destroy() { state().connected = false; }
}

/** Helper pengujian: kirim satu event pesan masuk. */
async function emitMessage(message) {
  for (const h of state().handlers) await h.cb({ message, chatId: message.peerId });
}

module.exports = { TelegramClient, StringSession, NewMessage, emitMessage, __state: state };
