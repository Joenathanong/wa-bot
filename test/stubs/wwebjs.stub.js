/* STUB untuk pengujian otomatis - bukan bagian dari aplikasi produksi. */
const EventEmitter = require('events');

function state() {
  if (!global.__WA_STUB__) {
    global.__WA_STUB__ = { sent: [], groups: [], autoReady: true, requireQr: false, failStringMentions: false, failSend: false, initErrorOnce: null, launches: [], failGetChats: false, failStore: false, invites: {}, detached: false, lockedOnce: false, killed: 0, closed: 0, stuckAfterAuth: false, logoutOnStart: false };
  }
  return global.__WA_STUB__;
}

class LocalAuth {
  constructor(opts) { this.opts = opts; }
}

class Client extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.info = null;
  }
  get pupBrowser() {
    const s = state();
    return {
      close: async () => { s.closed += 1; },
      process: () => ({ pid: 4242, killed: false, kill: () => { s.killed += 1; } }),
    };
  }
  async initialize() {
    const s = state();
    if (!Array.isArray(s.launches)) s.launches = [];
    s.launches.push((this.options.puppeteer && this.options.puppeteer.executablePath) || null);
    if (s.lockedOnce) {
      s.lockedOnce = false;
      throw new Error('The browser is already running for C:\\x\\.wwebjs_auth\\session-telegram-wa-bridge. Use a different `userDataDir` or stop the running browser first.');
    }
    if (s.initErrorOnce) { const m = s.initErrorOnce; s.initErrorOnce = null; throw new Error(m); }
    if (s.requireQr) this.emit('qr', 'STUBQRDATA');
    if (s.logoutOnStart) {
      s.logoutOnStart = false;
      this.emit('authenticated');
      this.emit('disconnected', 'LOGOUT');
      return;
    }
    if (s.stuckAfterAuth) {
      this.emit('authenticated');       // macet: ready tidak pernah datang
      return;
    }
    if (s.autoReady) {
      this.emit('authenticated');
      this.info = { wid: { _serialized: '628000000000@c.us', user: '628000000000' }, pushname: 'Bot WH' };
      this.emit('ready');
    }
  }
  async destroy() {}
  get pupPage() {
    const self = this;
    return {
      async evaluate(fn) {
        const s = state();
        if (s.detached) throw new Error("Attempted to use detached Frame 'CA81E69EF89524A061BBDC707F9991E3'.");
        const src = typeof fn === 'function' ? fn.toString() : '';
        // Probe diagnosa
        if (src.includes('kunciStore')) {
          return {
            versiWA: '2.3000.1043270046',
            adaStore: true,
            kunciStore: ['Chat', 'Msg', 'GroupMetadata', 'Contact'],
            chat: { ada: true, punyaGetModelsArray: true, jumlahModels: s.groups.length, jumlahGetModels: s.groups.length },
            groupMetadata: { ada: true, jumlah: s.groups.length },
            wwebjs: ['getChats', 'sendMessage'],
          };
        }
        // Pembacaan daftar group
        if (s.failStore) throw new Error('t');
        if (s.storeEmpty) {
          return {
            groups: [],
            tried: [
              { label: 'Store.Chat.getModelsArray', total: 0, group: 0 },
              { label: 'Store.GroupMetadata.getModelsArray', total: 0, group: 0 },
            ],
            dipakai: null,
          };
        }
        return {
          groups: s.groups.map((g) => ({ id: g.id, name: g.name })),
          tried: [{ label: 'Store.Chat.getModelsArray', total: s.groups.length, group: s.groups.length }],
          dipakai: 'Store.Chat.getModelsArray',
        };
      },
    };
  }
  async getInviteInfo(code) {
    const found = state().invites[code];
    if (!found) throw new Error('stub: kode undangan tidak dikenal');
    return { id: { _serialized: found.id }, subject: found.name };
  }
  async getChats() {
    if (state().failGetChats) { const e = new Error('r'); e.name = 'r'; throw e; }
    return state().groups.map((g) => ({ id: { _serialized: g.id }, isGroup: true, name: g.name }))
      .concat([{ id: { _serialized: '628111@c.us' }, isGroup: false, name: 'Personal' }]);
  }
  async getChatById(id) {
    const g = state().groups.find((x) => x.id === id);
    return g ? { id: { _serialized: g.id }, isGroup: true, name: g.name } : null;
  }
  async getContactById(jid) {
    return { id: { _serialized: jid }, __isContact: true };
  }
  async sendMessage(chatId, text, options = {}) {
    const s = state();
    if (s.detached) throw new Error("Attempted to use detached Frame 'CA81E69EF89524A061BBDC707F9991E3'.");
    if (s.failSend) throw new Error('stub: pengiriman gagal');
    if (options.mentions && options.mentions.length && typeof options.mentions[0] === 'string' && s.failStringMentions) {
      throw new Error('stub: versi lama butuh objek Contact');
    }
    s.sent.push({ chatId, text, mentions: options.mentions || [] });
    return { id: { _serialized: `stub-${s.sent.length}` } };
  }
}

module.exports = { Client, LocalAuth };
