'use strict';
// ANIME : w16.french-manga.net calibre sur donnees reelles.
// - Recherche : POST /engine/ajax/search.php (body query+page) -> .search-item
// - Fiche : #serie-config[data-news-id] + h1 + meta + poster TMDB
// - Episodes : GET /engine/ajax/manga_episodes_api.php?id=N -> {vf:{ep:{host:url}}, vostfr:{...}, alt_titles}
const { DleAdapter, decode } = require('./dle');
const { fetchText } = require('../http');
const log = require('../logger');

function meta(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))
    || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i'));
  return m ? decode(m[1]) : null;
}

class AnimeAdapter extends DleAdapter {
  constructor(siteKey, siteCfg) {
    super(siteKey, siteCfg, '/engine/ajax/manga_episodes_api.php?id=');
  }

  async extractContent(pageUrl) {
    const r = await fetchText(pageUrl, { site: this.siteKey });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + pageUrl);
    const h = r.text;
    // newsId : data-news-id OU digits du slug
    let newsId = (h.match(/data-news-id="(\d+)"/i) || h.match(/dataset\.newsId[^0-9]*(\d+)/))[1] || null;
    if (!newsId) newsId = this.newsId(pageUrl);
    const title = decode((h.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, '') || '')
      || meta(h, 'og:title') || decode((h.match(/<title>([\s\S]{1,150}?)<\/title>/i) || [])[1] || '').split(/[-|–]/)[0].trim();
    const poster = meta(h, 'og:image') || (h.match(/<img[^>]+src="([^"]+)"[^>]*class="[^"]*poster/i) || [])[1] || null;
    const backdrop = (h.match(/hero-backdrop[^>]*url\(['"]?(https?:[^'")]+)/i) || [])[1]
      || (h.match(/background-image:[^;]*url\(['"]?(https?:[^'")]+)/i) || [])[1]
      || null;
    const genres = [];
    {
      const gm = h.match(/class="genres"[^>]*>([\s\S]{1,800}?)<\/(?:span|div)>/i);
      if (gm) {
        for (const x of [...gm[1].matchAll(/>([^<>]{2,30})</g)].map(y => decode(y[1]).trim()).filter(Boolean)) {
          if (x.length > 1 && genres.length < 5) genres.push(x);
        }
      }
    }
    const desc = decode((h.match(/<div[^>]+id="s-desc"[^>]*>([\s\S]{1,3000}?)<\/div>/i) || h.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) || [])[1]?.replace(/<[^>]+>/g, '').slice(0, 1500) || '');
    const yearM = h.match(/\b((?:19|20)\d{2})\b/);
    // Titres alternatifs via API (si newsId)
    let altTitles = [];
    let eps = null;
    if (newsId) {
      try {
        const api = await this.episodesMap(newsId, pageUrl);
        if (api) {
          eps = api;
          const at = api.alt_titles || {};
          for (const v of Object.values(at)) {
            if (typeof v === 'string') v.split(/[|~]/).forEach((t) => { const tt = t.trim(); if (tt) altTitles.push(tt); });
          }
        }
      } catch (e) { log.warn(this.siteKey, 'api', 'episodes API fail ' + newsId, { err: String(e).slice(0, 150) }); }
    }
    const episodes = [];
    const sources = [];
    if (eps) {
      for (const [version, map] of Object.entries({ vf: eps.vf || {}, vostfr: eps.vostfr || {} })) {
        for (const [num, entry] of Object.entries(map)) {
          const ep = +num;
          if (!ep) continue;
          episodes.push({ season: 1, episode: ep, title: `Episode ${ep} (${version.toUpperCase()})`, url: `${pageUrl}#ep=${ep}&v=${version}`, version, hosts: entry });
          for (const { host, url } of this.pickHosts(entry)) {
            sources.push({ label: `Ep ${ep} ${version.toUpperCase()} • ${host}`, url, quality: 'HD', lang: version === 'vf' ? 'fr' : 'vostfr', episode: ep, version, host });
          }
        }
      }
    }
    return { title, altTitles: [...new Set(altTitles)].slice(0, 10), year: yearM ? +yearM[1] : null, type: episodes.length ? 'series' : 'movie', synopsis: desc, poster: poster ? this.abs(poster) : null, background: backdrop ? this.abs(backdrop) : null, genres, episodes, sources, newsId };
  }

  // Sources pour un episode precis (utilise par streams.js)
  async sourcesForEpisode(pageUrl, episode, version) {
    const detail = await this.extractContent(pageUrl);
    let list = detail.sources.filter((s) => s.episode === episode);
    if (version) list = list.filter((s) => s.version === version);
    return { title: detail.title, sources: list };
  }
}

module.exports = { AnimeAdapter };
