# Development Workflow

This project uses a remote deployment workflow for testing on a running Home Assistant instance.

## Prerequisites

- SSH access to your Home Assistant instance.
- `rsync` installed on your local machine.

## Deploying Changes

1.  Copy `.env-dist` to `.env`:
2.  Edit `.env` and update your SSH connection details.

To sync your local changes to the remote instance, run:

```bash
chmod +x deploy_remote.sh
./deploy_remote.sh
```
