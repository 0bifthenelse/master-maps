import { describe, it, expect } from 'vitest';
import {
  DecodeQueue,
  TileDecodeCancelled,
  TileWorkerPool,
  isStaleJob,
  resolvePoolSize,
  DEFAULT_MAX_QUEUE_LENGTH,
  type PoolJob,
  type WorkerLike,
} from '../../src/lib/render/workerPool';
import { isDecodedResponse, isErrorResponse } from '../../src/lib/render/protocol';

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: { message: unknown; transfer?: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function decodedPayload(tileId: string, gen: number): unknown {
  return {
    t: 'decoded',
    tileId,
    gen,
    header: { tileId, lod: 0, bounds: [0, 0, 1, 1], datasetVersion: 'v', layers: [], featureMetaBytes: 0, featureMetaOffset: 0 },
    payload: new ArrayBuffer(16),
    layers: [],
    meta: [],
  };
}

function buffer(): ArrayBuffer {
  return new ArrayBuffer(8);
}

function swallow(pool: TileWorkerPool, tileId: string, gen: number): Promise<unknown> {
  return pool.decode(tileId, buffer(), gen).catch(() => undefined);
}

describe('resolvePoolSize', () => {
  it('subtracts two cores and clamps to [2, 6]', () => {
    expect(resolvePoolSize(2)).toBe(2);
    expect(resolvePoolSize(3)).toBe(2);
    expect(resolvePoolSize(4)).toBe(2);
    expect(resolvePoolSize(8)).toBe(6);
    expect(resolvePoolSize(64)).toBe(6);
    expect(resolvePoolSize(16)).toBe(6);
    expect(resolvePoolSize(6)).toBe(4);
    expect(resolvePoolSize(5)).toBe(3);
  });

  it('falls back to a safe default when hardwareConcurrency is missing', () => {
    expect(resolvePoolSize(undefined)).toBe(2);
  });
});

describe('isStaleJob', () => {
  it('treats only strictly older generations as stale', () => {
    expect(isStaleJob({ tileId: 'a', gen: 1, buffer: buffer() }, 2)).toBe(true);
    expect(isStaleJob({ tileId: 'a', gen: 2, buffer: buffer() }, 2)).toBe(false);
    expect(isStaleJob({ tileId: 'a', gen: 3, buffer: buffer() }, 2)).toBe(false);
  });
});

describe('DecodeQueue', () => {
  it('dispatches in FIFO order', () => {
    const queue = new DecodeQueue();
    queue.submit({ tileId: 'a', gen: 1, buffer: buffer() }, () => undefined, () => undefined);
    queue.submit({ tileId: 'b', gen: 1, buffer: buffer() }, () => undefined, () => undefined);
    queue.submit({ tileId: 'c', gen: 1, buffer: buffer() }, () => undefined, () => undefined);
    const batch = queue.takeIdle(3);
    expect(batch.map((job) => job.tileId)).toEqual(['a', 'b', 'c']);
    expect(queue.queued).toBe(0);
  });

  it('rejects a job submitted below the current generation without queueing it', () => {
    const queue = new DecodeQueue();
    queue.cancelOlderThan(5);
    let rejected: Error | null = null;
    const accepted = queue.submit({ tileId: 'stale', gen: 4, buffer: buffer() }, () => undefined, (error: Error) => {
      rejected = error;
    });
    expect(accepted).toBe(false);
    expect(rejected).toBeInstanceOf(TileDecodeCancelled);
    expect(queue.queued).toBe(0);
    expect(queue.stats.droppedStale).toBe(1);
  });

  it('drops stale entries at dispatch time and never sends them out', () => {
    const queue = new DecodeQueue();
    queue.submit({ tileId: 'old', gen: 1, buffer: buffer() }, () => undefined, () => undefined);
    queue.submit({ tileId: 'new', gen: 7, buffer: buffer() }, () => undefined, () => undefined);
    let rejected: Error | null = null;
    const accepted = queue.submit({ tileId: 'mid', gen: 7, buffer: buffer() }, () => undefined, () => undefined);
    expect(accepted).toBe(true);
    queue.cancelOlderThan(7);
    const batch = queue.takeIdle(8);
    expect(batch.map((job) => job.tileId)).toEqual(['new', 'mid']);
    expect(rejected).toBeNull();
  });

  it('rejects every queued job older than the cancel generation', () => {
    const queue = new DecodeQueue();
    const errors: Error[] = [];
    const collect = (error: Error): void => {
      errors.push(error);
    };
    queue.submit({ tileId: 'a', gen: 1, buffer: buffer() }, () => undefined, collect);
    queue.submit({ tileId: 'b', gen: 2, buffer: buffer() }, () => undefined, collect);
    queue.submit({ tileId: 'c', gen: 3, buffer: buffer() }, () => undefined, collect);
    const removed = queue.cancelOlderThan(3);
    expect(removed).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof TileDecodeCancelled)).toBe(true);
    expect(queue.queued).toBe(1);
    expect(queue.stats.cancelled).toBe(2);
  });

  it('never moves the current generation backwards', () => {
    const queue = new DecodeQueue();
    queue.cancelOlderThan(9);
    expect(queue.generation).toBe(9);
    queue.cancelOlderThan(4);
    expect(queue.generation).toBe(9);
  });

  it('matches a decode result to the right (tileId, gen) pair', () => {
    const queue = new DecodeQueue();
    const resolved: string[] = [];
    queue.submit({ tileId: 'a', gen: 2, buffer: buffer() }, () => resolved.push('a'), () => undefined);
    queue.submit({ tileId: 'b', gen: 2, buffer: buffer() }, () => resolved.push('b'), () => undefined);
    queue.takeIdle(2);
    const message = decodedPayload('b', 2);
    if (!isDecodedResponse(message)) throw new Error('expected decoded');
    expect(queue.complete(message)).toBe(true);
    expect(resolved).toEqual(['b']);
    expect(queue.complete(message)).toBe(false);
    expect(queue.stats.inFlight).toBe(1);
  });

  it('routes worker errors to the matching rejection only', async () => {
    const queue = new DecodeQueue();
    const rejected: string[] = [];
    queue.submit({ tileId: 'a', gen: 1, buffer: buffer() }, () => undefined, (error: Error) => rejected.push(`a:${error.message}`));
    queue.submit({ tileId: 'b', gen: 1, buffer: buffer() }, () => undefined, (error: Error) => rejected.push(`b:${error.message}`));
    queue.takeIdle(2);
    const message = { t: 'error', tileId: 'a', gen: 1, message: 'bad magic' };
    if (!isErrorResponse(message)) throw new Error('expected error');
    expect(queue.fail(message)).toBe(true);
    expect(rejected).toEqual(['a:bad magic']);
    expect(queue.stats.inFlight).toBe(1);
  });

  it('fails every pending job on dispose', () => {
    const queue = new DecodeQueue();
    let count = 0;
    const bump = (): void => {
      count += 1;
    };
    queue.submit({ tileId: 'a', gen: 1, buffer: buffer() }, bump, bump);
    queue.takeIdle(1);
    queue.submit({ tileId: 'b', gen: 1, buffer: buffer() }, bump, bump);
    queue.failAll(new Error('disposed'));
    expect(count).toBe(2);
  });
});

