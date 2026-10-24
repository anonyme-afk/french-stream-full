'use strict';
// Résolution et assemblage des flux Stremio :
// 1. Résolution concurrente des sources retenues
// 2. Contrôle des flux média et rejet des faux flux
// 3. URL directe quand possible, externalUrl pour les lecteurs qui l'exigent
// 4. Cache temporaire avec durée configurable

const store = require('./store');
const { fetchText } = require('./http');
const { probeStream } = require('./probe');
const log = require('./logger');

// ──────────────────────────────────────────────
//  Unpacker p,a,c,k,e,d
// ──────────────────────────────────────────────
function unpack(packed) {
  try {
    const fn = new Function('return ' + packed.replace('eval(', '('));
    return fn();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
//  Decoders pour chaque lecteur
// ──────────────────────────────────────────────
function decodeFsvid(html, hostname) {
  try {
    const m = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\.split\('\|'\)\)\)/);
    if (!m) return null;
    const unp = unpack(m[0]);
    if (!unp) return null;

    const mCalc = unp.match(/calc\(1in\s*\+\s*(\d+)px\)[\s\S]+?calc\(100%\s*-\s*(\d+)px\)/);
    if (!mCalc) return null;
    const inA = parseInt(mCalc[1], 10);
    const inB = parseInt(mCalc[2], 10);

    const mStr = unp.match(/return\/\^https\?:[\s\S]+?\}\)\("([^"]+)"\)/);
    if (!mStr) return null;
    const s = mStr[1];

    const h = hostname || "fsvid.lol";
    let H = 0;
    for (let j = 0; j < h.length; j++) H = (H + h.charCodeAt(j)) & 255;
    const BC = (96 + inA - inB) | 0;
    const b = Buffer.from(s, 'base64').toString('binary');
    const a = b.split("").reverse().join("");
    let r = "";
    for (let i = 0; i < a.length; i++) {
      const kk = (0x3d + i * 89 + H + BC) & 255;
      r += String.fromCharCode(a.charCodeAt(i) ^ kk);
    }
    return /^https?:/.test(r) ? r : null;
  } catch {
    return null;
  }
}

function decodeUqload(html) {
  try {
    const m = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\.split\('\|'\)\)\)/);
    if (!m) return null;
    const unp = unpack(m[0]);
    if (!unp) return null;
    const match = unp.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/i);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// Extraction alternative : regex directe sur les sources vidéo classiques dans le HTML
