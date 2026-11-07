"""The Teufel Raumfeld (Raumkernel Addon) integration."""

import json
import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.loader import async_get_integration

from .api import RaumfeldApiClient
from .const import DOMAIN, ISSUE_RESTART_REQUIRED

_LOGGER = logging.getLogger(__name__)

# Persistent notification created by the add-on's IntegrationManager after it
# copies new integration files. Superseded by the Repairs issue below.
ADDON_RESTART_NOTIFICATION_ID = "teufel_raumfeld_restart_required"


def _read_installed_version() -> str | None:
    """Read the integration version from manifest.json on disk."""
    try:
        manifest = json.loads(
            (Path(__file__).parent / "manifest.json").read_text(encoding="utf-8")
        )
        return manifest.get("version")
    except (OSError, ValueError):
        return None


PLATFORMS: list[Platform] = [
    Platform.MEDIA_PLAYER,
    Platform.BUTTON,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Teufel Raumfeld (Raumkernel Addon) from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]

    client = RaumfeldApiClient(host, port)

    # The add-on replaces the integration files when it updates, then restarts,
    # which makes us reconnect. Compare the version we're running with the one
    # now on disk and, if they differ, offer a restart via a Repairs issue.
    loaded_version = str((await async_get_integration(hass, DOMAIN)).version)
    ir.async_delete_issue(hass, DOMAIN, ISSUE_RESTART_REQUIRED)

    async def _check_for_integration_update() -> None:
        installed_version = await hass.async_add_executor_job(_read_installed_version)
        if not installed_version or installed_version == loaded_version:
            return

        _LOGGER.info(
            "Integration updated on disk from %s to %s; restart required",
            loaded_version,
            installed_version,
        )
        ir.async_create_issue(
            hass,
            DOMAIN,
            ISSUE_RESTART_REQUIRED,
            is_fixable=True,
            is_persistent=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_RESTART_REQUIRED,
            translation_placeholders={"version": installed_version},
            data={"version": installed_version},
        )
        await hass.services.async_call(
            "persistent_notification",
            "dismiss",
            {"notification_id": ADDON_RESTART_NOTIFICATION_ID},
        )

    client.register_connect_callback(_check_for_integration_update)

    # Connect in background to avoid blocking startup
    entry.async_create_background_task(
        hass, client.connect(), "teufel_raumfeld_raumkernel_connect"
    )

    hass.data[DOMAIN][entry.entry_id] = client

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(
        entry, PLATFORMS
    ):
        client = hass.data[DOMAIN].pop(entry.entry_id)
        await client.close()

    return unload_ok
