'use strict';
// Stockage JSON zero-dependance (remplace better-sqlite3 qui exige un build C++).
// Contenus stables (durables) SEPARES des liens temporaires (cache court).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'fsf.json');

let store = { contents: {}, pages: {}, episodes: [], streamCache: {}, diagnostics: [], crawlLog: [] };
try {
  if (fs.existsSync(DB_PATH)) store = { ...store, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
} catch {}

function save() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(store)); } catch {}
}

const { norm } = require('./utils/normalize');

function upsertContent(c) {
  store.contents[c.id] = {
    id: c.id, title: c.title, title_norm: norm(c.title),
    altTitles: c.altTitles || [], year: c.year || null, type: c.type,
    synopsis: c.synopsis || null, poster: c.poster || null, background: c.background || null,
    genres: c.genres || [], lang: c.lang || 'fr', updatedAt: Date.now()
  };
  save();
  return c.id;
}

function upsertPage(p) {
  store.pages[p.url] = {
    url: p.url, site: p.site, contentId: p.contentId || null,
    season: p.season ?? null, episode: p.episode ?? null,
    episodeTitle: p.episodeTitle || null, status: p.status || 0,
    error: p.error || null, crawledAt: Date.now()
  };
  if (p.contentId && p.season != null && p.episode != null) {
    if (!store.episodes.find((e) => e.contentId === p.contentId && e.season === p.season && e.episode === p.episode)) {
      store.episodes.push({ contentId: p.contentId, season: p.season, episode: p.episode, title: p.episodeTitle || null, pageUrl: p.url });
    }
  }
  save();
}

function getContent(id) { return store.contents[id] || null; }
function contentsByType(type, limit = 30) {
  return Object.values(store.contents).filter((c) => c.type === type).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
function episodesFor(contentId) {
  return store.episodes.filter((e) => e.contentId === contentId).sort((a, b) => a.season - b.season || a.episode - b.episode);
}
function allContents() { return Object.values(store.contents); }

function logDiag(site, page, op, kind, message) {
  store.diagnostics.push({ site, page, op, kind, message: String(message).slice(0, 500), at: new Date().toISOString() });
  store.diagnostics = store.diagnostics.slice(-500);
  save();
}
function logCrawl(site, url, op, status, detail) {
  store.crawlLog.push({ site, url, op, status, detail: String(detail || '').slice(0, 300), at: new Date().toISOString() });
  store.crawlLog = store.crawlLog.slice(-500);
  save();
}

function getCache(pageUrl) { return store.streamCache[pageUrl] || null; }
function setCache(pageUrl, data) { store.streamCache[pageUrl] = { ...data, verifiedAt: Date.now() }; save(); }

module.exports = { DB_PATH, upsertContent, upsertPage, getContent, contentsByType, episodesFor, allContents, logDiag, logCrawl, getCache, setCache, store };
