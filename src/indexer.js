'use strict';
// Indexeur JSON : recherche normalisee + score anti-faux-amis.
const store = require('./store');
const { norm, score } = require('./utils/normalize');

function contentId(site, url) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  return `fsf:${site}:${h}`;
}

function episodePagesForItem(item, site, id) {
  return (Array.isArray(item.episodes) ? item.episodes : []).map(ep => ({
      url: `${item.url}#s=${ep.season ?? 1}&ep=${ep.episode}&v=${(ep.version || 'vf').toLowerCase()}`,
      site, contentId: id, season: ep.season, episode: ep.episode, episodeTitle: ep.title, status: 200
  }));
}

function indexResult(site, item, type) {
  const id = contentId(site, item.url);
  store.upsertContent({ id, title: item.title, altTitles: item.altTitles || [], year: item.year, type: type || item.type || 'movie', synopsis: item.synopsis, poster: item.poster, background: item.background, genres: item.genres });
  store.upsertPage({ url: item.url, site, contentId: id, season: item.season ?? null, episode: item.episode ?? null, status: 200 });
  const episodePages = episodePagesForItem(item, site, id);
  if (episodePages.length) {
    store.upsertPages(episodePages);
  }
  return id;
}

function searchIndex(query, type, limit = 20) {
  const qn = norm(query);
  const rows = store.allContents().filter((r) => !type || r.type === type);
  const scored = rows.map((r) => {
    const cands = [r.title, ...(r.altTitles || [])];
    let best = 0;
    for (const c of cands) best = Math.max(best, score(query, c, { candYear: r.year }));
    const words = qn.split(' ').filter((w) => w.length > 2);
    if (words.length && words.every((w) => r.title_norm.includes(w))) best = Math.min(1, best + 0.08);
    return { ...r, _score: best };
  }).filter((r) => r._score >= 0.4).sort((a, b) => b._score - a._score).slice(0, limit);
  return scored;
}

function pagesForContent(contentId) {
  return Object.values(store.store.pages).filter((p) => p.contentId === contentId);
}

module.exports = { indexResult, searchIndex, pagesForContent, episodePagesForItem };
