# Repair `SingleFlightCache`

The Python package in `/app` contains a broken asynchronous cache used by a
request fan-out service. Repair `src/flightcache/cache.py`. Do not change the
public API in `src/flightcache/__init__.py`.

`SingleFlightCache(max_entries, clock)` stores values by key. `clock` is a
callable returning monotonic seconds. Its public coroutine
`get(key, loader, *, ttl, stale_ttl=0)` must have these semantics:

1. `ttl` and `stale_ttl` are finite, non-negative numbers; otherwise raise
   `ValueError` before calling `loader`.
2. A value is **fresh** through `loaded_at + ttl`. A fresh hit returns it
   without calling `loader`.
3. It is **stale but usable** after freshness and through
   `loaded_at + ttl + stale_ttl`. A stale hit returns the old value immediately
   and starts one background refresh for that key. It must not wait for that
   refresh.
4. A missing or fully expired key waits for a load. Concurrent callers for the
   same key share exactly one load. The caller that creates a flight determines
   its loader and TTLs.
5. Cancelling any waiter must not cancel the shared load or affect other
   waiters. If every waiter is cancelled, the load still runs to completion and
   may populate the cache.
6. `invalidate(key)` removes the cached value. If a load for that key started
   before invalidation, its result may still be returned to existing waiters,
   but must never repopulate the cache. A later `get` starts a new independent
   load. `clear()` applies the same rule to every key.
7. Loader exceptions propagate to foreground waiters and are never cached. A
   failed background refresh must leave the stale value available until its
   original stale deadline. No "Task exception was never retrieved" warnings
   may be emitted.
8. Successful reads and writes update true LRU order. Once `max_entries` is
   exceeded, evict the least-recently-used cached value. Flights do not count as
   entries. `max_entries=0` is allowed and disables value storage without
   disabling coalescing.
9. Calls for different keys must be able to load concurrently. Never await a
   user loader while holding internal state locks.

`invalidate`, `clear`, and `__len__` remain async methods. The package must use
only the Python standard library and pass the existing tests. Add your own tests
if useful, but do not weaken or delete any tests.
