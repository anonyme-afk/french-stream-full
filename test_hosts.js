const { AnimeAdapter } = require('./src/adapters/anime');
const { loadSites } = require('./src/config');
const { resolveDirectStream } = require('./src/streams');
const { probeStream } = require('./src/probe');
const SITES = loadSites();
const anime = new AnimeAdapter('anime', SITES.animeSite);
(async () => {
  const results = await anime.search('naruto');
  const item = results[0];
  const detail = await anime.extractContent(item.url);
  const ep1 = detail.sources.filter(s => s.episode === 1);
  console.log('Sources Ep 1:', ep1.length);
  const byHost = {};
  for (const s of ep1) {
    if (!byHost[s.host]) byHost[s.host] = [];
    byHost[s.host].push(s);
  }
  for (const [host, list] of Object.entries(byHost)) {
    console.log('\n--- ' + host + ' (' + list.length + ' sources) ---');
    for (const s of list.slice(0, 3)) {
      console.log('  URL:', s.url.slice(0, 120));
      try {
        const direct = await resolveDirectStream(s.url);
        if (direct && direct.url) {
          const probe = await probeStream(direct.url, 'https://w16.french-manga.net/');
          console.log('  -> Direct:', direct.url.slice(0, 100));
          console.log('     Probe:', probe.streamType, 'compatible=', probe.compatible, 'tooSmall=', probe.isTooSmall, 'reason=', probe.reason);
        } else {
          console.log('  -> Aucun flux resolu');
        }
      } catch(e) {
        console.log('  -> ERREUR:', e.message.slice(0, 150));
      }
    }
  }
})();
