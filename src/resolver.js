'use strict';
// Resout le SITE INTERMEDIAIRE : page qui affiche une URL / redirection / JS / temporaire.
// Ne confond jamais page intermediaire et destination finale. Journalise chaque etape.
const { fetchText } = require('../http');
const log = require('../logger');

async function resolveRedirect(intermediateUrl, siteCfg) {
  const steps = [];
  const push = (s) => steps.push(s);
  try {
    push({ step: 'Page intermediaire accessible', url: intermediateUrl });
    const r = await fetchText(intermediateUrl, { site: 'redirect' });
    if (!r.ok) {
      push({ step: 'Erreur reseau / HTTP', status: r.status });
      return { ok: false, reason: `HTTP ${r.status}`, steps };
    }
    // 1. Redirection HTTP suivie automatiquement
    if (r.url && r.url !== intermediateUrl) {
      push({ step: 'Redirection trouvee', to: r.url });
      return { ok: true, finalUrl: r.url, temporary: true, expiresAt: null, steps };
    }
    // 2. Meta refresh / JS location / lien evident dans le HTML
    const html = r.text || '';
    let m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>]+)/i);
    if (m) {
      const dest = new URL(m[1].trim(), intermediateUrl).href;
      push({ step: 'Redirection trouvee (meta-refresh)', to: dest });
      return { ok: true, finalUrl: dest, temporary: true, expiresAt: null, steps };
    }
    m = html.match(/(?:window\.location(?:\.href)?|location\.href)\s*=\s*["']([^"']+)["']/);
    if (m) {
      const dest = new URL(m[1].trim(), intermediateUrl).href;
      push({ step: 'Redirection trouvee (JS)', to: dest });
      return { ok: true, finalUrl: dest, temporary: true, expiresAt: null, steps };
    }
    // 3. URL visible dans le contenu (heuristique prudente)
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(x => x[0]);
    const baseHost = new URL(intermediateUrl).hostname;
    const external = urls.find(u => { try { return new URL(u).hostname !== baseHost; } catch { return false; } });
    if (external) {
      push({ step: 'URL finale identifiee dans le contenu', to: external });
      return { ok: true, finalUrl: external, temporary: true, expiresAt: null, steps };
    }
    push({ step: 'Aucun lien exploitable trouve' });
    return { ok: false, reason: 'Aucun lien exploitable trouve', steps };
  } catch (e) {
    log.error('redirect', 'resolve', String(e).slice(0, 300), { url: intermediateUrl });
    push({ step: 'Erreur reseau', detail: String(e).slice(0, 200) });
    return { ok: false, reason: 'Erreur reseau', steps };
  }
}

module.exports = { resolveRedirect };
