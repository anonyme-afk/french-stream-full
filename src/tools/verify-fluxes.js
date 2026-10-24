#!/usr/bin/env node
'use strict';

// Vérification manuelle à lancer depuis le PC de l'utilisateur.
// Les rapports affichent les hôtes, jamais les URL complètes ni leurs paramètres.
const { loadSites } = require('../config');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { buildStreams } = require('../streams');
const { probeStream } = require('../probe');

const SITES = loadSites();
const RENDER_BASE = (process.env.BASE_URL || 'https://french-stream-full.onrender.com').replace(/\/+$/, '');
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
  report(`Render manifest (${new URL(RENDER_BASE).hostname}) :`);
  try {
    const response = await fetch(`${RENDER_BASE}/manifest.json`, { signal: AbortSignal.timeout(60000) });
    report(`  HTTP ${response.status}`);
    if (!response.ok) return;
    const manifest = await response.json();
    report(`  id=${manifest.id || '(absent)'} version=${manifest.version || '(absente)'}`);
    report(`  types=${(manifest.types || []).join(', ')}`);
    report(`  catalogues=${(manifest.catalogs || []).map(c => `${c.type}:${c.id}`).join(', ')}`);
    if (manifest.id !== 'org.frenchstreamfull.addon') {
      report('  ATTENTION : Render sert encore un ancien manifeste; Stremio n’utilise pas le code poussé récemment.');
    }
  } catch (error) {
    report(`  inaccessible (${error.name || 'erreur réseau'})`);
  }
}

async function renderJSON(path) {
  const response = await fetch(`${RENDER_BASE}${path}`, { signal: AbortSignal.timeout(60000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function checkRenderStremioFlow({ label, type, catalogId, query }) {
  report(`\n--- CHAÎNE API RENDER / STREMIO : ${label} (« ${query} ») ---`);
  try {
    const catalog = await renderJSON(`/catalog/${type}/${catalogId}/search=${encodeURIComponent(query)}.json`);
    const metas = catalog.body?.metas || [];
    report(`Catalogue Render : HTTP ${catalog.status}, ${metas.length} résultat(s)`);
    if (!metas.length) return;

    const selected = metas[0];
    report(`  Élément reçu : ${selected.name || '(sans titre)'} (${selected.type || type})`);
    const metaResult = await renderJSON(`/meta/${type}/${encodeURIComponent(selected.id)}.json`);
    const meta = metaResult.body?.meta;
    report(`Métadonnées Render : HTTP ${metaResult.status}, ${meta?.videos?.length || 0} épisode(s)`);
    if (!meta) return;

    const video = meta.videos?.[0];
    const videoId = video?.id || selected.id;
    if (video) report(`  Épisode demandé : saison ${video.season || 1}, épisode ${video.episode || 1}`);
    const streamResult = await renderJSON(`/stream/${type}/${encodeURIComponent(videoId)}.json`);
    const streams = streamResult.body?.streams || [];
    report(`Réponse flux Render : HTTP ${streamResult.status}, ${streams.length} source(s)`);
    for (const stream of streams.slice(0, 6)) {
      if (stream.url) {
        report(`  Directe : ${hostOf(stream.url)}; en-têtes Stremio ${stream.behaviorHints?.proxyHeaders?.request ? 'présents' : 'absents'}`);
      } else if (stream.externalUrl) {
        report(`  Page externe : ${hostOf(stream.externalUrl)} (pas une lecture intégrée)`);
      } else {
        report('  Réponse sans URL vidéo reconnue.');
      }
    }
  } catch (error) {
    report(`  Échec chaîne Render : ${error.name || 'erreur réseau'} — ${redact(error.message || String(error)).slice(0, 180)}`);
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
    let directChecks = 0;
    for (const stream of streams) {
      if (stream.url) {
        const referer = stream.behaviorHints?.proxyHeaders?.request?.Referer;
        report(`  URL média Stremio — ${hostOf(stream.url)} — en-têtes ${referer ? 'présents' : 'absents'}`);
        if (directChecks < 2) {
          directChecks++;
          try {
            const probe = await probeStream(stream.url, referer);
            report(`    contrôle depuis ce PC : HTTP ${probe.status || 0}, ${probe.contentType || 'type inconnu'}, ${probe.compatible ? 'compatible' : 'incompatible'}${probe.reason ? ` (${probe.reason})` : ''}`);
          } catch (error) {
            report(`    contrôle média en échec : ${error.name || 'erreur réseau'}`);
          }
        }
      } else if (stream.externalUrl) {
        report(`  Lien de lecteur externe — ${hostOf(stream.externalUrl)} (ce n’est pas un flux lu directement dans Stremio)`);
      } else {
        report('  Source sans URL média ni lien externe reconnu.');
      }
    }
    if (!streams.length) report('  Rien ne prouve encore qu’un flux soit lisible. Vérifie la lecture dans Stremio après installation locale.');
  } catch (error) {
    report(`Échec vérification : ${error.name || 'erreur'} — ${redact(error.message || String(error)).slice(0, 220)}`);
  }
}

(async () => {
  report('Vérification locale French-Stream-Full — aucun jeton ni URL complète ne sera écrit dans ce rapport.');
  await checkRender();
  await checkRenderStremioFlow({ label: 'série A', type: 'series', catalogId: 'fsf-series', query: 'Breaking Bad' });
  await checkRenderStremioFlow({ label: 'série B', type: 'series', catalogId: 'fsf-series', query: 'Game of Thrones' });
  await checkRenderStremioFlow({ label: 'anime', type: 'series', catalogId: 'fsf-series', query: 'Naruto' });
  await checkRenderStremioFlow({ label: 'film témoin', type: 'movie', catalogId: 'fsf-movies', query: 'Avengers' });
  await checkTitle({ label: 'SÉRIE A', site: 'movies', query: 'Breaking Bad', type: 'series', episode: 1 });
  await checkTitle({ label: 'SÉRIE B', site: 'movies', query: 'Game of Thrones', type: 'series', episode: 1 });
  await checkTitle({ label: 'FILM A', site: 'movies', query: 'Avengers', type: 'movie', episode: null });
  await checkTitle({ label: 'FILM B', site: 'movies', query: 'Dune', type: 'movie', episode: null });
  await checkTitle({ label: 'ANIME A', site: 'anime', query: 'Naruto', type: 'series', episode: 1 });
  await checkTitle({ label: 'ANIME B', site: 'anime', query: 'One Piece', type: 'series', episode: 1 });
  report('\nFin. Le rapport distingue les sources annoncées par le site et les sources réellement retournées à Stremio.');
})().catch((error) => {
  report(`Erreur générale : ${error.name || 'erreur'} — ${redact(error.message || String(error)).slice(0, 220)}`);
  process.exitCode = 1;
});
