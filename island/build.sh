#!/bin/sh
# Builds HerdrIsland.app into ~/Applications (ad-hoc signed) and restarts it.
set -e
cd "$(dirname "$0")"
APP="$HOME/Applications/HerdrIsland.app"
mkdir -p build "$APP/Contents/MacOS"
swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos14 HerdrIsland.swift -o build/HerdrIsland
cp build/HerdrIsland "$APP/Contents/MacOS/HerdrIsland"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null
pkill -x HerdrIsland 2>/dev/null || true
sleep 0.3
open "$APP"
echo "Installed $APP"
