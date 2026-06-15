const fs = require('fs');
const Module = require('module');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const existingDetailRouteMarker = "\napp.get('/api/music/people/db/:personId',";
const notFoundMarker = '\napp.use((req, res) => {';

const musicPersonDetailPatch = `

// Runtime patch: V3 Music People detail route.
// Keeps the existing V3 backend architecture and reuses the same DB/archive
// helpers that power /api/music/people/db?archive=cache.
app.get('/api/music/people/db/:personId', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const rawPersonId = String(req.params.personId || '').trim();
    const lowerPersonId = rawPersonId.toLowerCase();
    const personSlug = String(rawPersonId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!personSlug) {
      res.status(400).json({
        ok: false,
        route: '/api/music/people/db/:personId',
        error: 'MUSIC_PERSON_ID_REQUIRED'
      });
      return;
    }

    const result = await dbPool.query(
      \`SELECT person_id, name, category, aliases, bands, associations, stats
       FROM music_people
       WHERE person_id::text = $1
          OR lower(trim(person_id::text)) = $2
          OR lower(regexp_replace(trim(coalesce(name, '')), '[^a-z0-9]+', '-', 'g')) = $3
       ORDER BY person_id ASC
       LIMIT 1\`,
      [rawPersonId, lowerPersonId, personSlug]
    );

    const row = result.rows && result.rows[0];
    if (!row) {
      res.status(404).json({
        ok: false,
        route: '/api/music/people/db/:personId',
        error: 'MUSIC_PERSON_NOT_FOUND',
        person_id: rawPersonId
      });
      return;
    }

    const personId = String(row.person_id || '').trim();
    const cachedRelationships = typeof getCachedMusicPeopleArchiveRelationships === 'function'
      ? getCachedMusicPeopleArchiveRelationships()
      : null;
    const cachedArchive = cachedRelationships && typeof cachedRelationships.get === 'function'
      ? cachedRelationships.get(personId)
      : null;
    const archive = cachedArchive || (
      typeof getMusicPersonArchiveRelationship === 'function'
        ? await getMusicPersonArchiveRelationship(row)
        : {}
    );
    const archiveRelationships = new Map([[personId, archive || {}]]);
    const data = typeof buildMusicPersonDbApiItem === 'function'
      ? buildMusicPersonDbApiItem(row, archiveRelationships)
      : { ...row, ...(archive || {}) };
    const stats = data && data.stats && typeof data.stats === 'object' ? data.stats : {};
    const matchedPhotos = Array.isArray(data.matched_photos)
      ? data.matched_photos
      : Array.isArray(stats.matched_photos)
        ? stats.matched_photos
        : [];
    const taggedShows = Array.isArray(data.tagged_shows)
      ? data.tagged_shows
      : Array.isArray(stats.tagged_shows)
        ? stats.tagged_shows
        : [];
    const bands = Array.isArray(data.bands) ? data.bands : [];
    const instruments = Array.from(new Set(bands
      .flatMap((band) => String(band && (band.instrument || band.instruments) || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean)));
    const generated = new Date();
    const photoCount = data.photo_count ?? stats.photo_count ?? matchedPhotos.length;
    const showCount = data.show_count ?? stats.show_count ?? taggedShows.length;
    const setCount = data.set_count ?? stats.set_count ?? taggedShows.length;

    res.json({
      ok: true,
      route: '/api/music/people/db/:personId',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      generatedAt: generated.toISOString(),
      generatedTime: typeof formatEasternGeneratedTime === 'function'
        ? formatEasternGeneratedTime(generated)
        : generated.toISOString(),
      person_id: data.person_id,
      name: data.name,
      category: data.category,
      aliases: Array.isArray(data.aliases) ? data.aliases : [],
      bands,
      instruments,
      photo_count: photoCount,
      event_count: data.event_count ?? stats.event_count ?? showCount,
      show_count: showCount,
      set_count: setCount,
      first_seen: data.first_seen ?? stats.first_seen ?? null,
      latest_seen: data.latest_seen ?? stats.latest_seen ?? null,
      matched_photos: matchedPhotos,
      tagged_shows: taggedShows,
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/music/people/db/:personId', err, {
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      section: 'music',
      type: 'people',
      error: 'MUSIC_PERSON_DB_DETAIL_ERROR'
    }));
  }
});
`;

const insertionMarker = source.includes(existingDetailRouteMarker)
  ? existingDetailRouteMarker
  : notFoundMarker;

if (!source.includes(insertionMarker)) {
  throw new Error('Unable to install V3 Music People detail route patch: route marker not found.');
}

const patchedSource = source.replace(insertionMarker, `${musicPersonDetailPatch}${insertionMarker}`);

const serverModule = new Module(serverPath, module.parent);
serverModule.filename = serverPath;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(patchedSource, serverPath);
