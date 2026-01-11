# Home Assistant Raumfeld Add-on & Integration

This project provides a Home Assistant integration for Teufel Raumfeld devices, based on `node-raumkernel`.

- ⚠️ **Pre-release:** _This project is currently in a pre-release state. Use at your own risk._
- 🤖 **AI Generated:** _This project is primarily AI generated, with some manual adjustments._

It consists of:

- A **Home Assistant Add-on** wrapping node-raumkernel and exposing a WebSocket API.
- A **Home Assistant Integration** (Custom Component) that communicates with the Add-on.

## 🎵 Key Features

- **All key features of Raumfeld integrated:** Playback information, Play, Pause, Prev/Back, Volume, Turn on/off
- **Spotify Support:** Stable support if Raumfeld devices are in Spotify single room mode.
- **Room and Zone Handling:** Supports multi-room. Allows grouping/ungrouping of Raumfeld devices.
- **Music Assistant:** Integrates well with Music Assistant.
- **Fast reaction times and efficient device usage:** Works well, for example, if you send multiple volume increase commands in quick succession (e.g., through a Zigbee remote).
- **Reboot Raumfeld Devices:** Dedicated button to reboot Raumfeld devices if necessary. The addon itself has a minimal footprint on the speakers.

## Installation

### Option A: Bundled Installation of Add-on and Integration

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**.
2. Add [this repository](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fulilicht%2Fha-raumkernel) to Homeassistant and install the **Teufel Raumfeld (Raumkernel Addon)**: 

 [![add Repository to Home Assistant and Install Add-on](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=4161e1f2_ha-raumkernel-addon&repository_url=https%3A%2F%2Fgithub.com%2Fulilicht%2Fha-raumkernel)

4. Start the Add-on. It will automatically install the integration on first startup.
5. Restart Home Assistant.
6. Go to **Settings > Devices & Services > Add Integration** and search for **Teufel Raumfeld (Raumkernel Addon)**.

### Option B: Separate Installation of Add-on and Integration

#### 1. Install the Add-on

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**.
2. Add [this repository](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fulilicht%2Fha-raumkernel) to Homeassistant and install the **Teufel Raumfeld (Raumkernel Addon)**: 

 [![add Repository to Home Assistant and Install Add-on](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=4161e1f2_ha-raumkernel-addon&repository_url=https%3A%2F%2Fgithub.com%2Fulilicht%2Fha-raumkernel)

3. Check the configuration: Disable automatic installation of the integration.
4. **Start** the Add-on. The default WebSocket port is `3000`.

#### 2. Install the Integration through HACS

1. Ensure the Add-on is running.
2. In HACS, add this repository [https://github.com/ulilicht/ha-raumkernel](https://github.com/ulilicht/ha-raumkernel) as a **Custom Repository** (Type: Integration).
3. Restart Home Assistant.
4. Go to **Settings > Devices & Services > Add Integration** and search for **Teufel Raumfeld (Raumkernel Addon)**.
5. Configure the host (local IP of your HA instance) and port (`3000`).

⚠️ If you want to switch from HACS to Option A (automatic install), you need to completely remove the `custom_components/teufel_raumfeld_raumkernel` folder previously created by HACS.

## Key Concepts: Rooms vs Zones

Understanding how Raumfeld organizes devices is key to using this integration:

- **Room**: A logical group of one or more physical speakers (e.g., a stereo pair).
- **Zone**: A dynamic grouping of one or more Rooms playing the same music synchronously. Zones have **dynamic identifiers** (`zoneUdn`) that change whenever the group composition changes.

### How this integration handles them:

1. **Stable Room Entities**: Home Assistant entities are created for **Rooms**, not Zones. This ensures your entities are stable and don't disappear when you group or ungroup speakers.
2. **Transparent Control**: When you send a command (Play, Pause, Volume) to a Room entity:
   - If the room is **standalone**, the command is sent to the room's own renderer.
   - If the room is **grouped**, the command is routed to the **Zone's Virtual Renderer**, affecting the entire group synchronously.
3. **Mode Abstraction**: The integration automatically handles transitions between playback modes (e.g., switching from Spotify Connect to a Raumfeld Favorite).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) in the repository folder for information on how to develop and deploy this addon.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
