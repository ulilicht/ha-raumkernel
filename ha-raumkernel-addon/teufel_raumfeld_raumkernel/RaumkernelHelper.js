/**
 * RaumkernelHelper - Manages Raumfeld devices for Home Assistant integration
 * 
 * ARCHITECTURE OVERVIEW:
 * ---------------------
 * The Raumfeld system uses several types of identifiers that are easy to confuse:
 * 
 * 1. RENDERER UDN (rendererUdn)
 *    - Physical device hardware identifier
 *    - Example: uuid:846851e1-0ad8-4664-b38a-5656ef1fb4ee
 *    - Used to: Look up MediaRenderer objects, match against getRoomRendererUDNs()
 * 
 * 2. ROOM UDN (roomUdn)  
 *    - Logical room identifier
 *    - Example: uuid:a5f7900f-3d53-47c9-a6f1-3e9440461036
 *    - Used to: Identify entities in Home Assistant, zone management operations
 * 
 * 3. ZONE UDN (zoneUdn)
 *    - Virtual renderer identifier (dynamic, changes with zone composition)
 *    - Example: uuid:d673d7dc-b412-4405-94d8-b811ca3ee775
 *    - Used to: Control grouped playback via MediaRendererVirtual
 * 
 * CRITICAL: These are NOT interchangeable!
 * - zoneManager.connectRoomToZone() expects a ROOM UDN
 * - renderer.getRoomRendererUDNs() returns RENDERER UDNs
 * - deviceManager.mediaRenderers is keyed by RENDERER UDN
 * - deviceManager.mediaRenderersVirtual is keyed by ZONE UDN
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { JSDOM } from 'jsdom';
import * as RaumkernelLib from 'node-raumkernel';

// ============================================================================
// TYPE DEFINITIONS (JSDoc for IDE support)
// ============================================================================

/**
 * @typedef {Object} RoomInfo
 * @property {string} name - Display name of the room
 * @property {string} roomUdn - Logical room identifier for zone operations
 * @property {string} rendererUdn - Physical device identifier
 * @property {string|null} zoneUdn - Current zone this room belongs to
 * @property {string[]} zoneMembers - UDNs of other rooms in the same zone
 * @property {string|null} zoneName - Display name of the current zone
 */

/**
 * @typedef {Object} NowPlayingState
 * @property {string} artist - Current artist name
 * @property {string} track - Current track title
 * @property {string} image - Album art URL (https)
 * @property {boolean} isPlaying - Whether playback is active
 * @property {boolean} isLoading - Whether transitioning between tracks
 * @property {boolean} isMuted - Whether audio is muted
 * @property {number} volume - Volume level (0-100)
 * @property {boolean} canPlayPause - Whether play/pause is available
 * @property {boolean} canPlayNext - Whether next track is available
 * @property {boolean} canPlayPrev - Whether previous track is available
 * @property {string} duration - Track duration
 * @property {string} position - Current playback position
 */

/**
 * @typedef {Object} RoomState
 * @property {string} name - Room display name
 * @property {string} udn - Room UDN (stable identifier)
 * @property {string} roomUdn - Same as udn (for compatibility)
 * @property {string} rendererUdn - Physical renderer UDN
 * @property {boolean} isZone - Always false (we expose rooms, not zones)
 * @property {string|null} zoneUdn - Current zone UDN if grouped
 * @property {string|null} zoneName - Zone display name if grouped
 * @property {string[]} zoneMembers - Room UDNs of zone members
 * @property {boolean} isPlaying - Whether room is playing
 * @property {NowPlayingState} nowPlaying - Current playback state
 */

/**
 * @typedef {Object} MediaMetadata
 * @property {string} track - Track title
 * @property {string} artist - Artist name
 * @property {string} album - Album name
 * @property {string} image - Album art URL
 * @property {string} classString - UPnP object class
 */

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================

const LOG_PREFIX = {
    REGISTRY: '[Registry]',
    RENDERER: '[Renderer]',
    COMMAND: '[Command]',
    MEDIA: '[Media]',
    BROWSE: '[Browse]'
};

// Path to the on-disk cache that maps CDN stream URL → TuneIn DIDL-Lite metadata.
// Survives add-on restarts; used to warm the metadata cache on cold starts where
// the renderer was left with External/corrupt metadata by a previous run.
const CDN_META_CACHE_FILE  = '/data/radio_metadata_cache.json';
const BROWSE_CACHE_FILE    = '/data/browse_cache.json';
const TUNEIN_SERIAL_FILE   = '/data/tunein_serial.json';

// ============================================================================
// MAIN CLASS
// ============================================================================

class RaumkernelHelper {
    constructor() {
        /** @type {RaumkernelLib.Raumkernel} */
        this.raumkernel = new RaumkernelLib.Raumkernel();

        // Configure manual host if set
        if (process.env.RAUMFELD_HOST && process.env.RAUMFELD_HOST.trim() !== '') {
            this.raumkernel.settings.raumfeldHost = process.env.RAUMFELD_HOST.trim();
            console.log(`[RK] [INFO] Using configured Raumfeld Host: ${this.raumkernel.settings.raumfeldHost}`);
        }
        
        /** @type {Map<string, RoomInfo>} Room registry keyed by RENDERER UDN */
        this._rooms = new Map();
        
        /** @type {{isReady: boolean, availableRooms: RoomState[], favourites: []}} */
        this._state = {
            isReady: false,
            availableRooms: [],
            favourites: []
        };

        /** @type {Object.<string, string>} CDN URL → TuneIn DIDL-Lite metadata (persisted) */
        this._cdnMetaCache = {};
        this._loadCdnMetaCache();

        /** @type {string|null} TuneIn device serial extracted from the first ebrowse URL seen.
         *  Used to reconstruct ebrowse metadata without fetching ContentDirectory. */
        this._tuneInSerial = null;
        this._loadTuneInSerial();

        /**
         * Browse result cache: objectId → Array of parsed items.
         * Populated on first Browse call and served from cache on all subsequent
         * requests to prevent repeated ContentDirectory Browse calls to the
         * Raumfeld kernel.  Each Browse triggers kernel-side ebrowse calls for
         * every TuneIn radio station in the container, which can invalidate an
         * active TuneIn session and stop a playing stream.
         * Cache is cleared on integration restart; call clearBrowseCache() to
         * force a refresh on the next Browse request.
         * @type {Map<string, Array>}
         */
        this._browseCache = new Map();

        // Load browse cache from disk so the very first Browse request after a
        // restart is served from cache without hitting the kernel.
        // (Hitting the kernel triggers ebrowse for all TuneIn stations in the
        // container, which can throttle TuneIn sessions and cause stream drops.)
        try {
            if (existsSync(BROWSE_CACHE_FILE)) {
                const data = JSON.parse(readFileSync(BROWSE_CACHE_FILE, 'utf8'));
                let loaded = 0;
                for (const [objectId, items] of Object.entries(data)) {
                    if (Array.isArray(items)) { this._browseCache.set(objectId, items); loaded++; }
                }
                if (loaded > 0) {
                    console.log(`[Browse] Loaded ${loaded} container(s) from disk cache`);
                }
            }
        } catch (err) {
            console.warn(`[Browse] Failed to load browse cache from disk: ${err.message}`);
        }

        this._setupLogging();
        this._setupEventHandlers();
        this.raumkernel.init();

        // Disable MediaListManager background content browsing.
        //
        // The MediaListManager's loadMediaItemListsByContainerUpdateIds is called
        // every time the Raumfeld MediaServer fires a ContentDirectory NOTIFY (which
        // happens roughly every 60 seconds as TuneIn streams update their now-playing
        // song metadata).  For each non-zone container ID in the NOTIFY payload it
        // issues a SOAP Browse to the MediaServer — e.g. "0/Favorites/MostPlayed" —
        // which is completely unnecessary: the integration gets all the metadata it
        // needs (title, artwork, station info) directly from AVTransport NOTIFY events
        // via CurrentTrackMetaData / AVTransportURIMetaData.
        //
        // These background Browse requests add load to the Raumfeld MediaServer and
        // are the root cause of stream drops: the MediaServer processes the Browse
        // by internally resolving TuneIn station URLs, consuming TuneIn serial-session
        // slots that the kernel needs for its own ebrowse renewal calls.
        //
        // Fix: replace the method with a no-op so the integration stays a pure
        // event listener and never triggers unsolicited MediaServer Browse calls.
        const mlm = this.raumkernel.managerDisposer?.mediaListManager;
        if (mlm && typeof mlm.loadMediaItemListsByContainerUpdateIds === 'function') {
            mlm.loadMediaItemListsByContainerUpdateIds = () => {};
            console.log(`${LOG_PREFIX.REGISTRY} MediaListManager background browsing disabled (pure event-listener mode)`);
        }
    }

    // ========================================================================
    // CDN METADATA CACHE (persistent across restarts)
    // ========================================================================

