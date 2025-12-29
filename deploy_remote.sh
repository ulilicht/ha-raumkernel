#!/bin/bash

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

echo "Deploying to $USER@$HOST..."
echo "Addon Path: $ADDON_PATH"
echo "Integration Path: $INTEGRATION_PATH"

# Deploy Add-on
echo "Syncing Add-on files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  ha-raumkernel-addon/ "$USER@$HOST:$ADDON_PATH"

# Deploy Integration and detect changed files
echo "Syncing Integration files..."
ssh $USER@$HOST "mkdir -p $INTEGRATION_PATH"
CHANGED_FILES=$(rsync -avz --delete --itemize-changes \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  custom_components/teufel_raumfeld_raumkernel/ "$USER@$HOST:$INTEGRATION_PATH" | grep '^>f' | awk '{print $2}')

# Clear Python bytecode cache to avoid stale code
echo "Clearing Python cache..."
ssh $USER@$HOST "rm -rf $INTEGRATION_PATH/__pycache__"

echo "Rebuilding and starting Add-on..."
ssh $USER@$HOST "ha addons rebuild local_ha-raumkernel-addon && ha addons start local_ha-raumkernel-addon"

# Restart Home Assistant Core
echo ""
echo "Restarting Home Assistant Core..."
ssh $USER@$HOST "ha core restart"
echo "✅ Deployment and Core restart complete!"
