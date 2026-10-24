@echo off
cd /d "%~dp0"
set /p SERIES_TEST=Nom de la serie qui pose probleme (laisser vide pour les tests standards) :
echo Verification en cours. Cela peut prendre quelques minutes...
node src\tools\verify-fluxes.js --series="%SERIES_TEST%" > verification-fluxes.txt 2>&1
if errorlevel 1 echo Le diagnostic a rencontre une erreur; consulte verification-fluxes.txt.
echo.
echo Rapport cree dans : %~dp0verification-fluxes.txt
echo Ouvre ce fichier et partage son contenu pour que je puisse analyser les resultats.
pause
