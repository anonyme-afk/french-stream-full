'use strict';
// Gestionnaire de sources calibre :
// 1. Cache prudent (10 min) + reverification
// 2. Re-extraction via adaptateur (API episodes / statiques / embeds directs)
// 3. Hub fstream si besoin (target fs26)
// 4. Verification : on n'annonce jamais OK sans preuve.
// Les embeds (vidzy/uqload/...) sont des pages lecteurs : Stremio les ouvre via
// behaviorHints.notWebReady + externalUrl. Les mp4/m3u8 directs sont lus nativement.
const store = require('./store');
const { fetchText, probeStream } = require('./http');
const log = require('./logger');

async function tryUnpackDirectStream(url) {
  if (/uqload\./i.test(url)) {
    try {
      const r = await fetchText(url, { headers: { Referer: 'https://fs26.lol/' } });
      const m = r.text && r.text.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\.split\('\|'\)\)\)/);
      if (m) {
        const fn = new Function('return ' + m[0].replace('eval(', '('));
        const unp = fn();
        const match = unp && unp.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/i);
        if (match) return { url: match[0], streamType: 'hls' };
      }
    } catch {}
  }
  return null;
}

function cacheFresh(entry, maxAgeMin = 10) {
  if (!entry || !entry.verifiedAt) return null;
  const ageMin = (Date.now() - entry.verifiedAt) / 60000;
  if (ageMin > maxAgeMin) return { ...entry, stale: true };
  return entry.ok ? entry : { ...entry, stale: true };
}

async function buildStreams(pages, want, ctx) {
  const { adapters, SITES } = ctx;
  const streams = [];
  const hubTarget = (SITES.redirectService && SITES.redirectService.target) || null;
  for (const p of pages.slice(0, 1)) {
    try {
      const cached = cacheFresh(store.getCache(p.url), SITES.settings.cacheStreamMinutes ?? 10);
      if (cached && !cached.stale && cached.items) {
        for (const it of cached.items) streams.push(it);
        continue;
      }
      const ad = adapters[p.site];
      if (!ad) continue;
      // Episode cible ?
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
      // Deduplique par URL (VF+VOSTFR partagent les memes embeds)
      {
        const seen = new Set();
        list = list.filter((s) => !seen.has(s.url) && seen.add(s.url));
      }
      if (!list.length) {
        store.logDiag(p.site, p.url, 'stream', 'empty', 'Aucune source extraite (page sans embeds decouverts)');
        // Fallback honnete : ouvrir la page source dans le navigateur
        streams.push({
          name: 'FSF [FR]',
          externalUrl: p.url.split('#')[0],
          title: `${title || p.site}\nOuvrir la page source (lecteur anti-bot)`
        });
        continue;
      }
      const items = [];
      for (const s of list.slice(0, 8)) {
        const langStr = (s.lang ? s.lang.toUpperCase() : 'FR');
        const hostName = (s.host || p.site || 'Source').toUpperCase();
        const epTag = s.episode != null ? ` Ep ${s.episode}` : '';

        // Verification de decompactage flux direct (ex: uqload HLS)
        const directHls = await tryUnpackDirectStream(s.url);
        if (directHls && directHls.url) {
          items.push({
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • Direct ${directHls.streamType.toUpperCase()}`,
            url: directHls.url,
            behaviorHints: { notWebReady: false }
          });
        }

        const probe = await probeStream(s.url).catch(() => ({ compatible: false }));
        const direct = probe.compatible && probe.streamType;
        if (direct) {
          items.push({
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • ${probe.streamType}`,
            url: s.url,
            behaviorHints: { notWebReady: probe.streamType !== 'mp4' }
          });
        } else {
          // Embed lecteur : on le propose en externe (Stremio ouvre le navigateur)
          items.push({
            name: `FSF [${langStr}]`,
            title: `${title}${epTag}\n${hostName} • Lecteur Web`,
            externalUrl: s.url
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
  // Deduplique finale par URL
  const seen = new Set();
  return streams.filter((s) => {
    const k = s.url || s.externalUrl;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { buildStreams };
