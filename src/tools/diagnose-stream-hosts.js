#!/usr/bin/env node
'use strict';

// Diagnostic ciblé des décodeurs : affiche uniquement les hôtes et statuts,
// jamais les URL média signées ni leurs paramètres.
const { loadSites } = require('../config');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { resolveDirectStream, unpack, extractDirectVideoUrl } = require('../streams');
const { probeStream } = require('../probe');
const { discoverMovieSeriesBase } = require('../site-discovery');
const { isMatch } = require('../utils/normalize');
const { fetchText } = require('../http');

const SITES = loadSites();
const adapters = {
  anime: new AnimeAdapter('anime', SITES.animeSite),
  movies: new MovieSeriesAdapter('movies', SITES.movieSeriesSite)
};
const cases = [
  { label: 'FILM', site: 'movies', type: 'movie', query: 'Dune', episode: null },
  { label: 'SÉRIE', site: 'movies', type: 'series', query: 'Breaking Bad', episode: 1 },
  { label: 'ANIME', site: 'anime', type: 'series', query: 'Naruto', episode: 1 }
];

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return '(hôte inconnu)'; }
}

async function main() {
  await discoverMovieSeriesBase(SITES, adapters);
  for (const test of cases) {
    const adapter = adapters[test.site];
    if (!adapter.enabled) { console.log(`${test.label}: adaptateur inactif`); continue; }
    try {
      const results = await adapter.search(test.query);
      const item = results.find(result => isMatch(test.query, result.title)) || results[0];
      if (!item) { console.log(`${test.label}: aucun résultat`); continue; }
      const detail = await adapter.extractContent(item.url);
      const sources = test.episode == null
        ? detail.sources || []
        : (await adapter.sourcesForEpisode(item.url, test.episode, null)).sources || [];
      const byHost = new Map();
      for (const source of sources) if (!byHost.has(source.host || hostOf(source.url))) byHost.set(source.host || hostOf(source.url), source);
      console.log(`\n${test.label}: ${detail.title || item.title}; sources=${sources.length}`);
      for (const [host, source] of [...byHost].slice(0, 6)) {
        const resolved = await resolveDirectStream(source.url, item.url);
        if (!resolved) {
          console.log(`  ${host}: aucun flux direct extrait`);
          if (process.argv.includes('--trace') && /luluvid/i.test(host)) {
            const page = await fetchText(source.url, { headers: { Referer: item.url }, timeout: 8000, retries: 0 });
            const pattern = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]{0,30000}?return\s+p\s*\}\s*\([\s\S]{0,200000}?\)\s*\)/gi;
            const blocks = [...String(page.text || '').matchAll(pattern)].slice(0, 4);
            console.log(`    page HTTP ${page.status || 0}; Packer blocks ${blocks.length}`);
            for (const [index, block] of blocks.entries()) {
              const decoded = unpack(block[0]);
              console.log(`    block ${index + 1}: decoded=${decoded ? 'yes' : 'no'}, text length=${decoded?.length || 0}, media marker=${decoded && /m3u8|\.mp4/i.test(decoded) ? 'yes' : 'no'}, URL recognized=${!!(decoded && extractDirectVideoUrl(decoded))}`);
            }
          }
          continue;
        }
        const probe = await probeStream(resolved.url, item.url);
        console.log(`  ${host}: ${resolved.streamType}, hôte média ${hostOf(resolved.url)}, HTTP ${probe.status || 0}, ${probe.contentType || 'type inconnu'}, ${probe.compatible ? 'compatible' : `incompatible${probe.reason ? ` (${probe.reason})` : ''}`}`);
      }
    } catch (error) {
      const safeMessage = String(error.message || error).replace(/https?:\/\/[^\s)]+/gi, '[URL masquée]');
      console.log(`${test.label}: erreur ${error.name || 'inconnue'} — ${safeMessage.slice(0, 160)}`);
    }
  }
}

main().catch(error => { console.error(`Diagnostic interrompu : ${error.name || 'erreur'}`); process.exitCode = 1; });
