'use strict';
// Normalisation FR : casse, accents, espaces, ponctuation. + score de correspondance.
function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Levenshtein simple
function lev(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

// Score 0..1 : exact > contient > fuzzy. Annee = bonus/malus fort.
function score(query, candidate, opts = {}) {
  const q = norm(query), c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  // Les pages de série portent souvent le suffixe "Saison N" :
  // compare le titre de base avant de classer les variantes.
  const candidateBase = c.replace(/\s+(?:saison|season)\s+\d+(?:\s+.*)?$/, '').trim();
  if (candidateBase === q) return 1;
  let s = 0;
  if (c.startsWith(`${q} `)) s = Math.max(s, 0.82);
  else if (c.includes(` ${q} `)) s = Math.max(s, 0.70);
  if (q.startsWith(`${c} `)) s = Math.max(s, 0.68);
  s = Math.max(s, lev(q, c));
  // Bonus annee
  if (opts.queryYear && opts.candYear) {
    if (String(opts.queryYear) === String(opts.candYear)) s = Math.min(1, s + 0.05);
    else if (Math.abs(Number(opts.queryYear) - Number(opts.candYear)) > 1) s -= 0.3;
  }
  return Math.max(0, Math.min(1, s));
}

// Seuil : on refuse les faux amis (ex. animes aux titres proches)
function isMatch(query, candidate, opts = {}) {
  return score(query, candidate, opts) >= (opts.threshold ?? 0.72);
}

function catalogScore(query, candidate, type, opts = {}) {
  const base = score(query, candidate, opts);
  // À score de titre égal, une fiche saison est un meilleur candidat dans le
  // catalogue des séries qu'un film portant le même titre.
  return type === 'series' && /\b(?:saison|season)\s*\d+\b/i.test(candidate || '') ? base + 0.02 : base;
}

// Parse "Saison 2 Episode 5" / "S02E05" / "Episode 12" / numerotation absolue
function parseSeasonEpisode(text) {
  const t = (text || '');
  let m = t.match(/S0?(\d+)\s*E0?(\d+)/i);
  if (m) return { season: +m[1], episode: +m[2] };
  m = t.match(/saison\s*0?(\d+).*?episode\s*0?(\d+)/i);
  if (m) return { season: +m[1], episode: +m[2] };
  m = t.match(/episode\s*0?(\d+)/i);
  if (m) return { season: 1, episode: +m[1] };
  return { season: 1, episode: null };
}

module.exports = { norm, lev, score, catalogScore, isMatch, parseSeasonEpisode };
