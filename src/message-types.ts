/**
 * Type definitions for P2P and tracker messages
 */

import { ModelPackage } from './model-serializer';

// Tracker Messages (WebSocket)
export interface WelcomeMessage {
  type: 'welcome';
  clientId: string;
}

export interface AnnounceMessage {
  type: 'announce';
  modelId: string;
  complete: boolean;
}

export interface AnnounceResponseMessage {
  type: 'announce-response';
  modelId: string;
  seeders: number;
  leechers: number;
  peers: PeerInfo[];
  complete: number;
  incomplete: number;
}

export interface PeerJoinedSwarmMessage {
  type: 'peer-joined-swarm';
  modelId: string;
  peerId: string;
  complete: boolean;
  peers: PeerInfo[]; // Same structure as announce-response for consistent handling
}

export interface PeerLeftSwarmMessage {
  type: 'peer-left-swarm';
  modelId: string;
  peerId: string;
}

export interface OfferMessage {
  type: 'offer';
  from: string;
  to: string;
  offer: RTCSessionDescriptionInit;
}

export interface AnswerMessage {
  type: 'answer';
  from: string;
  to: string;
  answer: RTCSessionDescriptionInit;
}

export interface IceCandidateMessage {
  type: 'ice-candidate';
  from: string;
  to: string;
  candidate: RTCIceCandidateInit;
}

export interface RequestConnectionMessage {
  type: 'request-connection';
  from: string;
}

export type TrackerMessage =
  | WelcomeMessage
  | AnnounceResponseMessage
  | PeerJoinedSwarmMessage
  | PeerLeftSwarmMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | RequestConnectionMessage;

// P2P Data Channel Messages
export interface BitfieldMessage {
  type: 'bitfield';
  modelId: string;
  bitfield: number[];
}

export interface HaveMessage {
  type: 'have';
  modelId: string;
  chunkIndex: number;
}

export interface RequestMessage {
  type: 'request';
  modelId: string;
  chunkIndex: number;
}

export interface PieceMessage {
  type: 'piece';
  modelId: string;
  chunkIndex: number;
  data: string; // base64 encoded
  checksum: number;
}

export interface MetadataMessage {
  type: 'metadata';
  package: ModelPackage;
}

export type P2PMessage =
  | BitfieldMessage
  | HaveMessage
  | RequestMessage
  | PieceMessage
  | MetadataMessage;

// Helper types
export interface PeerInfo {
  id: string;
  complete: boolean;
}

// Server-side types
export interface ClientInfo {
  id: string;
  ws: any; // WebSocket type
  models: Set<string>;
}

export interface SwarmPeerInfo {
  peerId: string;
  complete: boolean;
  lastSeen: number;
}