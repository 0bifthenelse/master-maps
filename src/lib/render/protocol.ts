import type { DecodedRenderTile } from './codec';

export type DecodeRequest = {
  t: 'decode';
  tileId: string;
  gen: number;
  buffer: ArrayBuffer;
};

export type CancelRequest = {
  t: 'cancel';
  gen: number;
};

export type MainToWorkerMessage = DecodeRequest | CancelRequest;

export type DecodedResponse = {
  t: 'decoded';
  tileId: string;
  gen: number;
  header: DecodedRenderTile['header'];
  payload: DecodedRenderTile['payload'];
  layers: DecodedRenderTile['layers'];
  meta: DecodedRenderTile['meta'];
};

export type ErrorResponse = {
  t: 'error';
  tileId: string;
  gen: number;
  message: string;
};

export type WorkerToMainMessage = DecodedResponse | ErrorResponse;

export function isDecodedResponse(message: WorkerToMainMessage): message is DecodedResponse {
  return message.t === 'decoded';
}

export function isErrorResponse(message: WorkerToMainMessage): message is ErrorResponse {
  return message.t === 'error';
}
