'use strict';

// Résolveur d'embeds réseau léger — inspiré de vidsrc-scraper / movie-web embed-resolver
// Prend une URL de page lecteur (.html) et retourne un lien vidéo brut (.mp4 / .m3u8)
// via requêtes HTTP directes uniquement, sans navigateur. Cible < 500ms.
const { fetchText } = require('./http');
const log = require('./logger');

// ──────────────────────────────────────────────
//  Unpacker P.A.C.K.E.R. (obfuscation courante sur les embeds)
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
  } catch { return null; }
}


// ──────────────────────────────────────────────
//  Extraction d'URL vidéo brute depuis du HTML
// ──────────────────────────────────────────────
function extractDirectVideoUrl(html, baseUrl) {
  const normalized = String(html || '')
    .replace(/&amp;/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\x3a/gi, ':');
  const patterns = [
    /(?:file|src|source|hls|url)[\"']?\s*:?\s*[\"']([^\"'\s<>]+?\.(?:m3u8|mp4)(?:\?[^\"'\s<>]*)?)/i,
    /(?:source\s+src|player\.src)\s*[=(]\s*[\"']([^\"'\s<>]+?\.(?:m3u8|mp4)(?:\?[^\"'\s<>]*)?)/i,
    /jwplayer\([^)]*\)\.setup\s*\(\s*\{[^}]*?(?:file|src)[\"']?\s*:\s*[\"']([^\"']+)[\"']/i,
    /<source[^>]+src=[\"']([^\"']+\.(?:m3u8|mp4))[\"']/i,
    /<video[^>]+src=[\"']([^\"']+\.(?:m3u8|mp4))[\"']/i,
    /(?:https?:)?\/\/[^\"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^\"'\s<>\\]*)?/i
  ];
  for (const p of patterns) {
    const m = normalized.match(p);
    const candidate = m && (m[1] || m[0]);
    if (candidate) {
      let absolute;
      try {
        absolute = candidate.startsWith('//') ? `https:${candidate}` : new URL(candidate, baseUrl || 'http://localhost/').href;
      } catch { absolute = candidate.startsWith('//') ? `https:${candidate}` : candidate; }
      if (/^https?:\/\//i.test(absolute)) return absolute;
    }
  }
  return null;
}

function decodePackedVideo(html, baseUrl) {
  const pattern = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]{0,30000}?return\s+p\s*\}\s*\([\s\S]{0,200000}?\)\s*\)/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const decoded = unpack(match[0]);
    const mediaUrl = decoded && extractDirectVideoUrl(decoded, baseUrl);
    if (mediaUrl) return mediaUrl;
  }
  return null;
}

// ──────────────────────────────────────────────
//  Résolveur d'embed réseau léger
// ──────────────────────────────────────────────
async function resolveEmbed(targetUrl, opts = {}) {
  const { referer = '', timeout = 5000, maxDepth = 2 } = opts;
  const depth = opts.depth || 0;
  if (depth > maxDepth) return null;

  try {
    const r = await fetchText(targetUrl, {
      timeout,
      retries: 0,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        ...(referer ? { 'Referer': referer } : {})
      }
    });

    if (!r.ok || !r.text) return null;

    const html = r.text;

    // 1. Liens directs .mp4 / .m3u8 bruts dans le HTML
    const direct = extractDirectVideoUrl(html, targetUrl);
    if (direct) {
      return { url: direct, streamType: direct.includes('.m3u8') ? 'hls' : 'mp4' };
    }

    // 2. Décodage P.A.C.K.E.R. (obfuscation JS courante sur les embeds vidzy / vidsrc)
    const packed = decodePackedVideo(html, targetUrl);
    if (packed) {
      return { url: packed, streamType: packed.includes('.m3u8') ? 'hls' : 'mp4' };
    }

    // 3. Iframe / embed imbriqué -> résolution récursive limitée (une seule profondeur)
    const iframeMatch = html.match(/<iframe[^>]+src=[\"']([^\"']+)[\"']/i);
    if (iframeMatch) {
      try {
        const iframeUrl = new URL(iframeMatch[1], targetUrl).href;
        if (iframeUrl !== targetUrl) {
          return resolveEmbed(iframeUrl, { referer: targetUrl, timeout, maxDepth, depth: depth + 1 });
        }
      } catch {}
    }

    return null;
  } catch (e) {
    log.error('embed-resolver', 'resolve', String(e).slice(0, 200), { url: targetUrl });
    return null;
  }
}

module.exports = { resolveEmbed };

