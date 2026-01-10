#!/bin/bash
# Prepares the addon directory for Docker build by copying integration files

set -e
cd "$(dirname "$0")"

# Sync versions first
echo "Syncing versions..."
./sync-version.sh

echo "Preparing build: copying integration files..."
rm -rf ./integration-build-output
cp -r ../custom_components/teufel_raumfeld_raumkernel ./integration-build-output

echo "Done! Ready to build addon."
