'use strict';

function seasonNumberFromTitle(title) {
  const text = String(title || '');
  const specialSuffix = /(?:^|[\s\-–—:()[\]])(?:special episodes?|specials?|episodes?\s+sp[eé]ciaux|sp[eé]cial(?:e|es)?|oavs?|ovas?|bonus|hors[-\s]s[eé]rie)\s*[)\]]?\s*$/i;
  if (specialSuffix.test(text)) return 0;
  const explicit = text.match(/\b(?:season|saison)\s*(\d+)\b/i);
  return explicit ? Number.parseInt(explicit[1], 10) : 1;
}

function episodeNumberFromKey(key, season = 1) {
  const text = String(key || '').trim();
  if (/^\d+$/.test(text)) {
    const number = Number.parseInt(text, 10);
    return number === 0 && Number(season) === 0 ? 1 : number;
  }
  const sxe = text.match(/^(?:s(\d+)\s*e(\d+)|(?:special|sp|oav|ova|bonus)[\s._-]*(\d+))$/i);
  if (!sxe) return null;
  return Number.parseInt(sxe[2] || sxe[3], 10);
}

function episodeCoordinatesFromKey(key, fallbackSeason = 1) {
  const text = String(key || '').trim();
  const aired = text.match(/^s(\d+)\s*e(\d+)$/i);
  if (aired) return { season: Number.parseInt(aired[1], 10), episode: Number.parseInt(aired[2], 10) };
  const special = text.match(/^(?:special|sp|oav|ova|bonus)[\s._-]*(\d+)$/i);
  if (special) return { season: 0, episode: Number.parseInt(special[1], 10) };
  const episode = episodeNumberFromKey(text, fallbackSeason);
  return episode == null ? null : { season: Number(fallbackSeason), episode };
}

function episodeLabel(season, episode, version) {
  const kind = Number(season) === 0 ? 'Spécial' : 'Épisode';
  return `${kind} ${episode} (${String(version || '').toUpperCase()})`;
}

function filterEpisodeSources(sources, { season, episode, version } = {}) {
  return (sources || []).filter((source) => {
    if (Number(source.episode) !== Number(episode)) return false;
    if (season != null && Number(source.season ?? 1) !== Number(season)) return false;
    if (version && source.version !== version) return false;
    return true;
  });
}

module.exports = { seasonNumberFromTitle, episodeNumberFromKey, episodeCoordinatesFromKey, episodeLabel, filterEpisodeSources };
