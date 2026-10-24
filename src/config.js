'use strict';
const fs = require('fs');
const path = require('path');

const SITES_PATH = path.join(__dirname, '..', 'config', 'sites.json');

function loadSites() {
  let text = fs.readFileSync(SITES_PATH, 'utf8');
  text = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const raw = JSON.parse(text);
  const clean = (u) => (u || '').trim().replace(/\/+$/, '');
  for (const key of ['animeSite', 'movieSeriesSite', 'redirectService']) {
    const s = raw[key] || {};
    s.baseUrl = clean(s.baseUrl);
    // Desactive proprement si URL d'exemple / vide
    if ((!s.baseUrl && !s.discoveryUrl) || /EXEMPLE/i.test(s.baseUrl)) {
      s.enabled = false;
      s._reason = 'URL et source de découverte non configurées (voir config/sites.json)';
    }
    raw[key] = s;
  }
  raw.settings = raw.settings || {};
  return raw;
}

module.exports = { loadSites, SITES_PATH };
