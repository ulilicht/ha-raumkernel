#!/bin/bash

# Smart deployment script for ha-raumkernel
# - Only restarts what actually changed
# - Add-on changes → only addon restart (fast)
# - Integration changes → only core restart
# - Both → both restarts

set -e

# Check if .env file exists
if [ ! -f .env ]; then
  echo "Error: .env file not found. Please copy .env-dist to .env and configure it."
  exit 1
fi

export $(cat .env | xargs)

# Check for required variables
if [ -z "$SSH_HOST" ] || [ -z "$SSH_USER" ] || [ -z "$REMOTE_ADDON_PATH" ] || [ -z "$REMOTE_INTEGRATION_PATH" ]; then
  echo "Error: Missing required configuration variables in .env"
  exit 1
fi

HOST=$SSH_HOST
USER=$SSH_USER
ADDON_PATH=$REMOTE_ADDON_PATH
INTEGRATION_PATH=$REMOTE_INTEGRATION_PATH
ADDON_SLUG="${ADDON_SLUG:-local_ha-raumkernel-addon}"

# Sync addon version (config.yaml -> package.json)
echo "Syncing addon version..."
./ha-raumkernel-addon/sync-version.sh

echo ""
echo "Deploying to $USER@$HOST..."
echo "Addon Path: $ADDON_PATH"
echo "Integration Path: $INTEGRATION_PATH"
echo ""

# Track what changed
ADDON_CHANGED=false
INTEGRATION_CHANGED=false

# Deploy Add-on and detect changes
echo "📦 Syncing Add-on files..."
ADDON_RSYNC_OUTPUT=$(rsync -avz --delete --itemize-changes \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  ha-raumkernel-addon/ "$USER@$HOST:$ADDON_PATH" 2>&1)

# Check if any files were transferred (lines starting with >f or <f indicate file changes)
if echo "$ADDON_RSYNC_OUTPUT" | grep -qE '^[<>]f'; then
  ADDON_CHANGED=true
  echo "   ✓ Add-on files changed"
else
  echo "   ○ Add-on files unchanged"
fi

# Deploy Integration and detect changes
echo "📦 Syncing Integration files..."
ssh $USER@$HOST "mkdir -p $INTEGRATION_PATH"
INTEGRATION_RSYNC_OUTPUT=$(rsync -avz --delete --itemize-changes \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  custom_components/teufel_raumfeld_raumkernel/ "$USER@$HOST:$INTEGRATION_PATH" 2>&1)

if echo "$INTEGRATION_RSYNC_OUTPUT" | grep -qE '^[<>]f'; then
  INTEGRATION_CHANGED=true
  echo "   ✓ Integration files changed"
  # Clear Python bytecode cache
  ssh $USER@$HOST "rm -rf $INTEGRATION_PATH/__pycache__"
else
  echo "   ○ Integration files unchanged"
fi

echo ""

# Handle Add-on changes
if [ "$ADDON_CHANGED" = true ]; then
  echo "🔄 Reloading Add-on..."
  
  # Reload supervisor to detect changes
  ssh $USER@$HOST "ha supervisor reload" 2>/dev/null || true
  sleep 1
  
  # Rebuild addon (picks up code changes without version bump)
  ssh $USER@$HOST "ha addons rebuild $ADDON_SLUG" 2>/dev/null || true
  sleep 2
  
  # Restart to ensure new code is running
  echo "   Restarting Add-on..."
  ssh $USER@$HOST "ha addons restart $ADDON_SLUG"
  sleep 3
  
  # Verify addon is running
  echo "   Verifying Add-on status..."
  ssh $USER@$HOST "ha addons info $ADDON_SLUG | grep -E 'state:|version:'"
fi

# Handle Integration changes
if [ "$INTEGRATION_CHANGED" = true ]; then
  echo "🔄 Restarting Home Assistant Core (for integration changes)..."
  ssh $USER@$HOST "ha core restart"
  echo "   ⏳ Waiting for Core to restart..."
  sleep 10
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ADDON_CHANGED" = true ] && [ "$INTEGRATION_CHANGED" = true ]; then
  echo "✅ Deployed: Add-on + Integration (full restart)"
elif [ "$ADDON_CHANGED" = true ]; then
  echo "✅ Deployed: Add-on only (no Core restart needed)"
elif [ "$INTEGRATION_CHANGED" = true ]; then
  echo "✅ Deployed: Integration only (Core restarted)"
else
  echo "ℹ️  No changes detected - nothing to restart"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
