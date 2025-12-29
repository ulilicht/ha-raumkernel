# GEMINI Instructions

## Context

This project controls Teufel Raumfeld devices via Home Assistant. It consists of:

1.  **Add-on**: `ha-raumkernel-addon` (Node.js/TypeScript) which wraps `node-raumkernel`.
2.  **Integration**: `custom_components/teufel_raumfeld_raumkernel` (Python) which communicates with the Add-on.

## Development Workflow

### 1. Deployment causes Remote Changes

**ALWAYS** deploy changes after editing code to verify them.

**Command:**

```bash
./deploy_remote.sh
```

_This script syncs files, automatically rebuilds/restarts the Add-on, and determines if a full Core restart is needed._

### 2. File Structure

- **Add-on Logic**: `/ha-raumkernel-addon/rootfs/app/` (Node.js code)
- **Integration Logic**: `/custom_components/teufel_raumfeld_raumkernel/` (Python code)
- **Example code**: `.prompt/example-code/` (Example code which must not be changed. It is there to add context for an AI coding assistant if it needs to understand more about how to steer raumfeld devices.) example-code must not be modified.

## Coding Guidelines

- **Add-on**: Use ES Modules (`import`/`export`). The entry point is `index.js`.
- **Logging**:
  - Add-on: `console.log()` (view with `ha addons logs local_ha-raumkernel-addon`)
  - Integration: `_LOGGER.debug()` (view in HA logs)

## Room & Zone Behavior

### Architecture: Room-Based Entities

This integration uses a **Room-Based Grouping** strategy.

- **Stable Identifiers**: Each physical Raumfeld device (Room Renderer) has a stable UDN. Home Assistant entities are created based on these stable Room UDNs.
- **Virtual Zones**: When rooms are grouped, a "Virtual Renderer" (Zone) is created by the Raumfeld system. Its UDN is dynamic and changes whenever grouping or playback modes (e.g., Spotify vs TuneIn) change.
- **Abstraction Layer**: The Add-on handles this complexity. It tracks which Room belongs to which Zone and routes commands (Play/Pause/Next/etc.) to the correct renderer.
  - If a room is in a group, commands are sent to the **Zone's Virtual Renderer**.
  - If a room is standalone, commands are sent to the **Room's Virtual Renderer** (standard playback) or the physical renderer (if applicable).

### CRITICAL: Room UDN vs Renderer UDN

**The Raumfeld system has two distinct types of UDNs:**

1. **Renderer UDN** - The physical speaker hardware identifier (e.g., `uuid:846851e1-0ad8-4664-b38a-5656ef1fb4ee`)
2. **Room UDN** - The logical room identifier in the zone configuration (e.g., `uuid:12345678-abcd-...`)

**These are NOT the same!** The physical renderer object has a `roomUdn()` method that returns the actual Room UDN.

**Why this matters:**

- `deviceManager.mediaRenderers` is a Map keyed by **Renderer UDN**
- `zoneManager.connectRoomToZone(roomUDN, zoneUDN)` expects a **Room UDN**, not a Renderer UDN
- `zoneManager.getZoneUDNFromRoomUDN(roomUDN)` expects a **Room UDN**
- The `zoneMap` stores rooms by their **Room UDN**

**Common Bug:** Passing a Renderer UDN to `connectRoomToZone` will fail silently - the device won't transition from Spotify to UPnP mode because the Raumfeld host doesn't recognize the UDN.

**Solution:** Always call `renderer.roomUdn()` to get the actual Room UDN when building the room registry or calling zone management functions.

## Documentation

Documentation for node-raumkernel can be found in this folder: .prompt/node-raumkernel-wiki, especially:

- .prompt/node-raumkernel-wiki/Data-&-Methods.md
- .prompt/node-raumkernel-wiki/Events.md
- .prompt/node-raumkernel-wiki/Raumfeld-Concepts.md
