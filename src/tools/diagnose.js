#!/usr/bin/env node
'use strict';
// Diagnostic calibre : recherche reelle + extraction + episodes + probe.
const { loadSites } = require('../config');
const store = require('../store');
const { AnimeAdapter } = require('../adapters/anime');
const { MovieSeriesAdapter } = require('../adapters/movies');
const { probeStream } = require('../probe');
const { score } = require('../utils/normalize');
const { findCurrentMovieSeriesUrl, discoverMovieSeriesBase } = require('../site-discovery');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

(async () => {
  if (args.selftest) {
    const assert = require('node:assert/strict');
    const { norm, isMatch, parseSeasonEpisode, score, catalogScore } = require('../utils/normalize');
    const testSites = loadSites();
    assert.equal(testSites.movieSeriesSite.enabled, true);
    assert.equal(testSites.movieSeriesSite.baseUrl, '');
    assert.ok(testSites.movieSeriesSite.discoveryUrl);
    console.log('norm =', norm("L'Attaque des Titans"));
    console.log('score naruto =', score('naruto', 'Naruto Shippuden Kai - Saison 1').toFixed(2));
    console.log('isMatch =', isMatch('naruto', 'Naruto Shippuden Kai - Saison 1'));
    console.log('parse =', JSON.stringify(parseSeasonEpisode('Saison 2 Episode 5')));
    const { DleAdapter } = require('../adapters/dle');
    const { detectContentType } = require('../adapters/movies');
    const sample = `<div class='search-item' onclick="location.href='/1498756-naruto-test-2025.html'"><div class='search-poster'><img src='https://image.tmdb.org/t/p/w500/x.jpg' alt='Naruto Test' loading='lazy'></div><div class='search-info'><div class='search-title'>Naruto Test (2025)</div></div></div>`;
    const dle = new DleAdapter('test', { baseUrl: 'https://x.test' });
    console.log('parse-search-items =', dle.parseSearchItems(sample).length + ' items (attendu: 1)');
    assert.equal(dle.parseSearchItems(sample).length, 1);
    assert.equal(detectContentType('<div id="serie-config" data-news-id="42"></div>'), 'series');
    assert.equal(detectContentType('<div id="film-data" data-newsid="43"></div>'), 'movie');
    assert.equal(detectContentType('<main class="not-a-content-page"></main>'), null);
    assert.equal(score('Breaking Bad', 'Breaking Bad - Saison 2'), 1);
    assert.ok(score('The Boys', 'The Boys - Saison 4') > score('The Boys', 'The Boys in the Band'));
    assert.ok(catalogScore('Death Note', 'Death Note - Saison 1', 'series') > catalogScore('Death Note', 'Death Note', 'series'));
    assert.equal(isMatch('The Matrix', 'A Glitch in the Matrix'), false);
    const { streamCacheKey, parseContentVideoId, uniqueContentPages, extractDirectVideoUrl, unpack, decodePackedVideo } = require('../streams');
    const packedFixture = `eval(function(p,a,c,k,e,d){return p}('0',10,1,'https://cdn.example.test/video.m3u8'.split('|'),0,{}))`;
    assert.equal(unpack(packedFixture), 'https://cdn.example.test/video.m3u8');
    assert.equal(decodePackedVideo(packedFixture), 'https://cdn.example.test/video.m3u8');
    assert.equal(unpack(`eval(function(p,a,c,k,e,d){return p}('0',10,1,'x'.split('|'),0,{}))`), 'x');
    const base62Words = Array.from({ length: 37 }, (_, i) => i === 36 ? 'video' : `unused${i}`).join('|');
    assert.equal(unpack(`eval(function(p,a,c,k,e,d){return p}('A',62,37,'${base62Words}'.split('|'),0,{}))`), 'video');
    assert.notEqual(
      streamCacheKey('https://site.test/show#ep=1&v=vf', { season: 1, episode: 1 }),
      streamCacheKey('https://site.test/show#ep=1&v=vf', { season: 1, episode: 2 })
    );
    assert.notEqual(
      streamCacheKey('https://site.test/show#ep=1&v=vf', { season: 1, episode: 1, version: 'vf' }),
      streamCacheKey('https://site.test/show#ep=1&v=vf', { season: 1, episode: 1, version: 'vostfr' })
    );
    assert.deepEqual(parseContentVideoId('fsf:movies:abc123:1:7'), { contentId: 'fsf:movies:abc123', season: 1, episode: 7 });
    assert.deepEqual(parseContentVideoId('fsf:anime:def456:S2E3'), { contentId: 'fsf:anime:def456', season: 2, episode: 3 });
    assert.equal(parseContentVideoId('fsf:anime:def456:bad'), null);
    assert.equal(uniqueContentPages([
      { site: 'movies', url: 'https://site.test/show' },
      { site: 'movies', url: 'https://site.test/show#ep=1&v=vf' },
      { site: 'movies', url: 'https://site.test/show#ep=2&v=vostfr' }
    ]).length, 1);
    assert.equal(extractDirectVideoUrl('{"file":"https:\\/\\/cdn.example.test\\/episode.m3u8?sig=abc"}'), 'https://cdn.example.test/episode.m3u8?sig=abc');
    assert.equal(findCurrentMovieSeriesUrl('<a href="https://ads.example.test">Publicité</a><a href="https://new.example.test/">Regarder en streaming</a>', 'https://relay.example.test/'), 'https://new.example.test');
    const { addonBuilder } = require('stremio-addon-sdk');
    const { ADDON_ID, ADDON_VERSION, createManifest } = require('../manifest');
    const manifest = createManifest('https://example.test/');
    assert.equal(manifest.id, ADDON_ID);
    assert.equal(manifest.version, ADDON_VERSION);
    assert.equal(manifest.name, 'French-Stream-Full');
    assert.deepEqual(manifest.catalogs.map(c => c.id), ['fsf-movies', 'fsf-series']);
    assert.equal(manifest.logo, 'https://example.test/logo.png');
    const manifestBuilder = new addonBuilder({ id: 'test.addon', version: '1.0.0', name: 'test', description: 'test', resources: ['stream'], types: ['movie', 'series'], catalogs: [] });
    manifestBuilder.defineStreamHandler(() => ({ streams: [] }));
    assert.deepEqual(manifestBuilder.getInterface().manifest.types, ['movie', 'series']);
    console.log('series-video-id = canonical and legacy episode IDs parsed');
    console.log('stream-pages = duplicate episode pages collapsed to one source page');
    console.log('SELFTEST OK');
    return;
  }
  const SITES = loadSites();
  const movieAdapter = new MovieSeriesAdapter('movies', SITES.movieSeriesSite);
  const discovery = await discoverMovieSeriesBase(SITES, { movies: movieAdapter });
  console.log('=== French-Stream-Full DIAGNOSTIC ===');
  for (const k of ['animeSite', 'movieSeriesSite', 'redirectService']) {
    const s = SITES[k];
    const host = s.baseUrl ? new URL(s.baseUrl).host : '';
    console.log(`- ${k}: ${s.enabled && host ? 'ACTIF ' + host : 'DESACTIVE (' + (s._reason || 'off') + ')'}`);
  }
  console.log(`- découverte: ${discovery.source}${discovery.baseUrl ? ' -> ' + new URL(discovery.baseUrl).host : ' (échec)'}`);
  if (args.query) {
    const isMovie = args.type === 'movie';
    const Ad = isMovie ? MovieSeriesAdapter : AnimeAdapter;
    const key = isMovie ? 'movieSeriesSite' : 'animeSite';
    const cfg = SITES[key];
    if (!cfg.enabled) { console.log(`\n[SKIP] ${key} desactive`); return; }
    const ad = isMovie ? movieAdapter : new Ad('anime', cfg);
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
