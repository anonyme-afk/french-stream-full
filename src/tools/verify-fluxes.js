#!/usr/bin/env node
'use strict';

// Vérification manuelle à lancer depuis le PC de l'utilisateur.
// Les rapports affichent les hôtes, jamais les URL complètes ni leurs paramètres.
const { loadSites } = require('../config');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { buildStreams } = require('../streams');

const SITES = loadSites();
const adapters = {
  anime: new AnimeAdapter('anime', SITES.animeSite),
  movies: new MovieSeriesAdapter('movies', SITES.movieSeriesSite)
};

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return '(URL invalide)'; }
}

function redact(value) {
  return String(value || '').replace(/https?:\/\/[^\s)]+/gi, '[URL masquée]');
}

function report(message = '') { process.stdout.write(message + '\n'); }

async function checkRender() {
  const base = (process.env.BASE_URL || 'https://french-stream-full.onrender.com').replace(/\/+$/, '');
  report(`Render manifest (${new URL(base).hostname}) :`);
  try {
    const response = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(15000) });
    report(`  HTTP ${response.status}`);
    if (!response.ok) return;
    const manifest = await response.json();
    report(`  id=${manifest.id || '(absent)'} version=${manifest.version || '(absente)'}`);
    report(`  types=${(manifest.types || []).join(', ')}`);
    report(`  catalogues=${(manifest.catalogs || []).map(c => `${c.type}:${c.id}`).join(', ')}`);
  } catch (error) {
    report(`  inaccessible (${error.name || 'erreur réseau'})`);
  }
}

async function checkTitle({ label, site, query, type, episode }) {
  const adapter = adapters[site];
  report(`\n=== ${label} | recherche « ${query} » ===`);
  if (!adapter || !adapter.enabled) {
    report('Adaptateur désactivé dans config/sites.json');
    return;
  }

  try {
    const found = await adapter.search(query);
    report(`Résultats recherche : ${found.length}`);
    const item = found[0];
    if (!item) return;
    report(`Premier résultat : ${item.title}`);

    const detail = await adapter.extractContent(item.url);
    report(`Fiche : titre=${detail.title || '(vide)'} type=${detail.type || type} épisodes=${(detail.episodes || []).length} sources=${(detail.sources || []).length}`);

    const candidates = (detail.sources || []).filter(s => episode == null || s.episode === episode);
    const seenHosts = new Set();
    const perHost = candidates.filter((source) => {
      const key = source.host || hostOf(source.url);
      if (seenHosts.has(key)) return false;
      seenHosts.add(key);
      return true;
    }).slice(0, 8);
    for (const source of perHost) report(`  Source ${redact(source.host || hostOf(source.url))} (${source.lang || source.version || 'langue inconnue'})`);
    if (!perHost.length) report('  Aucune source déclarée pour cet épisode/film.');

    const want = { season: 1, episode, version: null };
    const streams = await buildStreams([{ url: item.url, site }], want, { adapters, SITES });
    report(`Réponse assemblée pour Stremio : ${streams.length} source(s)`);
    for (const stream of streams) {
      const kind = stream.url ? `directe (${hostOf(stream.url)})` : `lecteur externe (${hostOf(stream.externalUrl)})`;
      const validShape = Boolean(stream.url || stream.externalUrl || stream.ytId || stream.infoHash);
      report(`  ${validShape ? 'format accepté' : 'format incomplet'} — ${kind} — ${stream.name || 'sans nom'}`);
    }
    if (!streams.length) report('  Rien ne prouve encore qu’un flux soit lisible. Vérifie la lecture dans Stremio après installation locale.');
  } catch (error) {
    report(`Échec vérification : ${error.name || 'erreur'} — ${redact(error.message || String(error)).slice(0, 220)}`);
  }
}

(async () => {
  report('Vérification locale French-Stream-Full — aucun jeton ni URL complète ne sera écrit dans ce rapport.');
  await checkRender();
  await checkTitle({ label: 'SÉRIE', site: 'movies', query: 'Breaking Bad', type: 'series', episode: 1 });
  await checkTitle({ label: 'FILM', site: 'movies', query: 'Avengers', type: 'movie', episode: null });
  await checkTitle({ label: 'ANIME', site: 'anime', query: 'Naruto', type: 'series', episode: 1 });
  report('\nFin. Le rapport distingue les sources annoncées par le site et les sources réellement retournées à Stremio.');
})().catch((error) => {
  report(`Erreur générale : ${error.name || 'erreur'} — ${redact(error.message || String(error)).slice(0, 220)}`);
  process.exitCode = 1;
});
