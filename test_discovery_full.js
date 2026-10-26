const { MovieSeriesAdapter } = require('./src/adapters/movies');
const { loadSites } = require('./src/config');
const SITES = loadSites();
console.log('movieSeriesSite.enabled:', SITES.movieSeriesSite.enabled);
console.log('movieSeriesSite.baseUrl:', JSON.stringify(SITES.movieSeriesSite.baseUrl));
console.log('movieSeriesSite.discoveryUrl:', SITES.movieSeriesSite.discoveryUrl);
const movies = new MovieSeriesAdapter('movies', SITES.movieSeriesSite);
console.log('Adapter enabled:', movies.enabled);
(async () => {
  try {
    console.log('--- Test recherche avengers ---');
    const results = await movies.search('avengers');
    console.log('Résultats:', results.length);
    for (const r of results.slice(0, 3)) {
      console.log('  ', r.title, '->', r.url);
    }
    if (results[0]) {
      console.log('--- Test extraction ---');
      const detail = await movies.extractContent(results[0].url);
      console.log('Titre:', detail.title);
      console.log('Type:', detail.type);
      console.log('Sources:', detail.sources.length);
      for (const s of detail.sources.slice(0, 3)) {
        console.log('  ', s.label, '->', s.url.slice(0, 80));
      }
    }
  } catch(e) {
    console.log('ERREUR:', e.message.slice(0, 500));
  }
})();
