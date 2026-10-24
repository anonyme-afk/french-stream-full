@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Diagnostic des episodes et specials - aucune URL complete n'est affichee.
echo.
node src\tools\diagnose-episode-maps.js
echo.
echo Copie le resultat pour verifier les saisons et les episodes detectes.
pause
