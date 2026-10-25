#!/usr/bin/env node
'use strict';

// Vérification manuelle à lancer depuis le PC de l'utilisateur.
// Les rapports affichent les hôtes, jamais les URL complètes ni leurs paramètres.
const { loadSites } = require('../config');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { buildStreams } = require('../streams');
const { probeStream } = require('../probe');
const { ADDON_ID, ADDON_VERSION } = require('../manifest');
const { score, catalogScore, isMatch } = require('../utils/normalize');
const { discoverMovieSeriesBase } = require('../site-discovery');

const SITES = loadSites();
const RENDER_BASE = (process.env.BASE_URL || 'https://french-stream-full.onrender.com').replace(/\/+$/, '');
const customSeries = process.argv.slice(2).find(arg => arg.startsWith('--series='))?.slice('--series='.length).trim();
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
    if (manifest.id !== ADDON_ID || manifest.version !== ADDON_VERSION) {
      report(`  ATTENTION : Render sert une autre version (attendue ${ADDON_ID} v${ADDON_VERSION}); redeploie le dernier commit.`);
    }
  } catch (error) {
    report(`  inaccessible (${error.name || 'erreur réseau'})`);
  }
  try {
    const health = await renderJSON('/health');
    const body = health.body || {};
    report(`Render health : HTTP ${health.status}, version=${body.version || '(absente)'}, commit=${body.gitCommit || '(non exposé)'}, branche=${body.gitBranch || '(non exposée)'}`);
  } catch (error) {
    report(`Render health : inaccessible (${error.name || 'erreur réseau'})`);
  }
}

