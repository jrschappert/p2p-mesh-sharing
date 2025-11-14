import { ModelPackage, ModelChunk } from './model-serializer';

export interface Peer {
  id: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  isInitiator: boolean;
  bitfield: Map<string, Uint8Array>; // modelId → bitfield of chunks
  lastActivity: number;
}

export interface Swarm {
  modelId: string;
  metadata?: ModelPackage;
  ownChunks: Set<number>;
  requestedChunks: Map<number, string>;
  receivedChunks: Map<number, ModelChunk>;
  totalChunks: number;
  startTime?: number;
}