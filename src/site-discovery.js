'use strict';

// Découvre le domaine courant depuis la page relais stable. Le domaine cible
// n'est pas conservé dans la configuration versionnée.
const fs = require('fs');
const path = require('path');
const { fetchText } = require('./http');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'resolved-sites.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
let inFlight = null;
let lastStatus = { ok: false, source: 'not-checked', baseUrl: null, checkedAt: null, error: null };

function readCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function anchorText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&')
    .replace(/&#0?39;/g, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function findCurrentMovieSeriesUrl(html, referenceUrl) {
  const candidates = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(String(html || ''))) !== null) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    const label = anchorText(match[2]);
    const priority = /regarder en streaming|watch now/.test(label) ? 3
      : /films?\s*(?:&|et)\s*s[eé]ries/.test(label) ? 2
      : /catalogue complet/.test(label) ? 1 : 0;
    if (!priority) continue;
    try {
      const url = new URL(href.replace(/&amp;/gi, '&'), referenceUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      candidates.push({ url: url.origin, priority });
    } catch {}
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const referenceHost = new URL(referenceUrl).hostname.toLowerCase();
  return candidates.find((item) => new URL(item.url).hostname.toLowerCase() !== referenceHost)?.url || null;
}

function persistCache(next) {
  cache = next;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tempPath = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next));
    fs.renameSync(tempPath, CACHE_PATH);
  } catch {}
}

function applyMovieBase(sites, adapters, baseUrl) {
  const cfg = sites.movieSeriesSite;
  cfg.baseUrl = baseUrl;
  cfg._reason = null;
  const adapter = adapters && adapters.movies;
  if (adapter) {
    adapter.baseUrl = baseUrl;
    adapter.cfg = cfg;
  }
  if (sites.redirectService) sites.redirectService.target = baseUrl;
}

async function discoverMovieSeriesBase(sites, adapters) {
  const cfg = sites.movieSeriesSite;
  if (!cfg || !cfg.enabled || !cfg.discoveryUrl) {
    lastStatus = { ok: !!cfg?.baseUrl, source: 'config', baseUrl: cfg?.baseUrl || null, checkedAt: Date.now(), error: null };
    return lastStatus;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const saved = readCache().movieSeries || {};
    const savedBase = saved.baseUrl || '';
    if (!cfg.baseUrl && savedBase) applyMovieBase(sites, adapters, savedBase);
    if (savedBase && Date.now() - (saved.discoveredAt || 0) < CACHE_TTL_MS) {
      applyMovieBase(sites, adapters, savedBase);
      lastStatus = { ok: true, baseUrl: savedBase, source: 'cache', checkedAt: Date.now(), discoveredAt: saved.discoveredAt, error: null };
      return lastStatus;
    }

    try {
      const referenceUrl = cfg.discoveryUrl;
      const page = await fetchText(referenceUrl, { timeout: 8000, retries: 0 });
      if (!page.ok) throw new Error(`page relais HTTP ${page.status}`);
      const candidate = findCurrentMovieSeriesUrl(page.text, referenceUrl);
      if (!candidate) throw new Error('lien Films & Séries introuvable sur la page relais');

      // Vérifie que le domaine candidat répond avant de le propager aux adaptateurs.
      const targetPage = await fetchText(`${candidate}/`, { timeout: 8000, retries: 0 });
      if (!targetPage.ok) throw new Error(`site cible HTTP ${targetPage.status}`);
      const verifiedBase = new URL(targetPage.url || `${candidate}/`).origin;
      const discoveredAt = Date.now();
      applyMovieBase(sites, adapters, verifiedBase);
      persistCache({ ...readCache(), movieSeries: { baseUrl: verifiedBase, discoveredAt } });
      lastStatus = { ok: true, baseUrl: verifiedBase, source: 'reference', checkedAt: Date.now(), discoveredAt, error: null };
      return lastStatus;
    } catch (error) {
      if (savedBase) {
        applyMovieBase(sites, adapters, savedBase);
        lastStatus = { ok: true, baseUrl: savedBase, source: 'last-known-good', checkedAt: Date.now(), discoveredAt: saved.discoveredAt || null, error: String(error.message || error) };
        return lastStatus;
      }
      cfg._reason = `découverte du domaine impossible : ${String(error.message || error).slice(0, 160)}`;
      lastStatus = { ok: false, baseUrl: null, source: 'reference', checkedAt: Date.now(), error: cfg._reason };
      return lastStatus;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function getDiscoveryStatus() {
  const { baseUrl, ...safe } = lastStatus;
  let host = null;
  try { host = baseUrl ? new URL(baseUrl).host : null; } catch {}
  return { ...safe, host };
}

module.exports = { CACHE_PATH, CACHE_TTL_MS, findCurrentMovieSeriesUrl, discoverMovieSeriesBase, getDiscoveryStatus };
