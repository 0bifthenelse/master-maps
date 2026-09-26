# W2-T14 Worker pool and client decode

Scope: CONTRACTS.md section 3. Owns `src/lib/render/protocol.ts`, `src/lib/render/tileWorker.ts`,
`src/lib/render/workerPool.ts`, `src/lib/render/loadRenderTile.ts`, `tests/unit/worker-protocol.test.ts`.
No file owned by another agent was modified.

## Files

### src/lib/render/protocol.ts (23 lines)

Wire types only, no runtime behaviour beyond two narrowing guards.

- `DecodeRequest` = `{ t: 'decode'; tileId: string; gen: number; buffer: ArrayBuffer }` (protocol.ts:3-8)
- `CancelRequest` = `{ t: 'cancel'; gen: number }` (protocol.ts:10-13)
- `DecodedResponse` = `{ t: 'decoded'; tileId, gen, header, layers, meta }` (protocol.ts:15-22)
- `ErrorResponse` = `{ t: 'error'; tileId, gen, message }` (protocol.ts:24-29)
- `isDecodedResponse` / `isErrorResponse` type guards (protocol.ts:31-38)

Codec types are referenced only by indexed access, `DecodedRenderTile['header']`, `['layers']`, `['meta']`
(protocol.ts:1, 18-20). No codec sub-type is named. This is deliberate: it makes the pool immune to any
sub-type naming drift in `codec.ts` and keeps the only hard coupling to the contract being the three
`DecodedRenderTile` slots named in section 2.

### src/lib/render/tileWorker.ts (53 lines)

Module worker body. On decode it checks the generation floor, calls `decodeRenderTile`, and replies with
every layer `ArrayBuffer` in the transfer list (tileWorker.ts:7-16 collects, 18-22 posts).

Generation floor: a decode whose `gen` is below the highest cancel the worker has seen is answered with an
`error` reply and never decoded (tileWorker.ts:24-33, 48-50). The worker cannot interrupt a decode already
running on its thread, so the floor only rejects work that has not started; the pool is responsible for the
in-flight side of cancellation (see below).

### src/lib/render/workerPool.ts (352 lines)

Two layers, deliberately separated so the scheduling logic is testable without spawning workers.

`DecodeQueue` (workerPool.ts:47-179) is pure state plus a callback sink. It owns the FIFO `jobs` array, the
`(gen, tileId)` keyed `pending` map, and the counters. It never touches a Worker.

`TileWorkerPool` (workerPool.ts:210-335) owns the workers and drives the queue.

Pool size, `resolvePoolSize` (workerPool.ts:38-41):

```
Math.min(6, Math.max(2, (hardwareConcurrency ?? 4) - 2))
```

Missing `hardwareConcurrency` falls back to 4, giving the floor of 2. Measured clamp behaviour in tests:
2 -> 2, 3 -> 2, 4 -> 2, 5 -> 3, 6 -> 4, 8 -> 6, 16 -> 6, 64 -> 6, undefined -> 2.

### src/lib/render/loadRenderTile.ts (137 lines)

`loadRenderTile(tileId, signal?)` (loadRenderTile.ts:107-138):

1. Rejects a tileId that is not `/^[a-zA-Z0-9_-]+$/` or contains `..` (loadRenderTile.ts:108-110), matching
   the existing `loadTile` guard in `src/lib/data/loadTile.ts:87`.
2. LRU hit: reinserts to refresh recency and returns (loadRenderTile.ts:111-116).
3. In-flight hit: returns the existing promise, so N concurrent callers cause one fetch and one decode
   (loadRenderTile.ts:118-121). The in-flight map is keyed by tileId alone, which is correct because a
   second caller for the same tile wants the same bytes.
4. Miss: `fetch('/api/map/render/<tileId>')` as `arrayBuffer`, then hand the buffer to the pool at the
   current generation (loadRenderTile.ts:124-126).
5. Success: measures decoded bytes, stores, evicts to budget (loadRenderTile.ts:128-134). The in-flight
   entry is always cleared in `finally` (loadRenderTile.ts:135-137).

`measuredTileBytes` (loadRenderTile.ts:70-77) sums `positions.byteLength + indices.byteLength +
ranges.byteLength` across layers. This is the real retained cost of the decoded object, not the wire size,
so the LRU budget measures memory rather than transfer.

Cache: `DEFAULT_RENDER_TILE_CACHE_BYTES` = 256 MB (loadRenderTile.ts:6), overridden via
`configureRenderTileCache({ maxBytes })` (loadRenderTile.ts:33-36). Eviction walks insertion order and
subtracts the recorded size (loadRenderTile.ts:78-87). A hit reinserts, so Map order is true LRU order.

`getRenderTileCacheStats()` (loadRenderTile.ts:38-50) returns entries, byteSize, maxBytes, inFlight, hits,
misses, evictions, plus the live pool `QueueStats` under `pool`.

## Queue and cancellation semantics

FIFO. `takeIdle(limit)` (workerPool.ts:103-118) shifts from the head. The pool hands it the current idle
worker count and dispatches the whole batch in one pass (workerPool.ts:293-305), so a single reply drains
as many idle workers as are free.

Stale definition, `isStaleJob` (workerPool.ts:43-45): `job.gen < currentGen`. Strictly less than, so a job
at exactly the current generation is live. Tested at gen 1/2/3 against current 2.

