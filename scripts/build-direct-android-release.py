"""Build a signed APK, or a Play bundle with --bundle, from a private signing configuration; never print its secrets."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
task = ":app:bundleRelease" if "--bundle" in sys.argv[1:] else ":app:assembleRelease"
if "GROGONI_ANDROID_BUILD_DIR" not in os.environ:
    subprocess.run(["node", str(root / "scripts/bundle-android-web.mjs")], cwd=root, check=True)
config = Path(os.environ.get("GROGONI_RELEASE_SIGNING_CONFIG", str(root / "backups/android-release/signing.json")))
if stat.S_IMODE(config.stat().st_mode) & 0o077:
    raise SystemExit("Signing configuration must be readable only by its owner (chmod 600).")
values = json.loads(config.read_text())
environment = dict(os.environ)
for key in ("GROGONI_RELEASE_STORE_FILE", "GROGONI_RELEASE_STORE_PASSWORD", "GROGONI_RELEASE_KEY_ALIAS", "GROGONI_RELEASE_KEY_PASSWORD"):
    if not values.get(key):
        raise SystemExit(f"Missing signing setting: {key}")
    environment[key] = values[key]
project = environment.get("GROGONI_ANDROID_BUILD_DIR", str(root / "apps/android"))
gradle = environment.get("GROGONI_GRADLE_BIN", "gradle")
subprocess.run([gradle, "-p", project, task, "--offline", "--no-daemon", "--max-workers=1", "-Dorg.gradle.jvmargs=-Xmx768m", "-Pkotlin.compiler.execution.strategy=in-process"], env=environment, check=True)
