'use strict';
// Gestionnaire de flux Stremio NATIF :
// 1. Tous les liens utilisent `url` (JAMAIS `externalUrl`) pour lancer directement dans le lecteur Stremio.
// 2. Dechiffrage des flux HLS direct (.m3u8) pour uqload, fsvid, vidzy.
// 3. Endpoint proxy interne `/play` pour rediriger proprement (HTTP 307) les autres flux vers la ressource video.
const store = require('./store');
const { fetchText, probeStream } = require('./http');
const log = require('./logger');

function unpack(packed) {
  try {
    const fn = new Function('return ' + packed.replace('eval(', '('));
    return fn();
  } catch {
    return null;
  }
}

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

async function resolveDirectStream(url) {
  try {
    if (/uqload\./i.test(url)) {
      const r = await fetchText(url, { headers: { Referer: 'https://fs26.lol/' } });
      if (r.ok && r.text) {
        const u = decodeUqload(r.text);
        if (u) return { url: u, streamType: 'hls' };
      }
    }
    if (/fsvid\./i.test(url)) {
      const r = await fetchText(url, { headers: { Referer: 'https://fs26.lol/' } });
      if (r.ok && r.text) {
        const u = decodeFsvid(r.text, 'fsvid.lol');
        if (u) return { url: u, streamType: 'hls' };
      }
    }
    if (/vidzy\./i.test(url)) {
      const r = await fetchText(url, { headers: { Referer: 'https://w16.french-manga.net/' } });
      if (r.ok && r.text) {
        const u = decodeFsvid(r.text, 'vidzy.cc') || decodeFsvid(r.text, 'vidzy.org');
        if (u) return { url: u, streamType: 'hls' };
        const m = r.text.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*/i);
        if (m) return { url: m[0], streamType: m[0].includes('.m3u8') ? 'hls' : 'mp4' };
      }
    }
  } catch {}
  return null;
}

function cacheFresh(entry, maxAgeMin = 10) {
  if (!entry || !entry.verifiedAt) return null;
  const ageMin = (Date.now() - entry.verifiedAt) / 60000;
  if (ageMin > maxAgeMin) return { ...entry, stale: true };
  return entry.ok ? entry : { ...entry, stale: true };
}

const PUBLIC_BASE = process.env.BASE_URL || 'https://french-stream-full.onrender.com';

async function buildStreams(pages, want, ctx) {
  const { adapters, SITES } = ctx;
  const streams = [];
  for (const p of pages.slice(0, 1)) {
    try {
      const cached = cacheFresh(store.getCache(p.url), SITES.settings.cacheStreamMinutes ?? 10);
      if (cached && !cached.stale && cached.items) {
        for (const it of cached.items) streams.push(it);
        continue;
      }
      const ad = adapters[p.site];
      if (!ad) continue;

      let title = '';
      let list = [];
      if (want.episode != null) {
        const frag = p.url.match(/#ep=(\d+)&v=([a-z]+)/);
        const pageBase = p.url.split('#')[0];
        const res = await ad.sourcesForEpisode(pageBase, want.episode, want.version || (frag && frag[2]) || null);
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

      const items = [];
      for (const s of list.slice(0, 8)) {
        const langStr = (s.lang ? s.lang.toUpperCase() : 'FR');
        const hostName = (s.host || p.site || 'Source').toUpperCase();
        const epTag = s.episode != null ? ` Ep ${s.episode}` : '';

        // Tente la resolution directe du flux HLS / MP4
        const direct = await resolveDirectStream(s.url);
        if (direct && direct.url) {
          items.push({
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • ${s.quality || 'HD'} (Direct)`,
            url: direct.url,
            behaviorHints: { notWebReady: false }
          });
        } else {
          // Utilise notre endpoint de lecture Stremio natif /play (HTTP 307 Redirect vers video)
          // Ne JAMAIS utiliser externalUrl pour que la video reste dans Stremio !
          const playUrl = `${PUBLIC_BASE}/play?source=${encodeURIComponent(s.url)}`;
          items.push({
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • ${s.quality || 'HD'}`,
            url: playUrl,
            behaviorHints: { notWebReady: false }
          });
        }
      }
      store.setCache(p.url, { ok: items.length > 0, items });
      for (const it of items) streams.push(it);
    } catch (e) {
      log.error(p.site, 'stream', String(e).slice(0, 300), { page: p.url });
      store.logDiag(p.site, p.url, 'stream', 'error', String(e).slice(0, 500));
    }
  }

  // Deduplique finale par URL de stream
  const seen = new Set();
  return streams.filter((s) => {
    const k = s.url;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { buildStreams, resolveDirectStream };
