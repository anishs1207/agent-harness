"""Async stale-while-revalidate cache.

This implementation is intentionally incomplete. Its API is already deployed,
so repair the internals without changing the public surface.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from typing import Generic, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


@dataclass
class _Entry(Generic[V]):
    value: V
    fresh_until: float
    stale_until: float


class SingleFlightCache(Generic[K, V]):
    def __init__(
        self,
        max_entries: int = 128,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_entries < 0:
            raise ValueError("max_entries must be non-negative")
        self._max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[K, _Entry[V]] = OrderedDict()
        self._flights: dict[K, asyncio.Task[V]] = {}
        self._lock = asyncio.Lock()

    async def get(
        self,
        key: K,
        loader: Callable[[], Awaitable[V]],
        *,
        ttl: float,
        stale_ttl: float = 0,
    ) -> V:
        # BUGS: stale reads block, cancellation spreads to all waiters, and an
        # invalidated flight can publish its result.
        async with self._lock:
            now = self._clock()
            entry = self._entries.get(key)
            if entry is not None and now <= entry.fresh_until:
                return entry.value

            flight = self._flights.get(key)
            if flight is None:
                flight = asyncio.create_task(
                    self._load(key, loader, ttl=ttl, stale_ttl=stale_ttl)
                )
                self._flights[key] = flight

        return await flight

    async def _load(
        self,
        key: K,
        loader: Callable[[], Awaitable[V]],
        *,
        ttl: float,
        stale_ttl: float,
    ) -> V:
        try:
            value = await loader()
            now = self._clock()
            async with self._lock:
                self._entries[key] = _Entry(
                    value=value,
                    fresh_until=now + ttl,
                    stale_until=now + ttl + stale_ttl,
                )
                while len(self._entries) > self._max_entries:
                    self._entries.popitem(last=False)
            return value
        finally:
            async with self._lock:
                self._flights.pop(key, None)

    async def invalidate(self, key: K) -> None:
        async with self._lock:
            self._entries.pop(key, None)

    async def clear(self) -> None:
        async with self._lock:
            self._entries.clear()

    async def __len__(self) -> int:
        async with self._lock:
            return len(self._entries)
