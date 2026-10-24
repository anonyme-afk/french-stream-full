@echo off
cd /d "%~dp0"
echo Serveur local Stremio : http://127.0.0.1:3000/manifest.json
echo Garde cette fenetre ouverte pendant le test dans Stremio.
node stream-proxy.js
pause
