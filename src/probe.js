'use strict';
// Probe video avance : type reel + taille + playlist HLS analysee (duree).
// Jette les dummy streams (18-20s, mp4 < 500KB, HLS < 120s).
const { headCheck } = require('./http');

const MIN_MP4_BYTES = 500_000;
const MIN_HLS_SECONDS = 120;

async function probeStream(url, referer) {
  const h = await headCheck(url, 4000, referer);
  const ct = (h.contentType || '').toLowerCase();
  const u = (h.finalUrl || url).toLowerCase();
  let streamType = null;
  if (ct.includes('mpegurl') || u.includes('.m3u8')) streamType = 'hls';
  else if (ct.includes('dash') || u.includes('.mpd')) streamType = 'dash';
  else if (ct.includes('video/mp4') || ct.includes('video/') || u.endsWith('.mp4')) streamType = 'mp4';
  else if (u.includes('.m3u8')) streamType = 'hls';
  else if (u.includes('.mpd')) streamType = 'dash';

  if (streamType === 'mp4' && h.contentLength != null && h.contentLength < MIN_MP4_BYTES) {
    return { ...h, streamType, compatible: false, isTooSmall: true, reason: 'mp4 < 500KB' };
  }
  if (streamType === 'hls' && h.ok) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      let fallbackReferer = '';
      try { fallbackReferer = `${new URL(url).origin}/`; } catch {}
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (referer || fallbackReferer) headers.Referer = referer || fallbackReferer;
      const res = await fetch(h.finalUrl || url, {
        signal: ctrl.signal,
        headers
      });
      const txt = await res.text().catch(() => '');
      clearTimeout(t);
      if (txt && txt.includes('#EXTM3U')) {
        const variants = [...txt.matchAll(/#EXT-X-STREAM-INF[^\n]*\n([^\n]+)/g)].map(m => m[1].trim());
        if (variants.length) {
          let best = variants[variants.length - 1];
          try { best = new URL(best, h.finalUrl || url).href; } catch {}
          return { ...h, streamType, compatible: true, variantUrl: best, reason: 'hls-master' };
        }
        const durations = [...txt.matchAll(/#EXTINF:([0-9.]+)/g)].map(m => parseFloat(m[1]));
        const total = durations.reduce((a, b) => a + b, 0);
        if (durations.length && total < MIN_HLS_SECONDS) {
          return { ...h, streamType, compatible: false, isTooSmall: true, durationSec: Math.round(total), reason: 'hls court' };
        }
        return { ...h, streamType, compatible: true, durationSec: Math.round(total) || null, reason: 'hls-media' };
      }
    } catch {}
  }
  return { ...h, streamType, compatible: !!streamType && h.ok !== false };
}

module.exports = { probeStream, MIN_MP4_BYTES, MIN_HLS_SECONDS };
