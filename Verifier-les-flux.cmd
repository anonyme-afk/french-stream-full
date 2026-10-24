@echo off
cd /d "%~dp0"
echo Verification en cours. Cela peut prendre quelques minutes...
node src\tools\verify-fluxes.js > verification-fluxes.txt 2>&1
if errorlevel 1 echo Le diagnostic a rencontre une erreur; consulte verification-fluxes.txt.
echo.
echo Rapport cree dans : %~dp0verification-fluxes.txt
echo Ouvre ce fichier et partage son contenu pour que je puisse analyser les resultats.
pause
