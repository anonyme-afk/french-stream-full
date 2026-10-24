'use strict';
// Base DLE optimisée : recherche rapide via /engine/ajax/search.php (POST query+page),
// extraction .search-item > onclick location.href + .search-title + img.
// Timeout réduit + cookie tracking auto + gestion anti-bot.
const { fetchText } = require('../http');
const log = require('../logger');

function decode(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\'/g, "'").trim();
}

let globalCookies = 'fsschal=k7x2m9q4v3b8; dle_skin=FrenchStream; ';

function extractCookie(html) {
  const m = (html || '').match(/document\.cookie\s*=\s*["']([^"']+)["']/i);
  if (m) {
    const cookie = m[1].split(';')[0];
    if (cookie && !globalCookies.includes(cookie)) {
      globalCookies += cookie + '; ';
    }
  }
}

class DleAdapter {
  constructor(siteKey, siteCfg, episodesApi) {
    this.siteKey = siteKey;
    this.cfg = siteCfg;
    this.baseUrl = (siteCfg.baseUrl || '').replace(/\/+$/, '');
    this.episodesApi = episodesApi;
  }
  get enabled() { return !!(this.cfg.enabled && this.baseUrl && !/EXEMPLE/i.test(this.baseUrl)); }

  abs(href) {
    if (!href) return null;
    try { return new URL(decode(href), this.baseUrl + '/').href; } catch { return null; }
  }

  async ajaxSearch(query, retry = true) {
    const url = this.baseUrl + '/engine/ajax/search.php';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000); // 10s max (was 20s)
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctrl.signal, redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', Referer: this.baseUrl + '/',
          'Cookie': globalCookies
        },
        body: 'query=' + encodeURIComponent(query) + '&page=1'
      });
      const text = await res.text().catch(() => '');
      clearTimeout(t);
      if (text.includes('Verification de votre navigateur') && retry) {
        extractCookie(text);
        return this.ajaxSearch(query, false);
      }
      return { ok: res.ok, status: res.status, text };
    } catch (e) { clearTimeout(t); throw e; }
  }

  parseSearchItems(html) {
    const out = [];
    // Pattern principal
    const re = /<div class='search-item' onclick="location\.href='([^']+)'"[^>]*>[\s\S]{0,600}?<img src='([^']+)'[^>]*alt='([^']*)'[\s\S]{0,600}?<div class='search-title'>([^<]+)<\/div>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = this.abs(m[1]);
      let title = decode(m[4]);
      const ym = title.match(/\((19|20)\d{2}\)\s*$/);
      const year = ym ? +ym[0].replace(/[()]/g, '') : null;
      if (ym) title = title.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
      const poster = this.abs(m[2]);
      if (href && title) out.push({ title: title.slice(0, 150), url: href, poster, year, type: 'series' });
    }
    // Pattern alternatif si pas de résultat
    if (!out.length) {
      const re2 = /location\.href\s*=\s*'([^']+)'[\s\S]{0,400}?(?:search-title|title)[^>]*>([^<]+)</gi;
      let m2;
      while ((m2 = re2.exec(html)) !== null) {
        const href = this.abs(m2[1]);
        const title = decode(m2[2]).trim();
        if (href && title && title.length > 1) out.push({ title: title.slice(0, 150), url: href, poster: null, year: null, type: 'series' });
      }
    }
    return out;
  }

  async search(query) {
    log.info(this.siteKey, 'search', `Searching "${query}" on ${this.baseUrl}`);
    const r = await this.ajaxSearch(query);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' recherche ' + this.siteKey);
    const items = this.parseSearchItems(r.text);
    const seen = new Set();
    return items.filter((o) => !seen.has(o.url) && seen.add(o.url)).slice(0, 20);
  }

  newsId(pageUrl) {
    const m = String(pageUrl).match(/[?&]newsid=(\d+)|^.*?\/(\d+)-[^/]*\.html/);
    return m ? (m[1] || m[2]) : null;
  }

  async episodesMap(newsId, pageUrl) {
    if (!this.episodesApi) return null;
    const url = this.baseUrl + this.episodesApi + encodeURIComponent(newsId);
    const r = await fetchText(url, { site: this.siteKey, timeout: 6000, retries: 0, headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl } });
    if (!r.ok) return null;
    try { return JSON.parse(r.text); } catch { return null; }
  }

  hostsPriority() {
    // Ordre préféré : lecteurs directs connus
    return ['premium', 'fsvid', 'vidzy', 'uqload', 'netu', 'voe', 'filemoon', 'dood', 'luluvid'];
  }

  pickHosts(epEntry) {
    const prio = this.hostsPriority();
    const keys = Object.keys(epEntry || {});
    keys.sort((a, b) => {
      const ia = prio.findIndex((p) => a.includes(p));
      const ib = prio.findIndex((p) => b.includes(p));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map((k) => ({ host: k, url: epEntry[k] })).filter((x) => x.url);
  }

  // Détecte les lecteurs intégrés via <iframe src="..."> dans le HTML d'une page
  extractIframes(html) {
    const iframes = [];
    const re = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html || '')) !== null) {
      const src = this.abs(m[1]);
      if (src && !iframes.includes(src)) iframes.push(src);
    }
    return iframes;
  }
}

module.exports = { DleAdapter, decode };
