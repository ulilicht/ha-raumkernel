# Addon to integrate Teufel Raumfeld devices to Home Assistant

A Home Assistant Add-on that provides a bridge to Teufel Raumfeld devices using the `node-raumkernel` library. The addon comes bundled with the Raumfeld integration and will install it automatically on startup. (can be disabled in the settings)

## Features

- **Stable Room Entities**: Provides consistent identifiers for your Raumfeld rooms.
- **Unified Control**: Seamlessly handles the transition between standalone playback and zone-based grouping.
- **WebSocket API**: High-performance communication between the add-on and the integration.
- **Auto-Install Integration**: Automatically installs and updates the HA integration on startup.

## Installation

On first startup the addon will install the Raumfeld integration automatically. If the integration is already installed, the addon will update it to the latest version.

> [!IMPORTANT] > **You need to restart Home Assistant** before you can see the integration in the Home Assistant UI.

## Configuration

| Option                | Default | Description                                     |
| --------------------- | ------- | ----------------------------------------------- |
| `LOG_LEVEL`           | `2`     | Logging verbosity (0-4)                         |
| `PORT`                | `3000`  | WebSocket server port                           |
| `RAUMFELD_HOST`       | `""`    | Optional: Manually specify the Raumfeld host IP |
| `ENABLE_AUTO_INSTALL` | `true`  | Auto-install/update integration on startup      |
| `DEVELOPER_MODE`      | `false` | Always copy integration files on startup        |
