# French-Stream-Full 🇫🇷

Add-on Stremio personnel : **films, séries, animes en français** via French-Stream + French-Manga (hub FStream).

## État : ✅ testé et fonctionnel

- Recherche anime : 17 résultats "naruto", 32 épisodes extraits
- Recherche films : 15 résultats "avengers"
- Séries : 26 épisodes, 125 sources (vidzy/uqload/fsvid/netu/voe)
- Index : recherche floue FR anti-faux-amis
- Une seule dépendance : `stremio-addon-sdk` (zéro build natif)

## Démarrage (2 min)

```powershell
npm install
node addon.js
# -> http://127.0.0.1:7000/manifest.json
```

Dans Stremio : **Addons > Installer via URL** > coller l'URL du manifest.

## Commandes

```powershell
node src/tools/diagnose.js --selftest        # test rapide (sans réseau)
node src/tools/diagnose.js --query=naruto     # test recherche anime live
node src/tools/diagnose.js --query=avengers --type=movie  # test films live
node src/tools/reindex.js --limit=30          # pré-remplir l'index
```

## Config

Tout est déjà rempli dans `config/sites.json` :
- `animeSite` → w16.french-manga.net (AJAX search + manga_episodes_api)
- `movieSeriesSite` → fs26.lol (AJAX search + /static/series/N.js)
- `redirectService` → fstream.net (hub → fs26.lol)

## Architecture

- `addon.js` — serveur Stremio (catalog/meta/stream)
- `src/adapters/dle.js` — base DataLife Engine (recherche AJAX)
- `src/adapters/anime.js` — French-Manga calibré
- `src/adapters/movies.js` — French-Stream calibré
- `src/store.js` — stockage JSON (contenus stables ≠ cache streams)
- `src/streams.js` — sources + vérification + fallback page
- `src/indexer.js` — recherche floue FR

## Hébergement gratuit

Voir GUIDE-HEBERGEMENT.txt (GitHub + Render, 10 min).
