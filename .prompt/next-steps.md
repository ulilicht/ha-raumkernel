# Next Steps: Music Assistant Compatibility

This document summarizes the findings regarding missing features for better compatibility with Music Assistant and the plan for implementation.

## Missing Features Identified

1.  **Seek (`MediaPlayerEntityFeature.SEEK`)**
    *   Essential for precise playback control in Music Assistant.
2.  **Grouping (`MediaPlayerEntityFeature.GROUPING`)**
    *   Allows native Raumfeld synchronization via `async_join_players` and `async_unjoin_player`.
3.  **Shuffle & Repeat (`MediaPlayerEntityFeature.SHUFFLE_SET`, `MediaPlayerEntityFeature.REPEAT_SET`)**
    *   Standard transport controls expected by Music Assistant.

## Feasibility Analysis

All features are natively supported by the underlying `node-raumkernel` library and require exposure through the Add-on and Integration.

### 1. Seek
- **Add-on**: `UPNPMediaRenderer.seek(_unit, _target)` exists. Need to expose in `RaumkernelHelper.js`.
- **Integration**: Add `SEEK` feature and implement `async_media_seek`.

### 2. Grouping
- **Add-on**: `ZoneManager.connectRoomToZone(_roomUdn, _zoneUdn)` and `dropRoomFromZone(_roomUdn)` exist.
- **Integration**: Add `GROUPING` feature and implement `async_join_players` / `async_unjoin_player`.

### 3. Shuffle & Repeat
- **Add-on**: `UPNPMediaRenderer.setPlayMode(_playMode)` exists.
- **Integration**: Add features and implement `async_set_repeat` / `async_set_shuffle_mode`.

## Implementation Strategy

1.  **Update Add-on (`ha-raumkernel-addon`)**:
    - Modify `RaumkernelHelper.js` to expose `seek`, `joinZone`, `leaveZone`, and `setPlayMode`.
    - Update `index.js` (WebSocket server) to handle new command types.
2.  **Update Integration (`custom_components/teufel_raumfeld_raumkernel`)**:
    - Update `api.py` to include new WebSocket commands.
    - Update `media_player.py` to support the new features and call the API.
3.  **Verification**:
    - Run `./deploy_remote.sh` after changes.
    - Verify features in Home Assistant UI and Music Assistant.