function extractDirectVideoUrl(html) {
  // Décode les échappements HTML/JSON courants avant d'inspecter les configs
  // de lecteurs (JWPlayer, Video.js et variantes JSON).
  const normalized = String(html || '')
    .replace(/&amp;/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\x3a/gi, ':');
  const patterns = [
    /(?:file|src|source|hls|url)["']?\s*:\s*["']((?:https?:)?\/\/[^"'\s<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?)/i,
    /(?:source\s+src|player\.src)\s*[=(]\s*["']((?:https?:)?\/\/[^"'\s<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?)/i,
    /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/i,
  ];
  for (const p of patterns) {
    const m = normalized.match(p);
    const candidate = m && (m[1] || m[0]);
    if (candidate) {
      const absolute = candidate.startsWith('//') ? `https:${candidate}` : candidate;
      if (/^https?:\/\//i.test(absolute)) return absolute;
    }
  }
  return null;
}

async function resolveDirectStream(url, pageReferer) {
  try {
    let referer = pageReferer || '';
    if (!referer) {
      try { referer = `${new URL(url).origin}/`; } catch {}
    }
    const opts = { headers: referer ? { Referer: referer } : {}, timeout: 4500, retries: 0 };

    if (/uqload\./i.test(url)) {
      const r = await fetchText(url, opts);
      if (r.ok && r.text) {
        const u = decodeUqload(r.text) || extractDirectVideoUrl(r.text);
        if (u) return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }

    if (/fsvid\./i.test(url)) {
      const r = await fetchText(url, opts);
      if (r.ok && r.text) {
        const u = decodeFsvid(r.text, 'fsvid.lol') || extractDirectVideoUrl(r.text);
        if (u) return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }

    if (/vidzy\./i.test(url)) {
      const r = await fetchText(url, opts);
      if (r.ok && r.text) {
        const u = decodeFsvid(r.text, 'vidzy.cc') || decodeFsvid(r.text, 'vidzy.org') || extractDirectVideoUrl(r.text);
        if (u) return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }

    // Generic : si on n'a pas de decoder spécifique, on tente l'extraction directe
    if (/voe\.|dood\.|streamtape\.|filemoon\.|vidoza\.|netu\.|luluvid\.|vidhsareup\./i.test(url)) {
      const r = await fetchText(url, opts);
      if (r.ok && r.text) {
        const u = extractDirectVideoUrl(r.text);
        if (u) return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }
  } catch {}
  return null;
}

// ──────────────────────────────────────────────
//  Cache helper
// ──────────────────────────────────────────────
function cacheFresh(entry, maxAgeMin = 10) {
  if (!entry || !entry.verifiedAt) return null;
  const ageMin = (Date.now() - entry.verifiedAt) / 60000;
  if (ageMin > maxAgeMin) return { ...entry, stale: true };
  return entry.ok ? entry : { ...entry, stale: true };
}

function streamCacheKey(pageUrl, want = {}) {
  const fragment = String(pageUrl).match(/#ep=(\d+)&v=([a-z]+)/i);
  return `${String(pageUrl).split('#')[0]}|s${want.season || 1}|e${want.episode ?? 'movie'}|v${want.version || (fragment && fragment[2]) || 'any'}`;
}

function parseContentVideoId(id) {
  const match = String(id).match(/^(fsf:[^:]+:[^:]+)(?::S(\d+)E(\d+)|:(\d+):(\d+))?$/i);
  if (!match) return null;
  return {
    contentId: match[1],
    season: Number.parseInt(match[2] || match[4] || '1', 10),
    episode: match[3] || match[5] ? Number.parseInt(match[3] || match[5], 10) : null
  };
}

function uniqueContentPages(pages = []) {
  const uniquePages = [];
  const pageKeys = new Set();
  for (const page of pages) {
    const baseUrl = String(page.url || '').split('#')[0];
    const key = `${page.site}|${baseUrl}`;
    if (!baseUrl || pageKeys.has(key)) continue;
    pageKeys.add(key);
    uniquePages.push({ ...page, url: baseUrl });
  }
  return uniquePages;
}

// ──────────────────────────────────────────────
//  Build streams — PARALLEL + filtered
// ──────────────────────────────────────────────
async function buildStreams(pages, want, ctx) {
  const { adapters, SITES } = ctx;
  const streams = [];
  const cacheMinutes = SITES.settings.cacheStreamMinutes ?? 10;
  const refererFor = (site) => {
    const cfg = SITES[site === 'anime' ? 'animeSite' : 'movieSeriesSite'];
    return cfg?.baseUrl ? `${cfg.baseUrl.replace(/\/+$/, '')}/` : '';
  };
  const uniquePages = uniqueContentPages(pages);

  // Deadline globale : jamais plus de ~12s pour tout le handler stream
  const deadline = Date.now() + 12000;
  const timeLeft = () => deadline - Date.now();

  // Process up to 3 pages (not just 1 anymore)
  for (const p of uniquePages.slice(0, 3)) {
    if (timeLeft() < 2500) break;
    try {
      const cacheKey = streamCacheKey(p.url, want);
      const cached = cacheFresh(store.getCache(cacheKey), cacheMinutes);
      if (cached && !cached.stale && cached.items) {
        for (const it of cached.items) streams.push(it);
        continue;
      }
      const ad = adapters[p.site];
      if (!ad) continue;

      let title = '';
      let list = [];
      if (want.episode != null) {
        const pageBase = p.url.split('#')[0];
        const res = await ad.sourcesForEpisode(pageBase, want.episode, want.version || null);
        title = res.title;
        list = res.sources;
      } else {
        const detail = await ad.extractContent(p.url.split('#')[0]);
        title = detail.title;
        list = detail.sources || [];
      }

      // Deduplique par URL
      {
        const seen = new Set();
        list = list.filter((s) => !seen.has(s.url) && seen.add(s.url));
      }

      // ─── RESOLUTION PARALLELE (max 8 sources, deadline respectee) ───
      const ref = refererFor(p.site);
      const resolvePromises = list.slice(0, 8).map(async (s) => {
        const langStr = (s.lang ? s.lang.toUpperCase() : 'FR');
        const hostName = (s.host || p.site || 'Source').toUpperCase();
        const epTag = s.episode != null ? ` S${s.season || want.season || 1} Ep ${s.episode}` : '';
        // Le lecteur attend l'origine de la fiche (anime/série), pas son URL à lui-même.
        const sourceReferer = /^https?:\/\//i.test(p.url) ? p.url : ref;

        try {
          const direct = await resolveDirectStream(s.url, sourceReferer);
          if (direct && direct.url) {
            const probe = await probeStream(direct.url, sourceReferer);
            if (probe.isTooSmall) {
              log.warn(p.site, 'stream-filter', `Filtre dummy: ${direct.url} (${probe.reason || ''})`);
              return null;
            }
            if (probe.compatible) {
              return {
                name: `FSF [${langStr}]`,
                title: `${title}${epTag}\n${hostName} • ${s.quality || 'HD'} (Direct)`,
                url: probe.variantUrl || direct.url,
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: {
                    request: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                      Referer: sourceReferer
                    }
                  }
                }
              }
            }
          }

          // A player page is a valid Stremio external link, but not a direct video stream.
          if (s.isIframe || /(?:vidzy|vidhsareup|luluvid|fsvid|uqload|voe|dood|streamtape|filemoon|vidoza|netu)\./i.test(s.url)) {
            return {
              name: `FSF [${langStr}]`,
              title: `${title}${epTag}\n${hostName} • Ouvrir le lecteur externe`,
              externalUrl: s.url
            };
          }
        } catch (e) {
          log.warn(p.site, 'resolve', `Fail ${s.url}: ${String(e).slice(0, 100)}`);
        }

        return null;
      });

      const results = await Promise.allSettled(resolvePromises);
      const items = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          items.push(r.value);
        }
      }

      store.setCache(cacheKey, { ok: items.length > 0, items });
      for (const it of items) streams.push(it);
    } catch (e) {
      log.error(p.site, 'stream', String(e).slice(0, 300), { page: p.url });
      store.logDiag(p.site, p.url, 'stream', 'error', String(e).slice(0, 500));
    }
  }

  // Deduplique finale par URL de stream
  const seen = new Set();
  return streams.filter((s) => {
    const k = s.url || s.externalUrl;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { buildStreams, resolveDirectStream, extractDirectVideoUrl, streamCacheKey, parseContentVideoId, uniqueContentPages };
