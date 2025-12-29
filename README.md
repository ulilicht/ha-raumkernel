# Home Assistant Raumfeld Add-on & Integration

This project provides a Home Assistant integration for Teufel Raumfeld devices, based on `node-raumkernel`.

⚠️ **Note:** This project is currently in a **pre-release** state. Use at your own risk.

🤖 _The Project is primarily AI generated, with some manual adjustments. Use with caution._ ⚠️

It consists of:

- A **Home Assistant Add-on** wrapping node-raumkernel and exposing a WebSocket API.
- A **Home Assistant Integration** (Custom Component) that communicates with the Add-on.

## Installation

### 1. Install the Add-on

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**.
2. Add the repository:

   [![add Add-on Repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fulilicht%2Fha-raumkernel)

3. Install **Teufel Raumfeld (Raumkernel Addon)**.
4. **Start** the Add-on. The default WebSocket port is `3000`.

### 2. Install the Integration

1. Ensure the Add-on is running.
2. If using HACS, add this repository [https://github.com/ulilicht/ha-raumkernel](https://github.com/ulilicht/ha-raumkernel) as a **Custom Repository** (Type: Integration).
3. Restart Home Assistant.
4. Go to **Settings > Devices & Services > Add Integration** and search for **Teufel Raumfeld (Raumkernel Addon)**.
5. Configure the host (local IP of your HA instance) and port (`3000`).

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

## Project Structure

- `ha-raumkernel-addon/`: Node.js Add-on source.
- `custom_components/teufel_raumfeld_raumkernel/`: Python Integration source.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
