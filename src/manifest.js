'use strict';

const ADDON_ID = 'org.frenchstreamfull.addon';
const ADDON_VERSION = '2.4.2';
const ADDON_NAME = 'French-Stream-Full';

function createManifest(baseUrl = 'https://french-stream-full.onrender.com') {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const logo = `${origin}/logo.png`;
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: 'Films, séries et anime en VF/VOSTFR — catalogues French-Stream et French-Manga.',
    logo,
    background: logo,
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['fsf:', 'tt'],
    catalogs: [
      { type: 'movie', id: 'fsf-movies', name: 'FSF Films', extra: [{ name: 'search', isRequired: false }] },
      { type: 'series', id: 'fsf-series', name: 'FSF Séries et anime', extra: [{ name: 'search', isRequired: false }] }
    ]
  };
}

module.exports = { ADDON_ID, ADDON_VERSION, ADDON_NAME, createManifest };
