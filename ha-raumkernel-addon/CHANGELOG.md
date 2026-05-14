## 1.2.83

- Fix: detect and recover from a stuck TRANSITIONING state. Previously, if the Raumfeld kernel entered TRANSITIONING (e.g. triggered by the native app or an HA automation) and then got stuck there because TuneIn was throttled and the CDN connection never opened, pressing Play via HA would log "kernel already loading, not interrupting" and do nothing — leaving the room unresponsive until the native app was used. Fix: track `room._transitioningStartTime` on every TRANSITIONING entry. In `play()`, if the kernel has been in TRANSITIONING for more than 30 seconds, force-call `renderer.stop()` (600 ms pause for the STOPPED subscription to arrive), then proceed with the normal Path A / Path B play logic. This means pressing Play on a hung room via HA will always recover within one press, regardless of how long the kernel has been stuck.

## 1.2.82

- Fix: eliminate the last source of unnecessary TuneIn session registrations — the "Poisoned CDN" cleanup. The `loadSingle` approach used since v1.2.80 registers a new TuneIn session at every startup where the kernel is in "poisoned" state (CDN URL + no ebrowse in metadata). Even though this cleanup was the right fix structurally, TuneIn throttles all recent sessions from the same serial, so the cleanup was deepening throttle instead of helping. New approach: at play time, if `_radioAvtMetadata` is empty (no cached ebrowse) but `CurrentTrackURI` is a direct CDN URL, `play()` attempts to reconstruct the ebrowse element directly from the kernel's `AVTransportURIMetaData` `refID` attribute (station ID) and `_tuneInSerial` (the device serial, extracted from the first real ebrowse URL seen in any room's subscription data). This produces complete station metadata with `raumfeld:ebrowse` and `raumfeld:durability` using only information already available from the kernel state, with **no ContentDirectory lookup and no new TuneIn session registration**.
- The `_tuneInSerial` field is now extracted passively from the first ebrowse URL seen in any room's `AVTransportURIMetaData` or `CurrentTrackMetaData` subscription events, making it available by the time the user presses Play.

## 1.2.81

- Fix: strip `<res>` from `AVTransportURIMetaData` before caching in `_radioAvtMetadata`. Previously, when the cleanup `loadSingle` (or a native-app play) produced `AVTransportURIMetaData` with both `raumfeld:ebrowse` and a `<res>` TuneIn relay URL, the metadata was cached as-is. Path A then called `setAvTransportUri(cdnUrl, metaWith<res>)`, which caused the kernel to fetch `<res>` and register yet another new TuneIn session. Registering Session 3 on top of the cleanup's Session 2 caused TuneIn to throttle the 2nd renewal → short-lived CDN token → drop at 312 s. Fix: always strip `<res>` from `AVTransportURIMetaData` before caching, exactly as the `CurrentTrackMetaData` path already did.
- Fix: at cleanup TRANSITIONING, save the fresh CDN URL (`CurrentTrackURI` = Session 2's URL) in `room._cleanupCdnUri`. Path A now prefers this URL over the stale pre-cleanup `CurrentTrackURI`, ensuring the active TuneIn session and the CDN URL used for streaming are always consistent.
- Fix: sync the bundled integration copy (`ha-raumkernel-addon/teufel_raumfeld_raumkernel/`) from `custom_components`, ensuring `integration=` in the startup log matches the addon version.

## 1.2.80

- Fix live radio drops after Play on a "poisoned CDN" state: v1.2.78 called `SetAVTransportURI` with stripped metadata (no `raumfeld:ebrowse`), leaving the kernel's persisted `AVTransportURI` as a plain HTTPS CDN URL with no ebrowse in its stored metadata. On the next restart, `_radioAvtMetadata` stays empty because no ebrowse is found in either `AVTransportURIMetaData` or `CurrentTrackMetaData`; Path A is skipped; bare `Play()` (Path B) falls through; the kernel re-resolves ContentDirectory and registers a new TuneIn session — which is throttled → drops at 102 s / 63 s. Fix: on initial subscription (`prevState === undefined`), if a stopped renderer has a direct HTTPS CDN URL as `AVTransportURI` but no `<raumfeld:ebrowse>` in its metadata, run the same `loadSingle + stop-at-TRANSITIONING` cleanup already used for stale TuneIn relay URLs. This restores the kernel to proper `dlna-playsingle://` state with full ContentDirectory metadata (including ebrowse) before the user presses Play, so Path A works correctly on the next play command.

## 1.2.79

- Fix live radio stream drops at ~511 s after pressing Play: the CDN URL used for BR Schlager and similar stations (`?aggregator=tunein`) is a TuneIn-session-dependent URL — without ebrowse renewal the CDN closes the connection once the initial token expires. v1.2.78 was stripping `raumfeld:ebrowse` and `raumfeld:durability` from the metadata before calling `SetAVTransportURI`, preventing the kernel from renewing. Fix: preserve ebrowse/durability in the metadata so the kernel renews the TuneIn session normally. The `_radioAvtMetadata` cache already has `<res>` stripped (from the stateChanged logic), so the metadata is correct: CDN URL via `CurrentURI`, station-level ebrowse for renewal, no raw TuneIn relay `<res>` URL.

## 1.2.78

- Fix live radio drops after pressing Play on a stopped stream: replace bare `Play()` (Path B) with CDN URL path (Path A) as the primary restart mechanism. Bare `Play()` on a `dlna-playsingle://` AVTransportURI forces the Raumfeld kernel to re-browse ContentDirectory and register a new TuneIn session; TuneIn throttles repeated registrations from the same device serial, causing drops at 82–126 s. Path A sends `SetAVTransportURI` with the CDN URL (retained in `CurrentTrackURI` across PLAYING→STOPPED) and station metadata with `ebrowse`/`durability` stripped, so the kernel streams the CDN URL directly with no TuneIn involvement, no renewal clock, and no throttle risk. Path B (bare `Play()`) is retained as fallback when no CDN URL is available (cold start).

## 1.2.77

- Fix TuneIn throttle from duplicate loadSingle: if the user taps a favorites item a second time within 60 s (e.g. because the HA frontend hadn't yet refreshed to show PLAYING), the second call is silently ignored. Without this guard, two TuneIn session registrations in quick succession trigger throttling and produce drops as short as 7 s.

## 1.2.76

- Fix persistent live radio drops caused by the HA integration calling `SetAVTransportURI` when the user presses Play on a stopped stream (Path C). Each such call registers a new TuneIn session; back-to-back registrations (e.g. Play then `loadSingle` within 30 s) trigger TuneIn throttling, causing drops as short as 37 s. The fix: always use a bare UPnP `Play()` for stopped live streams — identical to the native Raumfeld app — so the kernel reuses its own session context, which handles renewals stably even when durability is deeply negative. Also remove Path D (kernel auto-switch session refresh) for the same reason.

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
