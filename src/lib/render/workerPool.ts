import type { DecodedRenderTile } from './codec';
import { isDecodedResponse, isErrorResponse, type DecodedResponse, type ErrorResponse } from './protocol';

export const MIN_POOL_SIZE = 2;
export const MAX_POOL_SIZE = 6;

export interface PoolJob {
  tileId: string;
  gen: number;
  buffer: ArrayBuffer;
}

export interface PendingDecode {
  tileId: string;
  gen: number;
  resolve: (tile: DecodedRenderTile) => void;
  reject: (error: Error) => void;
}

export interface QueueStats {
  poolSize: number;
  queued: number;
  inFlight: number;
  dispatched: number;
  droppedStale: number;
  cancelled: number;
  completed: number;
  failed: number;
}

export class TileDecodeCancelled extends Error {
  constructor(tileId: string, gen: number) {
    super(`tile ${tileId} decode cancelled at generation ${gen}`);
    this.name = 'TileDecodeCancelled';
  }
}

export function resolvePoolSize(hardwareConcurrency: number | undefined): number {
  const reported = hardwareConcurrency ?? MIN_POOL_SIZE + 2;
  return Math.min(MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, reported - 2));
}

export function isStaleJob(job: PoolJob, currentGen: number): boolean {
  return job.gen < currentGen;
}

export class DecodeQueue {
  private readonly jobs: PoolJob[] = [];
  private readonly pending = new Map<string, PendingDecode>();
  private genCounter = 0;
  private currentGeneration = 0;
  private dispatched = 0;
  private inFlightCount = 0;
  private droppedStale = 0;
  private cancelled = 0;
  private completed = 0;
  private failed = 0;

  get stats(): QueueStats {
    return {
      poolSize: 0,
      queued: this.jobs.length,
      inFlight: this.inFlightCount,
      dispatched: this.dispatched,
      droppedStale: this.droppedStale,
      cancelled: this.cancelled,
      completed: this.completed,
      failed: this.failed,
    };
  }

  nextGeneration(): number {
    this.genCounter += 1;
    return this.genCounter;
  }


  get queued(): number {
    return this.jobs.length;
  }

  has(tileId: string, gen: number): boolean {
    return this.pending.has(this.key(tileId, gen));
  }
  get generation(): number {
    return this.currentGeneration;
  }


  submit(job: PoolJob, resolve: (tile: DecodedRenderTile) => void, reject: (error: Error) => void): boolean {
    if (job.gen !== 0 && isStaleJob(job, this.currentGeneration)) {
      this.droppedStale += 1;
      reject(new TileDecodeCancelled(job.tileId, job.gen));
      return false;
    }
    const key = this.key(job.tileId, job.gen);
    if (this.pending.has(key)) return false;
    this.jobs.push(job);
    this.pending.set(key, { tileId: job.tileId, gen: job.gen, resolve, reject });
    return true;
  }

  takeIdle(limit: number): PoolJob[] {
    const take = Math.min(limit, this.jobs.length);
    const batch: PoolJob[] = [];
    while (batch.length < take) {
      const job = this.jobs.shift();
      if (job === undefined) break;
      if (isStaleJob(job, this.currentGeneration)) {
        this.droppedStale += 1;
        this.settleError(job, new TileDecodeCancelled(job.tileId, job.gen));
        continue;
      }
      batch.push(job);
      this.dispatched += 1;
      this.inFlightCount += 1;
    }
    return batch;
  }

  cancelOlderThan(gen: number): number {
    if (gen <= this.currentGeneration) return 0;
    this.currentGeneration = gen;
    const kept: PoolJob[] = [];
    let removed = 0;
    for (const job of this.jobs) {
      if (isStaleJob(job, this.currentGeneration)) {
        removed += 1;
        this.droppedStale += 1;
        this.settleError(job, new TileDecodeCancelled(job.tileId, job.gen));
        continue;
      }
      kept.push(job);
    }
    this.jobs.length = 0;
    for (const job of kept) this.jobs.push(job);
    this.cancelled += removed;
    return removed;
  }

  complete(response: DecodedResponse): boolean {
    const key = this.key(response.tileId, response.gen);
    const entry = this.pending.get(key);
    if (entry === undefined) return false;
    this.pending.delete(key);
    this.inFlightCount -= 1;
    this.completed += 1;
    entry.resolve({ header: response.header, payload: response.payload, layers: response.layers, meta: response.meta });
    return true;
  }

  fail(response: ErrorResponse): boolean {
    const key = this.key(response.tileId, response.gen);
    const entry = this.pending.get(key);
    if (entry === undefined) return false;
    this.pending.delete(key);
    this.inFlightCount -= 1;
    this.failed += 1;
    entry.reject(new Error(response.message));
    return true;
  }

  release(job: { tileId: string; gen: number }, error: Error): boolean {
    const key = this.key(job.tileId, job.gen);
    const entry = this.pending.get(key);
    if (entry === undefined) return false;
    this.pending.delete(key);
    this.inFlightCount -= 1;
    this.cancelled += 1;
    entry.reject(error);
    return true;
  }

