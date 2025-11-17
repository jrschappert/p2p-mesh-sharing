import { ModelPackage, ModelChunk, ModelSerializer } from './model-serializer';
import { Swarm } from './types';
import * as Utils from './utils';
import { P2P_CONFIG } from './constants';
import { logger } from './logger';

// Action types that SwarmManager returns for P2PClient to execute
export interface SwarmAction {
  type: 'request_chunk' | 'broadcast_have' | 'send_piece' | 'download_complete' | 'download_progress';
  peerId?: string;
  modelId: string;
  chunkIndex?: number;
  chunk?: ModelChunk;
  progress?: number;
}

export class SwarmManager {
  private swarms = new Map<string, Swarm>();
  private readonly CHUNKS_PER_REQUEST = P2P_CONFIG.CHUNKS_PER_REQUEST;
  private readonly REQUEST_TIMEOUT = P2P_CONFIG.REQUEST_TIMEOUT;

  constructor() {}

  public getSwarms(): Map<string, Swarm> {
    return this.swarms;
  }

  public createSwarm(modelId: string, metadata: ModelPackage, chunks: ModelChunk[] = []) {
    const isSeeder = chunks.length > 0;
    const swarm: Swarm = {
      modelId,
      metadata,
      ownChunks: new Set(chunks.map((_, idx) => idx)),
      requestedChunks: new Map(),
      receivedChunks: new Map(chunks.map(c => [c.index, c])),
      totalChunks: isSeeder ? chunks.length : metadata.metadata.totalChunks,
      startTime: isSeeder ? undefined : Date.now()
    };
    this.swarms.set(modelId, swarm);
    return swarm;
  }

  public handlePiece(peerId: string, message: any, peerBitfields: Map<string, Map<string, Uint8Array>>): SwarmAction[] {
    const { modelId, chunkIndex, data, checksum } = message;
    const actions: SwarmAction[] = [];
    
    const swarm = this.swarms.get(modelId);
    if (!swarm) return actions;

    const chunk: ModelChunk = {
      modelId,
      index: chunkIndex,
      total: swarm.totalChunks,
      data: Utils.base64ToArrayBuffer(data),
      checksum
    };

    if (!ModelSerializer.verifyChunk(chunk)) {
      logger.error(`Chunk ${chunkIndex} failed verification`);
      swarm.requestedChunks.delete(chunkIndex);
      return actions;
    }

    swarm.receivedChunks.set(chunkIndex, chunk);
    swarm.ownChunks.add(chunkIndex);
    swarm.requestedChunks.delete(chunkIndex);

    logger.swarm(`Chunk ${chunkIndex}/${swarm.totalChunks} from ${peerId} (${Math.round(swarm.ownChunks.size / swarm.totalChunks * 100)}%)`);

    // Action: broadcast have
    actions.push({ type: 'broadcast_have', modelId, chunkIndex });

    // Action: report progress
    const progress = swarm.ownChunks.size / swarm.totalChunks * 100;
    actions.push({ type: 'download_progress', modelId, progress });

    // Check for timed out requests (event-driven timeout checking)
    this.checkTimeouts(swarm);

    // Action: download complete or request more
    if (swarm.ownChunks.size === swarm.totalChunks) {
      actions.push({ type: 'download_complete', modelId });
    } else {
      actions.push(...this.requestMoreChunks(modelId, peerBitfields));
    }

    return actions;
  }

  /**
   * Check for timed out chunk requests and clear them
   */
  private checkTimeouts(swarm: Swarm): void {
    const now = Date.now();
    const timeoutsToRemove: number[] = [];
    
    swarm.requestedChunks.forEach((peerId, chunkIndex) => {
      // Use swarm start time as a proxy for request time
      // If a chunk has been requested for longer than REQUEST_TIMEOUT, clear it
      if (swarm.startTime && now - swarm.startTime > this.REQUEST_TIMEOUT) {
        timeoutsToRemove.push(chunkIndex);
      }
    });
    
    timeoutsToRemove.forEach(chunkIndex => {
      const peerId = swarm.requestedChunks.get(chunkIndex);
      logger.warn(`Request timeout for chunk ${chunkIndex} from ${peerId}`);
      swarm.requestedChunks.delete(chunkIndex);
    });
  }

  public requestMoreChunks(modelId: string, peerBitfields: Map<string, Map<string, Uint8Array>>): SwarmAction[] {
    const swarm = this.swarms.get(modelId);
    const actions: SwarmAction[] = [];
    if (!swarm) return actions;

    const needed: number[] = [];
    for (let i = 0; i < swarm.totalChunks; i++) {
      if (!swarm.ownChunks.has(i) && !swarm.requestedChunks.has(i)) {
        needed.push(i);
      }
    }

    if (needed.length === 0) return actions;

    // Calculate rarity for each needed chunk
    const rarity = new Map<number, number>();
    needed.forEach(chunkIdx => {
      let count = 0;
      peerBitfields.forEach(bitfields => {
        const bitfield = bitfields.get(modelId);
        if (bitfield && Utils.hasBit(bitfield, chunkIdx)) {
          count++;
        }
      });
      rarity.set(chunkIdx, count);
    });

    // Sort by rarity (rarest first)
    needed.sort((a, b) => (rarity.get(a) || 0) - (rarity.get(b) || 0));

    // Generate request actions for each peer
    peerBitfields.forEach((bitfields, peerId) => {
      const bitfield = bitfields.get(modelId);
      if (!bitfield) return;

      const peerRequests = Array.from(swarm.requestedChunks.values())
        .filter(p => p === peerId).length;

      if (peerRequests >= this.CHUNKS_PER_REQUEST) return;

      let requestedThisRound = 0;
      for (const chunkIdx of needed) {
        if (peerRequests + requestedThisRound >= this.CHUNKS_PER_REQUEST) break;
        
        if (Utils.hasBit(bitfield, chunkIdx) && !swarm.requestedChunks.has(chunkIdx)) {
          actions.push({ type: 'request_chunk', peerId, modelId, chunkIndex: chunkIdx });
          swarm.requestedChunks.set(chunkIdx, peerId);
          requestedThisRound++;
        }
      }
    });

    return actions;
  }

  public requestChunksFromPeer(peerId: string, modelId: string, peerBitfield: Uint8Array): SwarmAction[] {
    const swarm = this.swarms.get(modelId);
    const actions: SwarmAction[] = [];
    if (!swarm) return actions;

    for (let i = 0; i < swarm.totalChunks; i++) {
      if (!swarm.ownChunks.has(i) &&
          !swarm.requestedChunks.has(i) &&
          Utils.hasBit(peerBitfield, i)) {
        actions.push({ type: 'request_chunk', peerId, modelId, chunkIndex: i });
        swarm.requestedChunks.set(i, peerId);
        break;
      }
    }

    return actions;
  }

  public handleRequest(peerId: string, message: any): SwarmAction | null {
    const { modelId, chunkIndex } = message;
    
    const swarm = this.swarms.get(modelId);
    if (!swarm || !swarm.ownChunks.has(chunkIndex)) {
      logger.warn(`We don't have chunk ${chunkIndex}`);
      return null;
    }

    const chunk = swarm.receivedChunks.get(chunkIndex);
    if (!chunk) {
      logger.warn(`Chunk ${chunkIndex} not found in storage`);
      return null;
    }

    return { type: 'send_piece', peerId, modelId, chunk };
  }

}