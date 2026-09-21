#!/bin/bash
cd "$(dirname "$0")"
echo "Cleaning project..."
rm -rf node_modules
rm -rf node
rm -f node.zip
rm -f node.tar.gz
rm -f node.tar.xz
rm -rf node_temp
rm -rf dist
rm -rf logs
rm -rf update
rm -rf download
rm -f config.json
rm -f port.json
rm -f cleanup.bat
rm -f cleanup.sh
echo "Done."
