'use strict';

const { chromium } = require('playwright');

// Détection environnement Render (plan gratuit : 512 Mo RAM, réponse rapide requise)
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER === '1' || process.env.RENDER === 'on';

const DEFAULT_OPTS = IS_RENDER
  ? {
      headless: true,
      executablePath: null,
      gotoTimeout: 8000,        // 8 s max pour charger la page lecteur
      waitMs: 500,
      maxWait: 3,               // ~1,5 s d'attente après clic play
      chromeArgs: [
        '--no-sandbox',
        '--disable-dev-shm-usage',      // impératif dans conteneur RAM limitée
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--disable-features=site-per-process,BlinkGenPropertyTrees',
        '--blink-settings=imagesEnabled=false',   // n'affiche pas les images (économie RAM/bande passante)
        '--memory-pressure-off',
        '--max_old_space_size=256'              // limite V8 à 256 Mo
      ]
    }
  : {
      headless: true,
      executablePath: null,
      gotoTimeout: 15000,
      waitMs: 500,
      maxWait: 10,
      chromeArgs: []
    };

/**
 * NIVEAU 2 — Interception réseau native (Playwright)
 * Ouvre la page de lecteur (.html) et intercepte les requêtes réseau pour
 * extraire le premier lien vidéo brut (.mp4 / .m3u8) détecté.
 * @param {string} targetUrl URL de la page .html extraite par le scraper niveau 1
 * @param {object} opts options de lancement (headless, timeout, args Chrome…)
 * @returns {Promise<string|null>} Lien direct .mp4/.m3u8 ou null
 */
async function extractUniversalVideoLink(targetUrl, opts = {}) {
    const {
        executablePath = DEFAULT_OPTS.executablePath,
        headless = DEFAULT_OPTS.headless,
        gotoTimeout = DEFAULT_OPTS.gotoTimeout,
        waitMs = DEFAULT_OPTS.waitMs,
        maxWait = DEFAULT_OPTS.maxWait,
        chromeArgs = DEFAULT_OPTS.chromeArgs
    } = opts;
    const launchOptions = { headless, args: chromeArgs };
    if (executablePath) launchOptions.executablePath = executablePath;
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    let directVideoLink = null;
    try {
        page.on('request', request => {
            const url = request.url();
            if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('/playlist.m3u8')) {
                if (!url.includes('fragment') && !url.includes('advertisement')) {
                    directVideoLink = url;
                }
            }
        });
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
        const playButton = page.locator('video, .play, #player, iframe');
        if (await playButton.count() > 0) { await playButton.first().click({ force: true }); }
        for (let i = 0; i < maxWait; i++) { if (directVideoLink) break; await new Promise(r => setTimeout(r, waitMs)); }
    } catch (e) { console.error(e); } finally { await browser.close(); }
    return directVideoLink;
}

module.exports = { extractUniversalVideoLink, IS_RENDER };
