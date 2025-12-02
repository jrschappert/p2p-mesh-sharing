import { ModelSerializer, ModelPackage, ModelChunk } from './model-serializer';
import { Vector3 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { WebRTCHandler } from './webrtc-handler';
import * as Utils from './utils';
import { SwarmManager, SwarmAction } from './swarm-manager';
import { P2P_CONFIG } from './constants';
import { logger } from './logger';
import type { TrackerMessage, P2PMessage } from './message-types';
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShadowGenerator } from '@babylonjs/core';
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { privateDecrypt } from 'crypto';

/**
 * BitTorrent-inspired P2P client for 3D model sharing. This class is the main coordinator.
 */
export class P2PClient {
  private ws: WebSocket | null = null;
  private clientId: string | null = null;
  private webRTCHandler: WebRTCHandler | null = null;
  private swarmManager: SwarmManager | null = null;
  private scene: Scene;
  private shadowGenerator: ShadowGenerator;
  
  // Track which peers have received metadata for each model
  private metadataSentTo = new Map<string, Set<string>>(); // modelId -> Set<peerId>
  
  // Callbacks
  private onPeerConnected?: (peerId: string) => void;
  private onPeerDisconnected?: (peerId: string) => void;
  private onModelReceived?: (modelPackage: ModelPackage) => void;
  private onDownloadProgress?: (modelId: string, progress: number) => void;
  
  constructor(scene: Scene, shadowGenerator: ShadowGenerator) {
    this.scene = scene;
    const url = import.meta.env.VITE_WEBSOCKET_URL || 'wss://p2p-mesh-sharing.onrender.com';
    logger.info("Connecting to tracker:", url);
    this.connectToTracker(url);
    this.shadowGenerator = shadowGenerator;
    
    // Handle tab/window close to properly disconnect
    window.addEventListener('beforeunload', () => {
      this.disconnect();
    });
  }

