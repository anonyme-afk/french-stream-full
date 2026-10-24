'use strict';
// Client HTTP v3 ULTRA : timeouts courts, concurrence, cookies persistants, probe avance.
const log = require('./logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let active = 0;
const MAX_CONCURRENT = 8;
const queue = [];
function acquireSlot() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise(resolve => queue.push(resolve));
}
function releaseSlot() {
  active--;
  if (queue.length) { active++; queue.shift()(); }
}

const cookieJar = new Map();
function jarGet(host) { return cookieJar.get(host) || ''; }
function jarSet(host, setCookies) {
  if (!setCookies) return;
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  let cur = cookieJar.get(host) || '';
  for (const sc of arr) {
    const kv = String(sc).split(';')[0].trim();
    if (!kv || !kv.includes('=')) continue;
    const name = kv.split('=')[0];
    const parts = cur.split(';').map(s => s.trim()).filter(Boolean).filter(s => !s.startsWith(name + '='));
    parts.push(kv);
    cur = parts.join('; ') + '; ';
  }
  cookieJar.set(host, cur);
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

async function fetchText(url, opts = {}) {
  const timeout = opts.timeout || 7000;
  const retries = opts.retries ?? 1;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquireSlot();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const host = hostOf(url);
      const jar = jarGet(host);
      const baseCookie = 'fsschal=k7x2m9q4v3b8; dle_skin=FrenchStream;';
      const res = await fetch(url, {
        method: opts.method || 'GET',
        body: opts.body,
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': [baseCookie, jar, (opts.headers && opts.headers.Cookie) || ''].filter(Boolean).join(' '),
          ...(opts.headers || {})
        }
      });
      clearTimeout(t);
      try {
        const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie');
        if (sc) jarSet(host, sc);
      } catch {}
      const text = await res.text().catch(() => '');
      releaseSlot();
      return { status: res.status, url: res.url, text, headers: res.headers, ok: res.ok };
    } catch (e) {
      clearTimeout(t);
      releaseSlot();
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function headCheck(url, timeout, referer) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 4000);
    let fallbackReferer = '';
    try { fallbackReferer = `${new URL(url).origin}/`; } catch {}
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    };
    if (referer || fallbackReferer) headers.Referer = referer || fallbackReferer;
    const res = await fetch(url, {
      method: 'HEAD', signal: ctrl.signal, redirect: 'follow',
      headers
    });
    clearTimeout(t);
    const cl = res.headers.get('content-length');
    return {
      ok: res.ok, status: res.status,
      contentType: res.headers.get('content-type'),
      contentLength: cl ? parseInt(cl, 10) : null,
      finalUrl: res.url
    };
  } catch (e) {
    return { ok: false, status: 0, contentType: null, contentLength: null, finalUrl: url, error: String(e).slice(0, 200) };
  }
}

module.exports = { fetchText, headCheck, sleep };
