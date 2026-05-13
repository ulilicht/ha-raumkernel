## 1.2.75

- Fix live radio stream drops at :02 past the minute: the root cause was that Path A (SetAVTransportURI with CDN URL) skipped the ContentDirectory lookup that fetches the TuneIn `<res>` session URL. Without that fetch, TuneIn has no record of a new session and kills renewal calls after 1–2 cycles. Replace Path A with Path C: always use the `dlna-playsingle://` URI (identical to what the native Raumfeld app does), which causes the kernel to fetch ContentDirectory → `<res>` URL → fresh TuneIn session registration → stable renewals indefinitely. Cache the dlna-playsingle:// URI so it remains available even if a previous run had corrupted AVTransportURI to a CDN URL.

## 1.2.74

- Fix live radio streams dropping at :02 past the minute after pressing Play via HA: Path A (CDN URL restart) was passing `<raumfeld:ebrowse>` and `<raumfeld:durability>` in the metadata, causing the kernel to schedule periodic TuneIn session renewal calls. TuneIn rate-limits those calls and tears down the stream. Strip both elements before calling `SetAVTransportURI` so the kernel streams the permanent CDN URL as a plain HTTP stream with no renewal cycle.

## 1.2.73

- Fix spurious "Previous" button on live radio streams: instead of routing play through `dlna-playsingle://` (which re-introduces TuneIn session renewal and drops at :02 past the minute), suppress `canPlayPrev` for any live stream directly in state extraction. The stable CDN URL path (Path A) is now the only live-stream restart path.

## 1.2.71

- Fix spurious "Previous" button appearing in HA media player when play is triggered via the integration after the native app had loaded a station via dlna-playsingle://

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
