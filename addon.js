#!/usr/bin/env node
'use strict';
// Serveur French-Stream-Full — SDK Stremio officiel + Express robuste.
const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const { loadSites } = require('./src/config');
const store = require('./src/store');
const { indexResult, searchIndex, pagesForContent } = require('./src/indexer');
const { AnimeAdapter } = require('./src/adapters/anime');
const { MovieSeriesAdapter } = require('./src/adapters/movies');
const { score, isMatch } = require('./src/utils/normalize');
const { fetchText } = require('./src/http');
const log = require('./src/logger');
const { buildStreams } = require('./src/streams');

const SITES = loadSites();
const adapters = {};
if (SITES.animeSite && SITES.animeSite.enabled) adapters.anime = new AnimeAdapter('anime', SITES.animeSite);
if (SITES.movieSeriesSite && SITES.movieSeriesSite.enabled) adapters.movies = new MovieSeriesAdapter('movies', SITES.movieSeriesSite);

const manifest = {
  id: 'org.frenchstreamfull.addon',
  version: '1.0.2',
  name: 'French-Stream-Full',
  description: 'Films, series, animes VF / VOSTFR — French-Stream + French-Manga.',
  logo: 'https://french-stream-full.onrender.com/logo.png',
  background: 'https://french-stream-full.onrender.com/logo.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'fsf-movies', name: 'FSF Films', extra: [{ name: 'search', isRequired: false }] },
    { type: 'series', id: 'fsf-series', name: 'FSF Series et Animes', extra: [{ name: 'search', isRequired: false }] }
  ],
  idPrefixes: ['fsf:', 'tt']
};

const builder = new addonBuilder(manifest);

function toMeta(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.title,
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
        const assignedType = type === 'movie' ? 'movie' : (item.title.match(/film/i) ? 'movie' : 'series');
        const id = indexResult(key, { ...item, type: assignedType }, type);
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

// Seeding populaire en arriere-plan pour que le catalogue Discover ne soit jamais vide
let seedingStarted = false;
async function seedCatalog() {
  if (seedingStarted) return;
  seedingStarted = true;
  const popularMovies = ['Gladiator', 'Dune', 'Inception', 'Avengers', 'Oppenheimer', 'Interstellar', 'Avatar'];
  const popularSeries = ['Naruto', 'One Piece', 'Breaking Bad', 'Game of Thrones', 'Stranger Things'];
  for (const m of popularMovies) {
    try { await searchAll(m, 'movie'); } catch {}
  }
  for (const s of popularSeries) {
    try { await searchAll(s, 'series'); } catch {}
  }
}

builder.defineCatalogHandler(async (args) => {
  const q = (args.extra && args.extra.search) || '';
  if (!q) {
    const list = store.contentsByType(args.type);
    if (list.length === 0) {
      // Lance le seeding en tâche de fond et cherche quelques titres immédiatement
      seedCatalog().catch(() => {});
      const seedQuery = args.type === 'movie' ? 'Gladiator' : 'Naruto';
      const initial = await searchAll(seedQuery, args.type);
      return { metas: initial.map((r) => toMeta(r.row)) };
    }
    return { metas: list.map(toMeta) };
  }
  const res = await searchAll(q, args.type);
  return { metas: res.map((r) => toMeta(r.row)) };
});

builder.defineMetaHandler(async (args) => {
  // Cas Cinemeta (tt...)
  if (String(args.id).startsWith('tt')) {
    try {
      const res = await fetchText(`https://v3-cinemeta.strem.io/meta/${args.type}/${args.id}.json`);
      if (res.ok) {
        const d = JSON.parse(res.text);
        if (d && d.meta) return { meta: d.meta };
      }
    } catch {}
    return { meta: null };
  }

  const row = store.getContent(args.id);
  if (!row) return { meta: null };
  const meta = toMeta(row);
  const pages = pagesForContent(args.id);
  let eps = store.episodesFor(args.id);

  // Si c'est une serie et qu'aucun episode n'est en cache, on extrait la fiche maintenant
  if (meta.type === 'series' && (!eps || !eps.length) && pages.length) {
    const page = pages[0];
    const ad = adapters[page.site];
    if (ad) {
      try {
        const detail = await ad.extractContent(page.url);
        if (detail && detail.episodes && detail.episodes.length) {
          for (const ep of detail.episodes) {
            store.upsertPage({
              url: `${page.url}#ep=${ep.episode}&v=${(ep.version || 'vf').toLowerCase()}`,
              site: page.site,
              contentId: args.id,
              season: ep.season || 1,
              episode: ep.episode,
              episodeTitle: ep.title,
              status: 200
            });
          }
          eps = store.episodesFor(args.id);
        }
      } catch (err) {
        log.error(page.site, 'meta-extract', String(err).slice(0, 300));
      }
    }
  }

  if (eps && eps.length) {
    const seen = new Set();
    meta.videos = [];
    for (const e of eps) {
      const key = `${e.season}x${e.episode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      meta.videos.push({
        id: `${args.id}:S${e.season}E${e.episode}`,
        title: e.title || `Episode ${e.episode}`,
        season: e.season,
        episode: e.episode
      });
    }
  }
  return { meta };
});

builder.defineStreamHandler(async (args) => {
  // Cas A : ID Cinemeta (tt0172495 ou tt0903747:1:2)
  if (String(args.id).startsWith('tt')) {
    try {
      const parts = String(args.id).split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;
      const metaRes = await fetchText(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`);
      if (metaRes.ok) {
        const metaData = JSON.parse(metaRes.text);
        const name = metaData?.meta?.name;
        if (name) {
          const searchRes = await searchAll(name, args.type);
          if (searchRes.length) {
            const bestId = searchRes[0].row.id;
            const pages = pagesForContent(bestId);
            if (pages.length) {
              const streams = await buildStreams(pages, { season, episode, version: null }, { adapters, SITES });
              if (streams.length) return { streams };
            }
          }
        }
      }
    } catch (e) {
      log.error('cinemeta', 'stream', String(e).slice(0, 300), { id: args.id });
    }
    return { streams: [] };
  }

  // Cas B : ID natif FSF (fsf:anime:hash ou fsf:anime:hash:S1E2)
  const m = String(args.id).match(/^(fsf:[^:]+:[^:]+)(?::S(\d+)E(\d+))?$/);
  if (!m) return { streams: [] };
  const contentId = m[1];
  const season = m[2] ? parseInt(m[2], 10) : 1;
  const episode = m[3] ? parseInt(m[3], 10) : null;
  const pages = pagesForContent(contentId);
  if (!pages.length) return { streams: [] };
  const streams = await buildStreams(pages, { season, episode, version: null }, { adapters, SITES });
  return { streams };
});

const app = express();
const PORT = process.env.PORT || 7000;

// Middleware CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// Fichiers statiques et routes explicites pour l'icone
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { maxAge: '1d' }));
app.use('/public', express.static(publicDir, { maxAge: '1d' }));

app.get('/logo.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(publicDir, 'logo.png'));
});

app.get('/logo.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(publicDir, 'logo.svg'));
});

// Routeur officiel SDK Stremio
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

// Page d'accueil / landing template
const landingHTML = landingTemplate(addonInterface.manifest);
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(landingHTML);
});

app.listen(PORT, () => {
  console.log(`\nFrench-Stream-Full : http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`Logo URL : http://127.0.0.1:${PORT}/logo.png`);
  console.log(`Sites actifs : ${Object.keys(adapters).join(', ') || 'AUCUN (verifie config/sites.json)'}\n`);
  // Pre-seed catalog en arrière-plan
  setTimeout(() => seedCatalog().catch(() => {}), 1000);
});
