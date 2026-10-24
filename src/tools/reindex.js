#!/usr/bin/env node
'use strict';
// Reindexation incrementale (store JSON) : --site=anime|movies --limit=50 --query=xxx
const { loadSites } = require('../config');
const store = require('../store');
const { indexResult } = require('../indexer');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { discoverMovieSeriesBase } = require('../site-discovery');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

(async () => {
  const SITES = loadSites();
  const jobs = [];
  if (!args.site || args.site === 'anime') jobs.push(['anime', new AnimeAdapter('anime', SITES.animeSite)]);
  if (!args.site || args.site === 'movies') jobs.push(['movies', new MovieSeriesAdapter('movies', SITES.movieSeriesSite)]);
  const adapters = Object.fromEntries(jobs.map(([key, adapter]) => [key, adapter]));
  const discovery = await discoverMovieSeriesBase(SITES, adapters);
  if (discovery.baseUrl) console.log(`[movies] domaine actif obtenu via ${discovery.source}: ${new URL(discovery.baseUrl).host}`);
  else console.log(`[movies] domaine indisponible: ${discovery.error || 'aucune adresse de secours'}`);
  const queries = args.query ? [args.query] : ['naruto', 'one piece', 'demon slayer', 'avengers', 'batman'];
  const limit = +(args.limit || 50);
  let n = 0;
  for (const [key, ad] of jobs) {
    if (!ad.enabled) { console.log(`[SKIP] ${key} desactive`); continue; }
    for (const q of queries) {
      if (n >= limit) break;
      try {
        const res = await ad.search(q);
        for (const item of res.slice(0, 10)) {
          try {
            const detail = await ad.extractContent(item.url).catch(() => null);
            indexResult(key, { ...item, altTitles: detail?.altTitles, episodes: detail?.episodes }, key === 'anime' ? 'series' : undefined);
          } catch { indexResult(key, item); }
          store.logCrawl(key, item.url, 'index', 'ok', item.title);
          n++;
          if (n >= limit) break;
        }
        console.log(`[${key}] "${q}" -> ${res.length} resultats`);
      } catch (e) {
        store.logCrawl(key, ad.baseUrl, 'index', 'error', String(e).slice(0, 300));
        console.log(`[${key}] "${q}" ERREUR: ${String(e).slice(0, 200)}`);
      }
    }
  }
  const all = store.allContents();
  console.log(`Index : ${all.length} contenus | ${Object.keys(store.store.pages).length} pages | ${store.store.episodes.length} episodes`);
})();
