"""Sensor entities for Teufel Raumfeld."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import RaumfeldApiClient
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Friendly display names for the raw "Source Select" values reported by
# Soundbars and Sounddecks. Kept in sync with media_player.py.
_SOURCE_RAW_TO_DISPLAY = {
    "Raumfeld": "Streaming",
    "LineIn": "Line-in",
    "OpticalIn": "Optical",
    "TV_ARC": "TV",
    "Spotify": "Spotify",
    "Radio": "Radio",
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Raumfeld sensors."""
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]

    known_udns = set()

    @callback
    def handle_message(data: dict[str, Any]) -> None:
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
        else:
            return

        new_entities = []
        for room in rooms:
            if room["udn"] not in known_udns:
                known_udns.add(room["udn"])
                new_entities.append(RaumfeldPowerStatusSensor(client, room))
                new_entities.append(RaumfeldInputSensor(client, room))

        if new_entities:
            async_add_entities(new_entities)

    client.register_listener(handle_message)

    # Trigger initial fetch if already connected
    if client.connected:
        hass.async_create_task(client.get_zones())


class RaumfeldSensorBase(SensorEntity):
    """Base class for Raumfeld room sensors."""

    _attr_has_entity_name = True

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        self._client = client
        self._udn = room_data["udn"]
        self._room_name = room_data.get("name")
        self.update_state(room_data)

    @property
    def device_info(self):
        """Return device info."""
        return {
            "identifiers": {(DOMAIN, self._udn)},
            "name": self._room_name,
            "manufacturer": "Teufel",
            "model": "Raumfeld Room",
        }

    async def async_added_to_hass(self) -> None:
        """Run when this Entity has been added to HA."""
        self._client.register_listener(self._handle_event)

    async def async_will_remove_from_hass(self) -> None:
        """Run when this Entity is being removed from HA."""
        self._client.unregister_listener(self._handle_event)

    @callback
    def _handle_event(self, data: dict[str, Any]) -> None:
        """Handle incoming events."""
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
        else:
            return

        for room in rooms:
            if room["udn"] == self._udn:
                self.update_state(room)
                self.async_write_ha_state()
                break

    def update_state(self, room_data: dict[str, Any]) -> None:
        """Update state from data. Implemented by subclasses."""
        raise NotImplementedError


class RaumfeldPowerStatusSensor(RaumfeldSensorBase):
    """Sensor showing the current power status: Off, On, or ECO mode."""

    _attr_icon = "mdi:power"
    _attr_name = "Power status"

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        super().__init__(client, room_data)
        self._attr_unique_id = f"{self._udn}_power_status"

    def update_state(self, room_data: dict[str, Any]) -> None:
        """Update state from data."""
        self._attr_available = True

        now_playing = room_data.get("nowPlaying", {})
        power_state = now_playing.get("powerState", "ACTIVE")

        if power_state == "MANUAL_STANDBY":
            self._attr_native_value = "Off"
        elif power_state == "AUTOMATIC_STANDBY":
            self._attr_native_value = "ECO mode"
        elif "STANDBY" in power_state:
            self._attr_native_value = "Off"
        else:
            self._attr_native_value = "On"


class RaumfeldInputSensor(RaumfeldSensorBase):
    """Sensor showing the current input source."""

    _attr_name = "Input"

    # Icons for each raw "Source Select" / current source value.
    _SOURCE_ICONS = {
        "Raumfeld": "mdi:cast-audio",
        "LineIn": "mdi:audio-input-rca",
        "OpticalIn": "mdi:toslink",
        "TV_ARC": "mdi:hdmi-port",
        "Spotify": "mdi:spotify",
        "Radio": "mdi:radio",
    }
    _DEFAULT_ICON = "mdi:import"

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        super().__init__(client, room_data)
        self._attr_unique_id = f"{self._udn}_input"

    def update_state(self, room_data: dict[str, Any]) -> None:
        """Update state from data."""
        self._attr_available = True

        now_playing = room_data.get("nowPlaying", {})
        current_source = now_playing.get("currentSource", "Raumfeld")

        self._attr_native_value = _SOURCE_RAW_TO_DISPLAY.get(
            current_source, current_source
        )
        self._attr_icon = self._SOURCE_ICONS.get(current_source, self._DEFAULT_ICON)
