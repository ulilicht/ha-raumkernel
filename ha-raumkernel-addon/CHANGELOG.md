## 1.2.15

- Fix the "Mute" state always showing as unmuted (`mdi:volume-high`), which made the media player's mute button only ever mute (never unmute), since the toggle always assumed the current state was unmuted. The UPnP `Mute` value is reported as the string `"0"`/`"1"`, not a number, so `state.Mute === 1` was always `false`.

## 1.2.14

- Add `selectSource` support for Soundbars and Sounddecks (TV_ARC, OpticalIn).
- Add Line-in switching for devices that don't support `Source Select` but have a physical Line-in input (e.g. Stereo M/L/R speakers).
- Add a separate "Eco mode" button per room, which puts the device into automatic standby (`EnterAutomaticStandby`) without affecting the existing "Off" button (`EnterManualStandby`).
- Add two new sensor entities per room: "Power status" (`Off` / `On` / `ECO mode`) and "Input" (current source: Streaming, Line-in, Optical, TV, Spotify, Radio).
- Track and broadcast the current "Source Select" value for soundbars/sounddecks, with periodic refresh to detect external changes (e.g. TV auto-switching to ARC).

Credits to contributor Simanias

## 1.2.13

- Fix track images which are hosted on Raumfeld devices (e.g. Local music, Tidal) not showing up.
- Add information/debug page to the addon (reachable at the default port).

## 1.2.12

- Added a setting to manually set the Raumfeld host address if auto discovery fails.

## 1.2.11

- Add support for media_content_id. It is now possible to see which media is currently playing.

## 1.2.10

- Fixes a crash if homeassistant sends a "prev" command even if prev is not allowed
- Fix issues with seek.

## 1.2.9

- Automatic install of integration

## 1.2.7

- Add Seek
- Improved Zone Handling
- Reboot Devices

## 1.2.2

- Add reboot feature to restart Raumfeld devices via SSH

## 1.0.0

- Initial release
