#!/usr/bin/env node
'use strict';
// Diagnostic calibre : recherche reelle + extraction + episodes + probe.
const { loadSites } = require('../config');
const store = require('../store');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { probeStream } = require('../probe');
const { score } = require('../utils/normalize');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

(async () => {
  if (args.selftest) {
    const { norm, isMatch, parseSeasonEpisode } = require('../utils/normalize');
    console.log('norm =', norm("L'Attaque des Titans"));
    console.log('score naruto =', score('naruto', 'Naruto Shippuden Kai - Saison 1').toFixed(2));
    console.log('isMatch =', isMatch('naruto', 'Naruto Shippuden Kai - Saison 1'));
    console.log('parse =', JSON.stringify(parseSeasonEpisode('Saison 2 Episode 5')));
    const { DleAdapter } = require('../adapters/dle');
    const sample = `<div class='search-item' onclick="location.href='/1498756-naruto-test-2025.html'"><div class='search-poster'><img src='https://image.tmdb.org/t/p/w500/x.jpg' alt='Naruto Test' loading='lazy'></div><div class='search-info'><div class='search-title'>Naruto Test (2025)</div></div></div>`;
    const dle = new DleAdapter('test', { baseUrl: 'https://x.test' });
    console.log('parse-search-items =', dle.parseSearchItems(sample).length + ' items (attendu: 1)');
    console.log('SELFTEST OK');
    return;
  }
  const SITES = loadSites();
  console.log('=== French-Stream-Full DIAGNOSTIC ===');
  for (const k of ['animeSite', 'movieSeriesSite', 'redirectService']) {
    const s = SITES[k];
    console.log(`- ${k}: ${s.enabled ? 'ACTIF ' + s.baseUrl : 'DESACTIVE (' + (s._reason || 'off') + ')'}`);
  }
  if (args.query) {
    const isMovie = args.type === 'movie';
    const Ad = isMovie ? MovieSeriesAdapter : AnimeAdapter;
    const key = isMovie ? 'movieSeriesSite' : 'animeSite';
    const cfg = SITES[key];
    if (!cfg.enabled) { console.log(`\n[SKIP] ${key} desactive`); return; }
    const ad = new Ad(isMovie ? 'movies' : 'anime', cfg);
    console.log(`\nRecherche "${args.query}" sur ${cfg.baseUrl} ...`);
    try {
      const res = await ad.search(args.query);
      console.log(`${res.length} resultats (top 5) :`);
      for (const r of res.slice(0, 5)) console.log(`  [${score(args.query, r.title).toFixed(2)}] ${r.title} (${r.year || '?'}) -> ${r.url}`);
      if (res[0]) {
        console.log(`\nExtraction ${res[0].url} ...`);
        const d = await ad.extractContent(res[0].url);
        console.log(`  Titre: ${d.title} | type: ${d.type} | episodes: ${d.episodes.length} | sources: ${d.sources.length} | newsId: ${d.newsId}`);
        for (const s of d.sources.slice(0, 4)) {
          const p = await probeStream(s.url).catch(() => ({ status: 0, compatible: false }));
          console.log(`  [${s.host}] ${s.url.slice(0, 80)} -> HTTP ${p.status} compatible-direct=${!!p.compatible} (sinon: lecteur externe)`);
        }
      }
    } catch (e) { console.log('ERREUR:', String(e).slice(0, 500)); }
  }
  console.log('\nDiagnostics stockes : data/fsf.json (diagnostics) + data/french-stream-full.log');
})();
