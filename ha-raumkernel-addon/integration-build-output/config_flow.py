"""Config flow for Teufel Raumfeld (Raumkernel Addon) integration."""

import logging
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN

try:
    from homeassistant.components.hassio import get_addon_info, is_hassio

    HASSIO_AVAILABLE = True
except ImportError:
    HASSIO_AVAILABLE = False

_LOGGER = logging.getLogger(__name__)

DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST, default="localhost"): str,
        vol.Required(CONF_PORT, default=3000): int,
    }
)


class RaumfeldConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Teufel Raumfeld (Raumkernel Addon)."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # validate connection here if needed
            return self.async_create_entry(
                title="Teufel Raumfeld (Raumkernel Addon)", data=user_input
            )

        # Try to discover addon if running on Hass.io
        host = "localhost"
        port = 3000

        if HASSIO_AVAILABLE and is_hassio(self.hass):
            for slug in ("local_ha-raumkernel-addon", "ha-raumkernel-addon"):
                try:
                    info = await get_addon_info(self.hass, slug)
                    if info and info.get("state") == "started":
                        _LOGGER.debug("Found Raumfeld (Raumkernel) addon: %s", slug)
                        port = info.get("options", {}).get("PORT", 3000)
                        break
                except Exception:  # pylint: disable=broad-except
                    continue

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=host): str,
                    vol.Required(CONF_PORT, default=port): int,
                }
            ),
            errors=errors,
        )