  failAll(error: Error): void {
    for (const job of this.jobs) this.settleError(job, error);
    this.jobs.length = 0;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private settleError(job: PoolJob, error: Error): void {
    const key = this.key(job.tileId, job.gen);
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    this.pending.delete(key);
    entry.reject(error);
  }

  private key(tileId: string, gen: number): string {
    return `${gen}:${tileId}`;
  }
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface WorkerPoolOptions {
  createWorker: WorkerFactory;
  poolSize?: number;
  maxQueueLength?: number;
}

export const DEFAULT_MAX_QUEUE_LENGTH = 1024;

export class TileWorkerPool {
  private readonly queue: DecodeQueue;
  private readonly workers: WorkerLike[] = [];
  private readonly idle: WorkerLike[] = [];
  private readonly busy = new Map<WorkerLike, { tileId: string; gen: number }>();
  private readonly createWorker: WorkerFactory;
  private readonly maxQueueLength: number;
  private readonly poolSize: number;
  private disposed = false;

  constructor(options: WorkerPoolOptions) {
    this.createWorker = options.createWorker;
    this.poolSize = options.poolSize ?? resolvePoolSize(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency);
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this.queue = new DecodeQueue();
    for (let index = 0; index < this.poolSize; index += 1) this.spawn();
  }

  get size(): number {
    return this.poolSize;
  }

  get stats(): QueueStats {
    return { ...this.queue.stats, poolSize: this.poolSize };
  }

  decode(tileId: string, buffer: ArrayBuffer, gen: number): Promise<DecodedRenderTile> {
    if (this.disposed) return Promise.reject(new Error('TileWorkerPool disposed'));
    if (this.queue.queued >= this.maxQueueLength && this.busy.size >= this.workers.length) {
      return Promise.reject(new Error(`TileWorkerPool queue full (${this.maxQueueLength})`));
    }
    if (this.queue.has(tileId, gen)) {
      return Promise.reject(new Error(`TileWorkerPool already decoding ${tileId} at generation ${gen}`));
    }
    return new Promise<DecodedRenderTile>((resolve, reject) => {
      this.queue.submit({ tileId, gen, buffer }, resolve, reject);
      this.pump();
    });
  }

  cancelOlderThan(gen: number): number {
    const removed = this.queue.cancelOlderThan(gen);
    for (const [worker, job] of this.busy) {
      if (job.gen < gen) {
        worker.postMessage({ t: 'cancel', gen });
        this.busy.delete(worker);
        this.idle.push(worker);
        this.queue.release(job, new TileDecodeCancelled(job.tileId, job.gen));
      }
    }
    this.pump();
    return removed;
  }

  nextGeneration(): number {
    return this.queue.nextGeneration();
  }

  get currentGeneration(): number {
    return this.queue.generation;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.failAll(new Error('TileWorkerPool disposed'));
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.busy.clear();
  }

  private spawn(): void {
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent): void => this.receive(worker, event);
    worker.onerror = (): void => this.recover(worker, new Error('tile worker crashed'));
    this.workers.push(worker);
    this.idle.push(worker);
  }

  private pump(): void {
    if (this.idle.length === 0) return;
    const batch = this.queue.takeIdle(this.idle.length);
    let index = 0;
    while (index < batch.length) {
      const job = batch[index];
      const worker = this.idle.shift();
      if (job === undefined || worker === undefined) return;
      this.busy.set(worker, { tileId: job.tileId, gen: job.gen });
      worker.postMessage({ t: 'decode', tileId: job.tileId, gen: job.gen, buffer: job.buffer }, [job.buffer]);
      index += 1;
    }
  }

  private receive(worker: WorkerLike, event: MessageEvent): void {
    const data = event.data;
    if (isDecodedResponse(data)) {
      this.queue.complete(data);
    } else if (isErrorResponse(data)) {
      this.queue.fail(data);
    }
    this.release(worker);
  }

  private recover(worker: WorkerLike, error: Error): void {
    const job = this.busy.get(worker);
    if (job !== undefined) {
      this.queue.fail({ t: 'error', tileId: job.tileId, gen: job.gen, message: error.message });
    }
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.busy.delete(worker);
    worker.terminate();
    if (this.disposed) return;
    this.spawn();
    this.pump();
  }

  private release(worker: WorkerLike): void {
    if (!this.workers.includes(worker)) return;
    this.busy.delete(worker);
    if (!this.idle.includes(worker)) this.idle.push(worker);
    this.pump();
  }
}

let sharedPool: TileWorkerPool | null = null;

export function getTileWorkerPool(): TileWorkerPool {
  if (sharedPool === null) {
    sharedPool = new TileWorkerPool({
      createWorker: () =>
        new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    });
  }
  return sharedPool;
}

export function disposeTileWorkerPool(): void {
  sharedPool?.dispose();
  sharedPool = null;
}
