"""Run Practice 8 checks against a separate local API and PostgreSQL schema."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--attacks", action="store_true", required=True)
parser.parse_args()
root = Path(__file__).resolve().parents[1]
raise SystemExit(subprocess.call(["node", "eval/security/http-run.mjs"], cwd=root))
