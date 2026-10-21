#!/usr/bin/env node
'use strict';

// ──────────────────────────────────────────────
//  STREAMLINE PROXY — Stremio Add-on
// ──────────────────────────────────────────────

const express = require('express');

const { resolveDirectStream } = require('./src/streams.js');
const { AnimeAdapter } = require('./src/adapters/anime.js');
const { MovieSeriesAdapter } = require('./src/adapters/movies.js');

// ──────────────────────────────────────────────
//  Cache à court terme (10 minutes)
// ──────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function getCachedResolution(contentId) {
  const entry = cache.get(contentId);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(contentId);
    return null;
  }
  return entry;
}

function setCachedResolution(contentId, data) {
  cache.set(contentId, {
    ...data,
    expiry: Date.now() + CACHE_TTL_MS
  });
}

// ──────────────────────────────────────────────
//  Résolveur de métadonnées de contenu
// ──────────────────────────────────────────────
async function resolveContentMetadata(contentId) {
  if (!contentId || typeof contentId !== 'string') {
    throw new Error('contentId manquant ou invalide');
  }

  const isSeries = contentId.includes(':');
  let imdbId;
  let season = null;
  let episode = null;

  if (isSeries) {
    const parts = contentId.split(':');
    imdbId = parts[0];
    season = parts[1] ? parseInt(parts[1], 10) : null;
    episode = parts[2] ? parseInt(parts[2], 10) : null;
  } else {
    imdbId = contentId;
  }

  let manifestUrl = null;

  if (contentId.startsWith('anime_') || !contentId.startsWith('tt')) {
    const ad = new AnimeAdapter('anime', {
      baseUrl: 'https://w16.french-manga.net',
      siteKey: 'anime',
      episodesApi: '/engine/ajax/manga_episodes_api.php?id='
    });
    const pageUrl = 'https://w16.french-manga.net/' + contentId + '.html';
    const page = await ad.extractContent(pageUrl);
    const sources = page && page.sources ? page.sources : null;
    manifestUrl = sources && sources.length ? sources[0].url : null;
  } else {
    const ad = new MovieSeriesAdapter('movies', {
      baseUrl: 'https://fs26.lol',
      siteKey: 'movies'
    });
    const targetPageUrl = 'https://fs26.lol/' + imdbId + '.html';
    if (isSeries) {
      const detail = await ad.sourcesForEpisode(targetPageUrl, episode);
      const sources = detail && detail.sources ? detail.sources : null;
      manifestUrl = sources && sources.length ? sources[0].url : null;
    } else {
      const detail = await ad.extractContent(targetPageUrl);
      const sources = detail && detail.sources ? detail.sources : null;
      manifestUrl = sources && sources.length ? sources[0].url : null;
    }
  }

  if (!manifestUrl) {
    throw new Error('Aucune URL de streaming valide trouvée');
  }

  const finalManifestUrl = await resolveDirectStream(manifestUrl);

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const cookies = '';

  return {
    contentId,
    imdbId,
    season,
    episode,
    manifestUrl: finalManifestUrl,
    userAgent,
    cookies
  };
}

// ──────────────────────────────────────────────
//  Express + CORS
// ──────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ──────────────────────────────────────────────
//  Manifest Stremio
// ──────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.myaddon.proxyresolver',
    version: '1.0.0',
    name: 'Stream Proxy',
    description: 'Proxy de résolution de flux média pour Stremio',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'anime_'],
    catalogs: []
  });
});

// ──────────────────────────────────────────────
//  Route /stream (appelée par Stremio)
// ──────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const contentId = req.query.id || null;

  if (!contentId) {
    return res.status(400).json({ error: 'Paramètre id requis' });
  }

  try {
    let metadata = getCachedResolution(contentId);

    if (!metadata) {
      metadata = await resolveContentMetadata(contentId);
      setCachedResolution(contentId, metadata);
    }

    const streamTitle = '🎬 Flux HD - ' + metadata.imdbId + (metadata.season ? ' S' + metadata.season + 'E' + metadata.episode : '');

    const streams = [
      {
        title: streamTitle,
        url: metadata.manifestUrl,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': metadata.userAgent,
              ...(metadata.cookies ? { 'Cookie': metadata.cookies } : {})
            }
          }
        }
      }
    ];

    res.json({ streams });
  } catch (err) {
    res.status(500).json({ error: 'Résolution du flux échouée', detail: err.message });
  }
});

// ──────────────────────────────────────────────
//  Démarrage du serveur
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Serveur Proxy Stremio : http://127.0.0.1:' + PORT);
});
