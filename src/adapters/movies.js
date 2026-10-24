'use strict';
// FILMS + SERIES : domaine courant fourni par le résolveur de site.
// - Recherche : POST /engine/ajax/search.php -> .search-item (meme moteur que l'anime)
// - Film : #film-data[data-newsid] (+ embeds decouverts page, fallback hub fstream)
// - Serie : #serie-config[data-news-id] + /static/series/N.js (fallback /data/eps_N.txt, /ep-data.php?id=N)
// - La page relais publie l'adresse actuelle du catalogue films/séries.
const { DleAdapter, decode } = require('./dle');
const { fetchText } = require('../http');
const log = require('../logger');

function meta(h, prop) {
  const m = h.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))
    || h.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i'));
  return m ? decode(m[1]) : null;
}

function pickPoster(h) {
  return meta(h, 'og:image')
    || (h.match(/data-affiche2="(https?:[^"]+)"/i) || [])[1]
    || (h.match(/data-affiche="(https?:[^"]+)"/i) || [])[1]
    || (h.match(/<img[^>]+class="[^"]*(?:poster|affiche)[^"]*"[^>]+src="([^"]+)"/i) || [])[1]
    || (h.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*(?:poster|affiche)[^"]*"/i) || [])[1]
    || null;
}

function pickBackdrop(h) {
  return (h.match(/data-affiche2="(https?:[^"]+)"/i) || [])[1]
    || (h.match(/hero-backdrop[^>]*url\(['"]?(https?:[^'")]+)/i) || [])[1]
    || (h.match(/background-image:[^;]*url\(['"]?(https?:[^'")]+)/i) || [])[1]
    || null;
}

function pickGenres(h) {
  const out = [];
  const m = h.match(/class="genres"[^>]*>([\s\S]{1,800}?)<\/(?:span|div)>/i);
  if (m) {
    const links = [...m[1].matchAll(/>([^<>]{2,30})</g)].map(x => decode(x[1]).trim()).filter(Boolean);
    for (const g of links) if (g.length > 1 && out.length < 5) out.push(g);
  }
  return out;
}

function detectContentType(html) {
  if (/id=["']serie-config["']/i.test(html || '')) return 'series';
  if (/id=["']film-data["']/i.test(html || '')) return 'movie';
  return null;
}

class MovieSeriesAdapter extends DleAdapter {
  constructor(siteKey, siteCfg) {
    super(siteKey, siteCfg, null);
  }

  isSeriePage(html) {
    return /id="serie-config"/i.test(html);
  }

  async detectContentType(pageUrl) {
    const response = await fetchText(pageUrl, { site: this.siteKey, timeout: 4500, retries: 0 });
    if (!response.ok) return null;
    return detectContentType(response.text);
  }

  async serieEpisodes(newsId) {
    const urls = [
      this.baseUrl + '/static/series/' + newsId + '.js',
      this.baseUrl + '/data/eps_' + newsId + '.txt',
      this.baseUrl + '/ep-data.php?id=' + encodeURIComponent(newsId)
    ];
    for (const u of urls) {
      try {
        const r = await fetchText(u, { site: this.siteKey, headers: { Referer: this.baseUrl + '/' } });
        if (r.ok && r.text.length > 50) {
          try { return JSON.parse(r.text); } catch { /* format txt ? */ }
        }
      } catch {}
    }
    return null;
  }

  async extractContent(pageUrl) {
    const r = await fetchText(pageUrl, { site: this.siteKey });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + pageUrl);
    const h = r.text;
    const filmM = h.match(/<div id="film-data"[^>]*data-newsid="(\d+)"[^>]*data-title="([^"]*)"/i);
    const serieM = h.match(/<div id="serie-config"[^>]*data-news-id="(\d+)"[^>]*>/i);
    const newsId = (filmM && filmM[1]) || (serieM && serieM[1]) || this.newsId(pageUrl);
    const title = decode((h.match(/<h1[^>]*id="s-title"[^>]*>([\s\S]{1,200}?)<\/h1>/i) || h.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, '') || '')
      || (filmM && decode(filmM[2])) || meta(h, 'og:title') || '';
    const seasonMatch = title.match(/\b(?:saison|season)\s*(\d+)\b/i);
    const seasonNumber = seasonMatch ? Number(seasonMatch[1]) : 1;
    const poster = pickPoster(h) || null;
    const backdrop = pickBackdrop(h) || null;
    const genres = pickGenres(h);
    const desc = decode((h.match(/<div[^>]+id="s-desc"[^>]*>([\s\S]{1,3000}?)<\/div>/i) || h.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) || [])[1]?.replace(/<[^>]+>/g, '').slice(0, 1500) || '');
    const yearM = h.match(/date-de-sortie[^>]*>(\d{4})</) || h.match(/\b((?:19|20)\d{2})\b/);
    const langM = h.match(/id="film_lang"[^>]*>[\s\S]{0,200}?>([^<]{2,20})</i);
    const lang = /vostfr/i.test(langM?.[1] || '') ? 'vostfr' : 'fr';

    const episodes = [];
    const sources = [];
    if (serieM && newsId) {
      // SERIE : JSON statique {vf:{ep:{host:url}}, vostfr:{...}}
      let eps = null;
      try { eps = await this.serieEpisodes(newsId); } catch (e) { log.warn(this.siteKey, 'serie-api', 'fail ' + newsId); }
      if (eps) {
        for (const [version, map] of Object.entries({ vf: eps.vf || {}, vostfr: eps.vostfr || {}, vo: eps.vo || {} })) {
          for (const [num, entry] of Object.entries(map || {})) {
            const ep = +num;
            if (!ep) continue;
            episodes.push({ season: seasonNumber, episode: ep, title: `Episode ${ep} (${version.toUpperCase()})`, url: `${pageUrl}#ep=${ep}&v=${version}`, version, hosts: entry });
            for (const { host, url } of this.pickHosts(entry)) {
              sources.push({ label: `Ep ${ep} ${version.toUpperCase()} • ${host}`, url, quality: 'HD', lang: version === 'vf' ? 'fr' : version, season: seasonNumber, episode: ep, version, host });
            }
          }
        }
      }
      return { title, altTitles: [], year: yearM ? +yearM[1] : null, type: 'series', synopsis: desc, poster: poster ? this.abs(poster) : null, background: backdrop ? this.abs(backdrop) : null, genres, episodes, sources, newsId };
    }
    // FILM : interrogation API film_api.php?id={newsId}
    if (newsId) {
      try {
        const apiUrl = this.baseUrl + '/engine/ajax/film_api.php?id=' + encodeURIComponent(newsId);
        const rApi = await fetchText(apiUrl, {
          site: this.siteKey,
          headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl }
        });
        if (rApi.ok && rApi.text) {
          const data = JSON.parse(rApi.text);
          if (data && data.players) {
            for (const [host, versions] of Object.entries(data.players)) {
              if (typeof versions === 'string') {
                sources.push({ label: `Film • ${host}`, url: versions, quality: 'HD', lang, episode: null, version: lang, host });
              } else if (typeof versions === 'object' && versions) {
                for (const [ver, u] of Object.entries(versions)) {
                  if (u && typeof u === 'string') {
                    const sLang = /vost/i.test(ver) ? 'vostfr' : (ver === 'default' ? lang : 'fr');
                    sources.push({ label: `Film ${ver !== 'default' ? ver.toUpperCase() : ''} • ${host}`, url: u, quality: 'HD', lang: sLang, episode: null, version: sLang, host });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        log.warn(this.siteKey, 'film-api', 'film_api fail ' + newsId);
      }
    }

    // Fallback : regex direct embeds
    const embeds = [...h.matchAll(/https?:\/\/(?:www\.)?((?:fsvid|vidzy|uqload|voe|vidoza|dood|streamtape|filemoon|multiup|trakx|netu|luluvid|vidhsareup)[^"'\s<>]*)/gi)].map((m) => m[0].slice(0, 200));
    [...new Set(embeds)].slice(0, 8).forEach((u) => {
      const host = (u.match(/\/\/(?:www\.)?([a-z0-9-]+)/i) || [])[1] || 'lecteur';
      if (!sources.find((s) => s.url === u)) {
        sources.push({ label: `Film • ${host}`, url: u, quality: 'HD', lang, episode: null, version: lang, host });
      }
    });
    // Iframes détectés (lecteurs intégrés)
    const iframes = this.extractIframes(h);
    iframes.slice(0, 4).forEach((u) => {
      const host = (u.match(/\/\/(?:www\.)?([a-z0-9-]+)/i) || [])[1] || 'lecteur';
      if (!sources.find((s) => s.url === u)) {
        sources.push({ label: `Film • ${host} (iframe)`, url: u, quality: 'HD', lang, episode: null, version: lang, host, isIframe: true });
      }
    });
    return { title, altTitles: [], year: yearM ? +yearM[1] : null, type: 'movie', synopsis: desc, poster: poster ? this.abs(poster) : null, background: backdrop ? this.abs(backdrop) : null, genres, episodes, sources, newsId };
  }

  async sourcesForEpisode(pageUrl, episode, version) {
    const detail = await this.extractContent(pageUrl);
    let list = detail.sources.filter((s) => s.episode === episode);
    if (version) list = list.filter((s) => s.version === version);
    return { title: detail.title, sources: list };
  }
}

module.exports = { MovieSeriesAdapter, detectContentType };
