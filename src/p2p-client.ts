import { ModelSerializer, ModelPackage, ModelChunk } from './model-serializer';
import { Vector3 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { WebRTCHandler } from './webrtc-handler';
import * as Utils from './utils';
import { SwarmManager } from './swarm-manager';

/**
 * BitTorrent-inspired P2P client for 3D model sharing. This class is the main coordinator.
 */
export class P2PClient {
  private ws: WebSocket | null = null;
  private clientId: string | null = null;
  private webRTCHandler: WebRTCHandler | null = null;
  private swarmManager: SwarmManager | null = null;
  private scene: Scene;
  
  // Callbacks
  private onPeerConnected?: (peerId: string) => void;
  private onPeerDisconnected?: (peerId: string) => void;
  private onModelReceived?: (modelPackage: ModelPackage) => void;
  private onDownloadProgress?: (modelId: string, progress: number) => void;
  
  constructor(scene: Scene, trackerUrl: string = 'ws://localhost:8080') {
    this.scene = scene;
    this.connectToTracker(trackerUrl);
    
    setInterval(() => this.swarmManager?.maintainSwarms(), 15000);
  }

  private connectToTracker(url: string) {
    console.log('🔗 Connecting to tracker...');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('✅ Connected to tracker');
      this.webRTCHandler = new WebRTCHandler(this.ws!);
      this.swarmManager = new SwarmManager(this.webRTCHandler);
      this.setupWebRTCHandlerCallbacks();
      
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'request-connection' }));
          console.log('📡 Requesting connections to existing peers');
        }
      }, 1000);
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleTrackerMessage(message);
    };

    this.ws.onerror = (error) => console.error('❌ Tracker error:', error);
    this.ws.onclose = () => {
      console.log('❌ Disconnected from tracker, reconnecting...');
      setTimeout(() => this.connectToTracker(url), 3000);
    };
  }

  private async handleTrackerMessage(message: any) {
    switch (message.type) {
      case 'welcome':
        this.clientId = message.clientId;
        console.log('🆔 My peer ID:', this.clientId);
        break;
      case 'peer-joined-swarm':
      case 'announce-response':
        this.handleSwarmPeers(message.modelId, message.peers);
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
        await this.webRTCHandler?.createPeerConnection(message.from, true);
        break;
    }
  }

  private setupWebRTCHandlerCallbacks() {
    if (!this.webRTCHandler) return;

    this.webRTCHandler.onPeerConnected = (peerId) => {
      this.onPeerConnected?.(peerId);
      this.sendAllMetadata(peerId);
    };
    this.webRTCHandler.onPeerDisconnected = (peerId) => this.onPeerDisconnected?.(peerId);
    this.webRTCHandler.onDataChannelMessage = (peerId, data) => this.handlePeerMessage(peerId, data);
    this.webRTCHandler.onDataChannelOpen = (peerId) => this.sendAllMetadata(peerId);
  }

  private handlePeerMessage(peerId: string, data: any) {
    const message = JSON.parse(data);
    switch (message.type) {
      case 'bitfield':
        this.handleBitfield(peerId, message);
        break;
      case 'have':
        this.handleHave(peerId, message);
        break;
      case 'request':
        this.swarmManager?.handleRequest(peerId, message, this.sendPiece.bind(this));
        break;
      case 'piece':
        this.swarmManager?.handlePiece(peerId, message, this.handleDownloadComplete.bind(this), this.onDownloadProgress!, this.broadcastHave.bind(this));
        break;
      case 'metadata':
        this.handleMetadata(peerId, message);
        break;
    }
  }
  
  private announceToTracker(modelId: string, complete: boolean, chunks: number[] = []) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'announce',
      modelId,
      complete,
      chunks
    }));

    console.log(`📢 Announced ${modelId} to tracker (complete: ${complete})`);
  }

  private async handleSwarmPeers(modelId: string, peers: any[]) {
    if (peers && peers.length > 0) {
      console.log(`🔗 Connecting to ${peers.length} peers in swarm ${modelId}`);
      await this.joinSwarm(modelId, peers);
    }
  }

  private async joinSwarm(modelId: string, peers: any[]) {
    console.log(`🚀 Joining swarm for ${modelId}`);
    const peersToConnect = peers
      .filter(p => p.id !== this.clientId && !this.webRTCHandler?.getPeer(p.id))
      .slice(0, 50 - (this.webRTCHandler?.getAllPeers().size || 0));

    for (const peer of peersToConnect) {
      await this.webRTCHandler?.createPeerConnection(peer.id, true);
    }
  }

  private handleMetadata(peerId: string, message: any) {
    const modelPackage: ModelPackage = message.package;
    console.log(`📦 Metadata received from ${peerId}: ${modelPackage.id}`);
    if (!this.swarmManager?.getSwarms().has(modelPackage.id)) {
      this.downloadModel(modelPackage.id, modelPackage);
    }
  }

  private sendAllMetadata(peerId: string) {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return;

    this.swarmManager?.getSwarms().forEach((swarm, modelId) => {
      if (swarm.metadata && swarm.ownChunks.size === swarm.totalChunks) {
        try {
          peer.dataChannel!.send(JSON.stringify({ type: 'metadata', package: swarm.metadata }));
          const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
          peer.dataChannel!.send(JSON.stringify({ type: 'bitfield', modelId, bitfield: Array.from(bitfield) }));
        } catch (error) {
          console.error(`Failed to send metadata to ${peerId}:`, error);
        }
      }
    });
  }

  private handleBitfield(peerId: string, message: any) {
    const { modelId, bitfield } = message;
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer) return;
    peer.bitfield.set(modelId, new Uint8Array(bitfield));
    console.log(`📊 Received bitfield from ${peerId} for ${modelId}`);
    if (this.swarmManager?.getSwarms().has(modelId)) {
      this.swarmManager?.requestChunksFromPeer(peerId, modelId);
    }
  }

  private handleHave(peerId: string, message: any) {
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
    console.log(`📣 Peer ${peerId} now has chunk ${chunkIndex} of ${modelId}`);
    this.swarmManager?.requestChunksFromPeer(peerId, modelId);
  }

  private sendPiece(peerId: string, modelId: string, chunk: ModelChunk) {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return;
    peer.dataChannel.send(JSON.stringify({
      type: 'piece',
      modelId,
      chunkIndex: chunk.index,
      data: Utils.arrayBufferToBase64(chunk.data),
      checksum: chunk.checksum
    }));
    console.log(`📤 Sent chunk ${chunk.index} to ${peerId}`);
  }

  private broadcastHave(modelId: string, chunkIndex: number) {
    this.webRTCHandler?.getAllPeers().forEach((peer) => {
      if (peer.dataChannel?.readyState === 'open') {
        peer.dataChannel.send(JSON.stringify({ type: 'have', modelId, chunkIndex }));
      }
    });
  }

  private async handleDownloadComplete(modelId: string) {
    const swarm = this.swarmManager?.getSwarms().get(modelId);
    if (!swarm || !swarm.metadata) return;
    console.log(`🎉 Download complete for ${modelId}!`);
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
      }
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('❌ Failed to load model:', error);
    }
    this.announceToTracker(modelId, true);
  }

  async shareModel(modelUrl: string, position: Vector3, rotation: Vector3, scale: Vector3, prompt?: string) {
    const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(modelUrl, position, rotation, scale, { prompt, authorId: this.clientId || 'unknown' });
    const modelId = modelPackage.id;
    const swarm = this.swarmManager?.createSwarm(modelId, modelPackage, chunks);
    if (!swarm) return;
    console.log(`📤 Sharing ${modelId} (${chunks.length} chunks)`);
    this.announceToTracker(modelId, true);
    this.webRTCHandler?.getAllPeers().forEach((peer) => {
      if (peer.dataChannel?.readyState === 'open') {
        peer.dataChannel.send(JSON.stringify({ type: 'metadata', package: modelPackage }));
        const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
        peer.dataChannel.send(JSON.stringify({ type: 'bitfield', modelId, bitfield: Array.from(bitfield) }));
      }
    });
  }

  async downloadModel(modelId: string, metadata: ModelPackage) {
    if (this.swarmManager?.getSwarms().has(modelId)) return;
    this.swarmManager?.createSwarm(modelId, metadata);
    console.log(`📥 Starting download for ${modelId}`);
    this.announceToTracker(modelId, false, []);
    this.swarmManager?.requestMoreChunks(modelId);
  }

  // Public API
  public setOnPeerConnected = (cb: (peerId: string) => void) => this.onPeerConnected = cb;
  public setOnPeerDisconnected = (cb: (peerId: string) => void) => this.onPeerDisconnected = cb;
  public setOnModelReceived = (cb: (modelPackage: ModelPackage) => void) => this.onModelReceived = cb;
  public setOnDownloadProgress = (cb: (modelId: string, progress: number) => void) => this.onDownloadProgress = cb;
  public getConnectedPeers = (): string[] => Array.from(this.webRTCHandler?.getAllPeers().keys() || []);

  public disconnect() {
    this.webRTCHandler?.disconnectAll();
    this.ws?.close();
    console.log('👋 Disconnected from all peers and tracker');
  }
}

export default P2PClient;