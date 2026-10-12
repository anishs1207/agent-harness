import asyncio
import gc
import math
import unittest

from flightcache import SingleFlightCache


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


async def eventually(predicate, attempts=20):
    for _ in range(attempts):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition did not become true")


class CacheContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_bad_durations_without_calling_loader(self):
        cache = SingleFlightCache()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1

        for ttl, stale in [(-1, 0), (1, -1), (math.nan, 0), (math.inf, 0), ("x", 0)]:
            with self.subTest(ttl=ttl, stale=stale):
                with self.assertRaises(ValueError):
                    await cache.get("x", load, ttl=ttl, stale_ttl=stale)
        self.assertEqual(calls, 0)

    async def test_stale_returns_immediately_and_only_one_refresh_runs(self):
        clock = Clock()
        cache = SingleFlightCache(clock=clock)
        release = asyncio.Event()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            if calls > 1:
                await release.wait()
            return calls

        self.assertEqual(await cache.get("k", load, ttl=2, stale_ttl=5), 1)
        clock.now = 3
        values = await asyncio.wait_for(
            asyncio.gather(*(cache.get("k", load, ttl=2, stale_ttl=5) for _ in range(8))),
            1,
        )
        self.assertEqual(values, [1] * 8)
        self.assertEqual(calls, 2)
        release.set()
        await eventually(lambda: calls == 2)
        await asyncio.sleep(0)
        self.assertEqual(await cache.get("k", load, ttl=2, stale_ttl=5), 2)

    async def test_cancelled_waiter_does_not_cancel_flight(self):
        cache = SingleFlightCache()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return "done"

        first = asyncio.create_task(cache.get("k", load, ttl=10))
        await started.wait()
        second = asyncio.create_task(cache.get("k", load, ttl=10))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertEqual(await asyncio.wait_for(second, 1), "done")
        self.assertEqual(calls, 1)

    async def test_load_survives_when_only_waiter_is_cancelled(self):
        cache = SingleFlightCache()
        started = asyncio.Event()
        release = asyncio.Event()

        async def load():
            started.set()
            await release.wait()
            return 9

        waiter = asyncio.create_task(cache.get("k", load, ttl=10))
        await started.wait()
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        release.set()
        await eventually(lambda: bool(getattr(cache, "_entries", {})))

        async def forbidden():
            raise AssertionError("completed value was not cached")

        self.assertEqual(await cache.get("k", forbidden, ttl=10), 9)

    async def test_invalidate_detaches_old_flight_and_blocks_publication(self):
        cache = SingleFlightCache()
        old_started = asyncio.Event()
        old_release = asyncio.Event()

        async def old_load():
            old_started.set()
            await old_release.wait()
            return "old"

        old_waiter = asyncio.create_task(cache.get("k", old_load, ttl=100))
        await old_started.wait()
        await cache.invalidate("k")

        async def new_load():
            return "new"

        self.assertEqual(
            await asyncio.wait_for(cache.get("k", new_load, ttl=100), 1),
            "new",
        )
        old_release.set()
        self.assertEqual(await old_waiter, "old")

        async def forbidden():
            raise AssertionError("old flight overwrote the new value")

        self.assertEqual(await cache.get("k", forbidden, ttl=100), "new")

    async def test_clear_blocks_all_inflight_publication(self):
        cache = SingleFlightCache()
        releases = {key: asyncio.Event() for key in ("a", "b")}

        async def load(key):
            await releases[key].wait()
            return key

        tasks = [asyncio.create_task(cache.get(k, lambda k=k: load(k), ttl=5)) for k in releases]
        await asyncio.sleep(0)
        await cache.clear()
        for event in releases.values():
            event.set()
        self.assertEqual(await asyncio.gather(*tasks), ["a", "b"])
        self.assertEqual(await cache.__len__(), 0)

    async def test_failed_refresh_preserves_stale_and_exception_is_retrieved(self):
        clock = Clock()
        cache = SingleFlightCache(clock=clock)
        loop = asyncio.get_running_loop()
        messages = []
        old_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: messages.append(context))
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            if calls > 1:
                raise RuntimeError("refresh failed")
            return "stale"

        try:
            await cache.get("k", load, ttl=1, stale_ttl=10)
            clock.now = 2
            self.assertEqual(await cache.get("k", load, ttl=1, stale_ttl=10), "stale")
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            gc.collect()
            self.assertEqual(messages, [])
            self.assertEqual(await cache.get("k", load, ttl=1, stale_ttl=10), "stale")
        finally:
            loop.set_exception_handler(old_handler)

    async def test_foreground_failures_are_not_cached(self):
        cache = SingleFlightCache()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise LookupError("boom")
            return "ok"

        with self.assertRaisesRegex(LookupError, "boom"):
            await cache.get("k", load, ttl=3)
        self.assertEqual(await cache.get("k", load, ttl=3), "ok")
        self.assertEqual(calls, 2)

    async def test_lru_reads_affect_eviction(self):
        cache = SingleFlightCache(max_entries=2)

        async def value(v):
            return v

        await cache.get("a", lambda: value("A"), ttl=100)
        await cache.get("b", lambda: value("B"), ttl=100)
        await cache.get("a", lambda: value("wrong"), ttl=100)
        await cache.get("c", lambda: value("C"), ttl=100)
        calls = 0

        async def reload_b():
            nonlocal calls
            calls += 1
            return "B2"

        self.assertEqual(await cache.get("b", reload_b, ttl=100), "B2")
        self.assertEqual(calls, 1)

    async def test_zero_capacity_still_coalesces(self):
        cache = SingleFlightCache(max_entries=0)
        release = asyncio.Event()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            await release.wait()
            return calls

        tasks = [asyncio.create_task(cache.get("k", load, ttl=10)) for _ in range(3)]
        await asyncio.sleep(0)
        release.set()
        self.assertEqual(await asyncio.gather(*tasks), [1, 1, 1])
        self.assertEqual(await cache.__len__(), 0)
        self.assertEqual(await cache.get("k", load, ttl=10), 2)

    async def test_different_keys_load_concurrently(self):
        cache = SingleFlightCache()
        both_started = asyncio.Event()
        count = 0

        async def load(value):
            nonlocal count
            count += 1
            if count == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 0.5)
            return value

        self.assertEqual(
            await asyncio.gather(
                cache.get("a", lambda: load("A"), ttl=1),
                cache.get("b", lambda: load("B"), ttl=1),
            ),
            ["A", "B"],
        )


if __name__ == "__main__":
    unittest.main()