Two independent drop points, both rejecting with `TileDecodeCancelled`:

- Submit time (workerPool.ts:91-96): a job below the current generation is never queued.
- Dispatch time (workerPool.ts:109-112): `takeIdle` re-checks each job as it leaves the queue, so a job
  queued before a cancel and dispatched after it is dropped rather than sent.

`cancelOlderThan(gen)` (workerPool.ts:250-262) raises the floor, drops every queued job below it, and for
each in-flight worker sends `{ t: 'cancel', gen }` to that worker, marks the worker idle, and rejects that
job. The current generation never moves backwards (workerPool.ts:122, tested 9 then 4 stays 9).

A late reply for cancelled work is ignored: the `(gen, tileId)` key was deleted on cancel, so `complete`
returns false and `completed` does not move (tested).

Counters are explicit fields, not derived arithmetic. `inFlightCount` is incremented on dispatch
(workerPool.ts:116-117) and decremented (145, 156, 167) on complete, fail, and release. Deriving it as
`dispatched - completed - failed` would go wrong the moment an in-flight job is cancelled rather than
finished.

Bounded queue: `DEFAULT_MAX_QUEUE_LENGTH` = 64 (workerPool.ts:208). Rejection happens only when the queue
is full AND every worker is busy (workerPool.ts:238-240), so a burst never fails while capacity is idle.

Worker replacement: `onerror` calls `recover` (workerPool.ts:313-327), which fails only the crashing
worker's own job, terminates it, removes it, and spawns a replacement. Tested: pool of 1, worker 0 errors,
`workers` grows to 2, and a subsequent decode on the replacement resolves.

`release` is guarded (workerPool.ts:329-334) against a worker that is no longer in `this.workers`, and does
not double-push into `idle`. Without that guard a crash-recovery plus a late message from the dead worker
would leave the same worker counted idle twice and oversubscribe the pool.

## Evidence

Tests, `npx vitest run tests/unit/worker-protocol.test.ts`: 23 passed, 0 failed, no unhandled rejections.
The run is clean because every fire-and-forget decode in the tests goes through `swallow`
(tests/unit/worker-protocol.test.ts:48-50), which attaches a catch. An earlier revision leaked five
"TileWorkerPool disposed" unhandled rejections from `void pool.decode(...)` promises; those are fixed.

Typecheck. `npx tsc --noEmit` across the repo cannot go green while `codec.ts` is being written by another
agent: at the time of this report `src/lib/render/codec.ts` had syntax errors at lines 45, 46, 48, 327
(`error TS1005`, `TS1131`), a half-closed `FeatureMeta` interface followed by two duplicated helper
functions. To prove the four owned files are clean independently of that, they were copied to a scratch
directory against a codec shim carrying the real published shapes read from `codec.ts:1-102`
(`RenderLayerId` as a string union, `DecodedRenderLayer.id: RenderLayerId`, `DecodedRenderTile` with
`header`/`layers`/`meta`) and compiled with the project's strict flags. Result: `tsc` exit 0, zero
diagnostics. Scratch directory removed afterwards.

Coverage of the assertions: pool size clamp across the whole domain; stale predicate at three generation
relationships; FIFO order across three jobs; reject-on-submit below the floor; drop at dispatch for a job
queued before a cancel; `cancelOlderThan` rejecting exactly the two older of three jobs; floor monotonicity;
result matched to the right `(tileId, gen)` and a duplicate reply ignored; error routed to the matching
rejection only; `failAll` on dispose; one worker per slot; concurrency never exceeding pool size; the
buffer being transferred rather than cloned; the next job starting on reply; queued and in-flight
cancellation; late replies ignored; queue-full rejection; duplicate decode rejection; crash recovery;
dispose rejecting pending and future work; and the two protocol guards.

Deliberately not tested: real Worker instantiation, actual ArrayBuffer transfer across a real module
boundary, and real `decodeRenderTile` execution. Those need a browser, and are integration surface rather
than this module's logic.

## Integration notes

- `codec.ts` must export `decodeRenderTile(buffer: ArrayBuffer): DecodedRenderTile` returning fresh
  `Float32Array`/`Uint32Array` views whose `.buffer` is transferable. If it returned views over a shared
  slab buffer, the transfer list in `tileWorker.ts:7-16` would detach a buffer shared by every layer. The
  contract's "concatenated sections" wording is consistent with per-layer views over one payload, so this
  is the one real integration risk and it belongs to the codec owner, wave2-4.
- `getRenderTileCacheStats()` instantiates the shared pool on first call, which spawns Workers. Call it
  only on the client.
- `nextRenderTileGeneration()` (loadRenderTile.ts:60-64) is the intended camera-move hook: it advances the
  generation and cancels everything older. Nothing calls it yet; wiring it into MapShell is T15's file.
- `experimental.webpackBuildWorker: true` in `next.config.ts:4-6` is unrelated to module Web Workers; it
  controls whether webpack builds run in a worker process. The `new Worker(new URL('./tileWorker.ts',
  import.meta.url), { type: 'module' })` pattern is supported by webpack 5 independently, and that is what
  `getTileWorkerPool` uses (workerPool.ts:339-345).