describe('TileWorkerPool scheduling', () => {
  function makePool(poolSize: number, maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH): { pool: TileWorkerPool; workers: FakeWorker[] } {
    const workers: FakeWorker[] = [];
    const pool = new TileWorkerPool({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      poolSize,
      maxQueueLength,
    });
    return { pool, workers };
  }

  it('spawns one worker per pool slot and never exceeds it', () => {
    const { pool, workers } = makePool(3);
    expect(workers).toHaveLength(3);
    expect(pool.size).toBe(3);
    pool.dispose();
  });

  it('never runs more concurrent decodes than the pool size', () => {
    const { pool, workers } = makePool(2);
    void swallow(pool, 'a', 1);
    void swallow(pool, 'b', 1);
    void swallow(pool, 'c', 1);
    void swallow(pool, 'd', 1);
    const dispatched = workers.flatMap((worker) => worker.posted.filter((entry) => (entry.message as { t: string }).t === 'decode'));
    expect(dispatched).toHaveLength(2);
    expect(pool.stats.queued).toBe(2);
    expect(pool.stats.inFlight).toBe(2);
    pool.dispose();
  });

  it('transfers the buffer instead of structured cloning it', () => {
    const { pool, workers } = makePool(1);
    const payload = buffer();
    void pool.decode('a', payload, 1).catch(() => undefined);
    const entry = workers[0]!.posted[0]!;
    expect(entry.transfer).toEqual([payload]);
    pool.dispose();
  });

  it('resolves the decode with the single transferred payload slab', async () => {
    const { pool, workers } = makePool(1);
    const decoded = pool.decode('a', buffer(), 1);
    workers[0]!.respond(decodedPayload('a', 1));
    const tile = await decoded;
    expect(tile.payload.byteLength).toBe(16);
    expect(Array.isArray(tile.layers)).toBe(true);
    pool.dispose();
  });

  it('starts the next queued job when a worker reports back', async () => {
    const { pool, workers } = makePool(1);
    const first = pool.decode('a', buffer(), 1);
    const second = pool.decode('b', buffer(), 1);
    workers[0]!.respond(decodedPayload('a', 1));
    await expect(first).resolves.toMatchObject({ header: { tileId: 'a' } });
    expect(workers[0]!.posted).toHaveLength(2);
    workers[0]!.respond(decodedPayload('b', 1));
    await expect(second).resolves.toMatchObject({ header: { tileId: 'b' } });
    expect(pool.stats.inFlight).toBe(0);
    expect(pool.stats.completed).toBe(2);
    pool.dispose();
  });

  it('rejects queued and in-flight work when the generation advances', async () => {
    const { pool, workers } = makePool(1);
    const running = pool.decode('running', buffer(), 1);
    const queued = pool.decode('queued', buffer(), 1);
    pool.cancelOlderThan(2);
    await expect(running).rejects.toBeInstanceOf(TileDecodeCancelled);
    await expect(queued).rejects.toBeInstanceOf(TileDecodeCancelled);
    const messages = workers[0]!.posted.map((entry) => entry.message as { t: string; gen: number });
    expect(messages).toContainEqual({ t: 'cancel', gen: 2 });
    expect(pool.stats.inFlight).toBe(0);
    expect(pool.stats.queued).toBe(0);
    pool.dispose();
  });

  it('ignores a late reply for work already cancelled', async () => {
    const { pool, workers } = makePool(1);
    const running = pool.decode('a', buffer(), 1);
    pool.cancelOlderThan(2);
    await expect(running).rejects.toBeInstanceOf(TileDecodeCancelled);
    workers[0]!.respond(decodedPayload('a', 1));
    expect(pool.stats.completed).toBe(0);
    pool.dispose();
  });

  it('rejects when the bounded queue is saturated', async () => {
    const { pool } = makePool(1, 2);
    void pool.decode('a', buffer(), 1).catch(() => undefined);
    void pool.decode('b', buffer(), 1).catch(() => undefined);
    void pool.decode('c', buffer(), 1).catch(() => undefined);
    await expect(pool.decode('d', buffer(), 1)).rejects.toThrow(/queue full/);
    pool.dispose();
  });

  it('rejects a duplicate decode of the same tile at the same generation', async () => {
    const { pool } = makePool(1);
    const first = pool.decode('a', buffer(), 1);
    const second = pool.decode('a', buffer(), 1);
    await expect(second).rejects.toThrow(/already decoding/);
    expect(pool.stats.queued + pool.stats.inFlight).toBe(1);
    pool.dispose();
    await expect(first).rejects.toThrow(/disposed/);
  });

  it('replaces a crashed worker and fails only its in-flight job', async () => {
    const workers: FakeWorker[] = [];
    const pool = new TileWorkerPool({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      poolSize: 1,
    });
    const failing = pool.decode('a', buffer(), 1);
    workers[0]!.onerror?.({});
    await expect(failing).rejects.toThrow(/crashed/);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const recovered = pool.decode('b', buffer(), 1);
    workers[1]!.respond(decodedPayload('b', 1));
    await expect(recovered).resolves.toMatchObject({ header: { tileId: 'b' } });
    pool.dispose();
  });

  it('rejects everything still pending after dispose', async () => {
    const { pool } = makePool(1);
    const running = pool.decode('a', buffer(), 1);
    const queued = pool.decode('b', buffer(), 1);
    pool.dispose();
    await expect(running).rejects.toThrow(/disposed/);
    await expect(queued).rejects.toThrow(/disposed/);
    await expect(pool.decode('c', buffer(), 1)).rejects.toThrow(/disposed/);
  });
});

describe('protocol guards', () => {
  it('discriminates decoded and error replies', () => {
    expect(isDecodedResponse(decodedPayload('a', 1) as never)).toBe(true);
    expect(isErrorResponse({ t: 'error', tileId: 'a', gen: 1, message: 'x' })).toBe(true);
    expect(isDecodedResponse({ t: 'error', tileId: 'a', gen: 1, message: 'x' } as never)).toBe(false);
  });
});

describe('PoolJob shape', () => {
  it('carries the transferred buffer alongside identity fields', () => {
    const payload = buffer();
    const job: PoolJob = { tileId: 'l0_558_293_s4_1_0', gen: 3, buffer: payload };
    expect(job.buffer.byteLength).toBe(8);
  });
});
