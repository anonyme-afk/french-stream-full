#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diagnose.py — Outil de diagnostic réseau pour les protocoles de streaming
==========================================================================

Utilise yt-dlp en mode simulation pour extraire la structure d'une page
web (films, séries, animés) sans télécharger le fichier vidéo.

Flags yt-dlp utilises :
  --dump-json    : exporte les métadonnées brutes (format JSON)
  --verbose      : logs détaillés (cookies, User-Agent, requêtes réseau)
  --simulate     : aucune descente de fichier (test uniquement)

Sortie :
  Tout le flux (stdout + stderr) est ajoute a rapport-diagnostic.txt
  dans le repertoire du script (mode Append) pour comparaison multi-sources.
"""

import argparse
import datetime
import os
import shutil
import subprocess
import sys

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------
WORKSPACE = os.path.dirname(os.path.abspath(__file__))
RAPPORT_PATH = os.path.join(WORKSPACE, "rapport-diagnostic.txt")
YTDLP_CMD = "yt-dlp"  # Nom de l'executable ou module python

# ---------------------------------------------------------------------------
# Verification / installation de yt-dlp
# ---------------------------------------------------------------------------

def ensure_yt_dlp() -> str:
    """Verifie la presence de yt-dlp et tente l'installation si absent.
    Retourne la commande valide a executer."""
    # 1. Executable autonome dans le PATH
    if shutil.which(YTDLP_CMD):
        return YTDLP_CMD

    # 2. Module Python yt_dlp
    try:
        __import__("yt_dlp")
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        pass

    # 3. Tentative d'installation via pip
    print("[!] yt-dlp introuvable. Tentative d'installation via pip...", file=sys.stderr)
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "yt-dlp"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if shutil.which(YTDLP_CMD):
            return YTDLP_CMD
        try:
            __import__("yt_dlp")
            return [sys.executable, "-m", "yt_dlp"]
        except ImportError:
            pass
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"[!] Echec de l'installation automatique : {exc}", file=sys.stderr)

    # 4. Echec : instructions manuelles
    print(
        "[!] yt-dlp est introuvable et n'a pas pu etre installe automatiquement.\n"
        "    Installez-le manuellement :\n"
        "      pip install yt-dlp\n"
        "    ou telechargez le binaire :\n"
        "      https://github.com/yt-dlp/yt-dlp/releases\n",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Execution du diagnostic
# ---------------------------------------------------------------------------

def run_diagnostic(url: str, yt_dlp_cmd: list | str) -> int:
    """Lance yt-dlp en mode simulation et redirige tout vers le rapport."""
    # Construction de la commande
    if isinstance(yt_dlp_cmd, str):
        cmd = [yt_dlp_cmd, "--dump-json", "--verbose", "--simulate", url]
    else:
        cmd = yt_dlp_cmd + ["--dump-json", "--verbose", "--simulate", url]

    # Separateur visuel + horodatage
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    separator = (
        f"\n{'='*80}\n"
        f"DIAGNOSTIC STREAM — {now}\n"
        f"URL cible : {url}\n"
        f"Commande  : {' '.join(cmd)}\n"
        f"{'='*80}\n"
    )

    try:
        # Capture stdout et stderr separément puis fusion dans le rapport
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        returncode = result.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", errors="replace") if exc.stdout else ""
        stderr = (exc.stderr.decode("utf-8", errors="replace") if exc.stderr else "")
        stderr += "\n[!] TIMEOUT : yt-dlp a depasse 120 secondes.\n"
        returncode = -1
    except FileNotFoundError:
        stdout = ""
        stderr = f"[!] Executable yt-dlp introuvable : {cmd[0]}\n"
        returncode = 127
    except Exception as exc:  # noqa: BLE001
        stdout = ""
        stderr = f"[!] Erreur inattendue : {exc}\n"
        returncode = 1

    # Ecriture en mode Append
    with open(RAPPORT_PATH, "a", encoding="utf-8") as f:
        f.write(separator)
        f.write("--- STDOUT ---\n")
        f.write(stdout)
        if stdout and not stdout.endswith("\n"):
            f.write("\n")
        f.write("--- STDERR ---\n")
        f.write(stderr)
        if stderr and not stderr.endswith("\n"):
            f.write("\n")
        f.write(f"--- CODE RETOUR : {returncode} ---\n")
        f.write(f"{'='*80}\n\n")

    return returncode


# ---------------------------------------------------------------------------
# Point d'entree
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diagnostic réseau streaming via yt-dlp (simulation uniquement)."
    )
    parser.add_argument(
        "url",
        help="URL de la page web cible (film, serie ou anime).",
    )
    args = parser.parse_args()

    yt_dlp_cmd = ensure_yt_dlp()
    rc = run_diagnostic(args.url, yt_dlp_cmd)

    if rc == 0:
        print(f"[OK] Diagnostic termine. Rapport ajoute dans : {RAPPORT_PATH}")
    else:
        print(f"[WARN] Diagnostic termine avec le code {rc}. Consultez : {RAPPORT_PATH}")

    return rc


if __name__ == "__main__":
    sys.exit(main())
