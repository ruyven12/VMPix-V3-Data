'use strict';

const crypto = require('node:crypto');
const { gzip, gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_STORED_BYTES = 8 * 1024 * 1024;
const PACK_THRESHOLD = 256 * 1024;
const STORAGE_FORMAT = 'gzip_json_v1';
const PACKED_WRAPPER_BYTES = Buffer.byteLength(JSON.stringify({ storage_format: STORAGE_FORMAT, json_bytes: MAX_JSON_BYTES, sha256: 'f'.repeat(64), payload: '' }));
const MAX_COMPRESSED_BYTES = Math.floor((MAX_STORED_BYTES - PACKED_WRAPPER_BYTES) / 4) * 3;
const { guardClient, clientFailure, isConnectionError, retryDatabaseRead } = require('./db-resilience');
const VERSION = 1;
const DEFINITION = 'music_people_linked_album_caption_relationships_v1';
const SNAPSHOT_KEY = 'relationship_population:v1';
const metadata = new WeakMap();
const PEOPLE_SQL = 'SELECT person_id, name, aliases FROM music_people ORDER BY person_id';
const SHOWS_SQL = `SELECT id, show_id, name, date, show_date, show_url, venue, city, state,
  gallery_id, album_id, cover_image_url, smug_albums FROM music_shows ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, id DESC`;
const failure = code => Object.assign(new Error(code), { code });
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const personKey = row => String(row?.person_id ?? '').trim();
const identitySignature = row => hash([personKey(row), row?.name ?? '', row?.aliases ?? []]);
const showFields = ['id', 'show_id', 'name', 'date', 'show_date', 'show_url', 'venue', 'city', 'state',
  'gallery_id', 'album_id', 'cover_image_url'];
const albumFields = ['album_id', 'albumId', 'gallery_id', 'galleryId', 'cover_image_url'];
const project = (row, fields) => Object.fromEntries(fields.map(key => [key, row?.[key] ?? null]));

function projectSource(people, shows) {
  const identities = new Map();
  const population = people.map(row => ({ person_id: row.person_id, name: row.name ?? '', aliases: row.aliases ?? [] }));
  population.forEach(row => {
    const id = personKey(row);
    if (!id || identities.has(id)) throw failure('source_check_failed');
    identities.set(id, identitySignature(row));
  });
  const albums = shows.map(row => ({ ...project(row, showFields),
    show_date: row.show_date instanceof Date ? row.show_date.toISOString().slice(0, 10) : row.show_date ?? null,
    smug_albums: Array.isArray(row.smug_albums) ? row.smug_albums.map(album => project(album, albumFields)) : [] }));
  const fingerprint = hash({
    definition: DEFINITION,
    people: population.slice().sort((a, b) => personKey(a).localeCompare(personKey(b))),
    shows: albums.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
  });
  return { people: population, shows: albums, identities, fingerprint };
}

async function readSource(db, { retry = true } = {}) {
  const read = () => db.query(`SELECT
    coalesce((SELECT jsonb_agg(p) FROM (${PEOPLE_SQL}) p), '[]'::jsonb) AS people,
    coalesce((SELECT jsonb_agg(s) FROM (${SHOWS_SQL}) s), '[]'::jsonb) AS shows`);
  const result = await (retry ? retryDatabaseRead(read) : read());
  const row = result.rows?.[0];
  if (!Array.isArray(row?.people) || !Array.isArray(row?.shows)) throw failure('source_check_failed');
  return projectSource(row.people, row.shows);
}

const countFields = ['photo_count', 'set_count', 'show_count', 'event_count'];
const valueFields = ['gallery_id', 'album_id', 'cover_image_url', 'first_seen', 'first_seen_date_time_original',
  'first_seen_display', 'latest_seen', 'latest_seen_date_time_original', 'latest_seen_display'];
const photoFields = ['image_key', 'caption', 'date_taken', 'taken_at', 'date_time_original', 'thumbnail_url',
  'small_url', 'medium_url', 'large_url', 'album_id', 'gallery_id', 'show_id', 'show_key', 'show_title',
  'show_name', 'show_date', 'venue', 'location'];
const taggedFields = ['show_id', 'show_key', 'show_title', 'album_id', 'gallery_id', 'title', 'date', 'venue', 'location'];
function text(value, key) {
  if (value == null) return null;
  if (typeof value !== 'string') throw failure('persistence_invalid');
  if (key.endsWith('_url')) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password
        || [...url.searchParams.keys()].some(name => /^(api_?key|token|authorization|password|secret)$/i.test(name))) return null;
    } catch (_) { return null; }
  }
  return value;
}
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('persistence_invalid');
  return Object.fromEntries(fields.map(key => [key, text(value[key], key)]));
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('persistence_invalid');
  return value;
}
function relationship(value, photoCache = new WeakMap()) {
  if (!value || typeof value !== 'object') throw failure('persistence_invalid');
  const result = { ...Object.fromEntries(countFields.map(key => [key, count(value[key])])), ...record(value, valueFields) };
  if (!Array.isArray(value.matched_photos) || !Array.isArray(value.tagged_shows)) throw failure('persistence_invalid');
  const photoRecord = photo => {
    if (photo && typeof photo === 'object' && photoCache.has(photo)) return photoCache.get(photo);
    const item = record(photo, photoFields); photoCache.set(photo, item); return item;
  };
  result.matched_photos = value.matched_photos.map(photoRecord);
  result.tagged_shows = value.tagged_shows.map(show => ({
    ...record(show, taggedFields), tagged_photo_count: count(show.tagged_photo_count),
    matched_photos: Array.isArray(show.matched_photos) ? show.matched_photos.map(photoRecord)
      : (() => { throw failure('persistence_invalid'); })()
  }));
  if (result.matched_photos.length > result.photo_count) throw failure('persistence_invalid');
  return result;
}
function emptyRelationship() {
  return { ...Object.fromEntries(countFields.map(key => [key, 0])),
    ...Object.fromEntries(valueFields.map(key => [key, null])), matched_photos: [], tagged_shows: [] };
}
function coverageRecord(value, people) {
  const result = { known_people: people, total_albums: count(value.total_albums),
    albums_processed: count(value.albums_processed), pages_processed: count(value.pages_processed), albums_from_cache: count(value.albums_from_cache) };
  if (result.albums_processed !== result.total_albums || result.albums_from_cache > result.albums_processed) throw failure('persistence_invalid');
  return result;
}
function encode(source, value, generation, verifiedAt, startedAt, coverage) {
  if (!(value instanceof Map) || !Number.isSafeInteger(generation) || generation < 0
    || typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt))
    || typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) throw failure('persistence_invalid');
  if ([...value.keys()].some(id => typeof id !== 'string' || !source.identities.has(id))) throw failure('persistence_invalid');
  const photoCache = new WeakMap();
  return { version: VERSION, definition: DEFINITION, complete: true, source_fingerprint: source.fingerprint,
    generation, verified_at: verifiedAt, build_started_at: startedAt, coverage: coverageRecord(coverage, source.identities.size), identities: [...source.identities].sort(([a], [b]) => a.localeCompare(b)),
    relationships: [...source.identities.keys()].sort().map(id => [id, relationship(value.has(id) ? value.get(id) : emptyRelationship(), photoCache)]) };
}
function decode(data, source) {
  try {
    if (!data || data.version !== VERSION || data.definition !== DEFINITION || data.complete !== true
      || data.source_fingerprint !== source.fingerprint || !Number.isSafeInteger(data.generation) || data.generation < 0
      || typeof data.verified_at !== 'string' || !Number.isFinite(Date.parse(data.verified_at))
      || typeof data.build_started_at !== 'string' || !Number.isFinite(Date.parse(data.build_started_at))
      || !Array.isArray(data.identities) || !Array.isArray(data.relationships)
      || data.identities.length !== source.identities.size || data.relationships.length !== source.identities.size) return null;
    if (data.coverage?.known_people !== source.identities.size) return null;
    const coverage = coverageRecord(data.coverage, source.identities.size);
    const identities = new Map(data.identities), value = new Map(), photoCache = new WeakMap();
    if (identities.size !== source.identities.size) return null;
    for (const [id, signature] of source.identities) if (identities.get(id) !== signature) return null;
    for (const [id, item] of data.relationships) {
      if (!source.identities.has(id) || value.has(id)) return null;
      value.set(id, relationship(item, photoCache));
    }
    metadata.set(value, { fingerprint: source.fingerprint, identities, generation: data.generation, verifiedAt: data.verified_at, startedAt: data.build_started_at, coverage });
    return value;
  } catch (_) { return null; }
}