async function renderJSON(path) {
  const startedAt = Date.now();
  const response = await fetch(`${RENDER_BASE}${path}`, { signal: AbortSignal.timeout(60000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, elapsedMs: Date.now() - startedAt };
}

async function checkRenderStremioFlow({ label, type, catalogId, query, maxEpisodes = 1, expectedTitleIncludes = null, expectedSeason = null }) {
  report(`\n--- CHAÎNE API RENDER / STREMIO : ${label} (« ${query} ») ---`);
  const stats = { label, query, catalogMs: null, metaMs: null, streamMs: 0, catalogCount: 0, episodeCount: 0, streamCount: 0, directCount: 0, externalCount: 0, directProbeOk: 0, directProbeFail: 0, titleMismatch: 0, typeMismatch: 0, errors: 0 };
  try {
    const catalog = await renderJSON(`/catalog/${type}/${catalogId}/search=${encodeURIComponent(query)}.json`);
    const metas = catalog.body?.metas || [];
    stats.catalogMs = catalog.elapsedMs;
    stats.catalogCount = metas.length;
    report(`Catalogue Render : HTTP ${catalog.status}, ${metas.length} résultat(s), ${catalog.elapsedMs} ms`);
    if (catalog.status >= 400 || !metas.length) { stats.errors++; return stats; }

    const selected = expectedTitleIncludes
      ? metas.find(item => String(item.name || '').toLowerCase().includes(expectedTitleIncludes.toLowerCase()))
      : metas[0];
    if (!selected) {
      stats.errors++;
      report(`  ERREUR : aucun résultat ne contient « ${expectedTitleIncludes} ».`);
      return stats;
    }
    const selectedTitle = selected.name || '';
    const titleScore = score(query, selectedTitle);
    report(`  Élément reçu : ${selectedTitle || '(sans titre)'} (${selected.type || type}), correspondance titre ${titleScore.toFixed(2)}`);
    if (!isMatch(query, selectedTitle)) {
      stats.titleMismatch++;
      stats.errors++;
      report('  ERREUR : le premier résultat ne correspond pas suffisamment à la recherche.');
    }
    const metaResult = await renderJSON(`/meta/${type}/${encodeURIComponent(selected.id)}.json`);
    const meta = metaResult.body?.meta;
    stats.metaMs = metaResult.elapsedMs;
    stats.episodeCount = meta?.videos?.length || 0;
    report(`Métadonnées Render : HTTP ${metaResult.status}, type=${meta?.type || '(absent)'}, ${stats.episodeCount} épisode(s), ${metaResult.elapsedMs} ms`);
    if (metaResult.status >= 400 || !meta) { stats.errors++; return stats; }

    const actualType = meta.type || selected.type || type;
    if (actualType !== type) {
      stats.typeMismatch++;
      stats.errors++;
      report(`  ERREUR : le catalogue ${type} a renvoyé une fiche de type ${actualType}.`);
    }
    const allVideos = meta.videos?.length ? meta.videos : [];
    if (expectedSeason != null && !allVideos.some(video => Number(video.season) === Number(expectedSeason))) {
      stats.errors++;
      report(`  ERREUR : aucune vidéo de la saison ${expectedSeason} n’est exposée pour cette fiche.`);
      return stats;
    }
    const matchingVideos = expectedSeason == null
      ? allVideos
      : allVideos.filter(video => Number(video.season) === Number(expectedSeason));
    const videos = matchingVideos.length ? matchingVideos.slice(0, maxEpisodes) : [{ id: selected.id }];
    for (const video of videos) {
      const videoId = video.id;
      let directProbed = false;
      if (video.season != null || video.episode != null) {
        report(`  Sélection saison ${video.season ?? 1}, épisode ${video.episode ?? 1} — ID ${/:\d+:\d+$/.test(videoId) ? 'canonique' : 'à vérifier'}`);
      }
      const streamResult = await renderJSON(`/stream/${actualType}/${encodeURIComponent(videoId)}.json`);
      const streams = streamResult.body?.streams || [];
      stats.streamMs += streamResult.elapsedMs;
      stats.streamCount += streams.length;
      report(`    Flux Render : HTTP ${streamResult.status}, ${streams.length} source(s), ${streamResult.elapsedMs} ms`);
      if (streamResult.status >= 400) stats.errors++;
      for (const [index, stream] of streams.entries()) {
        if (stream.url) {
          stats.directCount++;
          if (index < 4) report(`      Directe : ${hostOf(stream.url)}; en-têtes Stremio ${stream.behaviorHints?.proxyHeaders?.request ? 'présents' : 'absents'}`);
          if (!directProbed) {
            directProbed = true;
            try {
              const referer = stream.behaviorHints?.proxyHeaders?.request?.Referer;
              const probe = await probeStream(stream.url, referer);
              if (probe.compatible) stats.directProbeOk++;
              else { stats.directProbeFail++; stats.errors++; }
              report(`      Contrôle média : HTTP ${probe.status || 0}, ${probe.contentType || 'type inconnu'}, ${probe.compatible ? 'accessible' : 'échec'}`);
            } catch {
              stats.directProbeFail++;
              stats.errors++;
              report('      Contrôle média : erreur réseau');
            }
          }
        } else if (stream.externalUrl) {
          stats.externalCount++;
          if (index < 4) report(`      Page externe : ${hostOf(stream.externalUrl)} (pas une lecture intégrée)`);
        } else {
          stats.errors++;
          if (index < 4) report('      Réponse sans URL vidéo reconnue.');
        }
      }
    }
    return stats;
  } catch (error) {
    stats.errors++;
    report(`  Échec chaîne Render : ${error.name || 'erreur réseau'} — ${redact(error.message || String(error)).slice(0, 180)}`);
    return stats;
  }
}

async function checkTitle({ label, site, query, type, episode, season = null }) {
  const adapter = adapters[site];
  const stats = { searchMs: null, detailMs: null, localEpisodeCount: 0, localSourceCount: 0, assembledStreamCount: 0 };
  report(`\n=== ${label} | recherche « ${query} » ===`);
  if (!adapter || !adapter.enabled) {
    report('Adaptateur désactivé dans config/sites.json');
    return stats;
  }

  try {
    let startedAt = Date.now();
    const found = await adapter.search(query);
    stats.searchMs = Date.now() - startedAt;
    const ranked = found
      .map(item => ({ item, rank: catalogScore(query, item.title, type, { candYear: item.year }) }))
      .filter(({ item }) => isMatch(query, item.title, { candYear: item.year }))
      .filter(({ item }) => !expectedTitleIncludes || String(item.title || '').toLowerCase().includes(expectedTitleIncludes.toLowerCase()))
      .sort((a, b) => b.rank - a.rank);
    report(`Étape recherche ${site} : ${stats.searchMs} ms, ${found.length} résultat(s), ${ranked.length} résultat(s) retenu(s) après le tri de l’add-on`);
    const item = ranked[0]?.item;
    if (!item) {
      report(expectedTitleIncludes
        ? `Aucun résultat exploitable avec « ${expectedTitleIncludes} » dans le titre.`
        : 'Aucun résultat ne passe le filtre de correspondance de l’add-on.');
      return stats;
    }
    report(`Premier résultat : ${item.title}`);

    startedAt = Date.now();
    const detail = await adapter.extractContent(item.url);
    stats.detailMs = Date.now() - startedAt;
    stats.localEpisodeCount = (detail.episodes || []).length;
    stats.localSourceCount = (detail.sources || []).length;
    report(`Étape fiche ${site} : ${stats.detailMs} ms; titre=${detail.title || '(vide)'} type=${detail.type || type} épisodes=${stats.localEpisodeCount} sources=${stats.localSourceCount}`);

    const selectedEpisode = episode == null
      ? null
      : (detail.episodes || []).find((item) => Number(item.episode) === Number(episode)
        && (season == null || Number(item.season ?? 1) === Number(season)));
    const selectedSeason = season ?? selectedEpisode?.season ?? 1;
    if (selectedEpisode) {
      report(`  Épisode retenu : saison ${selectedSeason}, épisode ${episode} (${selectedEpisode.title || 'sans titre'})`);
    }
    const candidates = (detail.sources || []).filter(s => episode == null
      || (Number(s.episode) === Number(episode) && Number(s.season ?? 1) === Number(selectedSeason)));
    const seenHosts = new Set();
    const perHost = candidates.filter((source) => {
      const key = source.host || hostOf(source.url);
      if (seenHosts.has(key)) return false;
      seenHosts.add(key);
      return true;
    }).slice(0, 8);
    for (const source of perHost) report(`  Source ${redact(source.host || hostOf(source.url))} (${source.lang || source.version || 'langue inconnue'})`);
    if (!perHost.length) report('  Aucune source déclarée pour cet épisode/film.');

    const want = { season: selectedSeason, episode, version: null };
    const assembleStartedAt = Date.now();
    const streams = await buildStreams([{ url: item.url, site }], want, { adapters, SITES });
    const assembleMs = Date.now() - assembleStartedAt;
    stats.assembledStreamCount = streams.length;
    report(`Étape résolution Stremio locale : ${assembleMs} ms, ${streams.length} source(s)`);
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
  return stats;
}

(async () => {
  report('Vérification locale French-Stream-Full — aucun jeton ni URL complète ne sera écrit dans ce rapport.');
  const discovery = await discoverMovieSeriesBase(SITES, adapters);
  report(discovery.baseUrl
    ? `Domaine films/séries découvert : ${hostOf(discovery.baseUrl)} (source ${discovery.source})`
    : `Domaine films/séries introuvable : ${discovery.error || 'aucune adresse de secours'}`);
  await checkRender();
  const cases = [
    ...['Avengers', 'Dune', 'Inception', 'Interstellar', 'Gladiator', 'Titanic', 'Oppenheimer', 'The Matrix', 'Jurassic Park', 'Spider-Man'].map(query => ({ label: 'FILM', site: 'movies', type: 'movie', catalogId: 'fsf-movies', query, episode: null })),
    ...['Breaking Bad', 'Game of Thrones', 'Stranger Things', 'The Walking Dead', 'The Boys', 'Sherlock', 'Prison Break', 'La Casa de Papel', 'The Last of Us', 'The Office'].map(query => ({ label: 'SÉRIE', site: 'movies', type: 'series', catalogId: 'fsf-series', query, episode: 1 })),
    ...['Naruto', 'One Piece', 'L’Attaque des Titans', 'Demon Slayer', 'Jujutsu Kaisen', 'Death Note', 'Dragon Ball Z', 'My Hero Academia', 'One Punch Man', 'Tokyo Ghoul'].map(query => ({ label: 'ANIME', site: 'anime', type: 'series', catalogId: 'fsf-series', query, episode: 1 }))
  ];
  const totals = { FILM: { tested: 0, results: 0, episodes: 0, direct: 0, external: 0, probeOk: 0, probeFail: 0, errors: 0, localSources: 0, localStreams: 0 }, SÉRIE: { tested: 0, results: 0, episodes: 0, direct: 0, external: 0, probeOk: 0, probeFail: 0, errors: 0, localSources: 0, localStreams: 0 }, ANIME: { tested: 0, results: 0, episodes: 0, direct: 0, external: 0, probeOk: 0, probeFail: 0, errors: 0, localSources: 0, localStreams: 0 } };
  for (const testCase of cases) {
    const result = await checkRenderStremioFlow(testCase);
    const local = await checkTitle({ label: `LOCAL ${testCase.label}`, site: testCase.site, query: testCase.query, type: testCase.type, episode: testCase.episode });
    const total = totals[testCase.label];
    total.tested++;
    total.results += result.catalogCount;
    total.episodes += result.episodeCount;
    total.direct += result.directCount;
    total.external += result.externalCount;
    total.probeOk += result.directProbeOk;
    total.probeFail += result.directProbeFail;
    total.errors += result.errors;
    total.localSources += local.localSourceCount;
    total.localStreams += local.assembledStreamCount;
  }
  report('\n=== VÉRIFICATION CIBLÉE DES SPÉCIAUX ===');
  await checkRenderStremioFlow({
    label: 'ANIME SPÉCIAUX', type: 'series', catalogId: 'fsf-series',
    query: 'One Punch Man', maxEpisodes: 6,
    expectedTitleIncludes: 'special', expectedSeason: 0
  });
  await checkTitle({
    label: 'ANIME SPÉCIAUX', site: 'anime', query: 'One Punch Man',
    type: 'series', episode: 1, season: 0, expectedTitleIncludes: 'special'
  });
  report('\n=== SYNTHÈSE 30 CAS ===');
  for (const [type, total] of Object.entries(totals)) {
    report(`${type}: ${total.tested} test(s), ${total.results} résultat(s) catalogue Render, ${total.episodes} épisode(s), ${total.direct} flux directs / ${total.external} pages externes Render, médias accessibles ${total.probeOk}/${total.probeOk + total.probeFail}, ${total.localSources} source(s) trouvée(s) localement, ${total.localStreams} flux assemblé(s) localement, ${total.errors} erreur(s) API/type/titre Render`);
  }
  if (customSeries) {
    await checkRenderStremioFlow({ label: 'série à diagnostiquer', type: 'series', catalogId: 'fsf-series', query: customSeries, maxEpisodes: 3 });
    await checkTitle({ label: 'SÉRIE À DIAGNOSTIQUER', site: 'movies', query: customSeries, type: 'series', episode: 1 });
  }
  report('\nFin. Le rapport distingue les sources annoncées par le site et les sources réellement retournées à Stremio.');
})().catch((error) => {
  report(`Erreur générale : ${error.name || 'erreur'} — ${redact(error.message || String(error)).slice(0, 220)}`);
  process.exitCode = 1;
});
