# French-Stream-Full

Add-on Stremio modulaire pour rechercher des films, des séries et des anime, avec des résultats en VF/VOSTFR.

## À propos du projet

Ce projet a été réalisé par un développeur indépendant, sans commande, affiliation ni autorisation de French-Stream ou French-Manga. Il ne s’agit pas d’un produit officiel et ces noms ainsi que les marques associées restent ceux de leurs propriétaires respectifs.

Chaque partie a demandé un vrai travail de conception, de tests et de corrections : recherche, fiches, saisons et épisodes, anime, résolution des flux, intégration Stremio et hébergement. Le projet a avancé au fil de nombreux essais et difficultés rencontrées.

## Identité et manifeste

- Nom : `French-Stream-Full`
- Identifiant stable Stremio : `org.frenchstreamfull.addon`
- Version du manifeste et du projet : `2.3.0`
- Types Stremio : `movie`, `series` (les anime sont publiés comme séries)
- Catalogues : `fsf-movies` et `fsf-series`
- Logo : `public/logo.png` et `public/logo.svg`

Le manifeste partagé se trouve dans `src/manifest.js` et sert aux deux points d’entrée (`addon.js` et `stream-proxy.js`). Les anime gardent le type Stremio `series` pour que l’application puisse sélectionner une saison et un épisode.

## Lancer en local

```powershell
npm install
npm start
```

Le serveur Render utilise `stream-proxy.js` et la variable `PORT`. Pour lancer l’autre point d’entrée en mode développement :

```powershell
npm run dev
```

Installe dans Stremio l’adresse `/manifest.json` affichée au démarrage. En local, le serveur de développement écoute sur le port `7000` ; le serveur proxy utilise le port `3000` par défaut.

## Vérification

```powershell
npm test
```

Ce contrôle vérifie localement les identifiants d’épisodes et la déduplication des fiches, sans contacter les sites externes. Pour le parcours complet, lance `Verifier-les-flux.cmd` sous Windows : il vérifie 10 films, 10 séries et 10 anime, interroge le manifeste/catalogue/métadonnées/flux Render, compare avec les adaptateurs locaux et écrit `verification-fluxes.txt`. Le rapport masque les URL complètes.

## Modules principaux

- `src/manifest.js` : identité, version, logo et catalogues communs aux deux serveurs.
- `src/adapters/dle.js` : fonctions communes aux sites de type DataLife Engine.
- `src/adapters/movies.js` : recherche de films et séries, fiches, épisodes et sources.
- `src/adapters/anime.js` : recherche anime, fiches, épisodes et sources.
- `src/streams.js` : extraction, résolution, contrôle et assemblage des flux Stremio.
- `src/indexer.js` et `src/store.js` : index de recherche et stockage/cache.
- `stream-proxy.js` : serveur utilisé par Render (`npm start`).
- `addon.js` : serveur de développement local (`npm run dev`).
- `config/sites.json` : configuration des sites utilisés par les adaptateurs.

## Déploiement Render

Le dépôt contient `render.yaml`, configuré pour `npm install` puis `node stream-proxy.js`. Après un push sur la branche reliée à Render, vérifie les journaux de déploiement, puis ouvre `/manifest.json` et `/health`. Render peut mettre le service gratuit en veille après une période sans requête.

Pour les étapes de raccordement GitHub et Render, voir [GUIDE-HEBERGEMENT.txt](GUIDE-HEBERGEMENT.txt).
