import { WebSocketServer } from 'ws';
import RaumkernelHelper from './RaumkernelHelper.js';
import IntegrationManager from './IntegrationManager.js';

import fs from 'fs';

// Run integration install/update check on startup
const integrationManager = new IntegrationManager();
await integrationManager.ensureIntegrationInstalled();

let PORT = 3000;

// Override console methods to add timestamps
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function getTimestamp() {
    return new Date().toISOString();
}

console.log = function(...args) {
    originalLog(`[${getTimestamp()}]`, ...args);
};

console.warn = function(...args) {
    originalWarn(`[${getTimestamp()}]`, ...args);
};

console.error = function(...args) {
    originalError(`[${getTimestamp()}]`, ...args);
};
try {
    if (fs.existsSync('/data/options.json')) {
        const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        if (options.PORT) PORT = options.PORT;
    }
} catch {
    console.warn('Failed to read /data/options.json, using default port 3000');
}
if (process.env.PORT) PORT = process.env.PORT;
const wss = new WebSocketServer({ port: PORT });
const rkHelper = new RaumkernelHelper();

// Log startup information
let addonVersion = 'unknown';
try {
    const addonPackage = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
    addonVersion = addonPackage.version;
} catch {
    console.warn('Could not read addon version from package.json');
}

let nodeRaumkernelVersion = 'unknown';
try {
    const rkPackage = JSON.parse(fs.readFileSync('/app/node_modules/node-raumkernel/package.json', 'utf8'));
    nodeRaumkernelVersion = rkPackage.version;
} catch {
    console.warn('Could not read node-raumkernel version');
}

// Get installed integration version
const installedIntegrationVersion = integrationManager.getInstalledVersion() || 'not installed';

console.log(`Startup: addon=${addonVersion} node-raumkernel=${nodeRaumkernelVersion} integration=${installedIntegrationVersion}`);

console.log(`WebSocket server started on port ${PORT}`);

// Broadcast state to all connected clients
const broadcast = (data) => {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
};

// Handle state changes from Raumkernel
rkHelper.raumkernel.on('systemReady', (ready) => {
    broadcast({ type: 'systemReady', payload: ready });
});

rkHelper.raumkernel.on('combinedZoneStateChanged', () => {
    // rkHelper handles the update internally via its own listener
    const zones = rkHelper.getState().availableRooms;
    broadcast({ type: 'zoneStateChanged', payload: zones });
});

rkHelper.raumkernel.on('rendererStateChanged', () => {
     // This might be too noisy, but useful for real-time updates
     // Ideally we map this back to the Zone it belongs to or send generic update
     // For minimal implementation, rely on periodic or major events, or implement granular updates.
     // rkHelper.getAvailableZones() is triggered by combinedZoneStateChanged mostly.
     // But 'rendererStateChanged' is for volume/transport changes.
     
     // Trigger a broadcast of the full zone state for simplicity for now
     const fullState = rkHelper.getState(); 
     broadcast({ type: 'fullStateUpdate', payload: fullState });
});


wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Send initial state
    ws.send(JSON.stringify({ type: 'fullStateUpdate', payload: rkHelper.getState() }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received command:', data);
            
            const { command, payload } = data;
            
            switch (command) {
                case 'getZones':
                    ws.send(JSON.stringify({ type: 'zones', payload: rkHelper.getState().availableRooms }));
                    break;
                    
                case 'play':
                    // payload: { roomUdn, streamUrl } (streamUrl optional if just resuming)
                    if (payload.streamUrl) {
                        await rkHelper.load(payload.roomUdn, payload.streamUrl);
                    } else {
                        // Use play() directly to ensure wakeup logic is triggered
                        await rkHelper.play(payload.roomUdn);
                    }
                    break;

                case 'seek':
                    await rkHelper.seek(payload.roomUdn, payload.value);
                    break;
                    
                case 'pause':
                    await rkHelper.setPause(payload.roomUdn, true);
                    break;
                    
                case 'stop':
                    await rkHelper.setStop(payload.roomUdn);
                    break;
                    
                case 'next':
                    await rkHelper.setNext(payload.roomUdn);
                    break;
                    
                case 'prev':
                    await rkHelper.setPrev(payload.roomUdn);
                    break;
                    
                case 'setVolume':
                    await rkHelper.setVolume(payload.roomUdn, payload.volume);
                    break;
                    
                case 'setMute':
                    await rkHelper.setMute(payload.roomUdn, payload.mute);
                    break;
                
                case 'load':
                    await rkHelper.load(payload.roomUdn, payload.url);
                    break;

                case 'browse': {
                    const items = await rkHelper.browse(payload.objectId);
                    ws.send(JSON.stringify({ 
                        type: 'browseResult', 
                        payload: { 
                            objectId: payload.objectId, 
                            items: items 
                        }     
                    }));
                    break;
                }

                case 'loadContainer':
                    await rkHelper.loadContainer(payload.roomUdn, payload.containerId);
                    break;

                case 'loadSingle':
                    await rkHelper.loadSingle(payload.roomUdn, payload.itemId);
                    break;

                case 'playSystemSound':
                    await rkHelper.playSystemSound(payload.roomUdn, payload.soundId);
                    break;

                case 'enterStandby':
                    await rkHelper.enterStandby(payload.roomUdn);
                    break;

                case 'reboot': {
                    // payload: { roomUdn }
                    const roomInfo = rkHelper.findRoom(payload.roomUdn);
                    
                    if (roomInfo && roomInfo.rendererUdn) {
                        const deviceManager = rkHelper.raumkernel.managerDisposer.deviceManager;
                        const renderer = deviceManager.getMediaRenderer(roomInfo.rendererUdn);
                        
                        if (renderer) {
                            const host = renderer.host();
                            console.log(`Rebooting device at ${host} (${roomInfo.name})`);
                            try {
                                const { exec } = await import('child_process');
                                exec(`ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@${host} /sbin/reboot`, (error) => {
                                    if (error) {
                                        console.error(`Reboot failed for ${host}:`, error.message);
                                        return;
                                    }
                                    console.log(`Reboot command sent to ${host}`);
                                });
                            } catch (err) {
                                console.error(`Failed to execute reboot command:`, err.message);
                            }
                        } else {
                            console.warn(`Reboot failed: renderer not found for ${roomInfo.name}`);
                        }
                    } else {
                        console.warn(`Reboot failed: room not found for UDN ${payload.roomUdn}`);
                    }
                    break;
                }

                case 'joinGroup':
                    // payload: { roomUdn, zoneUdn }
                    await rkHelper.joinGroup(payload.roomUdn, payload.zoneUdn);
                    break;
                    
                case 'leaveGroup':
                    // payload: { roomUdn }
                    await rkHelper.leaveGroup(payload.roomUdn);
                    break;



                default:
                    console.warn('Unknown command:', command);
            }
            
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({ type: 'error', error: error.message }));
        }
    });
});
