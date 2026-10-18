'use strict';
// Client HTTP robuste : timeout, retry, redirections bornees, anti-boucle, concurrence.
const log = require('./logger');

const inflight = new Set();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url, opts = {}) {
  const timeout = opts.timeout || 15000;
  const retries = opts.retries ?? 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) French-Stream-Full/1.0',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(opts.headers || {})
        }
      });
      clearTimeout(t);
      const text = await res.text().catch(() => '');
      return { status: res.status, url: res.url, text, headers: res.headers, ok: res.ok };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      log.warn(opts.site || '-', 'http', `Echec ${url} (tentative ${attempt + 1}/${retries + 1})`, { err: String(e).slice(0, 200) });
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function headCheck(url, timeout = 10000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type'), finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, contentType: null, finalUrl: url, error: String(e).slice(0, 200) };
  }
}

// HEAD leger -> GET partiel si doute. Ne telecharge jamais tout le flux.
async function probeStream(url) {
  const h = await headCheck(url);
  const ct = (h.contentType || '').toLowerCase();
  const u = (h.finalUrl || url).toLowerCase();
  let streamType = null;
  if (ct.includes('mpegurl') || u.includes('.m3u8')) streamType = 'hls';
  else if (ct.includes('dash') || u.includes('.mpd')) streamType = 'dash';
  else if (ct.includes('video/mp4') || ct.includes('video/') || u.endsWith('.mp4')) streamType = 'mp4';
  else if (u.includes('.m3u8')) streamType = 'hls';
  else if (u.includes('.mpd')) streamType = 'dash';
  return { ...h, streamType, compatible: !!streamType && h.ok !== false };
}

module.exports = { fetchText, headCheck, probeStream };
