import { ModelSerializer, ModelPackage, ModelChunk } from './model-serializer';
import { Vector3 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { WebRTCHandler } from './webrtc-handler';
import * as Utils from './utils';
import { SwarmManager, SwarmAction } from './swarm-manager';

/**
 * BitTorrent-inspired P2P client for 3D model sharing. This class is the main coordinator.
 */
export class P2PClient {
  private ws: WebSocket | null = null;
  private clientId: string | null = null;
  private webRTCHandler: WebRTCHandler | null = null;
  private swarmManager: SwarmManager | null = null;
  private scene: Scene;
  
  // Track pending metadata sends for retry
  private pendingMetadataSends = new Map<string, NodeJS.Timeout>();
  
  // Callbacks
  private onPeerConnected?: (peerId: string) => void;
  private onPeerDisconnected?: (peerId: string) => void;
  private onModelReceived?: (modelPackage: ModelPackage) => void;
  private onDownloadProgress?: (modelId: string, progress: number) => void;
  
  constructor(scene: Scene, trackerUrl: string = 'wss://p2p-mesh-sharing.onrender.com') {
    this.scene = scene;
    this.connectToTracker(trackerUrl);
    
    setInterval(() => {
      if (this.swarmManager && this.webRTCHandler) {
        const actions = this.swarmManager.maintainSwarms(
          this.getPeerBitfields(),
          this.getPeerLastActivity()
        );
        this.executeActions(actions);
      }
    }, 15000);
  }

  private connectToTracker(url: string) {
    console.log('🔗 Connecting to tracker...');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('✅ Connected to tracker');
      this.webRTCHandler = new WebRTCHandler(this.ws!);
      this.swarmManager = new SwarmManager();
      this.setupWebRTCHandlerCallbacks();
      
      // Delay connection request to ensure everything is ready
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
        console.log(`🤝 Connection request from ${message.from}`);
        await this.webRTCHandler?.createPeerConnection(message.from, true);
        break;
    }
  }

  private setupWebRTCHandlerCallbacks() {
    if (!this.webRTCHandler) return;

    this.webRTCHandler.onPeerConnected = (peerId) => {
      console.log(`✅ Peer connection established with ${peerId}`);
      this.onPeerConnected?.(peerId);
    };
    
    this.webRTCHandler.onPeerDisconnected = (peerId) => {
      console.log(`❌ Peer disconnected: ${peerId}`);
      // Clear any pending metadata sends for this peer
      const timeout = this.pendingMetadataSends.get(peerId);
      if (timeout) {
        clearTimeout(timeout);
        this.pendingMetadataSends.delete(peerId);
      }
      this.onPeerDisconnected?.(peerId);
    };
    
    this.webRTCHandler.onDataChannelMessage = (peerId, data) => this.handlePeerMessage(peerId, data);
    
    this.webRTCHandler.onDataChannelOpen = (peerId) => {
      console.log(`📡 Data channel OPEN with ${peerId} - sending metadata`);
      // Send metadata immediately when channel opens
      this.sendAllMetadata(peerId);
      
      // Also retry after a short delay in case of any issues
      this.scheduleMetadataRetry(peerId);
    };
  }

  private scheduleMetadataRetry(peerId: string, attemptNumber: number = 1) {
    // Clear any existing timeout
    const existingTimeout = this.pendingMetadataSends.get(peerId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Max 3 retry attempts
    if (attemptNumber > 3) {
      console.log(`⚠️ Gave up retrying metadata send to ${peerId} after 3 attempts`);
      this.pendingMetadataSends.delete(peerId);
      return;
    }

    // Schedule retry with exponential backoff
    const delay = 1000 * attemptNumber;
    const timeout = setTimeout(() => {
      const peer = this.webRTCHandler?.getPeer(peerId);
      if (peer?.dataChannel?.readyState === 'open') {
        console.log(`🔄 Retry #${attemptNumber}: Sending metadata to ${peerId}`);
        this.sendAllMetadata(peerId);
        this.scheduleMetadataRetry(peerId, attemptNumber + 1);
      } else {
        console.log(`⏭️ Skipping retry for ${peerId} - channel not open`);
        this.pendingMetadataSends.delete(peerId);
      }
    }, delay);

    this.pendingMetadataSends.set(peerId, timeout);
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
    if (!peers || peers.length === 0) return;
    
    console.log(`🔗 Swarm update for ${modelId}: ${peers.length} peers available`);
    
    // Connect to new peers we're not connected to yet
    const peersToConnect = peers
      .filter(p => p.id !== this.clientId && !this.webRTCHandler?.getPeer(p.id))
      .slice(0, 50 - (this.webRTCHandler?.getAllPeers().size || 0));

    if (peersToConnect.length > 0) {
      console.log(`📞 Initiating connections to ${peersToConnect.length} new peers`);
      for (const peer of peersToConnect) {
        await this.webRTCHandler?.createPeerConnection(peer.id, true);
      }
    }

    // For existing connections, ensure we have their metadata
    peers.forEach(peer => {
      if (peer.id !== this.clientId && peer.complete) {
        const existingPeer = this.webRTCHandler?.getPeer(peer.id);
        if (existingPeer?.dataChannel?.readyState === 'open') {
          // Peer has complete model but we might not have received metadata yet
          // The peer should send it when channel opens, but we can request it
          console.log(`✅ Peer ${peer.id} has complete model ${modelId}`);
        }
      }
    });
  }

  private handleMetadata(peerId: string, message: any) {
    const modelPackage: ModelPackage = message.package;
    console.log(`📦 Metadata received from ${peerId}: ${modelPackage.id}`);
    
    if (!this.swarmManager?.getSwarms().has(modelPackage.id)) {
      console.log(`🆕 New model discovered: ${modelPackage.id}, starting download`);
      this.downloadModel(modelPackage.id, modelPackage);
    } else {
      console.log(`ℹ️ Already downloading/have model: ${modelPackage.id}`);
    }
  }

  private sendAllMetadata(peerId: string) {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
      console.log(`⚠️ Cannot send metadata to ${peerId} - channel not ready (state: ${peer?.dataChannel?.readyState})`);
      return;
    }

    let sentCount = 0;
    this.swarmManager?.getSwarms().forEach((swarm, modelId) => {
      if (swarm.metadata && swarm.ownChunks.size === swarm.totalChunks) {
        try {
          peer.dataChannel!.send(JSON.stringify({ 
            type: 'metadata', 
            package: swarm.metadata 
          }));
          
          const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
          peer.dataChannel!.send(JSON.stringify({ 
            type: 'bitfield', 
            modelId, 
            bitfield: Array.from(bitfield) 
          }));
          
          sentCount++;
          console.log(`📤 Sent metadata for ${modelId} to ${peerId}`);
        } catch (error) {
          console.error(`❌ Failed to send metadata to ${peerId}:`, error);
        }
      }
    });

    if (sentCount === 0) {
      console.log(`ℹ️ No complete models to share with ${peerId}`);
    } else {
      console.log(`✅ Sent ${sentCount} model(s) metadata to ${peerId}`);
    }
  }

  private handleBitfield(peerId: string, message: any) {
    const { modelId, bitfield } = message;
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer) return;
    
    const bitfieldArray = new Uint8Array(bitfield);
    peer.bitfield.set(modelId, bitfieldArray);
    
    const hasPieces = Array.from(bitfieldArray).some(byte => byte !== 0);
    console.log(`📊 Received bitfield from ${peerId} for ${modelId} (has pieces: ${hasPieces})`);
    
    if (this.swarmManager?.getSwarms().has(modelId)) {
      const actions = this.swarmManager?.requestChunksFromPeer(peerId, modelId, bitfieldArray);
      if (actions) {
        this.executeActions(actions);
      }
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
    
    const actions = this.swarmManager?.requestChunksFromPeer(peerId, modelId, bitfield);
    if (actions) {
      this.executeActions(actions);
    }
  }

  // Execute actions returned by SwarmManager
  private executeActions(actions: SwarmAction[]) {
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

  private requestChunk(peerId: string, modelId: string, chunkIndex: number) {
    const peer = this.webRTCHandler?.getPeer(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
      console.log(`⚠️ Cannot request chunk from ${peerId} - channel not ready`);
      return;
    }

    peer.dataChannel.send(JSON.stringify({
      type: 'request',
      modelId,
      chunkIndex
    }));

    console.log(`📥 Requesting chunk ${chunkIndex} from ${peerId}`);
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

  private getPeerLastActivity(): Map<string, number> {
    const lastActivity = new Map<string, number>();
    this.webRTCHandler?.getAllPeers().forEach((peer, peerId) => {
      lastActivity.set(peerId, peer.lastActivity);
    });
    return lastActivity;
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
    
    // Announce to tracker first
    this.announceToTracker(modelId, true);
    
    // Send to all connected peers
    let sentTo = 0;
    this.webRTCHandler?.getAllPeers().forEach((peer) => {
      if (peer.dataChannel?.readyState === 'open') {
        try {
          peer.dataChannel.send(JSON.stringify({ type: 'metadata', package: modelPackage }));
          const bitfield = Utils.createBitfield(swarm.ownChunks, swarm.totalChunks);
          peer.dataChannel.send(JSON.stringify({ type: 'bitfield', modelId, bitfield: Array.from(bitfield) }));
          sentTo++;
          console.log(`📤 Shared model with peer ${peer.id}`);
        } catch (error) {
          console.error(`❌ Failed to share with peer ${peer.id}:`, error);
        }
      }
    });
    
    console.log(`✅ Shared model with ${sentTo} peer(s)`);
  }

  async downloadModel(modelId: string, metadata: ModelPackage) {
    if (this.swarmManager?.getSwarms().has(modelId)) {
      console.log(`ℹ️ Already downloading ${modelId}`);
      return;
    }
    
    this.swarmManager?.createSwarm(modelId, metadata);
    console.log(`📥 Starting download for ${modelId} (${metadata.metadata.totalChunks} chunks)`);
    
    this.announceToTracker(modelId, false, []);
    
    const actions = this.swarmManager?.requestMoreChunks(modelId, this.getPeerBitfields());
    if (actions) {
      console.log(`📊 Requesting ${actions.length} chunks to start download`);
      this.executeActions(actions);
    } else {
      console.log(`⚠️ No chunks available to request yet`);
    }
  }

  // Public API
  public setOnPeerConnected = (cb: (peerId: string) => void) => this.onPeerConnected = cb;
  public setOnPeerDisconnected = (cb: (peerId: string) => void) => this.onPeerDisconnected = cb;
  public setOnModelReceived = (cb: (modelPackage: ModelPackage) => void) => this.onModelReceived = cb;
  public setOnDownloadProgress = (cb: (modelId: string, progress: number) => void) => this.onDownloadProgress = cb;
  public getConnectedPeers = (): string[] => Array.from(this.webRTCHandler?.getAllPeers().keys() || []);

  public disconnect() {
    // Clear all pending metadata sends
    this.pendingMetadataSends.forEach(timeout => clearTimeout(timeout));
    this.pendingMetadataSends.clear();
    
    this.webRTCHandler?.disconnectAll();
    this.ws?.close();
    console.log('👋 Disconnected from all peers and tracker');
  }
}

export default P2PClient;