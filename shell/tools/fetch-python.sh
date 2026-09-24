#!/bin/sh
# 隨包 Python:python-build-standalone 的 install_only 版,釘死版本 + SHA256。
# universal 包兩顆都要:解到 shell/vendor/python-arm64/ 與 python-x64/(gitignored),
# electron-builder 再以 extraResources 收進 .app;main.js 啟動時照 process.arch 挑一顆。
# 升版:改 PBS_TAG / PY_VERSION 與兩個 SHA256;SHA256 取自該 release 的 SHA256SUMS
# (https://github.com/astral-sh/python-build-standalone/releases/download/<PBS_TAG>/SHA256SUMS),不要用猜的。
set -eu
PBS_TAG="20260901"
PY_VERSION="3.12.14"
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"

fetch() {   # <node arch> <pbs triple> <sha256>
  ARCH="$1"; TRIPLE="$2"; SHA256="$3"
  FILE="cpython-${PY_VERSION}+${PBS_TAG}-${TRIPLE}-install_only.tar.gz"
  URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/$(printf %s "$FILE" | sed 's/+/%2B/')"
  OUT="$DIR/python-$ARCH"
  MARK="$OUT/.blave-pbs"
  if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$FILE $SHA256" ]; then return 0; fi
  mkdir -p "$DIR"
  TMP="$DIR/$FILE.part"
  curl -fsSL --retry 3 -o "$TMP" "$URL"
  GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"
  if [ "$GOT" != "$SHA256" ]; then
    rm -f "$TMP"
    echo "fetch-python: $FILE SHA256 不符(拿到 $GOT)" >&2; exit 1
  fi
  # tar 頂層固定是 python/:先解到暫存目錄再搬,才不會兩顆互相蓋
  STAGE="$DIR/.stage-$ARCH"
  rm -rf "$STAGE" "$OUT"
  mkdir -p "$STAGE"
  tar -xzf "$TMP" -C "$STAGE"
  mv "$STAGE/python" "$OUT"
  rm -rf "$STAGE" "$TMP"
  printf '%s' "$FILE $SHA256" > "$MARK"
  echo "fetch-python: $FILE → $OUT"
}

fetch arm64 aarch64-apple-darwin 3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76
fetch x64   x86_64-apple-darwin  2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba
# 舊版單顆的目錄(vendor/python/)不再使用;留著只會讓人以為它還會進包
rm -rf "$DIR/python"