function describeRelationships(value) { return metadata.get(value) || null; }
function matchesIdentity(value, row) {
  return metadata.get(value)?.identities.get(personKey(row)) === identitySignature(row);
}

// Keep large photo populations opaque to PostgreSQL's JSONB parser. The public
// model and private snapshot namespace are unchanged; old envelopes still read.
async function packSnapshot(envelope) {
  // Intern the full whitelisted photo record, not only image_key: the same image
  // can carry different show metadata. This changes storage only, never counts.
  const references = envelope.relationships.reduce((n, [, item]) => n + item.matched_photos.length
    + item.tagged_shows.reduce((sum, show) => sum + show.matched_photos.length, 0), 0);
  if (references > 256) {
    const photos = [], indexes = new Map(), objects = new WeakMap();
    const indexPhoto = photo => {
      if (objects.has(photo)) return objects.get(photo);
      const tuple = photoFields.map(key => photo[key]);
      const digest = hash(tuple);
      if (!indexes.has(digest)) { indexes.set(digest, photos.length); photos.push(tuple); }
      const index = indexes.get(digest); objects.set(photo, index); return index;
    };
    for (const [, item] of envelope.relationships) {
      item.matched_photos = item.matched_photos.map(indexPhoto);
      for (const show of item.tagged_shows) show.matched_photos = show.matched_photos.map(indexPhoto);
    }
    envelope.photo_encoding = 'indexed_v1'; envelope.photos = photos;
  }
  const json = JSON.stringify(envelope), bytes = Buffer.byteLength(json);
  if (bytes > MAX_JSON_BYTES) throw failure('persistence_invalid');
  let stored = envelope;
  if (bytes > PACK_THRESHOLD || envelope.photo_encoding) {
    let zipped;
    try { zipped = await compress(json, { maxOutputLength: MAX_COMPRESSED_BYTES }); }
    catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw failure('persistence_invalid');
      throw error;
    }
    if (zipped.length > MAX_COMPRESSED_BYTES) throw failure('persistence_invalid');
    stored = { storage_format: STORAGE_FORMAT, json_bytes: bytes,
      sha256: crypto.createHash('sha256').update(json).digest('hex'), payload: zipped.toString('base64') };
  }
  const serialized = JSON.stringify(stored);
  if (Buffer.byteLength(serialized) > MAX_STORED_BYTES) throw failure('persistence_invalid');
  return { stored, serialized, jsonBytes: bytes, storedBytes: Buffer.byteLength(serialized) };
}

