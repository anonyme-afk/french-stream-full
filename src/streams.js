'use strict';
// Résolution et assemblage des flux Stremio :
// 1. Résolution concurrente des sources retenues
// 2. Contrôle des flux média et rejet des faux flux
// 3. URL directe quand possible, externalUrl pour les lecteurs qui l'exigent
// 4. Cache temporaire avec durée configurable

const store = require('./store');
const { fetchText } = require('./http');
const { probeStream } = require('./probe');
const { resolveEmbed } = require('./embed-resolver');
const log = require('./logger');

// ──────────────────────────────────────────────
//  Unpacker p,a,c,k,e,d
// ──────────────────────────────────────────────
function readJsString(input, start) {
  const quote = input[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch !== '\\') { value += ch; continue; }
    const next = input[++i];
    if (next == null) return null;
    if (next === 'x' && /^[\da-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
      value += String.fromCharCode(parseInt(input.slice(i + 1, i + 3), 16)); i += 2; continue;
    }
    if (next === 'u' && /^[\da-f]{4}$/i.test(input.slice(i + 1, i + 5))) {
      value += String.fromCharCode(parseInt(input.slice(i + 1, i + 5), 16)); i += 4; continue;
    }
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (next === '\n') continue;
    if (next === '\r') { if (input[i + 1] === '\n') i++; continue; }
    value += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
  }
  return null;
}

function packerWord(value, radix) {
  if (value < radix) return value > 35 ? String.fromCharCode(value + 29) : value.toString(36);
  return packerWord(Math.floor(value / radix), radix) + packerWord(value % radix, radix);
}

function unpack(packed) {
  // Décode le format P.A.C.K.E.R. en texte seulement. Le JavaScript distant
  // n'est jamais évalué dans le processus de l'addon.
  try {
    const call = /return\s+p\s*\}\s*\(/i.exec(String(packed || ''));
    if (!call) return null;
    let i = call.index + call[0].length;
    const skip = () => { while (/\s/.test(packed[i] || '')) i++; };
    const readString = () => { skip(); const token = readJsString(packed, i); if (token) i = token.end; return token?.value ?? null; };
    const readNumber = () => { skip(); const m = /^\d+/.exec(packed.slice(i)); if (!m) return null; i += m[0].length; return Number(m[0]); };
    const comma = () => { skip(); if (packed[i] !== ',') return false; i++; return true; };

    const source = readString();
    if (source == null || !comma()) return null;
    const radix = readNumber();
    if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !comma()) return null;
    const count = readNumber();
    if (!Number.isInteger(count) || count < 0 || count > 10000 || !comma()) return null;
    const table = readString();
    if (table == null) return null;
    const keys = table.split('|');
    let decoded = source;
    for (let n = Math.min(count, keys.length) - 1; n >= 0; n--) {
      if (!keys[n]) continue;
      const token = packerWord(n, radix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      decoded = decoded.replace(new RegExp(`(^|[^A-Za-z0-9_$])${token}(?=$|[^A-Za-z0-9_$])`, 'g'), (_match, prefix) => prefix + keys[n]);
    }
    return decoded;
  } catch {
    return null;
  }
}

function decodePackedVideo(html) {
  const pattern = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]{0,30000}?return\s+p\s*\}\s*\([\s\S]{0,200000}?\)\s*\)/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const decoded = unpack(match[0]);
    const mediaUrl = decoded && extractDirectVideoUrl(decoded);
    if (mediaUrl) return mediaUrl;
  }
  return null;
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
    return decodePackedVideo(html);
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
        const u = decodePackedVideo(r.text) || extractDirectVideoUrl(r.text);
        if (u) return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }

    // ─── SOLUTION 1 : Extraction regex universelle (liens .mp4/.m3u8 dans n'importe quelle page HTML) ───
    // Charge la page et cherche un vrai flux vidéo brut pour lecture native dans Stremio.
    try {
      const isHtmlPage = /\.html/i.test(url) || !/\.(mp4|m3u8|mpd|mkv)$/i.test(url);
      if (isHtmlPage) {
        const r = await fetchText(url, { ...opts, timeout: 8000, retries: 0 });
        if (r.ok && r.text) {
          const u = extractDirectVideoUrl(r.text);
          if (u) {
            return { url: u, streamType: u.includes('.m3u8') ? 'hls' : 'mp4' };
          }
        }
      }
    } catch {}

    // ─── SOLUTION 2 : Résolveur d'embed réseau léger (vidzy / vidsrc) sur page .html ───
    // Transforme un lien de lecteur (.html) en fichier brut .mp4/.m3u8 avant l'envoi à Stremio.
    // Requêtes HTTP directes uniquement — sans navigateur — cible < 500ms.
    if (/\.html/i.test(url)) {
      try {
        const isRender = process.env.RENDER === 'true' || process.env.RENDER === '1';
        const resolved = await resolveEmbed(url, {
          referer: sourceReferer,
          timeout: isRender ? 4000 : 8000
        });
        if (resolved && resolved.url) {
          return {
            url: resolved.url,
            streamType: resolved.streamType
          };
        }
      } catch {}
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
  return `${String(pageUrl).split('#')[0]}|s${want.season ?? 1}|e${want.episode ?? 'movie'}|v${want.version || (fragment && fragment[2]) || 'any'}`;
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
        const res = await ad.sourcesForEpisode(pageBase, want.episode, want.version || null, want.season);
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
        const epTag = s.episode == null ? '' : Number(s.season ?? want.season ?? 1) === 0
          ? ` Spécial ${s.episode}`
          : ` S${s.season ?? want.season ?? 1} Ep ${s.episode}`;
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
                  notWebReady: false,
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

          // Si le flux direct n'est pas résolu ou pas compatible, on retourne
          // externalUrl pour que Stremio puisse tenter d'ouvrir la page de lecteur.
          return {
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • ${s.quality || 'HD'} (Lecteur)`,
            externalUrl: s.url,
            behaviorHints: { notWebReady: true }
          };
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

module.exports = { buildStreams, resolveDirectStream, extractDirectVideoUrl, streamCacheKey, parseContentVideoId, uniqueContentPages, unpack, decodePackedVideo };
