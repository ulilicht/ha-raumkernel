"""API Client for Raumfeld Add-on."""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class RaumfeldApiClient:
    """Raumfeld API Client."""

    def __init__(
        self,
        host: str,
        port: int = 3000,
        session: aiohttp.ClientSession = None,
    ) -> None:
        """Initialize."""
        self._host = host
        self._port = port
        self._session = session
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._loop = asyncio.get_running_loop()

    @property
    def connected(self) -> bool:
        """Return True if connected."""
        return self._ws is not None and not self._ws.closed

    async def connect(self) -> None:
        """Connect to the WebSocket and maintain connection."""
        if self._session is None:
            self._session = aiohttp.ClientSession()

        url = f"ws://{self._host}:{self._port}"

        while True:
            try:
                _LOGGER.debug("Connecting to %s", url)
                self._ws = await self._session.ws_connect(url)
                _LOGGER.info("Connected to Raumfeld Add-on at %s", url)

                # Fetch initial state
                await self.get_zones()

                # Listen for messages - this blocks until connection is closed
                await self._listen()

                _LOGGER.warning(
                    "Disconnected from Raumfeld Add-on. Reconnecting in 5s..."
                )

            except asyncio.CancelledError:
                _LOGGER.debug("Connection task cancelled")
                raise
            except (aiohttp.ClientError, OSError) as err:
                _LOGGER.warning(
                    "Failed to connect to Raumfeld Add-on at %s: %s. Retrying in 5s...",
                    url,
                    str(err) or type(err).__name__,
                )
            except Exception as err:
                _LOGGER.error("Unexpected error in connection loop: %s", err)

            # Reset ws to ensure connected property returns False
            if self._ws and not self._ws.closed:
                await self._ws.close()
            self._ws = None

            # Wait before retrying
            await asyncio.sleep(5)

    async def close(self) -> None:
        """Close the client."""
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()

    async def _listen(self) -> None:
        """Listen for messages."""
        if not self._ws:
            return

        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    self._dispatch_event(data)
                except json.JSONDecodeError:
                    _LOGGER.error("Received invalid JSON: %s", msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                _LOGGER.error(
                    "WebSocket connection closed with exception %s",
                    self._ws.exception(),
                )
                break

    def _dispatch_event(self, data: dict[str, Any]) -> None:
        """Dispatch events to listeners."""
        for listener in self._listeners:
            try:
                listener(data)
            except Exception as err:
                _LOGGER.error("Error in listener: %s", err)

    def register_listener(self, listener: Callable[[dict[str, Any]], None]) -> None:
        """Register a message listener."""
        self._listeners.append(listener)

    async def send_command(self, command: str, payload: dict[str, Any]) -> None:
        """Send a command."""
        if not self._ws or self._ws.closed:
            _LOGGER.error("Not connected to Raumfeld Add-on (ws=%s)", self._ws)
            raise ConnectionError("Not connected to Raumfeld Add-on")

        _LOGGER.info("Sending command %s with payload %s", command, payload)
        msg = {"command": command, "payload": payload}
        await self._ws.send_json(msg)

    async def get_zones(self) -> None:
        """Request zones."""
        await self.send_command("getZones", {})

    async def play(self, room_udn: str, stream_url: str | None = None) -> None:
        """Play."""
        await self.send_command("play", {"roomUdn": room_udn, "streamUrl": stream_url})

    async def pause(self, room_udn: str) -> None:
        """Pause."""
        await self.send_command("pause", {"roomUdn": room_udn})

    async def stop(self, room_udn: str) -> None:
        """Stop."""
        await self.send_command("stop", {"roomUdn": room_udn})

    async def next(self, room_udn: str) -> None:
        """Next track."""
        await self.send_command("next", {"roomUdn": room_udn})

    async def prev(self, room_udn: str) -> None:
        """Previous track."""
        await self.send_command("prev", {"roomUdn": room_udn})

    async def set_volume(self, room_udn: str, volume: int) -> None:
        """Set volume."""
        await self.send_command("setVolume", {"roomUdn": room_udn, "volume": volume})

    async def set_mute(self, room_udn: str, mute: bool) -> None:
        """Set mute."""
        await self.send_command("setMute", {"roomUdn": room_udn, "mute": mute})

    async def browse(self, object_id: str) -> list[dict[str, Any]]:
        """Browse media."""
        future = self._loop.create_future()

        def _response_handler(data: dict[str, Any]) -> None:
            if (
                data.get("type") == "browseResult"
                and data.get("payload", {}).get("objectId") == object_id
            ):
                if not future.done():
                    future.set_result(data["payload"]["items"])

        self.register_listener(_response_handler)

        try:
            await self.send_command("browse", {"objectId": object_id})
            return await asyncio.wait_for(future, timeout=10.0)
        except TimeoutError:
            _LOGGER.error("Timeout waiting for browse result for %s", object_id)
            return []
        finally:
            if _response_handler in self._listeners:
                self._listeners.remove(_response_handler)

    async def load_container(self, room_udn: str, container_id: str) -> None:
        """Load container."""
        await self.send_command(
            "loadContainer", {"roomUdn": room_udn, "containerId": container_id}
        )

    async def load_single(self, room_udn: str, item_id: str) -> None:
        """Load single item."""
        await self.send_command("loadSingle", {"roomUdn": room_udn, "itemId": item_id})

    async def load_uri(self, room_udn: str, uri: str) -> None:
        """Load URI."""
        await self.send_command("load", {"roomUdn": room_udn, "url": uri})

    async def enter_standby(self, room_udn: str) -> None:
        """Enter standby."""
        await self.send_command("enterStandby", {"roomUdn": room_udn})

    async def play_system_sound(self, room_udn: str, sound_id: str) -> None:
        """Play system sound."""
        await self.send_command(
            "playSystemSound", {"roomUdn": room_udn, "soundId": sound_id}
        )
