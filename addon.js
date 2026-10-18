#!/usr/bin/env node
'use strict';
// Serveur French-Stream-Full — SDK Stremio officiel, zero dependance native.
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { loadSites } = require('./src/config');
const store = require('./src/store');
const { indexResult, searchIndex, pagesForContent } = require('./src/indexer');
const { AnimeAdapter } = require('./src/adapters/anime');
const { MovieSeriesAdapter } = require('./src/adapters/movies');
const { score, isMatch } = require('./src/utils/normalize');
const log = require('./src/logger');
const { buildStreams } = require('./src/streams');

const SITES = loadSites();
const adapters = {};
if (SITES.animeSite.enabled) adapters.anime = new AnimeAdapter('anime', SITES.animeSite);
if (SITES.movieSeriesSite.enabled) adapters.movies = new MovieSeriesAdapter('movies', SITES.movieSeriesSite);

const manifest = {
  id: 'org.frenchstreamfull.addon',
  version: '1.0.1',
  name: 'French-Stream-Full',
  description: 'Films, series, animes FR — French-Stream + French-Manga via hub FStream.',
  logo: 'https://french-stream-full.onrender.com/logo.png',
  background: 'https://french-stream-full.onrender.com/logo.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'fsf-movies', name: 'FSF Films', extra: [{ name: 'search', isRequired: false }] },
    { type: 'series', id: 'fsf-series', name: 'FSF Series et Animes', extra: [{ name: 'search', isRequired: false }] }
  ],
  idPrefixes: ['fsf:']
};

const builder = new addonBuilder(manifest);

function toMeta(row) {
  return {
    id: row.id, type: row.type, name: row.title,
    poster: row.poster || undefined,
    description: row.synopsis || undefined,
    releaseInfo: row.year ? String(row.year) : undefined
  };
}

async function searchAll(query, type) {
  const found = new Map();
  for (const r of searchIndex(query, type)) found.set(r.id, { row: r, score: r._score });
  for (const [key, ad] of Object.entries(adapters)) {
    if (type === 'movie' && key === 'anime') continue;
    try {
      const live = await ad.search(query);
      for (const item of live) {
        const s = score(query, item.title, { candYear: item.year });
        if (!isMatch(query, item.title, { candYear: item.year })) {
          store.logDiag(key, item.url, 'search', 'filtered', `Score ${s.toFixed(2)} : "${item.title}" vs "${query}"`);
          continue;
        }
        const id = indexResult(key, { ...item, type: type === 'movie' ? 'movie' : (item.title.match(/film/i) ? 'movie' : 'series') }, type);
        const row = store.getContent(id);
        if (!found.has(id)) found.set(id, { row, score: s });
      }
    } catch (e) {
      log.error(key, 'search', String(e).slice(0, 300), { query });
      store.logDiag(key, ad.baseUrl, 'search', 'error', String(e).slice(0, 500));
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 30);
}

builder.defineCatalogHandler(async (args) => {
  const q = (args.extra && args.extra.search) || '';
  if (!q) return { metas: store.contentsByType(args.type).map(toMeta) };
  const res = await searchAll(q, args.type);
  return { metas: res.map((r) => toMeta(r.row)) };
});

builder.defineMetaHandler(async (args) => {
  const row = store.getContent(args.id);
  if (!row) return { meta: null };
  const meta = toMeta(row);
  const eps = store.episodesFor(args.id);
  if (eps.length) {
    // Regroupe par version pour eviter les doublons VF/VOSTFR
    const seen = new Set();
    meta.videos = [];
    for (const e of eps) {
      const key = `${e.season}x${e.episode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      meta.videos.push({ id: `${args.id}:S${e.season}E${e.episode}`, title: `Episode ${e.episode}`, season: e.season, episode: e.episode });
    }
  }
  return { meta };
});

builder.defineStreamHandler(async (args) => {
  const m = String(args.id).match(/^(fsf:[^:]+)(?::S(\d+)E(\d+))?$/);
  if (!m) return { streams: [] };
  const pages = pagesForContent(m[1]);
  if (!pages.length) return { streams: [] };
  const streams = await buildStreams(pages, { season: m[2] ? +m[2] : 1, episode: m[3] ? +m[3] : null, version: null }, { adapters, SITES });
  return { streams };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT, static: './public' });
console.log(`\nFrench-Stream-Full : http://127.0.0.1:${PORT}/manifest.json`);
console.log(`Sites actifs : ${Object.keys(adapters).join(', ') || 'AUCUN (verifie config/sites.json)'}\n`);
