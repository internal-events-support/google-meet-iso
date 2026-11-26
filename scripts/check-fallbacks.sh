#!/usr/bin/env bash
# Runs canvas6 + passthrough in each engine configuration (render worker / in-page engine,
# WebGPU / WebGL2) and saves one NDI frame per output, so every render path can be eyeballed.
#   bash scripts/check-fallbacks.sh   → tmp/fallbacks/<config>/<scenario>/*.bmp + log lines
set -u
cd "$(dirname "$0")/.."
run() {
  local cfg="$1" scen="$2"; shift 2
  local out="tmp/fallbacks/$cfg/$scen"
  rm -rf "$out"; mkdir -p "$out"
  env "$@" node scripts/bench.js --serve="$scen" > "$out/serve.log" 2>&1 &
  for _ in $(seq 1 40); do grep -q "NDI source up" "$out/serve.log" 2>/dev/null && break; node -e "setTimeout(()=>{},500)"; done
  node -e "setTimeout(()=>{},8000)"
  node scripts/grab-ndi.js BENCH "$out" > "$out/grab.txt" 2>&1
  local prof; prof=$(grep -o "profile [^)]*" "$out/serve.log" | head -1 | cut -c9-)
  GMEET_ISO_USER_DATA="$prof" ./node_modules/.bin/electron . --cmd=quit > /dev/null 2>&1
  node -e "setTimeout(()=>{},3000)"
  echo "== $cfg / $scen: $(grep -c '→' "$out/grab.txt") frames; $(grep -m1 -oE 'render worker up[^"]*|rendering in the page|render worker unavailable[^"]*' "$out/serve.log"); $(grep -m1 -oE 'compositor: [a-z]+' "$out/serve.log")"
  grep -iE "error|failed" "$out/serve.log" | grep -v "Electron Security" | head -3
}
for scen in canvas6 passthrough; do
  run worker-webgpu "$scen"
  run worker-webgl "$scen" GMEET_ISO_WEBGPU=0
  run page-webgpu "$scen" GMEET_ISO_RENDER_WORKER=0
  run page-webgl "$scen" GMEET_ISO_RENDER_WORKER=0 GMEET_ISO_WEBGPU=0
done
