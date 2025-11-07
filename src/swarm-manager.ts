import { ModelPackage, ModelChunk, ModelSerializer } from './model-serializer';
import { Swarm } from './types';
import { WebRTCHandler } from './webrtc-handler';
import * as Utils from './utils';

export class SwarmManager {
  private swarms = new Map<string, Swarm>();
  private webRTCHandler: WebRTCHandler;
  private readonly CHUNKS_PER_REQUEST = 5;
  private readonly REQUEST_TIMEOUT = 15000;

  constructor(webRTCHandler: WebRTCHandler) {
    this.webRTCHandler = webRTCHandler;
  }

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

  public handlePiece(peerId: string, message: any, onDownloadComplete: (modelId: string) => void, onDownloadProgress: (modelId: string, progress: number) => void, broadcastHave: (modelId: string, chunkIndex: number) => void) {
    const { modelId, chunkIndex, data, checksum } = message;
    
    const swarm = this.swarms.get(modelId);
    if (!swarm) return;

    const chunk: ModelChunk = {
      modelId,
      index: chunkIndex,
      total: swarm.totalChunks,
      data: Utils.base64ToArrayBuffer(data),
      checksum
    };

    if (!ModelSerializer.verifyChunk(chunk)) {
      console.error(`❌ Chunk ${chunkIndex} failed verification`);
      swarm.requestedChunks.delete(chunkIndex);
      return;
    }

    swarm.receivedChunks.set(chunkIndex, chunk);
    swarm.ownChunks.add(chunkIndex);
    swarm.requestedChunks.delete(chunkIndex);

    console.log(`✅ Chunk ${chunkIndex}/${swarm.totalChunks} from ${peerId} (${Math.round(swarm.ownChunks.size / swarm.totalChunks * 100)}%)`);

    broadcastHave(modelId, chunkIndex);

    const progress = swarm.ownChunks.size / swarm.totalChunks * 100;
    onDownloadProgress(modelId, progress);

    if (swarm.ownChunks.size === swarm.totalChunks) {
      onDownloadComplete(modelId);
    } else {
      this.requestMoreChunks(modelId);
    }
  }

  public requestMoreChunks(modelId: string) {
    const swarm = this.swarms.get(modelId);
    if (!swarm) return;

    const needed: number[] = [];
    for (let i = 0; i < swarm.totalChunks; i++) {
      if (!swarm.ownChunks.has(i) && !swarm.requestedChunks.has(i)) {
        needed.push(i);
      }
    }

    if (needed.length === 0) return;

    const rarity = new Map<number, number>();
    needed.forEach(chunkIdx => {
      let count = 0;
      this.webRTCHandler.getAllPeers().forEach(peer => {
        const bitfield = peer.bitfield.get(modelId);
        if (bitfield && Utils.hasBit(bitfield, chunkIdx)) {
          count++;
        }
      });
      rarity.set(chunkIdx, count);
    });

    needed.sort((a, b) => (rarity.get(a) || 0) - (rarity.get(b) || 0));

    this.webRTCHandler.getAllPeers().forEach((peer, peerId) => {
      const bitfield = peer.bitfield.get(modelId);
      if (!bitfield || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        return;
      }

      const peerRequests = Array.from(swarm.requestedChunks.values())
        .filter(p => p === peerId).length;

      if (peerRequests >= this.CHUNKS_PER_REQUEST) return;

      for (const chunkIdx of needed) {
        if (peerRequests >= this.CHUNKS_PER_REQUEST) break;
        
        if (Utils.hasBit(bitfield, chunkIdx) && !swarm.requestedChunks.has(chunkIdx)) {
          this.requestChunk(peerId, modelId, chunkIdx);
          swarm.requestedChunks.set(chunkIdx, peerId);
          break;
        }
      }
    });
  }

  private requestChunk(peerId: string, modelId: string, chunkIndex: number) {
    const peer = this.webRTCHandler.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return;

    peer.dataChannel.send(JSON.stringify({
      type: 'request',
      modelId,
      chunkIndex
    }));

    console.log(`📥 Requesting chunk ${chunkIndex} from ${peerId}`);
  }

  public requestChunksFromPeer(peerId: string, modelId: string) {
    const swarm = this.swarms.get(modelId);
    const peer = this.webRTCHandler.getPeer(peerId);
    if (!swarm || !peer) return;

    const bitfield = peer.bitfield.get(modelId);
    if (!bitfield) return;

    for (let i = 0; i < swarm.totalChunks; i++) {
      if (!swarm.ownChunks.has(i) && 
          !swarm.requestedChunks.has(i) && 
          Utils.hasBit(bitfield, i)) {
        this.requestChunk(peerId, modelId, i);
        swarm.requestedChunks.set(i, peerId);
        break;
      }
    }
  }

  public handleRequest(peerId: string, message: any, sendPiece: (peerId: string, modelId: string, chunk: ModelChunk) => void) {
    const { modelId, chunkIndex } = message;
    
    const swarm = this.swarms.get(modelId);
    if (!swarm || !swarm.ownChunks.has(chunkIndex)) {
      console.warn(`We don't have chunk ${chunkIndex}`);
      return;
    }

    const chunk = swarm.receivedChunks.get(chunkIndex);
    if (!chunk) {
      console.warn(`Chunk ${chunkIndex} not found in storage`);
      return;
    }

    sendPiece(peerId, modelId, chunk);
  }

  public maintainSwarms() {
    const now = Date.now();

    this.swarms.forEach((swarm, modelId) => {
      // Check for timed out requests
      swarm.requestedChunks.forEach((peerId, chunkIndex) => {
        const peer = this.webRTCHandler.getPeer(peerId);
        if (!peer || now - peer.lastActivity > this.REQUEST_TIMEOUT) {
          console.warn(`⚠️ Request timeout for chunk ${chunkIndex} from ${peerId}`);
          swarm.requestedChunks.delete(chunkIndex);
        }
      });

      // Request more if needed
      if (swarm.ownChunks.size < swarm.totalChunks) {
        this.requestMoreChunks(modelId);
      }
    });
  }
}