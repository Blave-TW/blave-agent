#!/bin/sh
# 隨包 Python:python-build-standalone 的 install_only 版,釘死版本 + SHA256。
# 解到 shell/vendor/python/(gitignored),electron-builder 再以 extraResources 收進 .app。
# 升版:改下面三個值;SHA256 取自該 release 的 SHA256SUMS。
set -eu
PBS_TAG="20260901"
PY_VERSION="3.12.14"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin"; SHA256="3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76" ;;
  *) echo "fetch-python: 尚未釘 $ARCH 的 SHA256" >&2; exit 1 ;;
esac
FILE="cpython-${PY_VERSION}+${PBS_TAG}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/$(printf %s "$FILE" | sed 's/+/%2B/')"
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
MARK="$DIR/python/.blave-pbs"

if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$FILE $SHA256" ]; then exit 0; fi
mkdir -p "$DIR"
TMP="$DIR/$FILE.part"
curl -fsSL --retry 3 -o "$TMP" "$URL"
GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"
if [ "$GOT" != "$SHA256" ]; then
  rm -f "$TMP"
  echo "fetch-python: SHA256 不符(拿到 $GOT)" >&2; exit 1
fi
rm -rf "$DIR/python"
tar -xzf "$TMP" -C "$DIR"
rm -f "$TMP"
printf '%s' "$FILE $SHA256" > "$MARK"
echo "fetch-python: $FILE → $DIR/python"