  private connectToTracker(url: string): void {
    logger.info('Connecting to tracker...');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      logger.info('Connected to tracker');
      this.webRTCHandler = new WebRTCHandler(this.ws!);
      this.swarmManager = new SwarmManager();
      this.setupWebRTCHandlerCallbacks();
      
      // Delay connection request to ensure everything is ready
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'request-connection' }));
          logger.p2p('Requesting connections to existing peers');
        }
      }, P2P_CONFIG.CONNECTION_REQUEST_DELAY);
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as TrackerMessage;
        this.handleTrackerMessage(message);
      } catch (error) {
        logger.error('Failed to parse tracker message:', error);
      }
    };

    this.ws.onerror = (error) => logger.error('Tracker error:', error);
    this.ws.onclose = () => {
      logger.warn('Disconnected from tracker, reconnecting...');
      setTimeout(() => this.connectToTracker(url), P2P_CONFIG.RECONNECT_DELAY);
    };
  }

  private async handleTrackerMessage(message: TrackerMessage): Promise<void> {
    switch (message.type) {
      case 'welcome':
        this.clientId = message.clientId;
        logger.info('My peer ID:', this.clientId);
        break;
      case 'peer-joined-swarm':
      case 'announce-response':
        await this.handleSwarmPeers(message.modelId, message.peers);
        break;
      case 'peer-left-swarm':
        logger.p2p(`Peer ${message.peerId} left swarm ${message.modelId}, disconnecting.`);
        this.webRTCHandler?.handlePeerDisconnect(message.peerId);
        break;
      case 'offer':
        await this.webRTCHandler?.handleOffer(message.from, message.offer);
        break;
      case 'answer':
        await this.webRTCHandler?.handleAnswer(message.from, message.answer);
        break;
      case 'ice-candidate':
        await this.webRTCHandler?.handleIceCandidate(message.from, message.candidate);
        break;
      case 'request-connection':
        logger.p2p(`Connection request from ${message.from}`);
        await this.webRTCHandler?.createPeerConnection(message.from, true);
        break;
    }
  }

  private setupWebRTCHandlerCallbacks(): void {
    if (!this.webRTCHandler) return;

    this.webRTCHandler.onPeerConnected = (peerId) => {
      logger.p2p(`Peer connection established with ${peerId}`);
      this.onPeerConnected?.(peerId);
    };
    
    this.webRTCHandler.onPeerDisconnected = (peerId) => {
      logger.p2p(`Peer disconnected: ${peerId}`);
      // Clear metadata tracking for this peer
      this.metadataSentTo.forEach(peerSet => peerSet.delete(peerId));
      this.onPeerDisconnected?.(peerId);
    };
    
    this.webRTCHandler.onDataChannelMessage = (peerId, data) => this.handlePeerMessage(peerId, data);
    
    this.webRTCHandler.onDataChannelOpen = (peerId) => {
      logger.p2p(`Data channel OPEN with ${peerId} - sending metadata`);
      // Send metadata once when channel opens
      this.sendAllMetadata(peerId);
    };
  }

  private handlePeerMessage(peerId: string, data: string): void {
    try {
      const message = JSON.parse(data) as P2PMessage;
      switch (message.type) {
        case 'bitfield':
          this.handleBitfield(peerId, message);
          break;
        case 'have':
          this.handleHave(peerId, message);
          break;
        case 'request':
          const requestAction = this.swarmManager?.handleRequest(peerId, message);
          if (requestAction) {
            this.executeActions([requestAction]);
          }
          break;
        case 'piece':
          const pieceActions = this.swarmManager?.handlePiece(peerId, message, this.getPeerBitfields());
          if (pieceActions) {
            this.executeActions(pieceActions);
          }
          break;
        case 'metadata':
          this.handleMetadata(peerId, message);
          break;
      }
    } catch (error) {
      logger.error(`Failed to handle peer message from ${peerId}:`, error);
    }
  }
  
  private announceToTracker(modelId: string, complete: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot announce to tracker - not connected');
      return;
    }

    try {
      this.ws.send(JSON.stringify({
        type: 'announce',
        modelId,
        complete
      }));

      logger.p2p(`Announced ${modelId} to tracker (complete: ${complete})`);
    } catch (error) {
      logger.error('Failed to announce to tracker:', error);
    }
  }

  private async handleSwarmPeers(modelId: string, peers: any[]): Promise<void> {
    if (!peers || peers.length === 0) return;
    
    logger.p2p(`Swarm update for ${modelId}: ${peers.length} peers available`);
    
    // Connect to new peers we're not connected to yet
    const currentPeerCount = this.webRTCHandler?.getAllPeers().size || 0;
    const peersToConnect = peers
      .filter(p => p.id !== this.clientId && !this.webRTCHandler?.getPeer(p.id))
      .slice(0, P2P_CONFIG.MAX_PEERS - currentPeerCount);

    if (peersToConnect.length > 0) {
      logger.p2p(`Initiating connections to ${peersToConnect.length} new peers`);
      for (const peer of peersToConnect) {
        try {
          await this.webRTCHandler?.createPeerConnection(peer.id, true);
        } catch (error) {
          logger.error(`Failed to connect to peer ${peer.id}:`, error);
        }
      }
    }
  }

  private handleMetadata(peerId: string, message: any): void {
    const modelPackage: ModelPackage = message.package;
    logger.p2p(`Metadata received from ${peerId}: ${modelPackage.id}`);
    
    if (!this.swarmManager?.getSwarms().has(modelPackage.id)) {
      logger.info(`New model discovered: ${modelPackage.id}, starting download`);
      this.downloadModel(modelPackage.id, modelPackage);
    } else {
      logger.debug(`Already downloading/have model: ${modelPackage.id}`);
    }
  }
  
  /**
   * Send metadata and bitfield to a specific peer
   * Extracted to avoid duplication between sendAllMetadata and shareModel
   */
  private sendMetadataToPeer(peerId: string, modelId: string, metadata: ModelPackage, bitfield: Uint8Array): boolean {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
      logger.debug(`Cannot send metadata to ${peerId} - channel not ready`);
      return false;
    }
    
    // Check if already sent
    let peerSet = this.metadataSentTo.get(modelId);
    if (!peerSet) {
      peerSet = new Set();
      this.metadataSentTo.set(modelId, peerSet);
    }
    
    if (peerSet.has(peerId)) {
      logger.debug(`Already sent metadata for ${modelId} to ${peerId}, skipping`);
      return false;
    }
    
    try {
      peer.dataChannel.send(JSON.stringify({
        type: 'metadata',
        package: metadata
      }));
      
      peer.dataChannel.send(JSON.stringify({
        type: 'bitfield',
        modelId,
        bitfield: Array.from(bitfield)
      }));
      
      // Mark as sent to this peer
      peerSet.add(peerId);
      logger.debug(`Sent metadata for ${modelId} to ${peerId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to send metadata to ${peerId}:`, error);
      return false;
    }
  }

  private sendAllMetadata(peerId: string): void {
    let sentCount = 0;
    this.swarmManager?.getSwarms().forEach((swarm, modelId) => {
      if (swarm.metadata && swarm.ownChunks.size === swarm.totalChunks) {
        const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
        if (this.sendMetadataToPeer(peerId, modelId, swarm.metadata, bitfield)) {
          sentCount++;
        }
      }
    });

    if (sentCount === 0) {
      logger.debug(`No new models to share with ${peerId}`);
    } else {
      logger.p2p(`Sent ${sentCount} model(s) metadata to ${peerId}`);
    }
  }

  private handleBitfield(peerId: string, message: any): void {
    const { modelId, bitfield } = message;
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer) return;
    
    const bitfieldArray = new Uint8Array(bitfield);
    peer.bitfield.set(modelId, bitfieldArray);
    
    const hasPieces = Array.from(bitfieldArray).some(byte => byte !== 0);
    logger.debug(`Received bitfield from ${peerId} for ${modelId} (has pieces: ${hasPieces})`);
    
    if (this.swarmManager?.getSwarms().has(modelId)) {
      const actions = this.swarmManager?.requestChunksFromPeer(peerId, modelId, bitfieldArray);
      if (actions) {
        this.executeActions(actions);
      }
    }
  }

  private handleHave(peerId: string, message: any): void {
    const { modelId, chunkIndex } = message;
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer) return;
    
    let bitfield = peer.bitfield.get(modelId);
    if (!bitfield) {
      const swarm = this.swarmManager?.getSwarms().get(modelId);
      if (!swarm) return;
      bitfield = new Uint8Array(Math.ceil(swarm.totalChunks / 8));
      peer.bitfield.set(modelId, bitfield);
    }
    
    Utils.setBit(bitfield, chunkIndex);
    logger.debug(`Peer ${peerId} now has chunk ${chunkIndex} of ${modelId}`);
  }

  // Execute actions returned by SwarmManager
  private executeActions(actions: SwarmAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case 'request_chunk':
          this.requestChunk(action.peerId!, action.modelId, action.chunkIndex!);
          break;
        case 'send_piece':
          this.sendPiece(action.peerId!, action.modelId, action.chunk!);
          break;
        case 'broadcast_have':
          this.broadcastHave(action.modelId, action.chunkIndex!);
          break;
        case 'download_complete':
          this.handleDownloadComplete(action.modelId);
          break;
        case 'download_progress':
          this.onDownloadProgress?.(action.modelId, action.progress!);
          break;
      }
    }
  }

  private requestChunk(peerId: string, modelId: string, chunkIndex: number): void {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
      logger.debug(`Cannot request chunk from ${peerId} - channel not ready`);
      return;
    }

    try {
      peer.dataChannel.send(JSON.stringify({
        type: 'request',
        modelId,
        chunkIndex
      }));

      logger.debug(`Requesting chunk ${chunkIndex} from ${peerId}`);
    } catch (error) {
      logger.error(`Failed to request chunk from ${peerId}:`, error);
    }
  }

  private sendPiece(peerId: string, modelId: string, chunk: ModelChunk): void {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return;
    
    try {
      peer.dataChannel.send(JSON.stringify({
        type: 'piece',
        modelId,
        chunkIndex: chunk.index,
        data: Utils.arrayBufferToBase64(chunk.data),
        checksum: chunk.checksum
      }));
      logger.debug(`Sent chunk ${chunk.index} to ${peerId}`);
    } catch (error) {
      logger.error(`Failed to send piece to ${peerId}:`, error);
    }
  }

  private broadcastHave(modelId: string, chunkIndex: number): void {
    this.webRTCHandler?.getAllPeers().forEach((peer) => {
      if (peer.dataChannel?.readyState === 'open') {
        try {
          peer.dataChannel.send(JSON.stringify({ type: 'have', modelId, chunkIndex }));
        } catch (error) {
          logger.error(`Failed to broadcast have to ${peer.id}:`, error);
        }
      }
    });
  }

  // Helper methods to extract peer data for SwarmManager
  private getPeerBitfields(): Map<string, Map<string, Uint8Array>> {
    const bitfields = new Map<string, Map<string, Uint8Array>>();
    this.webRTCHandler?.getAllPeers().forEach((peer, peerId) => {
      if (peer.dataChannel?.readyState === 'open') {
        bitfields.set(peerId, peer.bitfield);
      }
    });
    return bitfields;
  }

  private async handleDownloadComplete(modelId: string): Promise<void> {
    const swarm = this.swarmManager?.getSwarms().get(modelId);
    if (!swarm || !swarm.metadata) return;
    
    logger.info(`Download complete for ${modelId}!`);
    
    // Clean up metadata tracking for completed downloads
    this.metadataSentTo.delete(modelId);
    
    const sortedChunks = Array.from(swarm.receivedChunks.values()).sort((a, b) => a.index - b.index);
    const blobUrl = ModelSerializer.createBlobFromChunks(sortedChunks);
    
    try {
      const result = await SceneLoader.ImportMeshAsync("", blobUrl, "", this.scene, undefined, ".glb");
      if (result.meshes.length > 0) {
        const rootMesh = result.meshes[0];
        rootMesh.position = new Vector3(swarm.metadata.position.x, swarm.metadata.position.y, swarm.metadata.position.z);
        rootMesh.rotation = new Vector3(swarm.metadata.rotation.x, swarm.metadata.rotation.y, swarm.metadata.rotation.z);
        rootMesh.scaling = new Vector3(swarm.metadata.scale.x, swarm.metadata.scale.y, swarm.metadata.scale.z);
        this.onModelReceived?.(swarm.metadata);
        result.meshes.forEach(mesh => {
          if (mesh.material instanceof PBRMaterial) {
            mesh.material.unlit = true;
          }
          this.shadowGenerator.addShadowCaster(mesh);
        });
      }
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      logger.error('Failed to load model:', error);
    }
    
    this.announceToTracker(modelId, true);
  }

  async shareModel(modelUrl: string, position: Vector3, rotation: Vector3, scale: Vector3, prompt?: string): Promise<void> {
    try {
      const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(modelUrl, position, rotation, scale, { prompt, authorId: this.clientId || 'unknown' });
      const modelId = modelPackage.id;
      
      const swarm = this.swarmManager?.createSwarm(modelId, modelPackage, chunks);
      if (!swarm) return;
      
      logger.info(`Sharing ${modelId} (${chunks.length} chunks)`);
      
      // Announce to tracker first
      this.announceToTracker(modelId, true);
      
      // Send to all connected peers using the extracted method
      let sentTo = 0;
      const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
      this.webRTCHandler?.getAllPeers().forEach((peer) => {
        if (this.sendMetadataToPeer(peer.id, modelId, modelPackage, bitfield)) {
          sentTo++;
        }
      });
      
      logger.info(`Shared model with ${sentTo} peer(s)`);
    } catch (error) {
      logger.error('Failed to share model:', error);
    }
  }

  async downloadModel(modelId: string, metadata: ModelPackage): Promise<void> {
    if (this.swarmManager?.getSwarms().has(modelId)) {
      logger.debug(`Already downloading ${modelId}`);
      return;
    }
    
    this.swarmManager?.createSwarm(modelId, metadata);
    logger.info(`Starting download for ${modelId} (${metadata.metadata.totalChunks} chunks)`);
    
    this.announceToTracker(modelId, false);
    
    const actions = this.swarmManager?.requestMoreChunks(modelId, this.getPeerBitfields());
    if (actions && actions.length > 0) {
      logger.p2p(`Requesting ${actions.length} chunks to start download`);
      this.executeActions(actions);
    } else {
      logger.debug(`No chunks available to request yet`);
    }
  }

  // Public API
  public setOnPeerConnected = (cb: (peerId: string) => void) => this.onPeerConnected = cb;
  public setOnPeerDisconnected = (cb: (peerId: string) => void) => this.onPeerDisconnected = cb;
  public setOnModelReceived = (cb: (modelPackage: ModelPackage) => void) => this.onModelReceived = cb;
  public setOnDownloadProgress = (cb: (modelId: string, progress: number) => void) => this.onDownloadProgress = cb;
  public getConnectedPeers = (): string[] => Array.from(this.webRTCHandler?.getAllPeers().keys() || []);

  public disconnect(): void {
    // Clear metadata tracking
    this.metadataSentTo.clear();
    
    this.webRTCHandler?.disconnectAll();
    this.ws?.close();
    logger.info('Disconnected from all peers and tracker');
  }

  public async sendTestMesh(): Promise<void> {
    console.log("[TEST] Sending mesh from puppeteer...");
    // Place at a random position within (-10, 1, -10) to (10, 1, 10)
    const x = Math.random() * 20 - 10;
    const y = 1;
    const z = Math.random() * 20 - 10;
    const position = new Vector3(x, y, z);
    const rotation = new Vector3(0, 0, 0);
    const scale = new Vector3(1, 1, 1);
    const modelUrl = "public/models/test_model_1.glb";
    try {
      await this.shareModel(modelUrl, position, rotation, scale, "Test mesh from puppeteer");
      console.log(`[TEST] Mesh shared at (${x.toFixed(2)}, ${y}, ${z.toFixed(2)})`);
    } catch (error) {
      console.error("[TEST] Failed to share mesh:", error);
    }
  }

}

export default P2PClient;

if (typeof window !== "undefined") {
  (window as any).sendTestMesh = () => {
    window.p2pClientInstance?.sendTestMesh();
  };
}