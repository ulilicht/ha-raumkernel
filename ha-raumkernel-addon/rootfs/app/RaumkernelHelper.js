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

// ============================================================================
// MAIN CLASS
// ============================================================================

class RaumkernelHelper {
    constructor() {
        /** @type {RaumkernelLib.Raumkernel} */
        this.raumkernel = new RaumkernelLib.Raumkernel();
        
        /** @type {Map<string, RoomInfo>} Room registry keyed by RENDERER UDN */
        this._rooms = new Map();
        
        /** @type {{isReady: boolean, availableRooms: RoomState[], favourites: []}} */
        this._state = {
            isReady: false,
            availableRooms: [],
            favourites: []
        };

        this._setupLogging();
        this._setupEventHandlers();
        this.raumkernel.init();
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
            if (ready) this._refreshRoomRegistry();
        });

        this.raumkernel.on('systemHostLost', () => {
            console.log(`${LOG_PREFIX.REGISTRY} System host lost`);
            this._resetState();
        });

        this.raumkernel.on('combinedZoneStateChanged', (data) => {
            this._handleZoneStateChange(data);
        });

        this.raumkernel.on('rendererStateChanged', () => {
            this._broadcastRoomStates();
        });
    }

    _resetState() {
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
            if (!zone.isZone) continue;

            const memberUdns = zone.rooms?.map(r => r.udn) ?? [];
            
            for (const memberUdn of memberUdns) {
                const room = this._findRoomByAnyUdn(memberUdn);
                if (room) {
                    room.zoneUdn = zone.udn;
                    room.zoneMembers = memberUdns;
                    room.zoneName = zone.name;
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
    }

    // ========================================================================
    // ROOM LOOKUP
    // ========================================================================

    /**
     * Finds a room by UDN or name
     * @param {string} identifier - Room UDN, zone UDN, or partial name
     * @returns {RoomState|undefined}
     */
    findRoom(identifier) {
        if (!identifier) return undefined;

        const rooms = this._state.availableRooms;

        // Try exact room UDN match
        let room = rooms.find(r => r.roomUdn === identifier);
        if (room) return room;

        // Try zone UDN match
        room = rooms.find(r => r.zoneUdn === identifier);
        if (room) return room;

        // Try partial name match (only if unambiguous)
        if (identifier.length > 2) {
            const matches = rooms.filter(r => 
                r.name.toLowerCase().includes(identifier.toLowerCase())
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
        if (this._rooms.has(udn)) {
            return this._rooms.get(udn);
        }

        // Try room UDN
        for (const room of this._rooms.values()) {
            if (room.roomUdn === udn) return room;
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

        // Parse transport actions
        let canPlayPause = false;
        let canPlayNext = false;
        let canPlayPrev = false;

        const actions = state.CurrentTransportActions ?? '';
        if (actions) {
            canPlayPause = /Play|Pause|Stop/i.test(actions);
            canPlayNext = actions.includes('Next');
            canPlayPrev = actions.includes('Previous');
        }

        // Fallback: Enable next/prev for container-based content (e.g. playlists)
        // only if not already explicitly enabled by transport actions.
        if (!canPlayNext || !canPlayPrev) {
            const isContainer = this._isContainerMedia(metadata.classString);
            const hasMultipleTracks = (parseInt(state.NumberOfTracks) || 0) > 1;
            const isRadio = metadata.classString?.includes('audioBroadcast') || 
                          metadata.classString?.includes('radio');
            
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

        return {
            artist: metadata.artist,
            track: metadata.track,
            image: metadata.image?.replace('http://', 'https://') ?? '',
            isPlaying,
            isLoading,
            isMuted: state.Mute === 1,
            volume: parseInt(state.Volume) || 0,
            canPlayPause,
            canPlayNext: !isLoading && canPlayNext,
            canPlayPrev: !isLoading && canPlayPrev,
            duration: state.CurrentTrackDuration || 0,
            position: state.RelativeTimePosition || 0,
            powerState
        };
    }

    _isContainerMedia(classString) {
        if (!classString) return false;
        // UPnP container classes start with object.container
        // We also include podcast to handle podcast containers, but exclude items like musicTrack
        return classString.startsWith('object.container') || 
               /playlist|album|podcastContainer/i.test(classString);
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
        const result = { track: '', artist: '', album: '', image: '', classString: '' };
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
        } catch (err) {
            console.warn(`${LOG_PREFIX.MEDIA} Metadata parse error: ${err.message}`);
        }

        return result;
    }

    // ========================================================================
    // PLAYBACK COMMANDS
    // ========================================================================

    async play(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) {
            // Wake the device from standby if needed
            await this._wakeRenderer(renderer);
            return renderer.play();
        }
    }

    async pause(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.pause();
    }

    async stop(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

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
            // Call prev twice for proper track rewind behavior
            renderer.prev();
            return renderer.prev();
        }
    }

    async setVolume(roomIdentifier, volume) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.setVolume(volume);
    }

    async setMute(roomIdentifier, mute) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.setMute(mute);
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
    // MEDIA LOADING
    // ========================================================================

    async loadUri(roomIdentifier, url) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadUri) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadUri) {
            await this._wakeRenderer(renderer);
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
            console.log(`${LOG_PREFIX.MEDIA} Loading container ${containerId} on ${room.name}`);
            return renderer.loadContainer(containerId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for container load: ${room.name}`);
    }

    async loadSingle(roomIdentifier, itemId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadSingle) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadSingle) {
            await this._wakeRenderer(renderer);
            console.log(`${LOG_PREFIX.MEDIA} Loading single ${itemId} on ${room.name}`);
            return renderer.loadSingle(itemId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for single load: ${room.name}`);
    }

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
        const mediaServer = this._getDeviceManager()?.getRaumfeldMediaServer();
        if (!mediaServer) {
            console.warn(`${LOG_PREFIX.BROWSE} No media server available`);
            return [];
        }

        try {
            const response = await mediaServer.browse(objectId);
            return this._parseBrowseResponse(response);
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} Error browsing ${objectId}: ${err.message}`);
            return [];
        }
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
                image: item.albumArtURI?.replace('http://', 'https://') ?? null,
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
                    image: getText(node, 'upnp:albumArtURI')?.replace('http://', 'https://') ?? null,
                    class: getText(node, 'upnp:class'),
                    playable: true,
                    isContainer: true
                });
            }

            // Parse items
            for (const node of doc.getElementsByTagName('item')) {
                items.push({
                    id: node.getAttribute('id'),
                    title: getText(node, 'dc:title') || 'Unknown',
                    artist: getText(node, 'upnp:artist'),
                    album: getText(node, 'upnp:album'),
                    image: getText(node, 'upnp:albumArtURI')?.replace('http://', 'https://') ?? null,
                    class: getText(node, 'upnp:class'),
                    playable: true,
                    isContainer: false
                });
            }
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} XML parse error: ${err.message}`);
        }

        return items;
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

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
