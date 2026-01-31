import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import RaumkernelHelper from './RaumkernelHelper.js';
import IntegrationManager from './IntegrationManager.js';

import fs from 'fs';

// Run integration install/update check on startup
const integrationManager = new IntegrationManager();
await integrationManager.ensureIntegrationInstalled();

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

const runtimeConfig = {
    PORT: 3000,
    RAUMFELD_HOST: process.env.RAUMFELD_HOST || '',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    ENABLE_AUTO_INSTALL: true,
    DEVELOPER_MODE: false
};

try {
    if (fs.existsSync('/data/options.json')) {
        const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        if (options.PORT) runtimeConfig.PORT = options.PORT;
        if (options.RAUMFELD_HOST) runtimeConfig.RAUMFELD_HOST = options.RAUMFELD_HOST;
        if (options.LOG_LEVEL !== undefined) runtimeConfig.LOG_LEVEL = options.LOG_LEVEL;
        if (options.ENABLE_AUTO_INSTALL !== undefined) runtimeConfig.ENABLE_AUTO_INSTALL = options.ENABLE_AUTO_INSTALL;
        if (options.DEVELOPER_MODE !== undefined) runtimeConfig.DEVELOPER_MODE = options.DEVELOPER_MODE;
        
        // Propagate to process.env as some modules might use it
        process.env.RAUMFELD_HOST = runtimeConfig.RAUMFELD_HOST;
        process.env.LOG_LEVEL = runtimeConfig.LOG_LEVEL;
    }
} catch {
    console.warn('Failed to read /data/options.json, using defaults');
}

if (process.env.PORT) runtimeConfig.PORT = process.env.PORT;
let PORT = runtimeConfig.PORT;

const server = createServer((req, res) => {
    // Serve a simple status page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Raumkernel Addon</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; background: #f6f6f6; }
                .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 2rem; }
                h1 { color: #333; margin-top: 0; }
                .status { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 1rem; background: #e6fcf5; color: #0ca678; font-weight: bold; font-size: 0.875rem; }
                .info { margin-top: 1.5rem; color: #666; line-height: 1.6; }
                .config-section { margin-top: 2rem; border-top: 1px solid #eee; padding-top: 1rem; }
                .config-item { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
                .config-label { font-weight: 500; color: #555; }
                .config-value { font-family: monospace; color: #333; }
                code { background: #eee; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
                
                .json-box { 
                    background: #fcfcfc; 
                    color: #333;
                    padding: 1rem; 
                    border: 1px solid #eee; 
                    border-radius: 4px; 
                    overflow: auto; 
                    max-height: 800px; 
                    font-family: monospace; 
                    font-size: 0.85em;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <span class="status">● Running</span>
                <h1>Raumkernel Addon</h1>
                <p>The addon server is running actively.</p>
                <div class="info">
                    <p>To use this addon, configure the Home Assistant integration to connect to this host on port <code>${PORT}</code>.</p>
                    <p><strong>WebSocket Status:</strong> <span id="wsStatusText">Ready for connections</span><br>
                    <strong>Integration Version:</strong> ${installedIntegrationVersion}<br>
                    <strong>Addon Version:</strong> ${addonVersion}</p>
                    
                    <div class="config-section">
                        <h3>Configuration</h3>
                        <div class="config-item">
                            <span class="config-label">PORT</span>
                            <span class="config-value">${runtimeConfig.PORT}</span>
                        </div>
                        <div class="config-item">
                            <span class="config-label">RAUMFELD_HOST</span>
                            <span class="config-value">${runtimeConfig.RAUMFELD_HOST || '<i>(Auto-Discovery)</i>'}</span>
                        </div>
                        <div class="config-item">
                            <span class="config-label">LOG_LEVEL</span>
                            <span class="config-value">${runtimeConfig.LOG_LEVEL}</span>
                        </div>
                        <div class="config-item">
                            <span class="config-label">ENABLE_AUTO_INSTALL</span>
                            <span class="config-value">${runtimeConfig.ENABLE_AUTO_INSTALL}</span>
                        </div>
                        <div class="config-item">
                            <span class="config-label">DEVELOPER_MODE</span>
                            <span class="config-value">${runtimeConfig.DEVELOPER_MODE}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card">
                <h3>Full System State</h3>
                <pre id="jsonOutput" class="json-box">Waiting for data...</pre>
            </div>

            <script>
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${wsProtocol}//\${window.location.host}\`;
                const outputEl = document.getElementById('jsonOutput');
                
                let ws;

                function connect() {
                    ws = new WebSocket(wsUrl);

                    ws.onopen = () => {
                        // console.log('Connected');
                    };

                    ws.onclose = () => {
                        setTimeout(connect, 3000);
                    };

                    ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.type === 'fullStateUpdate') {
                                outputEl.textContent = JSON.stringify(data.payload, null, 2);
                            }
                        } catch (e) {
                            console.error('Error parsing message', e);
                        }
                    };
                }

                connect();
            </script>
        </body>
        </html>
    `);
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
    console.log(`HTTP and WebSocket server started on port ${PORT}`);
});
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

console.log(`Startup: addon=${addonVersion} node-raumkernel=${nodeRaumkernelVersion} integration=${installedIntegrationVersion}`);

// console.log(\`WebSocket server started on port \${PORT}\`); // Logged by server.listen callback now

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
