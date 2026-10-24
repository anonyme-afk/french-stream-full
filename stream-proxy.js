'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// French Stream Full Proxy — v2.1.0 (fusion catalogue + proxy réseau)
// ═════════════════════════════════════════════════════════════════════════════

const { addonBuilder, getRouter, landingTemplate } = require('stremio-addon-sdk');
const path = require('path');
const express = require('express');
const { buildStreams, resolveDirectStream } = require('./src/streams.js');
const { MovieSeriesAdapter } = require('./src/adapters/movies.js');
const { AnimeAdapter } = require('./src/adapters/anime.js');
const store = require('./src/store');
const { indexResult, searchIndex, pagesForContent } = require('./src/indexer');
const { loadSites } = require('./src/config');
const { fetchText } = require('./src/http');
const { score, isMatch } = require('./src/utils/normalize');
const log = require('./src/logger');

// ══════════════════════════════════════════════════════════════════════════════
// CACHE EN MÉMOIRE VIVE (optimisation Render)
// ══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const resolutionCache = new Map();

function getCachedResolution(id) {
  const entry = resolutionCache.get(id);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  resolutionCache.delete(id);
  return null;
}

function setCachedResolution(id, data) {
  resolutionCache.set(id, { data, ts: Date.now() });
}

// ══════════════════════════════════════════════════════════════════════════════
// ADAPTERS & SITES
// ══════════════════════════════════════════════════════════════════════════════

const SITES = loadSites();
const adapters = {};
if (SITES.animeSite && SITES.animeSite.enabled) adapters.anime = new AnimeAdapter('anime', SITES.animeSite);
if (SITES.movieSeriesSite && SITES.movieSeriesSite.enabled) adapters.movies = new MovieSeriesAdapter('movies', SITES.movieSeriesSite);

// ══════════════════════════════════════════════════════════════════════════════
// CACHE IMDB ID → nom (évite les re-requêtes Cinemeta)
// ══════════════════════════════════════════════════════════════════════════════

const imdbNameCache = new Map();
const IMDB_CACHE_TTL = 3600_000; // 1 heure

async function getImdbName(imdbId, type) {
  const key = `${imdbId}:${type}`;
  const cached = imdbNameCache.get(key);
  if (cached && Date.now() - cached.ts < IMDB_CACHE_TTL) return cached;
  try {
    const res = await fetchText(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000, retries: 0 });
    if (res.ok) {
      const d = JSON.parse(res.text);
      if (d && d.meta) {
        const entry = { name: d.meta.name, meta: d.meta, ts: Date.now() };
        imdbNameCache.set(key, entry);
        return entry;
      }
    }
  } catch {}
  return null;
}
// ══════════════════════════════════════════════════════════════════════════════
// HELPERS (recopiés de addon.js)
// ══════════════════════════════════════════════════════════════════════════════

function toMeta(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.title,
    poster: row.poster || undefined,
    posterShape: 'poster',
    background: row.background || undefined,
    description: row.synopsis || undefined,
    releaseInfo: row.year ? String(row.year) : undefined,
    genres: row.genres && row.genres.length ? row.genres : undefined
  };
}

async function searchAll(query, type) {
  const found = new Map();
  for (const r of searchIndex(query, type)) found.set(r.id, { row: r, score: r._score });
  const adapterEntries = Object.entries(adapters).filter(([key]) => !(type === 'movie' && key === 'anime'));
  const promises = adapterEntries.map(async ([key, ad]) => {
    try {
      const live = await ad.search(query);
      const results = [];
      for (const item of live) {
        const s = score(query, item.title, { candYear: item.year });
        if (!isMatch(query, item.title, { candYear: item.year })) continue;
        const assignedType = type === 'movie' ? 'movie' : (item.title.match(/film/i) ? 'movie' : 'series');
        const id = indexResult(key, { ...item, type: assignedType }, type);
        const row = store.getContent(id);
        results.push({ id, row, score: s });
      }
      return results;
    } catch (e) {
      log.error(key, 'search', String(e).slice(0, 300), { query });
      return [];
    }
  });
  const allResults = await Promise.allSettled(promises);
  for (const r of allResults) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!found.has(item.id)) found.set(item.id, { row: item.row, score: item.score });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 30);
}

