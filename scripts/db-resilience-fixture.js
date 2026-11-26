'use strict';

// Real pg-pool lifecycle, synthetic callback clients. No sockets or credentials.
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const fs = require('node:fs');
const vm = require('node:vm');
const resilience = require('../db-resilience');
const tick = () => new Promise(resolve => setImmediate(resolve));
const disconnected = () => Object.assign(new Error('private socket details'), { code: 'ECONNRESET' });
function databaseState() {
  return { people: [{ person_id: 1, name: 'Person One', aliases: [] }, { person_id: 2, name: 'Person Two', aliases: [] }],
    shows: [{ id: 1, show_id: 'show1', show_date: '2026-01-02', album_id: 'AlbumA', smug_albums: [] }],
    data: null, log: [], clients: [], hook: null, acquireFailures: 0, releases: [], warnings: [] };
}
function databasePool(state = databaseState()) {
  class FakeClient extends EventEmitter {
    constructor() { super(); this.tx = null; this.closed = false; this._queryable = true; state.clients.push(this); }
    connect(callback) { queueMicrotask(() => callback(state.acquireFailures-- > 0 ? disconnected() : null)); }
    ref() {}
    unref() {}
    end(callback) {
      this.closed = true; this.tx = null;
      queueMicrotask(() => { this.emit('end'); callback?.(); });
    }
    query(...args) {
      const callback = args.pop(), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      const params = args[1] || args[0]?.values || [];
      state.log.push(sql);
      Promise.resolve().then(async () => {
        await state.hook?.(sql, this, 'before');
        if (this.closed) throw disconnected();
        let result = { rows: [], rowCount: 0 };
        if (sql.startsWith('BEGIN')) this.tx = {};
        else if (sql === 'ROLLBACK') this.tx = null;
        else if (sql === 'COMMIT') {
          if (this.tx?.staged) state.data = this.tx.staged;
          this.tx = null;
        } else if (sql.includes('AS people') && sql.includes('AS shows')) {
          result = { rows: [{ people: state.people, shows: state.shows }] };
        } else if (sql.startsWith('INSERT INTO stats_snapshots')) {
          if (!this.tx) throw Error('snapshot write outside transaction');
          this.tx.staged = JSON.parse(params[1]);
        } else if (sql.includes('SELECT data FROM stats_snapshots')) {
          const data = this.tx?.staged || state.data;
          result = { rows: data ? [{ data }] : [] };
        } else if (sql.includes('count(*)::int AS total') && sql.includes('music_people')) {
          result = { rows: [{ total: state.people.length }] };
        } else if (sql.includes('FROM music_people')) {
          result = { rows: state.people.map(row => ({ ...row, bands: [], stats: {} })) };
        }
        await state.hook?.(sql, this, 'after');
        return result;
      }).then(result => callback(null, result), error => callback(error));
    }
  }
  let pool;
  class TestPool extends Pool {
    constructor(options) {
      super({ ...options, Client: FakeClient, idleTimeoutMillis: 0 });
      pool = this;
      this.on('release', (error, client) => state.releases.push({ error: !!error, client }));
    }
  }
  const ctx = vm.createContext({ module: { exports: {} }, process: { env: {} },
    require(id) {
      if (id === 'pg') return { Pool: TestPool };
      if (id === './db-resilience') return { ...resilience,
        installPoolSafety: pool => resilience.installPoolSafety(pool, message => state.warnings.push(message)) };
      throw Error('Unexpected db dependency: ' + id);
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../db.js'), 'utf8'), ctx, { filename: 'db.js' });
  return { pool, state, tick };
}
const empty = photos => ({ photo_count: photos, set_count: 0, show_count: 0, event_count: 0,
  matched_photos: [], tagged_shows: [] });
module.exports = { databaseState, databasePool, disconnected, empty, tick };
