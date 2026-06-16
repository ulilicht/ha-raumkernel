#!/bin/bash

# Deploy script for ha-raumkernel addon
# - Syncs addon files to remote HA
# - Rebuilds and restarts the addon
# - Integration is installed automatically by the addon on startup

set -e

# Check if .env file exists
if [ ! -f .env ]; then
  echo "Error: .env file not found. Please copy .env-dist to .env and configure it."
  exit 1
fi

export $(cat .env | xargs)

# Check for required variables
if [ -z "$SSH_HOST" ] || [ -z "$SSH_USER" ] || [ -z "$REMOTE_ADDON_PATH" ]; then
  echo "Error: Missing required configuration variables in .env"
  exit 1
fi

HOST=$SSH_HOST
USER=$SSH_USER
ADDON_PATH=$REMOTE_ADDON_PATH
ADDON_SLUG="${ADDON_SLUG:-local_ha-raumkernel-addon}"

# Prepare build (syncs versions + copies integration into addon)
echo "Preparing build..."
./ha-raumkernel-addon/prepare-build.sh

echo ""
echo "Deploying to $USER@$HOST..."
echo "Addon Path: $ADDON_PATH"
echo ""

# Deploy Add-on
echo "📦 Syncing Add-on files..."
set +e
ADDON_RSYNC_OUTPUT=$(rsync -avz --delete --itemize-changes \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  ha-raumkernel-addon/ "$USER@$HOST:$ADDON_PATH" 2>&1)
RSYNC_EXIT_CODE=$?
set -e

if [ $RSYNC_EXIT_CODE -ne 0 ]; then
  echo "❌ Rsync failed with exit code $RSYNC_EXIT_CODE"
  echo "Output:"
  echo "$ADDON_RSYNC_OUTPUT"
  exit $RSYNC_EXIT_CODE
fi

# Check if any files were transferred
if echo "$ADDON_RSYNC_OUTPUT" | grep -qE '^[<>]f'; then
  echo "   ✓ Add-on files changed"
  
  echo "🔄 Reloading Add-on Store..."
  
  # Reload store to detect changes (including version updates)
  ssh $USER@$HOST "ha store reload" 2>/dev/null || true
  sleep 2
  
  # Check if addon is already installed
  if ssh $USER@$HOST "ha apps info $ADDON_SLUG" 2>/dev/null | grep -E "state: (started|stopped)"; then
    # Check if a version update is available
    if ssh $USER@$HOST "ha apps info $ADDON_SLUG" 2>/dev/null | grep -q "update_available: true"; then
      echo "   Updating Add-on to new version..."
      ssh $USER@$HOST "ha apps update $ADDON_SLUG"
      sleep 3
    else
      # Addon is installed but version hasn't changed - rebuild and restart to apply changes
      echo "   Rebuilding Add-on..."
      ssh $USER@$HOST "ha apps rebuild $ADDON_SLUG" 2>/dev/null || true
      sleep 2
      
      echo "   Restarting Add-on..."
      ssh $USER@$HOST "ha apps restart $ADDON_SLUG"
      sleep 3
    fi
  else
    # Addon not installed - install it
    echo "   Installing Add-on for the first time..."
    ssh $USER@$HOST "ha apps install $ADDON_SLUG"
    sleep 3
    
    echo "   Starting Add-on..."
    ssh $USER@$HOST "ha apps start $ADDON_SLUG"
    sleep 3
  fi
  
  # Verify addon is running
  echo "   Verifying Add-on status..."
  ssh $USER@$HOST "ha apps info $ADDON_SLUG | grep -E 'state:|version:'"
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "✅ Add-on deployed and restarted"
  echo "   Integration will be installed/updated by addon on startup."
  echo "   Check HA for persistent notification if restart is needed."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  echo "   ○ Add-on files unchanged"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "ℹ️  No changes detected - nothing to restart"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