async function unpackSnapshot(data, source) {
  const storedHash = data ? hash(data) : null;
  if (data?.storage_format !== undefined) {
    if (data.storage_format !== STORAGE_FORMAT || !Number.isSafeInteger(data.json_bytes)
      || data.json_bytes < 1 || data.json_bytes > MAX_JSON_BYTES
      || typeof data.payload !== 'string' || data.payload.length > MAX_STORED_BYTES
      || !/^[a-f0-9]{64}$/.test(data.sha256 || '')) throw failure('persistence_invalid');
    try {
      const buffer = await decompress(Buffer.from(data.payload, 'base64'), { maxOutputLength: data.json_bytes });
      if (buffer.length !== data.json_bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== data.sha256)
        throw failure('persistence_invalid');
      data = JSON.parse(buffer.toString('utf8'));
    } catch (_) { throw failure('persistence_invalid'); }
  }
  if (data?.photo_encoding !== undefined) {
    if (data.photo_encoding !== 'indexed_v1' || !Array.isArray(data.photos) || !Array.isArray(data.relationships))
      throw failure('persistence_invalid');
    const photos = data.photos.map(tuple => {
      if (!Array.isArray(tuple) || tuple.length !== photoFields.length) throw failure('persistence_invalid');
      return Object.fromEntries(photoFields.map((key, i) => [key, tuple[i]]));
    });
    const expand = refs => {
      if (!Array.isArray(refs)) throw failure('persistence_invalid');
      return refs.map(index => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= photos.length) throw failure('persistence_invalid');
        return photos[index];
      });
    };
    for (const entry of data.relationships) {
      if (!Array.isArray(entry) || !entry[1] || !Array.isArray(entry[1].tagged_shows)) throw failure('persistence_invalid');
      entry[1].matched_photos = expand(entry[1].matched_photos);
      for (const show of entry[1].tagged_shows) {
        if (!show) throw failure('persistence_invalid');
        show.matched_photos = expand(show.matched_photos);
      }
    }
  }
  const value = decode(data, source);
  if (value) metadata.get(value).storedHash = storedHash;
  return value;
}

