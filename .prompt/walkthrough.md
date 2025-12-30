# Media Browsing Verification

## Features Added

- **Media Browsing**: Browse Favorites, Radio, and Line In via Home Assistant Media Browser.
- **Play Container**: Play full albums, playlists, or radio stations from the browser.
- **Play Single**: Play individual tracks.
- **Play URL**: Support for playing raw URLs via `play_media` service.

## Verification Steps

### 1. Media Browser

1. Open Home Assistant.
2. Click **Media** in the sidebar.
3. Select the **Raumfeld** card (if visible) or select a Raumfeld entity from the bottom player.
4. Verify you see the root menu (e.g., "My Music", "TuneIn", "Line In").
5. Drill down into "TuneIn" > "Favorites" or "My Music".

### 2. Playback from Browser

1. In the Media Browser, click on a Radio Station or an Album.
2. Verify playback starts on the selected room/zone.
3. Verify Metadata (Title, Artist, Art) updates in the player.

### 3. Play URL via Service

1. Go to **Developer Tools** > **Services**.
2. Select `media_player.play_media`.
3. Target a Raumfeld entity.
4. Set Content ID: `https://files.testfile.org/AUDIO/C/M4A/sample2.m4a` (or any valid audio URL).
5. Set Content Type: `url` (or `music`).
6. Click **Call Service**.
7. Verify the audio plays.
