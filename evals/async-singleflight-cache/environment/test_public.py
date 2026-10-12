import asyncio
import unittest

from flightcache import SingleFlightCache


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class PublicTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_value_is_reused(self):
        clock = Clock()
        cache = SingleFlightCache(clock=clock)
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            return calls

        self.assertEqual(await cache.get("key", load, ttl=10), 1)
        clock.now = 5
        self.assertEqual(await cache.get("key", load, ttl=10), 1)
        self.assertEqual(calls, 1)

    async def test_misses_are_coalesced(self):
        cache = SingleFlightCache()
        release = asyncio.Event()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            await release.wait()
            return 42

        waiters = [asyncio.create_task(cache.get("k", load, ttl=1)) for _ in range(5)]
        await asyncio.sleep(0)
        release.set()
        self.assertEqual(await asyncio.gather(*waiters), [42] * 5)
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
