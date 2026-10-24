#!/usr/bin/env node
'use strict';

// Inspecte uniquement la forme des cartes d'épisodes, sans afficher les URL.
const { loadSites } = require('../config');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { discoverMovieSeriesBase } = require('../site-discovery');

const sites = loadSites();
const adapters = {
  anime: new AnimeAdapter('anime', sites.animeSite),
  movies: new MovieSeriesAdapter('movies', sites.movieSeriesSite)
};
const cases = [
  { label: 'ANIME', site: 'anime', query: 'One Punch Man' },
  { label: 'ANIME', site: 'anime', query: 'Naruto' },
  { label: 'SÉRIE', site: 'movies', query: 'Doctor Who' },
  { label: 'SÉRIE', site: 'movies', query: 'The Office' }
];

function mapSummary(label, data) {
  if (!data || typeof data !== 'object') { console.log(`  ${label}: données absentes`); return; }
  for (const [name, map] of Object.entries(data)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    const keys = Object.keys(map);
    const specialKeys = keys.filter(key => /special|sp[eé]cial|oav|ova|bonus|(^|\D)0($|\D)/i.test(key));
    console.log(`  ${label}.${name}: ${keys.length} entrée(s), premières clés=${keys.slice(0, 8).join(', ') || '(aucune)'}, clés spéciales=${specialKeys.join(', ') || '(aucune)'}`);
  }
}

async function main() {
  const discovery = await discoverMovieSeriesBase(sites, adapters);
  console.log(`Domaine films/séries : ${discovery.baseUrl ? new URL(discovery.baseUrl).host : 'indisponible'}`);
  for (const test of cases) {
    const adapter = adapters[test.site];
    if (!adapter.enabled) continue;
    try {
      const items = await adapter.search(test.query);
      const item = items[0];
      if (!item) { console.log(`${test.label} ${test.query}: aucun résultat`); continue; }
      const detail = await adapter.extractContent(item.url);
      const raw = test.site === 'anime'
        ? await adapter.episodesMap(detail.newsId, item.url)
        : await adapter.serieEpisodes(detail.newsId);
      const seasons = [...new Set(detail.episodes.map(episode => episode.season))].join(', ') || '(aucune)';
      console.log(`\n${test.label} ${test.query}: ${detail.title}; newsId présent=${!!detail.newsId}; épisodes exposés=${detail.episodes.length}; saisons exposées=${seasons}`);
      mapSummary('carte', raw);
    } catch (error) {
      const detail = String(error?.cause?.code || error?.message || error.name || 'erreur')
        .replace(/https?:\/\/\S+/gi, '[adresse masquée]')
        .replace(/[?&](?:token|key|sig|signature)=[^&\s]+/gi, '[paramètre masqué]')
        .slice(0, 120);
      console.log(`${test.label} ${test.query}: échec ${detail}`);
    }
  }
}

main().catch(error => { console.log(`Diagnostic interrompu : ${error.name || 'erreur'}`); process.exitCode = 1; });