    /** Load the on-disk CDN URL → TuneIn metadata map into memory. */
    _loadCdnMetaCache() {
        try {
            if (existsSync(CDN_META_CACHE_FILE)) {
                const data = JSON.parse(readFileSync(CDN_META_CACHE_FILE, 'utf8'));
                if (data && typeof data === 'object') {
                    this._cdnMetaCache = data;
                    const n = Object.keys(data).length;
                    console.log(`${LOG_PREFIX.REGISTRY} CDN metadata cache loaded (${n} station(s))`);
                }
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX.REGISTRY} CDN metadata cache load failed: ${err.message}`);
            this._cdnMetaCache = {};
        }
    }

    /**
     * Persist a CDN URL → TuneIn metadata mapping.
     * Write is skipped when the TuneIn station ID hasn't changed (avoids a disk
     * write on every song-title metadata update for an already-cached station).
     *
     * @param {string} cdnUrl    - Direct HTTPS CDN stream URL (cache key)
     * @param {string} metadata  - DIDL-Lite string containing <raumfeld:ebrowse>
     */
    _saveCdnMetaCacheEntry(cdnUrl, metadata) {
        if (!cdnUrl || !metadata) return;
        const sid = (m) => m.match(/[?&]id=(s\d+)[&"]/)?.[1] ?? null;
        if (sid(metadata) === sid(this._cdnMetaCache[cdnUrl] ?? '')) return;
        this._cdnMetaCache[cdnUrl] = metadata;
        try {
            writeFileSync(CDN_META_CACHE_FILE, JSON.stringify(this._cdnMetaCache, null, 2), 'utf8');
        } catch (err) {
            console.warn(`${LOG_PREFIX.REGISTRY} CDN metadata cache write failed: ${err.message}`);
        }
    }

    /** Load the TuneIn device serial from disk into memory. */
    _loadTuneInSerial() {
        try {
            if (existsSync(TUNEIN_SERIAL_FILE)) {
                const data = JSON.parse(readFileSync(TUNEIN_SERIAL_FILE, 'utf8'));
                if (data?.serial) {
                    this._tuneInSerial = data.serial;
                    console.log(`${LOG_PREFIX.REGISTRY} TuneIn serial loaded from disk: ${this._tuneInSerial}`);
                }
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX.REGISTRY} TuneIn serial load failed: ${err.message}`);
        }
    }

    /** Persist the TuneIn device serial to disk so it survives add-on restarts. */
    _saveTuneInSerial() {
        if (!this._tuneInSerial) return;
        try {
            writeFileSync(TUNEIN_SERIAL_FILE, JSON.stringify({ serial: this._tuneInSerial }, null, 2), 'utf8');
        } catch (err) {
            console.warn(`${LOG_PREFIX.REGISTRY} TuneIn serial save failed: ${err.message}`);
        }
    }

    /**
     * Attempt to inject raumfeld:ebrowse + raumfeld:durability into DIDL-Lite
     * metadata that has a station refID but no ebrowse.
     *
     * Station ID is extracted from the refID attribute.
     * Device serial comes from _tuneInSerial (persisted to disk across restarts
     * and populated from the first real ebrowse URL seen in any room's state).
     *
     * Returns the enriched DIDL-Lite string, or null if data is insufficient.
     */
    _tryInjectEbrowse(existingDidl) {
        if (!existingDidl || !existingDidl.includes('</item>')) {
            console.log(`${LOG_PREFIX.COMMAND} _tryInjectEbrowse: skip — no DIDL or no </item> (len=${existingDidl?.length ?? 0})`);
            return null;
        }
        if (!this._tuneInSerial) {
            console.log(`${LOG_PREFIX.COMMAND} _tryInjectEbrowse: skip — _tuneInSerial not yet populated`);
            return null;
        }
        const stMatch = existingDidl.match(/\brefID="[^"]*\/s-(s\d+)"/);
        if (!stMatch) {
            const snippet = existingDidl.replace(/\s+/g, ' ').substring(0, 200);
            console.log(`${LOG_PREFIX.COMMAND} _tryInjectEbrowse: skip — no refID match in: ${snippet}`);
            return null;
        }
        const stationId  = stMatch[1];
        const encSerial  = encodeURIComponent(this._tuneInSerial);
        const ebrowseUrl =
            `http://opml.radiotime.com/Tune.ashx` +
            `?partnerId=7aJ9pvV5` +
            `&amp;formats=mp3%2Cogg%2Caac%2Chls` +
            `&amp;serial=${encSerial}` +
            `&amp;id=${stationId}` +
            `&amp;c=ebrowse`;
        return existingDidl.replace('</item>',
            `<raumfeld:durability>120</raumfeld:durability>` +
            `<raumfeld:ebrowse>${ebrowseUrl}</raumfeld:ebrowse>` +
            `</item>`);
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    _setupLogging() {
        const logLevel = process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 2;
        this.raumkernel.createLogger(logLevel);
        
        const logPrefixes = ['ERROR', 'WARN ', 'INFO ', 'VERB ', 'DEBUG', 'SILLY'];
        this.raumkernel.logger.on('log', (data) => {
            const prefix = logPrefixes[data.logType] || `LVL${data.logType}`;
            console.log(`[RK] [${prefix}] ${data.log}`);
        });
    }

    _setupEventHandlers() {
        this.raumkernel.on('systemReady', (ready) => {
            console.log(`${LOG_PREFIX.REGISTRY} System ready: ${ready}`);
            this._state.isReady = ready;
            if (ready) {
                // If we have a fixed host, we might want to log it
                if (this.raumkernel.getSettings().raumfeldHost !== "0.0.0.0") {
                     console.log(`${LOG_PREFIX.REGISTRY} Connected to fixed host: ${this.raumkernel.getSettings().raumfeldHost}`);
                }
                // Share the discovered kernel host with tunein-patch.cjs so the
                // physical-renderer SUBSCRIBE suppression can use the real IP
                // rather than the static default (useful for non-standard subnets).
                const dm = this.raumkernel.managerDisposer?.deviceManager;
                if (dm?.host && dm.host !== global._raumfeldKernelHost) {
                    global._raumfeldKernelHost = dm.host;
                    console.log(`${LOG_PREFIX.REGISTRY} Kernel host confirmed: ${dm.host}`);
                }
                this._refreshRoomRegistry();
                
                // Populate active physical host allowlist for tunein-patch.cjs.
                // The zone configuration is already parsed by the time systemReady
                // fires (it fires one tick after zoneConfigurationChanged).
                // Setting global._raumfeldActivePhysicalHosts unblocks the polling
                // loop in physicalSubscribeProxy so deferred SUBSCRIBEs can complete.
                const zoneManager = this._getZoneManager();
                if (zoneManager) {
                    if (zoneManager.zoneConfiguration) {
                        this._updateSubscriptionFilter(zoneManager.zoneConfiguration);
                    }
                    // Keep the allowlist current if rooms are powered on/off later
                    zoneManager.on('zoneConfigurationChanged', (newConfig) => {
                        this._updateSubscriptionFilter(newConfig);
                    });
                }

                // Populate MediaServer port set for tunein-patch.cjs ContentDirectory
                // SUBSCRIBE suppression.  The port is dynamic (assigned by the kernel
                // on each boot), so it must be resolved at runtime and stored before
                // the ContentDirectory SUBSCRIBE HTTP request fires (which happens
                // asynchronously, after the OS binds the eventing server socket).
                this._updateMediaServerPorts(dm);

                // Process initial zone state
                if (zoneManager && zoneManager.zoneState) {
                    console.log(`${LOG_PREFIX.REGISTRY} Processing initial zone state`);
                    this._handleZoneStateChange(zoneManager.zoneState);
                }
            }
        });

        this.raumkernel.on('systemHostLost', () => {
            console.log(`${LOG_PREFIX.REGISTRY} System host lost`);
            this._resetState();
        });

        this.raumkernel.on('combinedZoneStateChanged', (data) => {
            this._handleZoneStateChange(data);
        });

        this.raumkernel.on('rendererStateChanged', () => {
            // Defer processing to the next event-loop tick so that the NOTIFY
            // acknowledgment (200 OK from our HTTP server) can be sent immediately
            // rather than blocking for ~50 ms while _broadcastRoomStates() runs
            // synchronously.  The Raumfeld kernel waits for our ACK before it can
            // proceed with the next operation — including issuing the outbound
            // TuneIn ebrowse HTTP call for session renewal.  When we're slow (e.g.
            // during the 38-request burst after a UPnP device-list rediscovery),
            // the kernel stalls and misses the 120-second renewal window → STOPPED.
            //
            // Deduplication: if multiple events arrive before the deferred call runs
            // (burst during device rediscovery), only one _broadcastRoomStates()
            // executes — the final one after all events have settled.
            if (this._broadcastScheduled) return;
            this._broadcastScheduled = true;
            setImmediate(() => {
                this._broadcastScheduled = false;
                this._broadcastRoomStates();
            });
        });

    }

    _resetState() {
        for (const room of this._rooms.values()) {
            this._clearSuppressInterval(room);
        }
        this._state = { isReady: false, availableRooms: [], favourites: [] };
        this._rooms.clear();
    }

    // ========================================================================
    // PUBLIC API - State Access
    // ========================================================================

    /**
     * Returns the current state for broadcasting to clients
     */
    getState() {
        return this._state;
    }

    // ========================================================================
    // ROOM REGISTRY MANAGEMENT
    // ========================================================================

    /**
     * Refreshes the room registry from current device state.
     * Called on system ready and when devices change.
     */
    _refreshRoomRegistry() {
        const deviceManager = this._getDeviceManager();
        if (!deviceManager) return;

        for (const [rendererUdn, renderer] of deviceManager.mediaRenderers) {
            if (this._rooms.has(rendererUdn)) continue;

            const roomInfo = this._createRoomInfo(rendererUdn, renderer);
            
            // Skip rooms with empty name or roomUdn - this happens when the device
            // is discovered before the zone configuration is available from the host.
            // The room will be added on subsequent updates when metadata is populated.
            if (!roomInfo.name || !roomInfo.roomUdn) {
                console.log(`${LOG_PREFIX.REGISTRY} Skipping renderer ${rendererUdn}: ` +
                    `incomplete metadata (name: "${roomInfo.name}", roomUdn: "${roomInfo.roomUdn}")`);
                continue;
            }
            
            this._rooms.set(rendererUdn, roomInfo);
            
            console.log(`${LOG_PREFIX.REGISTRY} Added: ${roomInfo.name} ` +
                `(room: ${roomInfo.roomUdn}, renderer: ${roomInfo.rendererUdn})`);
        }

        this._broadcastRoomStates();
    }

    /**
     * Creates a RoomInfo object from a renderer
     * @param {string} rendererUdn 
     * @param {*} renderer 
     * @returns {RoomInfo}
     */
    _createRoomInfo(rendererUdn, renderer) {
        const name = renderer.roomName?.() ?? renderer.name?.() ?? 'Unknown Room';
        const roomUdn = renderer.roomUdn?.() ?? rendererUdn;

        return {
            name,
            roomUdn,
            rendererUdn,
            zoneUdn: null,
            zoneMembers: [roomUdn],
            zoneName: null
        };
    }

    /**
     * Updates zone mappings when zone state changes
     * @param {*} combinedStateData 
     */
    _handleZoneStateChange(combinedStateData) {
        const state = JSON.parse(JSON.stringify(combinedStateData));
        
        this._refreshRoomRegistry();
        this._updateZoneMappings(state);
        this._broadcastRoomStates();
    }

    /**
     * Maps rooms to their current zones based on combined zone state
     * @param {{zones: Array}} combinedState 
     */
    _updateZoneMappings(combinedState) {
        if (!combinedState?.zones) return;

        // Reset all zone mappings
        for (const room of this._rooms.values()) {
            room.zoneUdn = null;
            room.zoneMembers = [room.roomUdn];
            room.zoneName = null;
        }

        // Apply zone mappings from state
        for (const zone of combinedState.zones) {
            // Log zone details for debugging
            // console.log(`${LOG_PREFIX.REGISTRY} Processing zone: ${zone.udn} (isZone: ${zone.isZone}, name: ${zone.name})`);
            
            if (!zone.isZone) continue;

            const memberUdns = zone.rooms?.map(r => r.udn) ?? [];
            // console.log(`${LOG_PREFIX.REGISTRY} Zone ${zone.name} (${zone.udn}) has members: ${memberUdns.join(', ')}`);
            
            for (const memberUdn of memberUdns) {
                const room = this._findRoomByAnyUdn(memberUdn);
                if (room) {
                    room.zoneUdn = zone.udn;
                    room.zoneMembers = memberUdns;
                    room.zoneName = zone.name;
                    // console.log(`${LOG_PREFIX.REGISTRY} Mapped room ${room.name} to zone ${zone.name}`);
                } else {
                    console.warn(`${LOG_PREFIX.REGISTRY} Could not find room for member UDN: ${memberUdn}`);
                }
            }
        }
    }

    /**
     * Builds and publishes the room state array
     */
    _broadcastRoomStates() {
        const rooms = [];

        for (const room of this._rooms.values()) {
            const nowPlaying = this._getNowPlayingForRoom(room);
            
            rooms.push({
                name: room.name,
                udn: room.roomUdn,
                roomUdn: room.roomUdn,
                rendererUdn: room.rendererUdn,
                isZone: false,
                zoneUdn: room.zoneUdn,
                currentZoneUdn: room.zoneUdn, // Alias for compatibility
                zoneName: room.zoneName,
                zoneMembers: room.zoneMembers,
                isPlaying: nowPlaying.isPlaying,
                nowPlaying
            });
        }

        rooms.sort((a, b) => a.name.localeCompare(b.name));
        this._state.availableRooms = rooms;

        // Second-pass cross-room CDN cache restoration.
        //
        // Rooms processed early in the loop above may have had _radioAvtMetadata=null
        // at that point even though a later-processed room (e.g. Kati, with a native
        // dlna-playsingle:// AVTransportURI) contributed ebrowse DIDL to _cdnMetaCache
        // for the same CDN URL.  This second pass restores _radioAvtMetadata for any
        // room that still lacks it, benefiting from the now-complete in-memory cache.
        for (const room of this._rooms.values()) {
            if (!room._radioAvtMetadata && room._lastSeenCdnUri) {
                const cached = this._cdnMetaCache[room._lastSeenCdnUri];
                if (cached) {
                    room._radioAvtMetadata = cached;
                    console.log(
                        `${LOG_PREFIX.REGISTRY} ${room.name}: cross-room TuneIn metadata` +
                        ` restored for ${room._lastSeenCdnUri}`
                    );
                }
            }
        }
    }

    // ========================================================================
    // ROOM LOOKUP
    // ========================================================================

    /**
     * Finds a room by UDN or name.
     * Always returns the RICH room object from this._rooms (which carries
     * persistent per-room state like position tracker fields).  The plain
     * objects in _state.availableRooms are rebuilt on every broadcast and
     * must NOT be used as the target for any mutable state.
     * @param {string} identifier - Room UDN, zone UDN, or partial name
     * @returns {RoomInfo|undefined}
     */
    findRoom(identifier) {
        if (!identifier) return undefined;

        // Try renderer UDN (registry key)
        if (this._rooms.has(identifier)) return this._rooms.get(identifier);

        // Try room UDN or zone UDN
        for (const room of this._rooms.values()) {
            if (room.roomUdn === identifier || room.zoneUdn === identifier) return room;
        }

        // Try partial name match (only if unambiguous)
        if (identifier.length > 2) {
            const lc = identifier.toLowerCase();
            const matches = [...this._rooms.values()].filter(r =>
                r.name.toLowerCase().includes(lc)
            );
            if (matches.length === 1) return matches[0];
        }

        return undefined;
    }

    /**
     * Finds a room in the registry by any UDN type
     * @param {string} udn
     * @returns {RoomInfo|undefined}
     */
    _findRoomByAnyUdn(udn) {
        // Try renderer UDN (registry key)
        if (this._rooms.has(udn)) return this._rooms.get(udn);

        // Try room UDN or zone UDN
        for (const room of this._rooms.values()) {
            if (room.roomUdn === udn || room.zoneUdn === udn) return room;
        }

        return undefined;
    }

    // ========================================================================
    // RENDERER RESOLUTION
    // ========================================================================

    /**
     * Gets the best renderer for controlling a room.
     * Priority: Zone renderer > Virtual renderer by match > Physical renderer
     * @param {RoomState} room 
     * @returns {*} MediaRenderer or MediaRendererVirtual
     */
    _getRendererForRoom(room) {
        if (!room) return null;

        const deviceManager = this._getDeviceManager();
        const zoneManager = this._getZoneManager();
        if (!deviceManager) return null;

        // Strategy 1: Try live zone lookup
        let zoneUdn = zoneManager?.getZoneUDNFromRoomUDN(room.roomUdn) ?? null;

        // Strategy 2: Fall back to cached zone
        if (!zoneUdn && room.zoneUdn) {
            zoneUdn = room.zoneUdn;
        }

        // Strategy 3: Try direct zone renderer lookup
        if (zoneUdn) {
            const zoneRenderer = deviceManager.mediaRenderersVirtual.get(zoneUdn);
            if (zoneRenderer) return zoneRenderer;
        }

        // Strategy 4: Search virtual renderers by renderer UDN
        for (const [, renderer] of deviceManager.mediaRenderersVirtual) {
            const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
            if (room.rendererUdn && memberUdns.includes(room.rendererUdn)) {
                return renderer;
            }
        }

        // Strategy 5: Fall back to physical renderer (limited functionality)
        return deviceManager.mediaRenderers.get(room.rendererUdn);
    }

    /**
     * Clears any residual suppress interval state on a room.
     * Kept for compatibility; the suppress interval was removed in v1.2.60.
     */
    _clearSuppressInterval(room) {
        if (!room) return;
        if (room._suppressRestartInterval) {
            clearInterval(room._suppressRestartInterval);
            room._suppressRestartInterval = undefined;
        }
        room._suppressRestartUntil = undefined;
    }

    /**
     * Strip TuneIn session-management fields from DIDL-Lite metadata XML.
     *
     * When streaming from a permanent CDN URL the <raumfeld:ebrowse> and
     * <raumfeld:durability> elements must NOT be sent to the kernel.  If they
     * are present the kernel schedules periodic ebrowse renewal calls; TuneIn
     * rate-limits those calls and eventually returns a zero-durability response
     * that causes the kernel to tear down the stream (the :02-past-the-minute
     * drop pattern).  The CDN URL itself never expires, so no renewal is needed.
     *
     * @param {string} metaXml - DIDL-Lite XML string
     * @returns {string} XML with ebrowse / durability elements removed
     */
    _stripEbrowse(metaXml) {
        return metaXml
            .replace(/<raumfeld:durability>[^<]*<\/raumfeld:durability>/g, '')
            .replace(/<raumfeld:ebrowse>[^<]*<\/raumfeld:ebrowse>/g, '');
    }

    /**
     * Strips ALL TuneIn / RadioTime session-management markers from DIDL-Lite
     * metadata so the Raumfeld kernel treats the CDN URL as a standalone audio
     * stream — no ContentDirectory lookup, no ebrowse scheduling, no TuneIn
     * rate-limit exposure.
     *
     * Beyond the ebrowse/durability fields removed by _stripEbrowse(), this
     * also removes:
     *   • refID attribute — the kernel follows this to look up the station's
     *     ContentDirectory entry, which contains the ebrowse URL; removing it
     *     severs that path.
     *   • raumfeld:section="RadioTime" — signals the kernel that this is a
     *     TuneIn station managed by the RadioTime ContentDirectory; removing
     *     it stops the kernel from treating the play session as TuneIn-managed.
     *   • raumfeld:name — purely display; redundant without section.
     *   • item id / parentID are neutralised to "cdn/direct" / "cdn" so the
     *     kernel cannot find the item in its ContentDirectory even via id lookup.
     *
     * Use this for PERMANENT CDN URLs (direct broadcaster streams that never
     * expire).  TuneIn dispatcher URLs (rndfnk / aggregator=tunein) must keep
     * their ebrowse metadata for renewal — use _stripEbrowse() for those.
     *
     * @param {string} metaXml - DIDL-Lite XML string
     * @returns {string} XML suitable for SetAVTransportURI on a permanent CDN URL
     */
    _makeCdnMeta(metaXml) {
        if (!metaXml) return metaXml;
        return metaXml
            .replace(/<raumfeld:durability>[^<]*<\/raumfeld:durability>/g, '')
            .replace(/<raumfeld:ebrowse>[^<]*<\/raumfeld:ebrowse>/g, '')
            .replace(/<raumfeld:section>[^<]*<\/raumfeld:section>/g, '')
            .replace(/<raumfeld:name>[^<]*<\/raumfeld:name>/g, '')
            .replace(/\s+refID="[^"]*"/g, '')
            .replace(/\bid="[^"]*"/g, 'id="cdn/direct"')
            .replace(/\bparentID="[^"]*"/g, 'parentID="cdn"');
    }

    /**
     * Gets or creates a virtual renderer for a room.
     * Used when switching from Spotify to standard UPnP playback.
     * @param {RoomState} room 
     * @returns {Promise<*>}
     */
    async _ensureVirtualRenderer(room) {
        if (!room) return undefined;

        const deviceManager = this._getDeviceManager();
        const zoneManager = this._getZoneManager();
        if (!deviceManager || !zoneManager) return undefined;

        // Force the room into UPnP mode by connecting to a zone
        try {
            await zoneManager.connectRoomToZone(room.roomUdn, '', false);
        } catch (err) {
            console.warn(`${LOG_PREFIX.RENDERER} Zone connect failed for ${room.name}: ${err.message}`);
        }

        // Poll for zone creation
        const maxAttempts = 15;
        for (let i = 0; i < maxAttempts; i++) {
            const zoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
            if (zoneUdn && deviceManager.mediaRenderersVirtual.has(zoneUdn)) {
                return deviceManager.mediaRenderersVirtual.get(zoneUdn);
            }
            if (i < maxAttempts - 1) {
                await this._delay(500);
            }
        }

        // Search by renderer UDN as fallback
        for (const [, renderer] of deviceManager.mediaRenderersVirtual) {
            const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
            if (memberUdns.includes(room.rendererUdn)) {
                return renderer;
            }
        }

        // Last resort: physical renderer
        console.warn(`${LOG_PREFIX.RENDERER} Could not create virtual renderer for ${room.name}`);
        return deviceManager.mediaRenderers.get(room.rendererUdn);
    }

    // ========================================================================
    // PLAYBACK STATE
    // ========================================================================

    /**
     * Gets the current playback state for a room
     * @param {RoomInfo} room 
     * @returns {NowPlayingState}
     */
    _getNowPlayingForRoom(room) {
        if (!this._state.isReady) return this._createEmptyNowPlaying();

        const deviceManager = this._getDeviceManager();
        if (!deviceManager) return this._createEmptyNowPlaying();

        // Try zone renderer first, then physical renderer
        let renderer = room.zoneUdn 
            ? deviceManager.mediaRenderersVirtual.get(room.zoneUdn)
            : null;

        if (!renderer) {
            renderer = deviceManager.mediaRenderers.get(room.rendererUdn);
        }

        return renderer 
            ? this._extractNowPlaying(renderer, room)
            : this._createEmptyNowPlaying();
    }

    /**
     * @returns {NowPlayingState}
     */
    _createEmptyNowPlaying() {
        return {
            artist: '',
            track: '',
            uri: '',
            image: '',
            isPlaying: false,
            isLoading: false,
            isMuted: false,
            volume: 0,
            canPlayPause: false,
            canPlayNext: false,
            canPlayPrev: false,
            duration: 0,
            position: 0,
            powerState: 'STANDBY'
        };
    }

    /**
     * Extracts playback state from a renderer
     * @param {*} renderer 
     * @param {RoomInfo} room - Room info to get physical renderer for power state
     * @returns {NowPlayingState}
     */
    _extractNowPlaying(renderer, room = null) {
        const state = renderer.rendererState;
        const metadata = this._parseMetadata(
            state.CurrentTrackMetaData || state.AVTransportURIMetaData
        );

        const isLoading = state.TransportState === 'TRANSITIONING';
        const isPlaying = state.TransportState === 'PLAYING';

        // Detect track changes by watching a fingerprint of AVTransportURI + CurrentTrack.
        // AVTransportURI alone is not enough for container/playlist playback where the URI
        // is a constant dlna-playcontainer:// reference and only CurrentTrack changes.
        // When the fingerprint changes we reset the position tracker to 0.
        // This is safe: our corrective Seek in play() does NOT change the URI or track
        // number, so this detection cannot be triggered by late subscription events.
        if (room) {
            const currentUri = state.AVTransportURI || '';
            const currentTrackNum = String(state.CurrentTrack ?? '');
            const fingerprint = currentUri ? `${currentUri}::${currentTrackNum}` : '';

            if (fingerprint) {
                if (room._resumeAnchorTrack === undefined) {
                    // First encounter — just record it; tracker may already be set
                    room._resumeAnchorTrack = fingerprint;
                    room._resumeAnchorUri = currentUri;
                } else if (fingerprint !== room._resumeAnchorTrack) {
                    // Track changed: device loaded a new track externally.
                    // Only reset _isLiveStream when the URI itself changes (new media source).
                    // If only the track number changed (same URI, e.g. song update on a radio
                    // stream), preserve the live-stream flag set earlier for that URI.
                    const prevAnchorUri      = room._resumeAnchorUri;  // save BEFORE update
                    const uriActuallyChanged = currentUri !== prevAnchorUri;
                    room._resumeAnchorTrack = fingerprint;
                    room._resumeAnchorUri = currentUri;
                    room._resumeAnchorSeconds = 0;
                    room._resumeAnchorTime = isPlaying ? Date.now() : null;
                    if (uriActuallyChanged) {
                        room._isLiveStream     = undefined;
                        room._radioOriginalUrl = undefined;
                        room._radioRefId       = undefined;
                        room._radioAvtMetadata = undefined;
                        room._lastStationId    = undefined;
                    }
                    console.log(`${LOG_PREFIX.RENDERER} Track changed for ${room.name}: position tracker reset`);
                }
            }

            // Thaw the position tracker when the device transitions to PLAYING.
            // This covers external play events (Music Assistant, original app) and
            // playlist auto-advance.  The freeze lives exclusively in pause() so
            // late subscription events from our corrective Seek cannot trigger it.
            if (isPlaying && room._resumeAnchorSeconds !== undefined && !room._resumeAnchorTime) {
                room._resumeAnchorTime = Date.now();
            }
        }

        // Parse transport actions
        let canPlayPause = false;
        let canPlayNext = false;
        let canPlayPrev = false;

        const actions = state.CurrentTransportActions ?? '';
        if (actions) {
            canPlayPause = /Play|Pause|Stop/i.test(actions);
            canPlayNext = actions.includes('Next');
            // Live streams (radio/TuneIn) never have a meaningful "previous track".
            // The kernel reports 'Previous' in CurrentTransportActions when playing
            // from a CDN URL (Path A), but that button makes no sense for live radio.
            const isLiveContext = room?._isLiveStream ||
                !!(metadata.classString?.includes('audioBroadcast') ||
                   metadata.classString?.includes('radio'));
            if (!isLiveContext) {
                canPlayPrev = actions.includes('Previous');
            }
        }

        // Detect radio/live-stream content from UPnP object class.
        // Stored on the room so play() can use it without re-parsing metadata.
        // STICKY: only ever set to true, never overwrite back to false.
        // When a radio station's "now playing" metadata updates, the UPnP class
        // often changes to musicTrack for the current song — overwriting with
        // false here would make play() think it's a file and issue a corrective
        // seek on the live stream, disconnecting the source.
        // The flag is reset to undefined only when a genuinely new URI is loaded
        // (loadUri / loadContainer / loadSingle, or URI change detected above).
        const isRadio = !!(metadata.classString?.includes('audioBroadcast') ||
                           metadata.classString?.includes('radio'));
        if (room && isRadio) {
            room._isLiveStream = true;
            // Maintain stationId for zone-grouping independent of the browse cache.
            // The refID attribute in the kernel's live metadata always carries the
            // RadioTime station ID (e.g. "0/RadioTime/Search/s-s8007" → "8007")
            // even when the UPnP class later changes to musicTrack for "now playing"
            // track updates, so this regex reliably identifies the station.
            const rawMeta = state.CurrentTrackMetaData || state.AVTransportURIMetaData || '';
            const stIdMatch = rawMeta.match(/refID="[^"]*\/s-s(\d+)"/);
            if (stIdMatch) room._lastStationId = stIdMatch[1];
        }

        // ---- Radio session management --------------------------------------------
        // The Raumfeld kernel manages TuneIn session renewal internally via the
        // dlna-playsingle:// URI mechanism: when the zone renderer's AVTransportURI
        // is a dlna-playsingle:// reference, the kernel browses the MediaServer for
        // the item (obtaining the raumfeld:ebrowse URL from its DIDL-Lite metadata)
        // and handles all TuneIn session renewals without any assistance from us.
        //
        // Cache _radioRefId and _radioAvtMetadata for informational purposes only.
        // play() uses a bare UPnP Play() command so the kernel can reuse its
        // existing session state — never SetAVTransportURI which would start a new
        // TuneIn session registration and trigger throttle-induced drops.
        //
        // Sources for the metadata (in priority order):
        //   1. AVTransportURIMetaData — set by the native Raumfeld app when it loads
        //      a station; contains ebrowse but no <res> URL.  Best choice.
        //   2. CurrentTrackMetaData with <res> stripped — always present after the
        //      first successful stream start, covers HA-initiated loads where
        //      AVTransportURIMetaData is minimal.
        if (room) {
            // Cache the content-directory refID (e.g. "0/Favorites/MyFavorites/36318")
            // so play() can reload the station after a drop.
            if (isRadio && metadata.refId) {
                room._radioRefId = metadata.refId;
            }

            // Cache station-level metadata that includes raumfeld:ebrowse so that
            // play() can issue a SetAVTransportURI with the CDN URL + TuneIn
            // metadata (skipping new-session establishment, doing renewal only).
            //
            // Guard: only cache metadata whose ebrowse element is NON-EMPTY.
            // The Raumfeld kernel generates <raumfeld:ebrowse/> (self-closing, empty)
            // for "External" streams loaded with a plain CDN URL and no TuneIn
            // context.  Caching that would overwrite good TuneIn metadata with a
            // useless value and break the renewal path.
                if (isRadio) {
                // Track the last direct CDN URL for this room (sticky — kept even when
                // the URI later transitions to dlna-playsingle:// so that, when TuneIn
                // metadata arrives for the same station, we can associate the two).
                const avturi = state.AVTransportURI || '';
                if (avturi.startsWith('https://') && !avturi.includes('opml.radiotime.com')) {
                    room._lastSeenCdnUri = avturi;
                }
                // Also capture from CurrentTrackURI when AVTransportURI is a
                // dlna-playsingle:// reference (native-app loads).  This ensures
                // that rooms loaded via the native app contribute their CDN URL
                // to the cross-room metadata cache, enabling Kueche and similar
                // rooms to inherit the ebrowse DIDL cached from Kati or TischlerEi.
                if (!room._lastSeenCdnUri) {
                    const trackUri = state.CurrentTrackURI || '';
                    if (trackUri.startsWith('https://') && !trackUri.includes('opml.radiotime.com')) {
                        room._lastSeenCdnUri = trackUri;
                    }
                }

                const avtMeta   = state.AVTransportURIMetaData || '';
                const trackMeta = state.CurrentTrackMetaData  || '';
                const hasRealEbrowse = (m) => m.includes('<raumfeld:ebrowse>http');
                let freshMeta = null;

                // Extract the TuneIn device serial from the first real ebrowse URL we see
                // (any room, any station).  Used to reconstruct ebrowse metadata for the
                // "Poisoned CDN" cleanup without registering a new TuneIn session.
                if (!this._tuneInSerial) {
                    const ebrowseSrc = hasRealEbrowse(avtMeta) ? avtMeta : (hasRealEbrowse(trackMeta) ? trackMeta : '');
                    // The ebrowse URL inside DIDL-Lite XML uses &amp; for '&', so
                    // the regex must handle both literal '&' and the '&amp;' entity.
                    const serialMatch = ebrowseSrc.match(/[?&](?:amp;)?serial=([^&"<\s]+)/);
                    if (serialMatch) {
                        this._tuneInSerial = decodeURIComponent(serialMatch[1]);
                        this._saveTuneInSerial();
                    }
                }
                if (hasRealEbrowse(avtMeta)) {
                    // Strip <res> before caching so that Path A (setAvTransportUri with
                    // CDN URL) never triggers a new-session fetch via the relay <res> URL.
                    // ContentDirectory AVTransportURIMetaData always includes <res> (the
                    // TuneIn relay session URL); if we cache it as-is and then use it in
                    // setAvTransportUri, the kernel fetches <res>, registers yet another
                    // TuneIn session, and the new session competes with the existing one
                    // → throttle → drops.  We keep ebrowse/durability for renewal.
                    const strippedAvt = avtMeta.replace(/<res\b[^>]*>[\s\S]*?<\/res>/g, '');
                    room._radioAvtMetadata = strippedAvt;
                    freshMeta = strippedAvt;
                } else if (hasRealEbrowse(trackMeta) && !room._radioAvtMetadata) {
                    // Fallback: strip the <res> element from CurrentTrackMetaData so
                    // we pass station-level info only (the kernel fetches a fresh
                    // session URL via ebrowse at load time).
                    const stripped = trackMeta.replace(/<res\b[^>]*>[\s\S]*?<\/res>/g, '');
                    room._radioAvtMetadata = stripped;
                    freshMeta = stripped;
                }

                // Persist the CDN URL → TuneIn metadata mapping so a cold start
                // after External-state corruption can use the cached metadata immediately.
                if (freshMeta && room._lastSeenCdnUri) {
                    this._saveCdnMetaCacheEntry(room._lastSeenCdnUri, freshMeta);
                }

                // Cold-start recovery: if the in-memory cache is still empty but we
                // know the CDN URL, warm it from the on-disk store (e.g. room was left
                // with External metadata by a previous run's loadUri call).
                if (!room._radioAvtMetadata && room._lastSeenCdnUri) {
                    const persisted = this._cdnMetaCache[room._lastSeenCdnUri];
                    if (persisted) {
                        room._radioAvtMetadata = persisted;
                        console.log(
                            `${LOG_PREFIX.REGISTRY} ${room.name}: restored TuneIn` +
                            ` metadata from CDN cache (${room._lastSeenCdnUri})`
                        );
                    }
                }
            }

            const prevState = room._prevTransportState;
            // For rooms in a multi-room zone the zone renderer's overall TransportState
            // stays PLAYING even when one room's physical renderer drops from the CDN
            // proxy connection.  Extract the room-specific state from RoomStates so
            // partial drops (e.g. Kueche=STOPPED while TischlerEi=PLAYING) are
            // detected correctly.
            let currState = state.TransportState;
            if (room && state.RoomStates) {
                const rm = state.RoomStates.match(new RegExp(room.roomUdn + '=([A-Z_]+)'));
                if (rm) currState = rm[1];
            }
            room._prevTransportState = currState;

            // Record session-start time when entering PLAYING (only on the actual
            // transition into PLAYING, not on song-title metadata updates that fire
            // rendererStateChanged while already in PLAYING).
            if (currState === 'PLAYING' && prevState !== 'PLAYING') {
                room._lastPlayingTime = Date.now();
            }

            // Track when TRANSITIONING starts so play() can detect a stuck kernel.
            if (currState === 'TRANSITIONING' && prevState !== 'TRANSITIONING') {
                room._transitioningStartTime = Date.now();
            } else if (currState !== 'TRANSITIONING') {
                room._transitioningStartTime = 0;
            }

            // Log when a live-stream session ends and let the Raumfeld kernel
            // handle its own auto-restart.
            //
            // The kernel sets CurrentTransportActions='Play' immediately after a drop
            // and restarts on its own within ~12–60 s.  Its internal restart uses the
            // same TuneIn session context (treated by TuneIn as a renewal, not a new
            // session request), so TuneIn responds faster and with longer CDN tokens
            // compared to a forced stop()+play() cycle from this integration.
            //
            // Calling stop() from here to "suppress" the kernel's restart was
            // counter-productive: it forced new-session ebrowse calls on every restart,
            // escalating TuneIn throttle and extending recovery windows to 10+ minutes
            // instead of the kernel's natural 12–60 s.
            const isStopped = currState === 'STOPPED' || currState === 'NO_MEDIA_PRESENT';
            if (isStopped && room._isLiveStream === true) {
                if (prevState === 'PLAYING') {
                    const sessionAge = room._lastPlayingTime
                        ? (Date.now() - room._lastPlayingTime) : undefined;
                    const ageStr = sessionAge !== undefined
                        ? `${Math.round(sessionAge / 1000)}s` : '?';
                    console.log(`${LOG_PREFIX.COMMAND} Stream dropped for ${room.name} (session ${ageStr}) — kernel will auto-restart, or press Play`);
                } else if (prevState === 'TRANSITIONING') {
                    console.log(`${LOG_PREFIX.COMMAND} Stream load failed or stopped for ${room.name}`);
                }

                // Partial zone drop: the zone renderer is still PLAYING (another room
                // is keeping it alive) but THIS room's physical renderer has lost its
                // CDN proxy connection.  The kernel will not auto-restart because the
                // zone is still active.  Auto-recover by dropping the room from the
                // zone and re-joining it via loadSingle, which uses the zone-join logic
                // to reconnect without interrupting the other rooms that are still
                // playing.
                //
                // Guard 1: only treat as a drop if the room was previously PLAYING
                //          (prevState==='PLAYING').  A fresh zone-join starts with
                //          STOPPED → kernel promotes to PLAYING within ~2 s; that
                //          initial STOPPED must not trigger a rejoin cycle.
                // Guard 2: deduplicate multiple subscription callbacks that fire for
                //          the same state change.  _extractNowPlaying can be called
                //          several times within a few ms for one physical event;
                //          _partialDropRejoinPending prevents redundant timers.
                if (prevState === 'PLAYING' &&
                    state.TransportState === 'PLAYING' &&
                    room._lastItemId && !room._userStopped &&
                    !room._partialDropRejoinPending) {
                    const rejoinItemId = room._lastItemId;
                    room._partialDropRejoinPending = true;
                    console.log(
                        `${LOG_PREFIX.COMMAND} Partial zone drop for ${room.name}` +
                        ` — scheduling drop+rejoin in 3 s (item ${rejoinItemId})`
                    );
                    setTimeout(async () => {
                        room._partialDropRejoinPending = false;
                        try {
                            // Verify the room is still stuck (hasn't self-healed).
                            const r2 = this._getRendererForRoom(room);
                            if (r2) {
                                const rs2 = r2.rendererState?.RoomStates || '';
                                const rm2 = rs2.match(new RegExp(room.roomUdn + '=([A-Z_]+)'));
                                const roomState2 = rm2 ? rm2[1] : r2.rendererState?.TransportState;
                                if (roomState2 === 'PLAYING' || roomState2 === 'TRANSITIONING') {
                                    console.log(
                                        `${LOG_PREFIX.COMMAND} Partial zone drop for ${room.name}` +
                                        ` self-healed — skipping rejoin`
                                    );
                                    return;
                                }
                            }
                            const zoneManager = this._getZoneManager();
                            if (zoneManager) {
                                const zoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
                                if (zoneUdn) {
                                    console.log(
                                        `${LOG_PREFIX.COMMAND} Dropping ${room.name} from zone` +
                                        ` ${zoneUdn} for partial-drop rejoin`
                                    );
                                    try {
                                        await zoneManager.dropRoomFromZone(room.roomUdn);
                                    } catch (e) {
                                        console.warn(
                                            `${LOG_PREFIX.COMMAND} dropRoomFromZone for partial-drop` +
                                            ` failed for ${room.name}: ${e.message}`
                                        );
                                    }
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                            }
                            room._userStopped = false;
                            await this.loadSingle(room.roomUdn, rejoinItemId);
                        } catch (err) {
                            console.warn(
                                `${LOG_PREFIX.COMMAND} Partial-drop rejoin failed for ${room.name}:` +
                                ` ${err.message}`
                            );
                        }
                    }, 3000);
                }
            }

            // ---- TuneIn relay URI cleanup ----------------------------------------
            // On initial subscription (prevState === undefined) a STOPPED renderer
            // may still have a raw TuneIn relay URL (opml.radiotime.com/Tune.ashx)
            // as its persisted AVTransportURI from a previous session.
            // node-raumkernel's MediaListManager fetches that URI on EVERY
            // subscription re-establishment (startup + each Device-list change).
            // Since the Raumfeld Host fires Device-list changes frequently
            // (e.g. each time Wc-Og's presence automation plays/stops a zone),
            // these fetches rapidly accumulate as extra TuneIn session requests
            // on the shared serial (78:a5:04:f1:82:ee), pushing it over TuneIn's
            // rate limit and causing throttle-induced drops on all rooms.
            //
            // Fix: when we detect such a stale TuneIn URI on a STOPPED renderer at
            // first subscription, we swap it to dlna-playsingle:// by calling
            // loadSingle() and immediately calling stop() when TRANSITIONING fires.
            // At TRANSITIONING the kernel has already executed SetAVTransportURI
            // (so dlna-playsingle:// is persisted) but has not yet opened a CDN
            // connection, so no audio is played and the stop() is inaudible.
            // After the swap, MediaListManager resolves dlna-playsingle:// locally
            // via the Raumfeld MediaServer and never contacts TuneIn again.
            if (isStopped && prevState === undefined && !room._cleaningTuneInUri) {
                const currentUri = state.AVTransportURI || '';
                const tuneInSid = currentUri.match(
                    /opml\.radiotime\.com\/Tune\.ashx.*?\bsid=(s\d+)\b/
                );
                if (tuneInSid) {
                    const stationId = tuneInSid[1];
                    room._cleaningTuneInUri = Date.now();
                    console.log(
                        `${LOG_PREFIX.COMMAND} Stale TuneIn relay URI on stopped ${room.name} ` +
                        `(${stationId}) — swapping to dlna-playsingle:// to eliminate ` +
                        `future MediaListManager TuneIn requests`
                    );
                    setImmediate(() => this.loadSingle(room.name, `0/RadioTime/Search/s-${stationId}`));
                    // Safety: clear the flag after 15 s if TRANSITIONING never fires
                    setTimeout(() => { if (room._cleaningTuneInUri) room._cleaningTuneInUri = 0; }, 15000);
                }
                // "Poisoned" CDN state (CDN URL + no ebrowse) is handled lazily in
                // play() via _tryInjectEbrowse() — no loadSingle here to avoid
                // registering an unnecessary TuneIn session at startup.
            }

            // Abort the URI-swap load the instant TRANSITIONING is seen:
            // SetAVTransportURI has already been applied (new dlna-playsingle://
            // URI is stored on the renderer) but no CDN connection is open yet.
            if (currState === 'TRANSITIONING' && room._cleaningTuneInUri) {
                const cleanupAge = Date.now() - room._cleaningTuneInUri;
                room._cleaningTuneInUri = 0;
                if (cleanupAge < 10000) {
                    // Save the fresh CDN URL the kernel established during the
                    // cleanup loadSingle so Path A can use it instead of the
                    // stale pre-cleanup URL (Session 1).  The two sessions share
                    // the same CDN URL for most stations, but saving here keeps
                    // the active session and CDN URL consistent.
                    const freshUri = renderer.rendererState?.CurrentTrackURI;
                    if (typeof freshUri === 'string' &&
                        freshUri.startsWith('https://') &&
                        !freshUri.includes('opml.radiotime.com')) {
                        room._cleanupCdnUri = freshUri;
                    }
                    console.log(
                        `${LOG_PREFIX.COMMAND} URI swap complete for ${room.name} — stopping`
                    );
                    setImmediate(() => renderer.stop());
                }
            }
            // ----------------------------------------------------------------------
        }
        // --------------------------------------------------------------------------

        // Fallback: Enable next/prev for container-based content (e.g. playlists)
        // only if not already explicitly enabled by transport actions.
        if (!canPlayNext || !canPlayPrev) {
            const isContainer = this._isContainerMedia(metadata.classString);
            const hasMultipleTracks = (parseInt(state.NumberOfTracks) || 0) > 1;

            // Radio stations never fallback to enabling next/prev buttons unless explicitly
            // reported by the device's current transport actions.
            if (!isRadio && ((isContainer && metadata.track) || hasMultipleTracks)) {
                canPlayNext = true;
                canPlayPrev = true;
            }
        }

        // PowerState must come from the PHYSICAL renderer, not the zone renderer
        // Zone renderers don't have accurate PowerState for individual devices
        let powerState = 'ACTIVE';
        if (room) {
            const deviceManager = this._getDeviceManager();
            const physicalRenderer = deviceManager?.mediaRenderers.get(room.rendererUdn);
            powerState = physicalRenderer?.rendererState?.PowerState || 'ACTIVE';
        } else {
            // Fallback if no room info provided
            powerState = state.PowerState || 'ACTIVE';
        }

        // Parse time strings to seconds (helper)
        const parseToSeconds = (timeVal) => {
            if (typeof timeVal === 'number') return timeVal;
            if (!timeVal) return 0;
            try {
                const parts = timeVal.split(':').map(Number);
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                return 0;
            } catch {
                return 0;
            }
        };

        const durationSeconds = parseToSeconds(state.CurrentTrackDuration);
        const positionSeconds = typeof state.RelativeTimePosition === 'number' 
            ? state.RelativeTimePosition 
            : parseToSeconds(state.RelativeTimePosition);

        // Derive shuffle / repeat from UPnP CurrentPlayMode
        const playMode = (state.CurrentPlayMode || 'NORMAL').toUpperCase();
        const shuffle = playMode === 'SHUFFLE' || playMode === 'RANDOM';
        let repeat = 'off';
        if (playMode === 'REPEAT_ONE') repeat = 'one';
        else if (playMode === 'REPEAT_ALL' || playMode === 'RANDOM') repeat = 'all';

        // Per-room volume: when the room is part of a multi-room zone the
        // zone renderer's Volume property is the zone-master (highest member)
        // volume, not this room's individual volume.  Read the room-specific
        // absolute volume from RoomVolumes so that each room's HA slider
        // reflects only its own speaker level and moves independently of
        // other zone members.  Negative values (corrupted delta from a prior
        // zone-level SetVolume) are clamped to 0.
        const zoneVolume = parseInt(state.Volume) || 0;
        let roomVolume = zoneVolume;
        if (room && state.RoomVolumes) {
            const rvMatch = state.RoomVolumes.match(
                new RegExp(room.roomUdn + '=([-\\d]+)')
            );
            if (rvMatch) roomVolume = Math.max(0, parseInt(rvMatch[1]) || 0);
        }

        return {
            artist: metadata.artist,
            track: metadata.track,
            album: metadata.album,
            uri: metadata.uri || state.AVTransportURI || '',
            image: this._sanitizeImageUrl(metadata.image),
            classString: metadata.classString,
            isPlaying,
            isLoading,
            isMuted: state.Mute === 1,
            volume: roomVolume,
            zoneVolume,
            canPlayPause,
            canPlayNext,
            canPlayPrev,
            duration: state.CurrentTrackDuration || 0,
            durationSeconds,
            position: this._getPositionForRoom(room, state.RelativeTimePosition || 0),
            positionSeconds: this._getPositionForRoom(room, positionSeconds),
            shuffle,
            repeat,
            powerState
        };
    }

    /**
     * Gets the position for a room, using seek position if recently seeked
     * @param {RoomInfo} room 
     * @param {number} defaultPosition - Position in seconds
     * @returns {number} Position in seconds
     */
    _getPositionForRoom(room, defaultPosition) {
        if (!room) return defaultPosition;

        // Recent explicit seek override (5-second window)
        const seekTime = room._lastSeekTime;
        const seekPos = room._lastSeekPosition;
        if (seekTime && typeof seekPos === 'number' && (Date.now() - seekTime) < 5000) {
            return seekPos;
        }

        // Elapsed-time position tracker.
        //   _resumeAnchorSeconds  – last-known position in seconds
        //   _resumeAnchorTime     – wall-clock when tracking started (null = frozen/paused)
        // This avoids relying on the Raumfeld device's RelativeTimePosition which does
        // not advance during playback (it stays frozen at the last seek anchor).
        if (room._resumeAnchorSeconds !== undefined) {
            if (room._resumeAnchorTime) {
                // Device is playing: position = anchor + elapsed
                return Math.max(0, room._resumeAnchorSeconds + (Date.now() - room._resumeAnchorTime) / 1000);
            }
            // Device is paused/stopped: return frozen position
            return Math.max(0, room._resumeAnchorSeconds);
        }

        return defaultPosition;
    }

    _isContainerMedia(classString) {
        if (!classString) return false;
        // UPnP container classes start with object.container
        // We also include podcast to handle podcast containers, but exclude items like musicTrack
        return classString.startsWith('object.container') || 
               /playlist|album|podcastContainer/i.test(classString);
    }

    /**
     * Sanitizes an image URL, upgrading to HTTPS where supported.
     * Local Raumfeld device URLs (e.g., /raumfeldImage on private IPs) are kept as HTTP
     * because the device doesn't support TLS on these endpoints.
     * @param {string} url 
     * @returns {string}
     */
    _sanitizeImageUrl(url) {
        if (!url) return '';
        // Don't convert local Raumfeld image proxy URLs to HTTPS - device doesn't support TLS
        // These URLs point to the Raumfeld host and redirect to external services
        if (url.includes('/raumfeldImage') || 
            /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|localhost|127\.)/.test(url)) {
            return url;
        }
        // Upgrade external URLs to HTTPS
        return url.replace('http://', 'https://');
    }

    // ========================================================================
    // METADATA PARSING
    // ========================================================================

    /**
     * Parses DIDL-Lite XML metadata
     * @param {string} xml 
     * @returns {MediaMetadata}
     */
    _parseMetadata(xml) {
        const result = { track: '', artist: '', album: '', image: '', uri: '', classString: '', ebrowseUrl: '', refId: '' };
        if (!xml) return result;

        try {
            const parser = new (new JSDOM('')).window.DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');

            const getText = (tag) => doc.getElementsByTagName(tag)[0]?.textContent ?? '';

            result.classString = getText('upnp:class');
            result.track = getText('dc:title');
            result.artist = getText('upnp:artist');
            result.album = getText('upnp:album');
            result.image = getText('upnp:albumArtURI');
            result.uri = getText('res');
            // Raumfeld-specific: URL used to get a fresh TuneIn session URL on renewal
            result.ebrowseUrl = getText('raumfeld:ebrowse');
            // Content-directory reference ID used by play() to reload the station
            // via loadSingle() after a TuneIn session drop.
            //
            // Critical: the Raumfeld kernel only sets up internal TuneIn session renewal
            // (the raumfeld:ebrowse mechanism) when the item is loaded via a Favorites or
            // RecentlyPlayed path.  When loaded directly from 0/RadioTime/Search/s-XXXXX
            // the kernel skips renewal and the session drops after the initial 120 s.
            //
            // Priority:
            //   1. id starts with "0/Favorites/" → use id directly (Favorites/RecentlyPlayed
            //      path enables kernel renewal; after loadSingle the metadata keeps the same
            //      Favorites id, so subsequent restarts stay on the renewal-capable path)
            //   2. refID present → use refID (RadioTime canonical id for the station)
            //   3. Fall back to id (RadioTime/Search path — renewal won't work, but it's
            //      the best we have when no Favorites path is available)
            const itemEl = doc.getElementsByTagName('item')[0];
            const idAttr   = itemEl?.getAttribute('id')    ?? '';
            const refIDAttr = itemEl?.getAttribute('refID') ?? '';
            result.refId = idAttr.startsWith('0/Favorites/') ? idAttr : (refIDAttr || idAttr);
        } catch (err) {
            console.warn(`${LOG_PREFIX.MEDIA} Metadata parse error: ${err.message}`);
        }

        return result;
    }

    // ========================================================================
    // PLAYBACK COMMANDS
    // ========================================================================

    async seek(roomIdentifier, value) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        // Format value to HH:MM:SS if it's a number (seconds)
        let targetValue = value;
        if (typeof value === 'number') {
            const h = Math.floor(value / 3600);
            const m = Math.floor((value % 3600) / 60);
            const s = Math.floor(value % 60);
            targetValue = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }

        // Perform the seek
        console.log(`${LOG_PREFIX.COMMAND} Seeking ${room.name} to ${targetValue} (raw: ${value})`);
        await renderer.seek('ABS_TIME', targetValue);

        // Wait briefly for the seek to take effect
        await this._delay(300);

        // Poll the new position and update state for all rooms in the zone
        try {
            const positionInfo = await renderer.getPositionInfo();
            if (positionInfo) {
                // Update position for all rooms in this zone
                const zoneUdn = room.zoneUdn;
                for (const r of this._rooms.values()) {
                    if (r.zoneUdn === zoneUdn || r.roomUdn === room.roomUdn) {
                        // Force position update in next broadcast
                        // Store as seconds for consistency with positionSeconds
                        r._lastSeekPosition = typeof value === 'number' ? value : 0;
                        r._lastSeekTime = Date.now();
                        // Advance the elapsed-time tracker to the new seek position
                        // so display and resume both stay correct after this seek.
                        r._resumeAnchorSeconds = r._lastSeekPosition;
                        r._resumeAnchorTime = Date.now();
                    }
                }
                
                // Broadcast updated state immediately
                this._broadcastRoomStates();
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX.COMMAND} Failed to get position after seek: ${err.message}`);
            // Still broadcast to update clients
            this._broadcastRoomStates();
        }
    }

    async play(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;


        await this._wakeRenderer(renderer);

        // Work around a Raumfeld device quirk: when resuming from PAUSED_PLAYBACK
        // the device restarts from the last seek anchor (set by SetAVTransportURI or
        // a prior Seek call) instead of the actual paused position. This is most
        // visible with Music Assistant playback where the player loads a URI and then
        // seeks into it — the anchor stays at the seek target, so a later pause +
        // resume jumps back to that target rather than where playback was paused.
        //
        // Fix: before calling play(), refresh the anchor to the current position by
        // issuing a Seek to that position while still paused, then wait for the device
        // to process the seek before resuming play.
        //
        // IMPORTANT: The corrective seek is only safe for finite-duration file media.
        // Live streams (TuneIn, internet radio) have no duration and don't support
        // seeking. Attempting a seek on a live stream causes the device to disconnect
        // from the source; the device may play from a small buffer for a while, then
        // stop. We detect this via CurrentTransportActions ("Seek" absent) and
        // CurrentTrackDuration (zero/NOT_IMPLEMENTED means live stream).
        //
        // We also skip the seek when the track URI changed externally (e.g. Music
        // Assistant loaded a new track bypassing our loadUri), because our elapsed-
        // time tracker would be stale from the previous track.
        if (renderer.rendererState?.TransportState === 'PAUSED_PLAYBACK') {
            // Four independent live-stream guards — any one is enough to skip seek:
            //  1. Duration: missing / zero / NOT_IMPLEMENTED → no seekable timeline
            //  2. Media class: audioBroadcast / radio stored from last _extractNowPlaying call
            //     (sticky: set to true and never overwritten by song-metadata updates on
            //      the same URI — see _extractNowPlaying for details)
            //  3. Fresh metadata parse: catches the window after loadUri() resets
            //     _isLiveStream but before the first state update arrives
            //  4. URI extension: stream URLs (TuneIn, internet radio) never end with
            //     a common audio file extension; NAS files almost always do.
            //     This is the most reliable guard when the device reports the current
            //     *song* class (musicTrack) rather than the station class (audioBroadcast),
            //     causing guards 1-3 to all evaluate false.
            //     Exception: dlna-playcontainer / dlna-playsingle URIs are finite-media
            //     containers and must still be seekable.
            const durationStr = renderer.rendererState?.CurrentTrackDuration ?? '';
            const isLiveByDuration = !durationStr || durationStr === '0:00:00' || durationStr === 'NOT_IMPLEMENTED';
            const isLiveByClass = !!(room?._isLiveStream);
            const metaXml = renderer.rendererState?.CurrentTrackMetaData ||
                            renderer.rendererState?.AVTransportURIMetaData || '';
            let isLiveByMeta = false;
            if (metaXml) {
                try {
                    const meta = this._parseMetadata(metaXml);
                    isLiveByMeta = !!(meta.classString?.includes('audioBroadcast') ||
                                      meta.classString?.includes('radio'));
                } catch { /* ignore parse errors */ }
            }
            const transportActions = renderer.rendererState?.CurrentTransportActions ?? '';
            const canSeek = /\bSeek\b/i.test(transportActions);
            const currentUri = renderer.rendererState?.AVTransportURI ?? '';
            const currentTrackNum = String(renderer.rendererState?.CurrentTrack ?? '');
            const currentFingerprint = currentUri ? `${currentUri}::${currentTrackNum}` : '';
            const trackerFingerprint = room?._resumeAnchorTrack;
            const uriChanged = !!(trackerFingerprint && currentFingerprint && trackerFingerprint !== currentFingerprint);

            // Guard 4: URIs that lack an audio file extension are treated as streams.
            // dlna-play* URIs are container/single references (always finite files).
            const audioExtRe = /\.(mp3|flac|wav|aac|ogg|wma|m4a|opus|alac|aiff|ape|ac3|dts|aif|dsf|dff)(\?|#|$)/i;
            const isDlnaContainer = /^dlna-play(container|single):\/\//i.test(currentUri);
            const isLiveByUri = !audioExtRe.test(currentUri) && !isDlnaContainer;

            const isLiveStream = isLiveByDuration || isLiveByClass || isLiveByMeta || isLiveByUri;

            let pos = null;

            if (room?._resumeAnchorSeconds !== undefined) {
                // Position tracker is initialised — use it (works for both the first
                // pause and all subsequent ones).
                //   • _resumeAnchorTime == null  → timer frozen at pause: use as-is
                //   • _resumeAnchorTime != null  → timer still running (edge case):
                //                                   add elapsed to get current position
                let anchorSeconds = room._resumeAnchorSeconds;
                if (room._resumeAnchorTime) {
                    anchorSeconds += (Date.now() - room._resumeAnchorTime) / 1000;
                }
                anchorSeconds = Math.max(0, anchorSeconds);
                const h = Math.floor(anchorSeconds / 3600);
                const m = Math.floor((anchorSeconds % 3600) / 60);
                const s = Math.floor(anchorSeconds % 60);
                pos = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            } else {
                // No position tracking yet (no loadUri/seek before this resume) —
                // fall back to getPositionInfo() which is reliable on the very first
                // pause before any of our corrective seeks have run.
                try {
                    const posInfo = await renderer.getPositionInfo();
                    const relTime = posInfo?.RelTime;
                    if (relTime && relTime !== '0:00:00' && relTime !== 'NOT_IMPLEMENTED') {
                        pos = relTime;
                    }
                } catch {
                    const statePos = renderer.rendererState?.RelativeTimePosition;
                    if (statePos && statePos !== '0:00:00' && statePos !== 'NOT_IMPLEMENTED') {
                        pos = statePos;
                    }
                }
            }

            // Diagnostic log — visible in add-on logs whenever play() is called
            // after a pause. Useful for diagnosing stream-stop regressions.
            console.log(
                `${LOG_PREFIX.COMMAND} play() resume for ${room?.name}: ` +
                `byDur=${isLiveByDuration} byClass=${isLiveByClass} byMeta=${isLiveByMeta} ` +
                `byUri=${isLiveByUri} → isLive=${isLiveStream} | ` +
                `canSeek=${canSeek} pos=${pos} uriChanged=${uriChanged} | ` +
                `uri="${currentUri.slice(0, 80)}" dur="${durationStr}"`
            );

            if (pos && !isLiveStream && canSeek && !uriChanged) {
                try {
                    await renderer.seek('ABS_TIME', pos);
                    // Give the device time to process the seek before play() is issued;
                    // without this pause the device may not have updated its anchor yet
                    // and will still resume from the old position.
                    await this._delay(300);
                    // Record anchor + start-time so subsequent resumes can estimate
                    // position via elapsed time instead of querying the device.
                    if (room) {
                        const parts = pos.split(':').map(Number);
                        room._resumeAnchorSeconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
                        room._resumeAnchorTime = Date.now();
                    }
                    console.log(`${LOG_PREFIX.COMMAND} Resume anchor refreshed: ${room?.name} → ${pos}`);
                } catch (err) {
                    console.warn(`${LOG_PREFIX.COMMAND} Resume anchor refresh failed for ${room?.name}: ${err.message}`);
                }
            } else {
                // Seek skipped — just unfreeze the position tracker so elapsed time
                // continues to advance from the frozen position.
                if (room?._resumeAnchorSeconds !== undefined && !room._resumeAnchorTime) {
                    room._resumeAnchorTime = Date.now();
                }
                if (uriChanged) {
                    // Track changed externally; invalidate the stale tracker so the
                    // next resume starts fresh.
                    if (room) {
                        room._resumeAnchorSeconds = undefined;
                        room._resumeAnchorUri = currentUri;
                    }
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: URI changed externally for ${room?.name}`);
                } else if (isLiveStream) {
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: live stream for ${room?.name}`);
                } else if (!canSeek) {
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: not supported by device for ${room?.name}`);
                }
            }
        }

        // Partial zone drop: the zone renderer is PLAYING but this room's physical
        // renderer has lost its CDN proxy connection (RoomStates shows room=STOPPED
        // while zone=PLAYING).  The kernel won't auto-recover because the zone is
        // still alive.  Reconnect by dropping the room from the zone and re-adding
        // it via loadSingle (zone-join logic picks up the still-playing zone).
        if (room?._isLiveStream === true &&
            renderer.rendererState?.TransportState === 'PLAYING' &&
            renderer.rendererState?.RoomStates &&
            room._lastItemId) {
            const rm = renderer.rendererState.RoomStates.match(
                new RegExp(room.roomUdn + '=([A-Z_]+)')
            );
            if (rm && rm[1] === 'STOPPED') {
                const zoneManager = this._getZoneManager();
                if (zoneManager) {
                    const zoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
                    if (zoneUdn) {
                        console.log(
                            `${LOG_PREFIX.COMMAND} play() partial zone drop for ${room.name}` +
                            ` — dropping and rejoining zone ${zoneUdn}`
                        );
                        room._userStopped         = false;
                        room._lastPlayCommandTime = Date.now();
                        try {
                            await zoneManager.dropRoomFromZone(room.roomUdn);
                            await new Promise(r => setTimeout(r, 800));
                            await this.loadSingle(room.roomUdn, room._lastItemId);
                            return;
                        } catch (err) {
                            console.warn(
                                `${LOG_PREFIX.COMMAND} play() zone-rejoin failed for ${room.name}` +
                                ` (${err.message}); falling through`
                            );
                        }
                    }
                }
            }
        }

        // For live radio streams in STOPPED state, choose the restart path that
        // avoids creating a new TuneIn session for the device serial:
        //
        //  • Permanent CDN shortcut (highest priority, within dlna-playsingle guard):
        //    When the kernel has a dlna-playsingle:// state AND we have a cached
        //    permanent CDN URL (direct broadcaster stream, no TuneIn session token)
        //    for the same station, call SetAVTransportURI with the CDN URL and
        //    stripped TuneIn metadata.  The kernel plays it as a plain HTTP stream
        //    — zero ebrowse calls, zero rate-limit exposure, plays indefinitely even
        //    with 3+ rooms all active simultaneously.
        //    NOTE: the kernel does NOT share TuneIn sessions across separate zones/
        //    rooms for dlna-playsingle:// — each room creates its own session.  With
        //    3 rooms × 1 ebrowse per 60 s = 15 calls/5 min → rate-limit at ~300 s.
        //    Using a permanent CDN URL bypasses this entirely.
        //
        //  • dlna-playsingle:// guard (fallback when no permanent CDN cache):
        //    Use bare Play() so the kernel handles TuneIn session management.
        //    Used for non-permanent (TuneIn-dispatcher) streams or when no CDN
        //    URL is cached yet (first-ever play of the station).
        //
        //  • Path A (CDN URL + cached metadata):
        //    Fallback when AVTransportURI is already a CDN URL (from a previous
        //    integration-initiated restart that replaced dlna-playsingle://).  Uses the
        //    cached ebrowse DIDL so the kernel can renew the session at the scheduled
        //    interval without a new registration.
        //
        //  • Path B (CDN-direct fallback) / bare Play():
        //    Last resort when no cached metadata or CDN URL is available.
        if (room?._isLiveStream === true &&
            renderer.rendererState?.TransportState === 'STOPPED') {

            const kernelAvtUri = renderer.rendererState?.AVTransportURI || '';

            this._clearSuppressInterval(room);
            room._userStopped         = false;
            room._lastPlayCommandTime = Date.now();
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorTrack   = undefined;

            // Kernel has dlna-playsingle:// — before restarting independently,
            // check if another room is already PLAYING the same station so we can
            // join its zone instead of creating a new TuneIn session (which would
            // add another independent ebrowse cycle and risk rate-limiting).
            if (kernelAvtUri.startsWith('dlna-playsingle://')) {
                if (room._lastStationId) {
                    const zoneManager = this._getZoneManager();
                    if (zoneManager) {
                        for (const other of this._rooms.values()) {
                            if (other === room) continue;
                            if (!other._isLiveStream || !other._lastStationId) continue;
                            if (other._lastStationId !== room._lastStationId) continue;

                            const otherRenderer = this._getRendererForRoom(other);
                            const otherState    = otherRenderer?.rendererState?.TransportState;
                            if (otherState !== 'PLAYING' && otherState !== 'TRANSITIONING') continue;

                            const targetZoneUdn = zoneManager.getZoneUDNFromRoomUDN(other.roomUdn);
                            if (!targetZoneUdn) continue;

                            console.log(
                                `${LOG_PREFIX.COMMAND} play() live stream (STOPPED→zone-join)` +
                                ` for ${room.name} → ${other.name}` +
                                ` (station s${room._lastStationId}, zone ${targetZoneUdn})`
                            );
                            try {
                                await zoneManager.connectRoomToZone(room.roomUdn, targetZoneUdn, false);
                                return;
                            } catch (err) {
                                console.warn(
                                    `${LOG_PREFIX.COMMAND} play() zone-join failed for ${room.name}` +
                                    ` (${err.message}); falling back to native Play()`
                                );
                            }
                            break;
                        }
                    }
                }
                console.log(
                    `${LOG_PREFIX.COMMAND} play() live stream (STOPPED→native) for ${room.name}`
                );
                room._resumeAnchorUri = kernelAvtUri;
                return renderer.play();
            }

            // Kernel is in CDN-URL mode (left by a previous integration run that
            // called SetAVTransportURI directly).  Reload via loadSingle so the
            // kernel returns to dlna-playsingle:// mode with a proper TuneIn
            // session — the only way to restore ebrowse-based renewal.
            const avMeta        = renderer.rendererState?.AVTransportURIMetaData || '';
            const derivedItemId = this._deriveItemIdFromMeta(avMeta) || room._lastItemId;
            if (derivedItemId) {
                const trackUri = renderer.rendererState?.CurrentTrackURI || kernelAvtUri;
                console.log(
                    `${LOG_PREFIX.COMMAND} play() live stream (STOPPED→reload) for ${room.name}:` +
                    ` ${derivedItemId}`
                );
                room._resumeAnchorUri = trackUri;
                return renderer.loadSingle(derivedItemId);
            }

            // Last resort: bare Play() — kernel may be able to restart on its own.
            console.log(
                `${LOG_PREFIX.COMMAND} play() live stream (STOPPED→kernel restart) for ${room.name}`
            );
            room._resumeAnchorUri = kernelAvtUri;
            return renderer.play();
        }

        // Live stream in TRANSITIONING: normally the kernel is already contacting TuneIn
        // and we should not interrupt.  But if the kernel has been stuck in TRANSITIONING
        // for more than 30 s (e.g. because TuneIn is throttled and the CDN connection
        // never opens), force-stop it so Path A / Path B can restart with fresh metadata.
        if (room?._isLiveStream === true &&
            renderer.rendererState?.TransportState === 'TRANSITIONING') {
            const transAge = room._transitioningStartTime
                ? Date.now() - room._transitioningStartTime
                : 0;
            if (transAge < 30000) {
                console.log(
                    `${LOG_PREFIX.COMMAND} play() live stream (TRANSITIONING→wait) for ${room.name}` +
                    ` — kernel already loading, not interrupting`
                );
                return;
            }
            // Stuck for more than 30 s — force-stop and fall through to Path A/B.
            console.log(
                `${LOG_PREFIX.COMMAND} play() live stream (TRANSITIONING→stuck ${Math.round(transAge / 1000)}s)` +
                ` for ${room.name} — forcing stop, will restart`
            );
            await renderer.stop();
            // Brief pause for the STOPPED subscription event to arrive.
            await new Promise(r => setTimeout(r, 600));
        }

        // Final fallback — bare Play().  Covers PAUSED_PLAYBACK and any other
        // non-STOPPED / non-TRANSITIONING state.
        // When a device is in deep standby (e.g. physical speaker off) Play()
        // can fail with ECONNRESET.  For live streams, retry by reloading the
        // CDN URL so the kernel sends a fresh SetAVTransportURI to the device,
        // which wakes it up and re-establishes the TuneIn session.
        try {
            return await renderer.play();
        } catch (err) {
            if (room?._isLiveStream === true &&
                (err?.code === 'ECONNRESET' || err?.message?.includes('socket hang up'))) {
                const avMeta = renderer.rendererState?.AVTransportURIMetaData || '';
                const derivedItemId = this._deriveItemIdFromMeta(avMeta) || room._lastItemId;
                if (derivedItemId) {
                    console.log(
                        `${LOG_PREFIX.COMMAND} play() live stream — Play() ECONNRESET, ` +
                        `reloading via loadSingle for ${room?.name}: ${derivedItemId}`
                    );
                    this._clearSuppressInterval(room);
                    room._userStopped         = false;
                    room._lastPlayCommandTime = Date.now();
                    room._resumeAnchorSeconds = 0;
                    room._resumeAnchorTime    = Date.now();
                    room._resumeAnchorUri     = renderer.rendererState?.CurrentTrackURI
                                             || renderer.rendererState?.AVTransportURI;
                    room._resumeAnchorTrack   = undefined;
                    return renderer.loadSingle(derivedItemId);
                }
            }
            throw err;
        }
    }

    async pause(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);

        // Freeze the elapsed-time tracker at the current position estimate.
        // Doing this here — when the pause command is received — avoids a race
        // condition where a late subscription event from our corrective Seek
        // (which carries TransportState=PAUSED_PLAYBACK from while we were still
        // paused) arrives after _resumeAnchorTime was set, triggering a spurious
        // freeze that resets the position back to the first-pause value.
        if (room && room._resumeAnchorSeconds !== undefined && room._resumeAnchorTime) {
            const elapsed = (Date.now() - room._resumeAnchorTime) / 1000;
            room._resumeAnchorSeconds = Math.max(0, room._resumeAnchorSeconds + elapsed);
            room._resumeAnchorTime = null;
        }


        if (renderer) return renderer.pause();
    }

    async stop(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        // Stop resets the device; clear the elapsed-time tracker so the next
        // pause/resume cycle starts fresh from whatever new track/position is loaded.
        if (room) {
            room._resumeAnchorSeconds = undefined;
            room._resumeAnchorTime = null;
            // Mark as user-intentional stop so the suppress auto-restart is skipped.
            if (room._isLiveStream === true) {
                room._userStopped = true;
            }
        }

        // Multi-room zone guard: if this room is currently sharing a zone with
        // other rooms (zone-join result), calling renderer.stop() would stop the
        // entire zone and silence all other rooms in it.  Instead, drop just this
        // room from the zone — it stops naturally while the others keep playing.
        const zoneManager = this._getZoneManager();
        if (zoneManager && room) {
            const zoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
            if (zoneUdn && zoneManager.getRoomCountForZoneUDN(zoneUdn) > 1) {
                console.log(
                    `${LOG_PREFIX.COMMAND} stop() dropping ${room.name} from multi-room zone` +
                    ` ${zoneUdn} (${zoneManager.getRoomCountForZoneUDN(zoneUdn)} rooms)`
                );
                try {
                    await zoneManager.dropRoomFromZone(room.roomUdn);
                    return;
                } catch (err) {
                    console.warn(
                        `${LOG_PREFIX.COMMAND} dropRoomFromZone failed for ${room.name}` +
                        ` (${err.message}); falling back to zone stop`
                    );
                }
            }
        }

        try {
            return await renderer.stop();
        } catch (err) {
            // 701 = Transition not available (already stopped)
            if (err.errorCode === '701' || err.message?.includes('701')) {
                return;
            }
            // Try pause as fallback
            try {
                return await renderer.pause();
            } catch {
                console.warn(`${LOG_PREFIX.COMMAND} Stop/pause failed for ${room?.name}`);
            }
        }
    }

    async next(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.next();
    }

    /**
     * Sets shuffle on or off while preserving the current repeat mode.
     * UPnP play-mode matrix:
     *   shuffle=false, repeat=off  → NORMAL
     *   shuffle=true,  repeat=off  → SHUFFLE
     *   shuffle=false, repeat=one  → REPEAT_ONE
     *   shuffle=false, repeat=all  → REPEAT_ALL
     *   shuffle=true,  repeat=all  → RANDOM
     * @param {string} roomIdentifier
     * @param {boolean} shuffle
     */
    async setShuffle(roomIdentifier, shuffle) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        const current = (renderer.rendererState?.CurrentPlayMode || 'NORMAL').toUpperCase();
        const repeatAll = current === 'REPEAT_ALL' || current === 'RANDOM';
        const repeatOne = current === 'REPEAT_ONE';

        let mode;
        if (shuffle) {
            mode = repeatAll ? 'RANDOM' : 'SHUFFLE';
        } else {
            if (repeatAll) mode = 'REPEAT_ALL';
            else if (repeatOne) mode = 'REPEAT_ONE';
            else mode = 'NORMAL';
        }

        console.log(`${LOG_PREFIX.COMMAND} SetPlayMode ${room?.name}: shuffle=${shuffle} → ${mode}`);
        return renderer.setPlayMode(mode);
    }

    /**
     * Sets repeat mode while preserving the current shuffle state.
     * @param {string} roomIdentifier
     * @param {'off'|'one'|'all'} repeat - HA repeat mode string
     */
    async setRepeat(roomIdentifier, repeat) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        const current = (renderer.rendererState?.CurrentPlayMode || 'NORMAL').toUpperCase();
        const isShuffle = current === 'SHUFFLE' || current === 'RANDOM';

        let mode;
        if (repeat === 'all') {
            mode = isShuffle ? 'RANDOM' : 'REPEAT_ALL';
        } else if (repeat === 'one') {
            mode = 'REPEAT_ONE';
        } else {
            mode = isShuffle ? 'SHUFFLE' : 'NORMAL';
        }

        console.log(`${LOG_PREFIX.COMMAND} SetPlayMode ${room?.name}: repeat=${repeat} → ${mode}`);
        return renderer.setPlayMode(mode);
    }

    async playSystemSound(roomIdentifier, soundId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        // System sounds must be played on the physical renderer, not the virtual zone renderer
        const deviceManager = this._getDeviceManager();
        const renderer = deviceManager?.mediaRenderers.get(room.rendererUdn);

        if (renderer) {
            // Wake the device from standby if needed
            await this._wakeRenderer(renderer);
            return renderer.playSystemSound(soundId);
        } else {
             console.warn(`${LOG_PREFIX.COMMAND} System sound failed: No physical renderer found for room ${room.name} (${room.roomUdn})`);
        }
    }

    async prev(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) {
            try {
                // Call prev twice for proper track rewind behavior
                await renderer.prev();
                await renderer.prev();
            } catch (err) {
                // 701 = Transition not available
                if (err.errorCode === '701' || err.message?.includes('701')) {
                    console.warn(`${LOG_PREFIX.COMMAND} Prev (701) ignored for ${room?.name}`);
                    return;
                }
                throw err;
            }
        }
    }

    async setVolume(roomIdentifier, volume) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;
        const deviceManager = this._getDeviceManager();
        // Use the physical renderer so that setting one room's volume in a
        // multi-room zone does not affect the other rooms in the zone.
        // The zone renderer's SetVolume applies a relative delta to ALL members;
        // the physical renderer only adjusts the one device it controls.
        const physRenderer = deviceManager?.mediaRenderers.get(room.rendererUdn);
        const renderer = physRenderer || this._getRendererForRoom(room);
        if (renderer) return renderer.setVolume(volume);
    }

    async setMute(roomIdentifier, mute) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;
        const deviceManager = this._getDeviceManager();
        const physRenderer = deviceManager?.mediaRenderers.get(room.rendererUdn);
        const renderer = physRenderer || this._getRendererForRoom(room);
        if (renderer) return renderer.setMute(mute);
    }

    async setZoneVolume(roomIdentifier, volume) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;
        // Use the virtual (zone) renderer so that all members of the zone are
        // adjusted together, matching the native app's group-volume behaviour.
        // When the room is not in a multi-room zone the zone renderer IS the
        // physical renderer, so this degrades gracefully to per-room control.
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.setVolume(volume);
    }

    async enterStandby(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        console.log(`${LOG_PREFIX.COMMAND} Entering standby for ${room.name} (Room UDN: ${room.roomUdn}, Renderer UDN: ${room.rendererUdn})`);

        try {
            // We must target the physical renderer for standby
            const deviceManager = this._getDeviceManager();
            const renderer = deviceManager.mediaRenderers.get(room.rendererUdn);
            
            if (renderer) {
                if (renderer.enterManualStandby) {
                    await renderer.enterManualStandby();
                    console.log(`${LOG_PREFIX.COMMAND} Successfully entered standby for ${room.name}`);
                    
                    // Wait a moment for the renderer state to update
                    await this._delay(500);
                    
                    // Broadcast updated state immediately
                    this._broadcastRoomStates();
                } else {
                     console.warn(`${LOG_PREFIX.COMMAND} Renderer ${room.name} does not support enterManualStandby`);
                }
            } else {
                 console.warn(`${LOG_PREFIX.COMMAND} Renderer not found for ${room.name}. Available renderers: ${Array.from(deviceManager.mediaRenderers.keys()).join(', ')}`);
            }
        } catch (err) {
             console.error(`${LOG_PREFIX.COMMAND} Failed to enter standby for ${room.name}: ${err.message}`);
             throw err; // Re-throw so caller knows it failed
        }
    }

    // ========================================================================
    // GROUPING COMMANDS
    // ========================================================================

    async joinGroup(roomIdentifier, zoneIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) {
             console.warn(`${LOG_PREFIX.COMMAND} joinGroup: Room not found for identifier ${roomIdentifier}`);
             return;
        }

        const zoneManager = this._getZoneManager();
        const deviceManager = this._getDeviceManager();
        if (!zoneManager || !deviceManager) {
            console.error(`${LOG_PREFIX.COMMAND} joinGroup failed: managers not available`);
            return;
        }

        // Resolve target zone UDN
        let targetZoneUdn = zoneIdentifier;
        const targetRoom = this.findRoom(zoneIdentifier);
        
        // Check if target has a valid zone
        if (targetRoom) {
            if (targetRoom.zoneUdn) {
                targetZoneUdn = targetRoom.zoneUdn;
            } else {
                // Target room exists but has no zone (likely Spotify mode)
                // We need to create a zone for the target first
                console.log(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} has no zone (likely Spotify mode), creating zone first`);
                
                try {
                    // Create a standalone zone for the target room to force UPnP mode
                    await zoneManager.connectRoomToZone(targetRoom.roomUdn, '', false);
                    
                    // Wait for the zone to be created
                    const maxAttempts = 15;
                    let targetZoneCreated = false;
                    for (let i = 0; i < maxAttempts; i++) {
                        const newZoneUdn = zoneManager.getZoneUDNFromRoomUDN(targetRoom.roomUdn);
                        if (newZoneUdn && deviceManager.mediaRenderersVirtual.has(newZoneUdn)) {
                            console.log(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} now has zone: ${newZoneUdn}`);
                            targetZoneUdn = newZoneUdn;
                            targetZoneCreated = true;
                            
                            // Wait for the Raumfeld host to stabilize after zone creation
                            // Without this delay, immediate join attempts may silently fail
                            // Increased to 4s as 1.5s was sometimes insufficient
                            console.log(`${LOG_PREFIX.COMMAND} Waiting for zone to stabilize...`);
                            await this._delay(4000);
                            break;
                        }
                        if (i < maxAttempts - 1) {
                            await this._delay(500);
                        }
                    }
                    
                    if (!targetZoneCreated) {
                        console.warn(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} zone creation may not have completed`);
                        // Use room UDN as fallback
                        targetZoneUdn = targetRoom.roomUdn;
                    }
                } catch (err) {
                    console.warn(`${LOG_PREFIX.COMMAND} Failed to create zone for target ${targetRoom.name}: ${err.message}`);
                    targetZoneUdn = targetRoom.roomUdn;
                }
            }
        }

        console.log(`${LOG_PREFIX.COMMAND} Joining ${room.name} (${room.roomUdn}) to zone ${targetZoneUdn}`);

        // Check if the room being joined currently has a virtual renderer (i.e., is in UPnP mode)
        // If not, the room is likely in Spotify Connect mode and needs to be transitioned first
        let roomHasVirtualRenderer = false;
        const currentZoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
        if (currentZoneUdn && deviceManager.mediaRenderersVirtual.has(currentZoneUdn)) {
            roomHasVirtualRenderer = true;
        }
        
        if (!roomHasVirtualRenderer) {
            // Room is likely in Spotify Connect mode - transition it to UPnP mode first
            // by creating a standalone zone for it
            console.log(`${LOG_PREFIX.COMMAND} Room ${room.name} has no virtual renderer (likely Spotify mode), transitioning to UPnP mode first`);
            
            try {
                // Create a standalone zone for this room to force UPnP mode
                await zoneManager.connectRoomToZone(room.roomUdn, '', false);
                
                // Wait for the zone and virtual renderer to be created
                const maxAttempts = 15;
                let transitioned = false;
                for (let i = 0; i < maxAttempts; i++) {
                    const newZoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
                    if (newZoneUdn && deviceManager.mediaRenderersVirtual.has(newZoneUdn)) {
                        console.log(`${LOG_PREFIX.COMMAND} Room ${room.name} successfully transitioned to UPnP mode (zone: ${newZoneUdn})`);
                        transitioned = true;
                        break;
                    }
                    if (i < maxAttempts - 1) {
                        await this._delay(500);
                    }
                }
                
                if (!transitioned) {
                    console.warn(`${LOG_PREFIX.COMMAND} Room ${room.name} may not have fully transitioned to UPnP mode, attempting join anyway`);
                }
            } catch (err) {
                console.warn(`${LOG_PREFIX.COMMAND} Failed to create standalone zone for ${room.name}: ${err.message}`);
                // Continue anyway - the main connectRoomToZone might still work
            }
        }
        
        // Now connect room to the target zone
        try {
            await zoneManager.connectRoomToZone(room.roomUdn, targetZoneUdn);
            console.log(`${LOG_PREFIX.COMMAND} Successfully joined ${room.name} to zone ${targetZoneUdn}`);
        } catch (err) {
            console.error(`${LOG_PREFIX.COMMAND} joinGroup failed: ${err.message}`);
            throw err;
        }
    }

    async leaveGroup(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) {
             console.warn(`${LOG_PREFIX.COMMAND} leaveGroup: Room not found for identifier ${roomIdentifier}`);
             return;
        }

        console.log(`${LOG_PREFIX.COMMAND} Removing ${room.name} (${room.roomUdn}) from zone`);

        const zoneManager = this._getZoneManager();
        if (zoneManager) {
            try {
                // dropRoomFromZone takes the room UDN
                await zoneManager.dropRoomFromZone(room.roomUdn);
            } catch (err) {
                console.error(`${LOG_PREFIX.COMMAND} leaveGroup failed: ${err.message}`);
                throw err;
            }
        }
    }

    // ========================================================================
    // MEDIA LOADING
    // ========================================================================

    async loadUri(roomIdentifier, url) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        // TuneIn relay URLs (opml.radiotime.com/Tune.ashx?...&sid=sXXXX) stored as
        // AVTransportURI persist on a renderer even after the stream stops.  Every
        // time the integration re-subscribes to AVTransport events — at startup or
        // after any Raumfeld Host device-list change — node-raumkernel's internal
        // MediaListManager fetches that URI directly from TuneIn's servers.  That
        // counts as an extra session request against the shared serial
        // (78:a5:04:f1:82:ee), pushing it over TuneIn's rate limit and throttling
        // CDN tokens for ALL rooms including Kueche, even when it is the only room
        // currently playing.  The native Raumfeld app does not do this — it has no
        // MediaListManager that polls stored URIs for idle renderers.
        //
        // Fix: convert any TuneIn relay URL to a dlna-playsingle:// request via
        // the RadioTime ContentDirectory path (0/RadioTime/Search/s-{stationId}).
        // dlna-playsingle:// URIs are resolved locally by the Raumfeld kernel, so
        // MediaListManager never contacts TuneIn on re-subscription.
        const tuneInSid = url.match(/opml\.radiotime\.com\/Tune\.ashx.*?\bsid=(s\d+)\b/);
        if (tuneInSid) {
            const stationId = tuneInSid[1];
            console.log(
                `${LOG_PREFIX.MEDIA} TuneIn relay URL → ContentDirectory for station ` +
                `${stationId} on ${room.name} (prevents MediaListManager TuneIn requests)`
            );
            return this.loadSingle(roomIdentifier, `0/RadioTime/Search/s-${stationId}`);
        }

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadUri) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadUri) {
            await this._wakeRenderer(renderer);
            this._clearSuppressInterval(room);
            room._userStopped = false;
            // New track: reset position tracker and live-stream flag.
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorUri     = url;
            room._resumeAnchorTrack   = undefined; // Will be set by _extractNowPlaying after load
            room._isLiveStream          = undefined; // Will be re-detected from metadata
            room._radioOriginalUrl      = url;
            room._lastPlayCommandTime   = Date.now();
            return renderer.loadUri(url);
        }

        console.error(`${LOG_PREFIX.MEDIA} No renderer for URI load: ${room.name}`);
    }

    async loadContainer(roomIdentifier, containerId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadContainer) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadContainer) {
            await this._wakeRenderer(renderer);
            this._clearSuppressInterval(room);
            room._userStopped = false;
            // New track: reset position tracker and live-stream flag
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorTrack   = undefined;
            room._isLiveStream          = undefined;
            room._lastPlayCommandTime   = Date.now();
            console.log(`${LOG_PREFIX.MEDIA} Loading container ${containerId} on ${room.name}`);
            return renderer.loadContainer(containerId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for container load: ${room.name}`);
    }

    async loadSingle(roomIdentifier, itemId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        // Dedup guard: loading the exact same item twice within 60 s causes
        // two TuneIn session registrations in quick succession which TuneIn
        // throttles, producing drops as short as 7 s.  The most common trigger
        // is the user tapping a favorites item a second time because the HA
        // frontend hadn't yet refreshed to show PLAYING.  Silently ignore the
        // duplicate; the first load is already in flight.
        //
        // Exception: if the room is STOPPED (stream dropped), always allow the
        // reload so the user can immediately restart without waiting 60 s.
        const now = Date.now();
        {
            let renderer0 = this._getRendererForRoom(room);
            const ts0 = renderer0?.rendererState?.TransportState;
            const isActivelyPlaying = ts0 === 'PLAYING' || ts0 === 'TRANSITIONING';
            if (room._lastLoadSingleId === itemId &&
                room._lastLoadSingleTime &&
                now - room._lastLoadSingleTime < 60000 &&
                isActivelyPlaying) {
                console.log(
                    `${LOG_PREFIX.MEDIA} Ignoring duplicate loadSingle within 60 s` +
                    ` for ${room.name}: ${itemId}`
                );
                return;
            }
        }
        room._lastLoadSingleId   = itemId;
        room._lastLoadSingleTime = now;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadSingle) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadSingle) {
            await this._wakeRenderer(renderer);
            this._clearSuppressInterval(room);
            room._userStopped = false;

            // ZONE GROUPING: if another room is already playing the same station
            // (identified via browse-cache refID → TuneIn station ID), join this
            // room to the existing zone instead of starting a new TuneIn session.
            // This prevents TuneIn rate-limiting when multiple rooms play the same
            // station simultaneously — exactly what the native app does internally
            // by using a single zone with multiple physical renderers.
            const itemRefId   = this._getItemRefIdFromCache(itemId);
            let stationId     = (itemRefId || '').match(/s-s(\d+)$/)?.[1] || null;

            // Browse-cache miss (e.g. favourite item re-added with a new ID since last
            // fresh browse): try to infer the station ID from another room that has
            // already played the same item and has a stationId derived from running
            // kernel metadata (set in _extractNowPlaying from the live refID attribute).
            if (!stationId) {
                for (const r of this._rooms.values()) {
                    if (r !== room && r._lastItemId === itemId && r._lastStationId) {
                        stationId = r._lastStationId;
                        break;
                    }
                }
            }
            room._lastStationId = stationId;

            // Already-loaded guard: if the kernel already has the same
            // dlna-playsingle:// URI loaded for this item and the room is STOPPED,
            // calling SetAVTransportURI again causes the kernel to reply
            // "already active" (HA shows the confusing "already active but not
            // playing" error).  Call Play() directly instead.
            const currentAvtUri = renderer.rendererState?.AVTransportURI || '';
            if (currentAvtUri.startsWith('dlna-playsingle://') &&
                decodeURIComponent(currentAvtUri).includes(`iid=${itemId}`) &&
                renderer.rendererState?.TransportState === 'STOPPED') {
                console.log(
                    `${LOG_PREFIX.MEDIA} loadSingle already loaded (STOPPED) for ${room.name}` +
                    ` — calling Play() directly: ${itemId}`
                );
                this._clearSuppressInterval(room);
                room._userStopped         = false;
                room._lastPlayCommandTime = Date.now();
                room._lastItemId          = itemId;
                return renderer.play();
            }

            if (stationId) {
                const zoneManager = this._getZoneManager();
                if (zoneManager) {
                    for (const other of this._rooms.values()) {
                        if (other === room) continue;
                        if (!other._isLiveStream || !other._lastStationId) continue;
                        if (other._lastStationId !== stationId) continue;

                        const otherRenderer = this._getRendererForRoom(other);
                        const otherState    = otherRenderer?.rendererState?.TransportState;
                        if (otherState !== 'PLAYING' && otherState !== 'TRANSITIONING') continue;

                        const targetZoneUdn = zoneManager.getZoneUDNFromRoomUDN(other.roomUdn);
                        if (!targetZoneUdn) continue;

                        console.log(
                            `${LOG_PREFIX.MEDIA} loadSingle zone-join for ${room.name}` +
                            ` → ${other.name} (station s${stationId}, zone ${targetZoneUdn})`
                        );
                        room._lastItemId          = itemId;
                        room._isLiveStream        = true;
                        room._resumeAnchorSeconds = 0;
                        room._resumeAnchorTime    = Date.now();
                        room._resumeAnchorTrack   = undefined;
                        room._lastPlayCommandTime = Date.now();
                        try {
                            await zoneManager.connectRoomToZone(room.roomUdn, targetZoneUdn, false);
                            return;
                        } catch (err) {
                            console.warn(
                                `${LOG_PREFIX.MEDIA} Zone join failed for ${room.name}` +
                                ` (${err.message}); falling through to native loadSingle`
                            );
                        }
                        break;
                    }
                }
            }

            // CDN shortcut: if the room is STOPPED and we have a cached CDN URL
            // + station metadata for the SAME station being requested, bypass the
            // full TuneIn dispatch round-trip and call SetAVTransportURI with the
            // CDN URL directly.
            //
            // Why this matters:
            //   renderer.loadSingle(itemId) → kernel sets dlna-playsingle:// →
            //   kernel calls TuneIn ebrowse (fast, ~200 ms) → kernel calls TuneIn
            //   session-dispatch URL (Tune.ashx?id=<event-id>, throttle-prone →
            //   can take 90+ s) → kernel connects to CDN → PLAYING.
            //
            //   CDN shortcut: renderer.setAvTransportUri(CDN URL, meta with
            //   durability=0) → kernel immediately calls ebrowse (fast) → gets
            //   fresh session + confirms CDN URL → PLAYING in under 2 s.
            //
            //   The session-dispatch endpoint has a separate, stricter throttle
            //   tier than ebrowse, which is why loadSingle can take 90 s while
            //   ebrowse still returns durability=120.
            //
            // Station safety: only activate when the browse-cache refID for the
            // requested item matches the refID in the cached station metadata, so
            // a different-station loadSingle always falls through to the normal
            // kernel path.
            const savedCdnUri = room._lastSeenCdnUri;
            const savedMeta   = room._radioAvtMetadata;
            if (savedCdnUri && savedMeta && room._isLiveStream &&
                renderer.rendererState?.TransportState === 'STOPPED') {

                const cachedRefId = (savedMeta.match(/refID="([^"]+)"/) || [])[1];
                const itemRefId   = this._getItemRefIdFromCache(itemId);
                const stationId   = (s) => (s || '').match(/s-s(\d+)$/)?.[1];

                if (cachedRefId && itemRefId && stationId(cachedRefId) === stationId(itemRefId)) {
                    console.log(
                        `${LOG_PREFIX.MEDIA} loadSingle CDN shortcut for ${room.name}` +
                        ` (station ${stationId(cachedRefId)}, bypassing TuneIn dispatch):` +
                        ` ${savedCdnUri}`
                    );
                    room._lastItemId          = itemId;
                    room._resumeAnchorSeconds = 0;
                    room._resumeAnchorTime    = Date.now();
                    room._resumeAnchorTrack   = undefined;
                    room._lastPlayCommandTime = Date.now();
                    // Only use the CDN shortcut when the cached metadata still has
                    // ebrowse — without it the kernel cannot renew the CDN session
                    // and the stream drops after ~40–143 s.  If ebrowse was stripped
                    // by an older run, fall through to native loadSingle so the kernel
                    // gets a fresh dlna-playsingle:// with full TuneIn metadata.
                    const hasEbrowse = savedMeta.includes('<raumfeld:ebrowse>');
                    if (hasEbrowse) {
                        const metaCs = this._zeroDurability(savedMeta);
                        return renderer.setAvTransportUri(savedCdnUri, metaCs);
                    }
                    console.log(
                        `${LOG_PREFIX.MEDIA} loadSingle CDN shortcut skipped for ${room.name}` +
                        ` — cached metadata lacks ebrowse; falling through to native loadSingle`
                    );
                }
            }

            // Normal path: kernel handles TuneIn session from scratch.
            // New track: reset position tracker and live-stream flag.
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorTrack   = undefined;
            room._isLiveStream          = undefined;
            room._radioAvtMetadata      = undefined;
            room._lastPlayCommandTime   = Date.now();
            room._lastItemId            = itemId;
            // _lastStationId already set above; keep it for zone-grouping next time.
            console.log(`${LOG_PREFIX.MEDIA} Loading single ${itemId} on ${room.name}`);
            return renderer.loadSingle(itemId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for single load: ${room.name}`);
    }




    /**
     * Returns a copy of a DIDL-Lite metadata string with raumfeld:durability
     * forced to 0 (expired).  Passing durability=0 (or negative) to the
     * Raumfeld kernel's SetAVTransportURI signals that the current TuneIn
     * session is expired, prompting the kernel to immediately call the
     * raumfeld:ebrowse URL and obtain a fresh session URL.
     *
     * If durability is NOT zeroed at restart time the kernel reuses the
     * previous — already-expired — session URL, causing the stream to drop
     * almost immediately again.
     *
     * @param {string} metaXml  DIDL-Lite XML (may be empty)
     * @returns {string}  XML with durability replaced by 0, or original if no match
     */
    /**
     * Wakes up all physical renderers in a virtual renderer
     * Only wakes devices that are actually in standby
     * @param {*} renderer 
     */
    async _wakeRenderer(renderer) {
        if (!renderer) return;

        // Physical renderer
        if (renderer.leaveStandby && !renderer.getRoomRendererUDNs) {
            // Only wake if in standby
            const powerState = renderer.rendererState?.PowerState;
            if (powerState && powerState.includes('STANDBY')) {
                try {
                    await renderer.leaveStandby(true);
                } catch { /* ignore */ }
            }
            return;
        }

        // Virtual renderer - wake all physical members
        const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
        const deviceManager = this._getDeviceManager();

        for (const udn of memberUdns) {
            const physicalRenderer = deviceManager?.getMediaRenderer(udn);
            if (physicalRenderer?.leaveStandby) {
                // Only wake if in standby
                const powerState = physicalRenderer.rendererState?.PowerState;
                if (powerState && powerState.includes('STANDBY')) {
                    try {
                        await physicalRenderer.leaveStandby(true);
                    } catch { /* ignore */ }
                }
            }
        }
    }

    // ========================================================================
    // MEDIA BROWSING
    // ========================================================================

    async browse(objectId = '0') {
        // Return cached result immediately — calling ContentDirectory.Browse on
        // the Raumfeld kernel triggers an ebrowse call for every TuneIn radio
        // station in the container.  If a zone is playing one of those stations,
        // the kernel creates a new TuneIn session for it, tears down the current
        // stream, and reloads it — causing a ~3 s audible interruption.
        // Serving from cache avoids this on every request after the first.
        const cached = this._browseCache.get(objectId);
        if (cached) {
            console.log(`${LOG_PREFIX.BROWSE} Serving cached result for ${objectId} (${cached.length} items)`);
            return cached;
        }

        const mediaServer = this._getDeviceManager()?.getRaumfeldMediaServer();
        if (!mediaServer) {
            console.warn(`${LOG_PREFIX.BROWSE} No media server available`);
            return [];
        }

        try {
            const response = await mediaServer.browse(objectId);
            const items = this._parseBrowseResponse(response);
            this._browseCache.set(objectId, items);
            console.log(`${LOG_PREFIX.BROWSE} Cached ${items.length} items for ${objectId}`);
            // Persist to disk so addon restarts are served from cache (no kernel hit).
            try {
                const obj = Object.fromEntries(this._browseCache.entries());
                writeFileSync(BROWSE_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
            } catch (_) { /* best-effort */ }
            return items;
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} Error browsing ${objectId}: ${err.message}`);
            return [];
        }
    }

    /**
     * Clears the Browse result cache so the next Browse request re-fetches
     * from the Raumfeld kernel.  Call when the user's Favourites list may have
     * changed (e.g. after adding a new station in the native Raumfeld app).
     * Note: the first Browse after clearing will still trigger a brief stream
     * interruption if a TuneIn station is currently playing.
     */
    clearBrowseCache() {
        const count = this._browseCache.size;
        this._browseCache.clear();
        console.log(`${LOG_PREFIX.BROWSE} Browse cache cleared (${count} entries removed)`);
        try { writeFileSync(BROWSE_CACHE_FILE, '{}', 'utf8'); } catch (_) { /* best-effort */ }
    }

    /**
     * @param {string|Array} response 
     * @returns {Array}
     */
    _parseBrowseResponse(response) {
        if (!response) return [];

        if (typeof response === 'string') {
            return this._parseBrowseXml(response);
        }

        if (Array.isArray(response)) {
            return response.map(item => ({
                id: item.id,
                title: item.title || item.name || 'Unknown',
                artist: item.artist,
                album: item.album,
                image: this._sanitizeImageUrl(item.albumArtURI),
                class: item.class,
                playable: item.class?.startsWith('object.item') || item.class?.startsWith('object.container'),
                isContainer: item.class?.startsWith('object.container') ?? false
            }));
        }

        return [];
    }

    /**
     * Parses DIDL-Lite browse result XML
     * @param {string} xml 
     * @returns {Array}
     */
    _parseBrowseXml(xml) {
        const items = [];

        try {
            const parser = new (new JSDOM('')).window.DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');

            const getText = (node, tag) => node.getElementsByTagName(tag)[0]?.textContent ?? null;

            // Parse containers
            for (const node of doc.getElementsByTagName('container')) {
                items.push({
                    id: node.getAttribute('id'),
                    title: getText(node, 'dc:title') || 'Unknown',
                    artist: getText(node, 'upnp:artist'),
                    album: getText(node, 'upnp:album'),
                    image: this._sanitizeImageUrl(getText(node, 'upnp:albumArtURI')),
                    class: getText(node, 'upnp:class'),
                    playable: true,
                    isContainer: true
                });
            }

            // Parse items
            for (const node of doc.getElementsByTagName('item')) {
                items.push({
                    id:          node.getAttribute('id'),
                    refId:       node.getAttribute('refID') ?? '',
                    title:       getText(node, 'dc:title') || 'Unknown',
                    artist:      getText(node, 'upnp:artist'),
                    album:       getText(node, 'upnp:album'),
                    image:       this._sanitizeImageUrl(getText(node, 'upnp:albumArtURI')),
                    class:       getText(node, 'upnp:class'),
                    playable:    true,
                    isContainer: false
                });
            }
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} XML parse error: ${err.message}`);
        }

        return items;
    }

    // ========================================================================
    // SUBSCRIPTION FILTER
    // ========================================================================

    /**
     * Returns a copy of a DIDL-Lite metadata string with raumfeld:durability
     * set to 0.  When the kernel's SetAVTransportURI receives durability=0 it
     * treats the TuneIn session as already expired and immediately calls the
     * raumfeld:ebrowse URL to obtain a fresh CDN URL + new durability — typically
     * completing in under a second (ebrowse is not throttled even when TuneIn's
     * session-dispatch endpoint is).  Use this when restarting from cached CDN
     * data so the kernel refreshes its session at the CDN level without waiting
     * 60 s for the normal renewal window.
     *
     * @param {string} metaXml  DIDL-Lite XML
     * @returns {string}  XML with durability replaced by 0
     */
    _zeroDurability(metaXml) {
        return (metaXml || '').replace(
            /<raumfeld:durability>[^<]*<\/raumfeld:durability>/,
            '<raumfeld:durability>0</raumfeld:durability>'
        );
    }

    /**
     * Returns true when `url` is a permanent/direct CDN stream that does NOT
     * require TuneIn session management (no session token in the URL, no
     * ebrowse calls needed to keep the stream alive).
     *
     * Permanent examples: orf-live.ors-shoutcast.at, ice.somafm.com, most
     * Shoutcast/Icecast streams, direct broadcaster HTTP URLs.
     *
     * Non-permanent (session-dependent) examples:
     *   - *.radiotime.com / *.tunein.com  (TuneIn)
     *   - dispatcher.rndfnk.com           (ARD / BR dispatcher — contains token)
     *   - URLs with ?aggregator=tunein     (TuneIn-forwarded streams)
     *   - opml.radiotime.com/Tune.ashx    (TuneIn session URL)
     *
     * @param {string} url
     * @returns {boolean}
     */
    _isPermanentCdnUrl(url) {
        if (typeof url !== 'string') return false;
        if (!url.startsWith('https://') && !url.startsWith('http://')) return false;
        if (url.includes('radiotime.com'))   return false;
        if (url.includes('tunein.com'))      return false;
        if (url.includes('Tune.ashx'))       return false;
        if (url.includes('rndfnk.'))         return false;
        if (url.includes('aggregator=tunein')) return false;
        return true;
    }

    /**
     * Extracts a ContentDirectory item ID from DIDL-Lite metadata so we can
     * call renderer.loadSingle(itemId) to restore dlna-playsingle:// mode.
     *
     * Handles the "ext/" prefix that our own code wrote into the kernel's
     * metadata: converts it back to "0/" for ContentDirectory lookup.
     *
     * @param {string} metaXml  DIDL-Lite XML (may be null/undefined)
     * @returns {string|null}   ContentDirectory item ID (starts with "0/") or null
     */
    _deriveItemIdFromMeta(metaXml) {
        if (!metaXml) return null;
        const m = metaXml.match(/\bid="([^"]+)"/);
        if (!m) return null;
        let id = m[1];
        if (id.startsWith('ext/')) id = '0/' + id.slice(4);
        return id.startsWith('0/') ? id : null;
    }

    /**
     * Prepares DIDL-Lite metadata for SetAVTransportURI when the stream URL
     * is a direct CDN URL (satisfies _isPermanentCdnUrl).
     *
     * The CDN TCP connection is periodically closed by the server (~every 120 s).
     * The Raumfeld kernel MUST call the TuneIn ebrowse endpoint to obtain a fresh
     * session token and reconnect.  Removing ebrowse from the metadata breaks that
     * renewal and causes the stream to drop at ~143 s — so ebrowse is KEPT.
     *
     * What this function changes:
     *   - raumfeld:durability  → zeroed to 0  (forces an immediate ebrowse refresh
     *     so the kernel never waits for a stale timer to expire)
     *   - <res> elements containing a TuneIn session-dispatch URL
     *     (Tune.ashx?id=…)  → removed  (the CDN URL is provided directly, so
     *     session-dispatch is never needed; removing it ensures the kernel uses
     *     the cheap ebrowse renewal path, not the throttled dispatch path)
     *   - item id / parentID prefixes 0/ → ext/  (prevents ContentDirectory
     *     lookup by id, which would re-expose the item's session-dispatch res URL)
     *   - refID attribute  → stripped  (prevents the kernel from walking the
     *     ContentDirectory hierarchy back to the base RadioTime item)
     *
     * What is deliberately KEPT:
     *   - raumfeld:ebrowse  — CRITICAL: the kernel calls this every ~60 s to renew
     *     the CDN session; without it the stream drops when the CDN closes the TCP
     *     connection (typically at ~143 s)
     *   - raumfeld:section=RadioTime  — keeps live-radio behavior (no Pause action,
     *     no regular-media reconnect timer)
     *   - dc:title, upnp:albumArtURI, upnp:class, raumfeld:name — display fields
     *
     * @param {string} metaXml  DIDL-Lite XML
     * @returns {string}
     */
    _stripTuneInMarkers(metaXml) {
        if (!metaXml) return metaXml;
        return metaXml
            // Zero durability → kernel calls ebrowse immediately for a fresh token
            .replace(/<raumfeld:durability>[^<]*<\/raumfeld:durability>/g,
                     '<raumfeld:durability>0</raumfeld:durability>')
            // Remove session-dispatch <res> URL — CDN URL provided directly;
            // kernel uses ebrowse (cheap) not Tune.ashx?id= (throttled) for renewal
            .replace(/<res\b[^>]*>[^<]*Tune\.ashx\?id=[^<]*<\/res>/g, '')
            // Neutralise id/parentID so the kernel cannot look up the item in
            // ContentDirectory by id (which would re-expose the dispatch res URL)
            .replace(/\bid="0\//g, 'id="ext/')
            .replace(/\bparentID="0\//g, 'parentID="ext/')
            // Strip refID to stop the kernel walking back to the base RadioTime
            // item (which carries a session-dispatch res URL)
            .replace(/\s+refID="[^"]*"/g, '');
    }

    /**
     * Looks up a ContentDirectory item in the browse cache and returns its
     * refID attribute, or null if the item is not cached or has no refID.
     * Used by loadSingle() to verify a station match before applying the
     * CDN shortcut path.
     *
     * @param {string} itemId  Full ContentDirectory item path
     *                         (e.g. "0/Favorites/MyFavorites/62621")
     * @returns {string|null}
     */
    _getItemRefIdFromCache(itemId) {
        const lastSlash = itemId.lastIndexOf('/');
        if (lastSlash < 0) return null;
        const parentId    = itemId.substring(0, lastSlash);
        const cachedItems = this._browseCache.get(parentId);
        if (!Array.isArray(cachedItems)) return null;
        return cachedItems.find(i => i.id === itemId)?.refId || null;
    }

    /**
     * Parses the Raumfeld zone configuration and populates
     * global._raumfeldActivePhysicalHosts (Set<string> of IP addresses) with
     * the IPs of physical renderers belonging to ACTIVE zones.
     *
     * This unblocks the polling loop in tunein-patch.cjs so that physical
     * SUBSCRIBE requests can be allowed (active zones = "presence certificate"
     * that satisfies the kernel health-check) or suppressed (standby zones).
     *
     * IMPORTANT: physical device event endpoints use paths like /AVTransport/event
     * and do NOT embed the renderer UDN.  Filtering must be done on the HOST IP,
     * not on the URL path.  We build the IP set by looking up each active UDN in
     * deviceManager.mediaRenderers and reading the renderer's host property.
     *
     * If the IP lookup fails for all active renderers (renderer.host unavailable),
     * global._raumfeldActivePhysicalHosts is set to null (fail-open: all physical
     * subscriptions are allowed, same as v1.2.84 behaviour).
     *
     * Zone configuration structure (parsed XML via xml2js):
     *   zoneConfig.zoneConfig.zones[].zone[].room[].$.powerState
     *   zoneConfig.zoneConfig.zones[].zone[].room[].renderer[].$.udn
     *   zoneConfig.zoneConfig.unassignedRooms[].room[].$ / renderer[]
     *
     * @param {Object} zoneConfig - The zoneConfiguration object from the zone manager
     */
    _updateSubscriptionFilter(zoneConfig) {
        const activeUdns  = new Set();
        const activeNames = [];

        const root = zoneConfig?.zoneConfig;
        if (!root) {
            console.warn(`${LOG_PREFIX.REGISTRY} _updateSubscriptionFilter: unexpected zoneConfig structure`);
            global._raumfeldActivePhysicalHosts = null; // fail-open
            return;
        }

        // Collect every room entry from zones[] and unassignedRooms[]
        const rooms = [];
        for (const zonesEntry of root.zones ?? []) {
            for (const zone of zonesEntry.zone ?? []) {
                rooms.push(...(zone.room ?? []));
            }
        }
        for (const unassigned of root.unassignedRooms ?? []) {
            rooms.push(...(unassigned.room ?? []));
        }

        for (const room of rooms) {
            if (room?.$?.powerState !== 'ACTIVE') continue;
            for (const renderer of room.renderer ?? []) {
                const udn = renderer?.$?.udn;
                if (udn) {
                    activeUdns.add(udn);
                    activeNames.push(room.$.name ?? '?');
                }
            }
        }

        // Map active renderer UDNs → physical device IP addresses.
        // tunein-patch.cjs filters physical SUBSCRIBEs by IP (host), because
        // physical device event paths (/AVTransport/event) do not contain UDNs.
        const activeHosts = new Set();
        const dm = this._getDeviceManager();
        if (dm) {
            for (const [rendererUdn, renderer] of dm.mediaRenderers) {
                if (!activeUdns.has(rendererUdn)) continue;
                try {
                    // upnp-device-client / node-raumkernel exposes host as a
                    // plain string property on the device/renderer object.
                    let h = null;
                    if (typeof renderer.host === 'string')        h = renderer.host;
                    else if (typeof renderer.host === 'function') h = renderer.host();
                    else if (renderer.device) {
                        const d = renderer.device;
                        if (typeof d.host === 'string')        h = d.host;
                        else if (typeof d.host === 'function') h = d.host();
                    }
                    if (h) activeHosts.add(h.split(':')[0]); // strip port if present
                } catch { /* skip this renderer */ }
            }
        }

        if (activeHosts.size === 0 && activeUdns.size > 0) {
            // Could not determine any device IPs from the renderer objects.
            // Fall back to allowing ALL physical subscriptions so the presence
            // certificate is not accidentally lost.
            global._raumfeldActivePhysicalHosts = null; // null = fail-open
            console.warn(
                `${LOG_PREFIX.REGISTRY} Could not resolve renderer IPs — ` +
                `allowing all physical subscriptions (fail-open)`
            );
        } else {
            global._raumfeldActivePhysicalHosts = activeHosts;
        }

        console.log(
            `${LOG_PREFIX.REGISTRY} Active-zone physical renderers: ` +
            `${activeUdns.size} UDN(s), ${activeHosts.size} IP(s) resolved ` +
            `(${activeNames.join(', ') || 'none'})`
        );
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

    /**
     * Discovers the Raumfeld MediaServer's UPnP HTTP port (which is assigned
     * dynamically by the kernel on each boot) and stores all found ports in
     * global._raumfeldMediaServerPorts (a Set<string>).
     *
     * tunein-patch.cjs uses this set to suppress ContentDirectory SUBSCRIBE
     * requests by matching the request's port against the set, regardless of
     * what path the MediaServer uses for its ContentDirectory eventSubURL.
     *
     * Must be called after systemReady so that dm.mediaServers is populated.
     *
     * @param {Object|null} dm - deviceManager reference (may be null)
     */
    _updateMediaServerPorts(dm) {
        if (!dm?.mediaServers) {
            console.warn(`${LOG_PREFIX.REGISTRY} _updateMediaServerPorts: no mediaServers map on deviceManager`);
            return;
        }
        const ports = new Set();
        for (const [, ms] of dm.mediaServers) {
            try {
                const urlStr = ms?.upnpClient?.url;
                if (!urlStr) continue;
                // url.parse / new URL both work; use the built-in URL since we're
                // on Node 18+ and it handles this reliably.
                const parsed = new URL(urlStr);
                const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
                ports.add(port);
            } catch { /* skip malformed URL */ }
        }
        if (ports.size > 0) {
            global._raumfeldMediaServerPorts = ports;
            console.log(`${LOG_PREFIX.REGISTRY} MediaServer port(s) for ContentDirectory suppression: [${[...ports].join(', ')}]`);
        } else {
            console.warn(`${LOG_PREFIX.REGISTRY} _updateMediaServerPorts: no MediaServer ports found — ContentDirectory suppression will rely on path match only`);
        }
    }

    _getDeviceManager() {
        return this.raumkernel.managerDisposer?.deviceManager ?? null;
    }

    _getZoneManager() {
        return this.raumkernel.managerDisposer?.zoneManager ?? null;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ========================================================================
    // LEGACY API COMPATIBILITY
    // ========================================================================

    // These methods match the old API signatures for backward compatibility

    getRoomForUdnOrName(identifier) {
        return this.findRoom(identifier);
    }

    getRendererForRoom(room) {
        return this._getRendererForRoom(room);
    }

    async setPause(roomIdentifier, shouldPause) {
        return shouldPause ? this.pause(roomIdentifier) : this.play(roomIdentifier);
    }

    async setStop(roomIdentifier) {
        return this.stop(roomIdentifier);
    }

    async setNext(roomIdentifier) {
        return this.next(roomIdentifier);
    }

    async setPrev(roomIdentifier) {
        return this.prev(roomIdentifier);
    }

    async load(roomIdentifier, url) {
        return this.loadUri(roomIdentifier, url);
    }
}

export default RaumkernelHelper;
