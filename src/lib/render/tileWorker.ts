import { decodeRenderTile } from './codec';
import type { ErrorResponse, MainToWorkerMessage, WorkerToMainMessage } from './protocol';

const MIN_GENERATION = 0;
let currentGeneration = MIN_GENERATION;

function collectTransferables(message: WorkerToMainMessage): ArrayBuffer[] {
  return message.t === 'decoded' ? [message.payload] : [];
}

function reply(message: WorkerToMainMessage): void {
  const transferables = collectTransferables(message);
  if (transferables.length > 0) (self as unknown as Worker).postMessage(message, transferables);
  else (self as unknown as Worker).postMessage(message);
}

function handleDecode(request: Extract<MainToWorkerMessage, { t: 'decode' }>): void {
  if (request.gen < currentGeneration) {
    const stale: ErrorResponse = {
      t: 'error',
      tileId: request.tileId,
      gen: request.gen,
      message: `stale generation ${request.gen} < ${currentGeneration}`,
    };
    reply(stale);
    return;
  }
  try {
    const decoded = decodeRenderTile(request.buffer);
    reply({ t: 'decoded', tileId: request.tileId, gen: request.gen, header: decoded.header, payload: decoded.payload, layers: decoded.layers, meta: decoded.meta });
  } catch (error) {
    reply({
      t: 'error',
      tileId: request.tileId,
      gen: request.gen,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleCancel(request: Extract<MainToWorkerMessage, { t: 'cancel' }>): void {
  if (request.gen > currentGeneration) currentGeneration = request.gen;
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  const message = event.data;
  if (message.t === 'decode') {
    handleDecode(message);
    return;
  }
  handleCancel(message);
};
