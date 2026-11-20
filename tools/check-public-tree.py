"""Reject private runtime data and workstation details from the public source tree."""
from pathlib import PurePosixPath
import re
import subprocess
import sys


paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
paths = [path for path in paths if path]
blocked_roots = {"jobs", "out", "release", "tmp", "node_modules"}
blocked_extensions = {
    ".asc", ".csv", ".exe", ".geojson", ".grib", ".gz", ".hgt", ".kmz",
    ".log", ".mbtiles", ".nc", ".prj", ".state", ".tif", ".tiff", ".zip",
}
errors = []
for name in paths:
    parts = PurePosixPath(name).parts
    if parts and (parts[0] in blocked_roots or (parts[0] == "data" and name != "data/README.md")):
        errors.append(f"runtime or data path: {name}")
    if name.startswith("vendor/cesium/Assets/Textures/NaturalEarthII/"):
        errors.append(f"third-party base-map tiles are excluded: {name}")
    if parts and parts[0] == "assets" and PurePosixPath(name).suffix.lower() in {
        ".ico", ".jpg", ".jpeg", ".png", ".webp"
    }:
        errors.append(f"unreviewed visual asset: {name}")
    if PurePosixPath(name).suffix.lower() in blocked_extensions:
        errors.append(f"runtime data or binary: {name}")
    if name.lower().endswith((".env", ".pem", ".key")):
        errors.append(f"credential or private key: {name}")

secret = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}"
)
slash = bytes((92, 92))
workstation = re.compile(rb"[A-Z]:" + slash + rb"(?:Users|sh)" + slash, re.IGNORECASE)
for name in paths:
    try:
        with open(name, "rb") as source:
            content = source.read(16 * 1024 * 1024 + 1)
        if len(content) > 16 * 1024 * 1024:
            errors.append(f"file exceeds 16 MiB: {name}")
            continue
        if secret.search(content):
            errors.append(f"possible credential: {name}")
        if workstation.search(content):
            errors.append(f"possible workstation path: {name}")
    except OSError:
        errors.append(f"cannot inspect tracked file: {name}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print(f"Public-tree check passed ({len(paths)} tracked files).")
