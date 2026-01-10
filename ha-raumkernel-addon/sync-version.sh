#!/bin/bash
# Syncs version from config.yaml to package.json and regenerates package-lock.json

set -e
cd "$(dirname "$0")"

# Extract version from config.yaml (master source)
VERSION=$(grep '^version:' config.yaml | sed 's/version: *//; s/"//g')

if [ -z "$VERSION" ]; then
    echo "ERROR: Could not extract version from config.yaml"
    exit 1
fi

echo "Syncing version: $VERSION"

# Update package.json version
cd rootfs/app
if command -v jq &> /dev/null; then
    # Use jq if available (preserves formatting better)
    jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
else
    # Fallback to sed
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
fi

echo "Updated package.json to version $VERSION"

# Regenerate package-lock.json
echo "Regenerating package-lock.json..."
npm install --package-lock-only

# Update integration manifest.json
cd ../../../custom_components/teufel_raumfeld_raumkernel
if command -v jq &> /dev/null; then
    jq --arg v "$VERSION" '.version = $v' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json
else
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json
fi
echo "Updated integration manifest.json to version $VERSION"

echo "Done! Version synced to $VERSION"
