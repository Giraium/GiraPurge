#!/usr/bin/env python3
"""Package site/ into a release zip and refresh hash, index.json and repo.json."""
import hashlib, json, pathlib, re, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
site = root / "site"
pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
ver, base = pkg["version"], pkg["homepage"].rstrip("/")
ID = "com.girapurge"

bundle_path = site / "index.js"
bundle = bundle_path.read_bytes()
m = re.search(rb'PLUGIN_VERSION="([^"]+)"', bundle)
if not m or m.group(1).decode() != ver:
    raise SystemExit(f"PLUGIN_VERSION in site/index.js ({m.group(1).decode() if m else 'missing'}) must equal package.json version ({ver})")

def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# keep site/builds in sync with the bundle
build_dir = site / "builds" / ID
(build_dir / "index.js").write_bytes(bundle)
bm = json.loads((build_dir / "manifest.json").read_text(encoding="utf-8"))
bm["version"] = ver
write_json(build_dir / "manifest.json", bm)

# deterministic zip: index.js + manifest.json
zip_path = site / f"GiraPurge-{ver}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in (("index.js", bundle), ("manifest.json", (build_dir / "manifest.json").read_bytes())):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data)
zbytes = zip_path.read_bytes()

# plugin manifest (hash of the bundle)
mf = json.loads((site / "manifest.json").read_text(encoding="utf-8"))
mf["version"] = ver
mf["hash"] = hashlib.sha256(bundle).hexdigest().upper()
write_json(site / "manifest.json", mf)

# repository listing
idx = json.loads((site / "index.json").read_text(encoding="utf-8"))
plugin = idx["plugins"][ID]
deps = bm["dependencies"]
plugin["versions"][ver] = {
    "url": f"{base}/GiraPurge-{ver}.zip",
    "sha256": hashlib.sha256(zbytes).hexdigest(),
    "size": len(zbytes),
    "dependencies": deps,
}
plugin["channels"] = {"latest": ver}
write_json(site / "index.json", idx)

rj = json.loads((site / "repo.json").read_text(encoding="utf-8"))
rj["$meta"]["description"] = f"Official GiraPurge {ver} repository by Giraium Studio for Revenge."
rj[ID]["version"] = ver
write_json(site / "repo.json", rj)

print(f"GiraPurge {ver}: {zip_path.name} {len(zbytes)} bytes, bundle sha256 {mf['hash'][:12]}...")
