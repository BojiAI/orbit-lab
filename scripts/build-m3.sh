#!/bin/sh
# Stage a static site and a native reference from the same source revision.
set -eu
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="$PWD/target"
out="$PWD/target/m3-site"
mkdir -p "$out/textures"
if ! npm --prefix web/m3 ls --depth=0 --silent >/dev/null 2>&1; then
    # The lockfile includes esbuild's prebuilt binary for each supported platform.
    npm --prefix web/m3 ci --ignore-scripts --include=optional --no-audit --no-fund
fi
npm --prefix web/m3 run build
cargo +1.85.1 build --locked --release --manifest-path m3/wasm/Cargo.toml --target wasm32-unknown-unknown
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/m3_wasm.wasm" "$out/orbit_lab_m3.wasm"
cargo +1.85.1 run --locked --release --example m3_reference > "$out/m3-reference.json"
cargo +1.85.1 run --locked --release --example m3_reference -- 0.25 > "$out/m3-unequal.json"
cargo +1.85.1 run --locked --release --example flyby_presets > "$out/flyby-presets.js"
cp web/m3/worker-client.js web/m3/experiment-file.js \
    web/m3/scene.html web/m3/scene.css web/m3/scene.js web/m3/scene-presets.js web/m3/scene-worker.js \
    web/m3/body-portraits.webp "$out/"
cp "$out/scene.html" "$out/index.html"
cp LICENSE "$out/LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$out/THIRD_PARTY_NOTICES.txt"
cp web/m3/node_modules/three/LICENSE "$out/THREE-LICENSE.txt"
for page in binary.html flyby.html; do
    cp web/m3/redirect-to-lab.html "$out/$page"
done
# Remove former site assets left in place by an earlier build.
rm -f "$out/page.js" "$out/worker.js" "$out/plot.js" "$out/flyby.js" "$out/flyby-worker.js"
cp web/m3/textures/*.jpg web/m3/textures/*.png "$out/textures/"
awk -F, 'NR == 1 { print; next } NR == 2 { epoch = $1 } $1 == epoch' \
    tests/fixtures/solar-system-de440.csv > "$out/solar-system-start.csv"
printf 'Staged M3 at %s\n' "$out"
