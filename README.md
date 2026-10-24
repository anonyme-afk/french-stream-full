# French-Stream-Full

Add-on Stremio modulaire pour rechercher des films, des séries et des anime, avec des résultats en VF/VOSTFR.

## À propos du projet

Ce projet a été réalisé par un développeur indépendant, sans commande, affiliation ni autorisation de French-Stream ou French-Manga. Il ne s’agit pas d’un produit officiel et ces noms ainsi que les marques associées restent ceux de leurs propriétaires respectifs.

Chaque partie a demandé un vrai travail de conception, de tests et de corrections : recherche, fiches, saisons et épisodes, anime, résolution des flux, intégration Stremio et hébergement. Le projet a avancé au fil de nombreux essais et difficultés rencontrées.

## Identité et manifeste

- Nom : `French-Stream-Full`
- Identifiant stable Stremio : `org.frenchstreamfull.addon`
- Version du manifeste et du projet : `2.4.5` (2.4.4 avant)
- Types Stremio : `movie`, `series` (les anime sont publiés comme séries)
- Catalogues : `fsf-movies` et `fsf-series`
- Logo : `public/logo.png` et `public/logo.svg`

Le manifeste partagé se trouve dans `src/manifest.js` et sert aux deux points d’entrée (`addon.js` et `stream-proxy.js`). Les anime gardent le type Stremio `series` pour que l’application puisse sélectionner une saison et un épisode.

Les épisodes spéciaux sont exposés comme saison 0 dans Stremio. Les clés `S00E01`, `OVA`, `OAV`, `bonus` et les titres de fiches marqués « Specials » sont reconnus pour que la sélection d’un spécial retrouve ses propres sources.

Le domaine films/séries n’est pas figé dans `config/sites.json` : au premier accès, l’add-on suit le lien « Regarder en streaming » publié par la page relais configurée, vérifie que le domaine répond, puis le conserve comme dernière adresse valide avec une durée de cache courte. Si la découverte échoue, il réutilise cette dernière adresse. L’identifiant Stremio et l’adresse du manifeste restent stables ; un changement de domaine source ne demande donc pas de réinstaller l’add-on.

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

Le dépôt contient `render.yaml`, configuré pour la branche `main`, le déclenchement `On Commit`, `npm install` puis `node stream-proxy.js`. Pour un service Render déjà créé, vérifie aussi dans **Settings** que la branche reliée est `main` et que **Auto-Deploy** est réglé sur **On Commit**. Après activation, déploie une fois le dernier commit déjà présent ; les pushes suivants partiront automatiquement. Vérifie les journaux, puis `/manifest.json` et `/health`. Render peut mettre le service gratuit en veille après une période sans requête.

Pour les étapes de raccordement GitHub et Render, voir [GUIDE-HEBERGEMENT.txt](GUIDE-HEBERGEMENT.txt).
