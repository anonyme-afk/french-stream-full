const fs = require('fs');
let c = fs.readFileSync('src/adapters/dle.js', 'utf8');

// 1. Modifier le constructeur pour ajouter _discoveryCache
c = c.replace(
  "    this.baseUrl = (siteCfg.baseUrl || '').replace(/\\/+$/, '');\n    this.episodesApi = episodesApi;\n  }\n  get enabled() { return !!(this.cfg.enabled && this.baseUrl && !/EXEMPLE/i.test(this.baseUrl)); }",
  "    this.baseUrl = (siteCfg.baseUrl || '').replace(/\\/+$/, '');\n    this.episodesApi = episodesApi;\n    // Cache de découverte dynamique (TTL 24h) pour baseUrl quand vide\n    this._discoveryCache = { url: null, ts: 0 };\n  }\n  get enabled() { return !!(this.cfg.enabled && (this.baseUrl || this.cfg.discoveryUrl) && !/EXEMPLE/i.test(this.baseUrl || '')); }"
);

// 2. Ajouter ensureBaseUrl après la méthode enabled (avant abs)
const ensureBaseUrlCode = `

  // Résout dynamiquement baseUrl via discoveryUrl si nécessaire (ex: fstream.net hub)
  async ensureBaseUrl() {
    if (this.baseUrl) return this.baseUrl;
    const now = Date.now();
    if (this._discoveryCache.url && now - this._discoveryCache.ts < 24 * 60 * 60 * 1000) {
      this.baseUrl = this._discoveryCache.url;
      this.cfg.baseUrl = this._discoveryCache.url;
      return this.baseUrl;
    }
    if (!this.cfg.discoveryUrl) return null;
    try {
      const r = await fetchText(this.cfg.discoveryUrl, { timeout: 10000, retries: 0 });
      if (!r.ok || !r.text) return null;
      const html = r.text;
      const baseHost = new URL(this.cfg.discoveryUrl).hostname;
      const links = [...html.matchAll(/<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>/gi)].map(m => m[1]);
      const candidates = [];
      for (const href of links) {
        try {
          const u = new URL(href, this.cfg.discoveryUrl).href;
          const host = new URL(u).hostname;
          if (host === baseHost) continue;
          if (/facebook|twitter|instagram|youtube|google|paypal|patreon/i.test(host)) continue;
          const score = (/stream|film|french|flix|vod|cinem|watch|play/i.test(u) ? 1 : 0);
          candidates.push({ url: u, score });
        } catch {}
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length) {
        const discovered = candidates[0].url;
        const clean = discovered.replace(/\\/+$/, '');
        this.baseUrl = clean;
        this.cfg.baseUrl = clean;
        this._discoveryCache = { url: clean, ts: now };
        log.info(this.siteKey, 'discovery', 'BaseUrl découvert via ' + this.cfg.discoveryUrl + ' -> ' + clean);
        return clean;
      }
    } catch (e) {
      log.warn(this.siteKey, 'discovery', 'Echec découverte via ' + this.cfg.discoveryUrl, { err: String(e).slice(0, 200) });
    }
    return null;
  }

  abs(href)`;

c = c.replace(/\n  abs\(href\)/, ensureBaseUrlCode);

// 3. Modifier ajaxSearch pour appeler ensureBaseUrl d'abord
c = c.replace(
  "  async ajaxSearch(query, retry = true) {\n    const url = this.baseUrl + '/engine/ajax/search.php';",
  "  async ajaxSearch(query, retry = true) {\n    await this.ensureBaseUrl();\n    if (!this.baseUrl) throw new Error('BaseUrl non résolu pour ' + this.siteKey);\n    const url = this.baseUrl + '/engine/ajax/search.php';"
);

// 4. Modifier search pour appeler ensureBaseUrl d'abord
c = c.replace(
  "  async search(query) {\n    log.info(this.siteKey, 'search', `Searching \"${query}\" on ${this.baseUrl}`);",
  "  async search(query) {\n    await this.ensureBaseUrl();\n    log.info(this.siteKey, 'search', `Searching \"${query}\" on ${this.baseUrl}`);"
);

// 5. Modifier episodesMap pour appeler ensureBaseUrl d'abord
c = c.replace(
  "  async episodesMap(newsId, pageUrl) {\n    if (!this.episodesApi) return null;\n    const url = this.baseUrl + this.episodesApi",
  "  async episodesMap(newsId, pageUrl) {\n    if (!this.episodesApi) return null;\n    await this.ensureBaseUrl();\n    if (!this.baseUrl) return null;\n    const url = this.baseUrl + this.episodesApi"
);

fs.writeFileSync('src/adapters/dle.js', c, 'utf8');
console.log('dle.js modifié avec découverte dynamique');