function createMusicPeopleRelationshipStore({ db, now = Date.now,
  report = info => console.warn('[music-people-snapshot]', JSON.stringify(info)) }) {
  const observe = info => { try { report(info); } catch (_) { /* Diagnostics cannot fail publication. */ } };
  async function load(source) {
    const result = await retryDatabaseRead(() => db.query(`SELECT data FROM stats_snapshots
      WHERE section = 'music' AND category = 'people' AND snapshot_key = $1`, [SNAPSHOT_KEY]));
    return unpackSnapshot(result.rows?.[0]?.data, source);
  }
  async function publish({ source, value, generation, startedAt = new Date(now()).toISOString(), verifiedAt = new Date(now()).toISOString(), coverage = { total_albums: 0, albums_processed: 0, pages_processed: 0, albums_from_cache: 0 }, isCancelled = () => false }) {
    let client;
    let damaged = false, committed = false, stage = 'encode', packed;
    const began = now();
    const query = (name, sql, params) => { stage = name; return client.query(sql, params); };
    try {
      // Verification belongs to completed provider work, not a later publication retry.
      packed = await packSnapshot(encode(source, value, generation, verifiedAt, startedAt, coverage));
      observe({ status: 'prepared', stage, elapsed_ms: now() - began,
        json_bytes: packed.jsonBytes, stored_bytes: packed.storedBytes });
      if (isCancelled()) throw failure('preparation_invalidated');
      stage = 'acquire';
      client = guardClient(await db.connect());
      await query('begin', 'BEGIN ISOLATION LEVEL READ COMMITTED');
      await query('lock_timeout', "SET LOCAL lock_timeout = '3000ms'");
      await query('statement_timeout', "SET LOCAL statement_timeout = '10000ms'");
      await query('source_lock', 'LOCK TABLE music_people, music_shows IN SHARE MODE');
      await query('snapshot_lock', "SELECT pg_advisory_xact_lock(hashtext('music_people_relationship_population_v1'))");
      stage = 'source_read';
      const current = await readSource(client, { retry: false });
      if (isCancelled() || current.fingerprint !== source.fingerprint) throw failure('preparation_invalidated');
      const previous = await query('previous_read', `SELECT data FROM stats_snapshots
        WHERE section = 'music' AND category = 'people' AND snapshot_key = $1 FOR UPDATE`, [SNAPSHOT_KEY]);
      const newer = await unpackSnapshot(previous.rows?.[0]?.data, current);
      if (newer && Date.parse(describeRelationships(newer).startedAt) > Date.parse(startedAt)) {
        await query('commit', 'COMMIT');
        committed = true;
        if (clientFailure(client)) throw clientFailure(client);
        return newer;
      }
      if (isCancelled()) throw failure('preparation_invalidated');
      await query('upsert', `INSERT INTO stats_snapshots (section, category, snapshot_key, data, generated_at, meta)
        VALUES ('music', 'people', $1, $2::jsonb, $3, $4::jsonb)
        ON CONFLICT (section, category, snapshot_key) DO UPDATE SET data = EXCLUDED.data,
          generated_at = EXCLUDED.generated_at, meta = EXCLUDED.meta`,
      [SNAPSHOT_KEY, packed.serialized, verifiedAt, JSON.stringify({ definition: DEFINITION, version: VERSION })]);
      const check = await query('transaction_readback', `SELECT data FROM stats_snapshots
        WHERE section = 'music' AND category = 'people' AND snapshot_key = $1`, [SNAPSHOT_KEY]);
      if (hash(check.rows?.[0]?.data) !== hash(packed.stored)) throw failure('persistence_invalid');
      if (isCancelled()) throw failure('preparation_invalidated');
      await query('commit', 'COMMIT');
      committed = true;
      if (clientFailure(client)) throw clientFailure(client);
      client.release(); client = null;
      stage = 'durable_readback';
      const restored = await load(current), saved = describeRelationships(restored);
      if (!saved || Date.parse(saved.startedAt) < Date.parse(startedAt)
        || saved.startedAt === startedAt && (saved.verifiedAt !== verifiedAt || saved.storedHash !== hash(packed.stored)))
        throw failure('persistence_invalid');
      if (isCancelled()) throw failure('preparation_invalidated');
      observe({ status: 'verified', stage, elapsed_ms: now() - began,
        json_bytes: packed.jsonBytes, stored_bytes: packed.storedBytes });
      return restored;
    } catch (error) {
      observe({ status: 'failed', stage, code: /^(?:[0-9A-Z]{5}|DATABASE_CONNECTION_LOST|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|persistence_invalid|preparation_invalidated|source_check_failed)$/.test(error?.code || '') ? error.code : 'UNCLASSIFIED',
        database_code: /^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)$/.test(error?.databaseCode || '') ? error.databaseCode : null,
        elapsed_ms: now() - began, json_bytes: packed?.jsonBytes ?? null, stored_bytes: packed?.storedBytes ?? null,
        commit_acknowledged: committed });
      damaged = !!clientFailure(client) || isConnectionError(error);
      if (client && !damaged && !committed) {
        try { await client.query('ROLLBACK'); } catch (_) { damaged = true; }
      }
      if (!['preparation_invalidated', 'source_check_failed', 'persistence_invalid'].includes(error?.code)) {
        throw failure('persistence_failed');
      }
      throw error;
    } finally { if (client) client.release(damaged || !!clientFailure(client)); }
  }
  return { load, publish };
}

module.exports = { VERSION, DEFINITION, SNAPSHOT_KEY, PEOPLE_SQL, SHOWS_SQL, projectSource, readSource,
  identitySignature, describeRelationships, matchesIdentity, createMusicPeopleRelationshipStore };
