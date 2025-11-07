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
  peers: Set<string>; // peer IDs in this swarm
  ownChunks: Set<number>; // chunks we have
  requestedChunks: Map<number, string>; // chunkIndex → peerId we requested from
  receivedChunks: Map<number, ModelChunk>; // completed chunks
  totalChunks: number;
  startTime?: number;
}