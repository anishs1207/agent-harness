"""Race-safe asyncio stale-while-revalidate cache."""

from __future__ import annotations

import asyncio
import math
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


@dataclass
class _Flight(Generic[V]):
    task: asyncio.Task[V]
    generation: int


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
        self._flights: dict[K, _Flight[V]] = {}
        self._generations: dict[K, int] = {}
        self._background: set[asyncio.Task[V]] = set()
        self._lock = asyncio.Lock()

    @staticmethod
    def _duration(value: float, name: str) -> float:
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"{name} must be a finite non-negative number") from exc
        if not math.isfinite(result) or result < 0:
            raise ValueError(f"{name} must be a finite non-negative number")
        return result

    def _start_flight(
        self,
        key: K,
        loader: Callable[[], Awaitable[V]],
        ttl: float,
        stale_ttl: float,
    ) -> _Flight[V]:
        generation = self._generations.get(key, 0)
        task = asyncio.create_task(
            self._load(key, loader, ttl, stale_ttl, generation)
        )
        flight = _Flight(task, generation)
        self._flights[key] = flight
        self._background.add(task)
        task.add_done_callback(self._finish_background)
        return flight

    def _finish_background(self, task: asyncio.Task[V]) -> None:
        self._background.discard(task)
        if not task.cancelled():
            task.exception()  # retrieve a background failure

    async def get(
        self,
        key: K,
        loader: Callable[[], Awaitable[V]],
        *,
        ttl: float,
        stale_ttl: float = 0,
    ) -> V:
        ttl = self._duration(ttl, "ttl")
        stale_ttl = self._duration(stale_ttl, "stale_ttl")

        async with self._lock:
            now = self._clock()
            entry = self._entries.get(key)
            if entry is not None and now <= entry.fresh_until:
                self._entries.move_to_end(key)
                return entry.value

            if entry is not None and now <= entry.stale_until:
                self._entries.move_to_end(key)
                if key not in self._flights:
                    self._start_flight(key, loader, ttl, stale_ttl)
                return entry.value

            if entry is not None:
                del self._entries[key]

            flight = self._flights.get(key)
            if flight is None:
                flight = self._start_flight(key, loader, ttl, stale_ttl)

        return await asyncio.shield(flight.task)

    async def _load(
        self,
        key: K,
        loader: Callable[[], Awaitable[V]],
        ttl: float,
        stale_ttl: float,
        generation: int,
    ) -> V:
        task = asyncio.current_task()
        try:
            value = await loader()
            loaded_at = self._clock()
            async with self._lock:
                current = self._flights.get(key)
                may_publish = (
                    current is not None
                    and current.task is task
                    and self._generations.get(key, 0) == generation
                )
                if may_publish and self._max_entries:
                    self._entries[key] = _Entry(
                        value,
                        loaded_at + ttl,
                        loaded_at + ttl + stale_ttl,
                    )
                    self._entries.move_to_end(key)
                    while len(self._entries) > self._max_entries:
                        self._entries.popitem(last=False)
            return value
        finally:
            async with self._lock:
                current = self._flights.get(key)
                if current is not None and current.task is task:
                    del self._flights[key]

    async def invalidate(self, key: K) -> None:
        async with self._lock:
            self._entries.pop(key, None)
            self._generations[key] = self._generations.get(key, 0) + 1
            self._flights.pop(key, None)

    async def clear(self) -> None:
        async with self._lock:
            keys = self._entries.keys() | self._flights.keys()
            for key in keys:
                self._generations[key] = self._generations.get(key, 0) + 1
            self._entries.clear()
            self._flights.clear()

    async def __len__(self) -> int:
        async with self._lock:
            return len(self._entries)