let seedingStarted = false;
async function seedCatalog() {
  if (seedingStarted) return;
  seedingStarted = true;
  const popular = [
    { q: 'Gladiator', t: 'movie' }, { q: 'Dune', t: 'movie' }, { q: 'Inception', t: 'movie' },
    { q: 'Avengers', t: 'movie' }, { q: 'Oppenheimer', t: 'movie' }, { q: 'Interstellar', t: 'movie' },
    { q: 'Naruto', t: 'series' }, { q: 'One Piece', t: 'series' }, { q: 'Breaking Bad', t: 'series' },
    { q: 'Game of Thrones', t: 'series' }, { q: 'Stranger Things', t: 'series' }, { q: 'Attack on Titan', t: 'series' }
  ];
  for (const { q, t } of popular) {
    try { await searchAll(q, t); } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MANIFESTE OFFICIEL (fusion)
// ══════════════════════════════════════════════════════════════════════════════

const builder = new addonBuilder({
  id: 'org.myaddon.proxyresolver',
  version: '2.1.0',
  name: 'French Stream Full Proxy',
  description: 'Films, séries, animes VF/VOSTFR avec proxy d\'en-têtes réseau stabilisé.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['fsf:', 'tt'],
  catalogs: [
    { type: 'movie', id: 'fs_movies', name: 'French Stream - Films' },
    { type: 'series', id: 'fs_series', name: 'French Stream - Séries' },
    { type: 'anime', id: 'fs_anime', name: 'French Manga - Animes' }
  ]
});
// ══════════════════════════════════════════════════════════════════════════════
// CATALOG HANDLER (recopié à l'identique de addon.js)
// ══════════════════════════════════════════════════════════════════════════════

builder.defineCatalogHandler(async (args) => {
  const q = (args.extra && args.extra.search) || '';
  if (!q) {
    const list = store.contentsByType(args.type);
    if (list.length === 0) {
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

// ══════════════════════════════════════════════════════════════════════════════
// META HANDLER (recopié à l'identique de addon.js, enrichi Cinemeta)
// ══════════════════════════════════════════════════════════════════════════════

builder.defineMetaHandler(async (args) => {
  // Cas Cinemeta (tt...)
  if (String(args.id).startsWith('tt')) {
    const entry = await getImdbName(args.id, args.type);
    if (entry && entry.meta) return { meta: entry.meta };
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
        // Enrich metadata from detail
        if (detail.poster && !row.poster) {
          store.upsertContent({ ...row, poster: detail.poster });
        }
        if (detail.synopsis && !row.synopsis) {
          store.upsertContent({ ...row, synopsis: detail.synopsis });
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
// ══════════════════════════════════════════════════════════════════════════════
// STREAM HANDLER (logique dynamique corrigée avec proxy réseau)
// ══════════════════════════════════════════════════════════════════════════════

const PROXY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
};

function streamResult(streams) {
  return {
    streams,
    behaviorHints: { notWebReady: true },
    proxyHeaders: PROXY_HEADERS
  };
}

builder.defineStreamHandler(async (args) => {
  // Cas A : ID Cinemeta (tt0172495 ou tt0903747:1:2)
  if (String(args.id).startsWith('tt')) {
    try {
      const parts = String(args.id).split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;
      const entry = await getImdbName(imdbId, args.type);
      if (entry && entry.name) {
        const searchRes = await searchAll(entry.name, args.type);
        if (searchRes.length) {
          for (const sr of searchRes.slice(0, 3)) {
            const pages = pagesForContent(sr.row.id);
            if (pages.length) {
              const streams = await buildStreams(pages, { season, episode, version: null }, { adapters, SITES });
              if (streams.length) {
                setCachedResolution(args.id, streamResult(streams));
                return streamResult(streams);
              }
            }
          }
        }
      }
    } catch (e) {
      log.error('cinemeta', 'stream', String(e).slice(0, 300), { id: args.id });
    }
    setCachedResolution(args.id, streamResult([]));
    return streamResult([]);
  }
  // Cas B : ID natif FSF (fsf:anime:hash ou fsf:anime:hash:S1E2)
  const m = String(args.id).match(/^(fsf:[^:]+:[^:]+)(?::S(\d+)E(\d+))?$/);
  if (!m) return streamResult([]);
  const contentId = m[1];
  const season = m[2] ? parseInt(m[2], 10) : 1;
  const episode = m[3] ? parseInt(m[3], 10) : null;
  const pages = pagesForContent(contentId);
  if (!pages.length) return streamResult([]);
  const streams = await buildStreams(pages, { season, episode, version: null }, { adapters, SITES });
  setCachedResolution(args.id, streamResult(streams));
  return streamResult(streams);
});

// ══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE DU SERVEUR (SDK Stremio)
// ══════════════════════════════════════════════════════════════════════════════

serveHTTP(builder.getInterface(), { port: process.env.PORT || 3000 });

console.log(`\n════════════════════════════════════════════════════════════════════════════════`);
console.log(`  French Stream Full Proxy v2.1.0`);
console.log(`  Manifest : http://127.0.0.1:${process.env.PORT || 3000}/manifest.json`);
console.log(`  Port     : ${process.env.PORT || 3000}`);
console.log(`════════════════════════════════════════════════════════════════════════════════\n`);