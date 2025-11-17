import { Peer } from './types';
import { P2P_CONFIG } from './constants';
import { logger } from './logger';

const getRTCConfig = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];

  if (import.meta.env.VITE_STUN_URL) {
    iceServers.push({ urls: import.meta.env.VITE_STUN_URL });
    logger.info('STUN configured:', import.meta.env.VITE_STUN_URL);
  }

  if (import.meta.env.VITE_TURN_URLS) {
    const turnUrls = import.meta.env.VITE_TURN_URLS.split(',');
    turnUrls.forEach((url: string) => {
      iceServers.push({
        urls: url.trim(),
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      });
    });
    logger.info(`TURN configured: ${turnUrls.length} server(s)`);
  }

  return {
    iceServers,
    iceCandidatePoolSize: P2P_CONFIG.ICE_CANDIDATE_POOL_SIZE,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

const RTC_CONFIG = getRTCConfig();

export class WebRTCHandler {
  private peers = new Map<string, Peer>();
  private ws: WebSocket;
  private rtcConfig: RTCConfiguration;
  private readonly MAX_PEERS = P2P_CONFIG.MAX_PEERS;
  private disconnectTimeouts = new Map<string, NodeJS.Timeout>();

  // Callbacks to communicate with P2PClient
  public onPeerConnected: (peerId: string) => void = () => {};
  public onPeerDisconnected: (peerId: string) => void = () => {};
  public onDataChannelMessage: (peerId: string, data: any) => void = () => {};
  public onDataChannelOpen: (peerId: string) => void = () => {};

  constructor(ws: WebSocket, rtcConfig: RTCConfiguration = RTC_CONFIG) {
    this.ws = ws;
    this.rtcConfig = rtcConfig;
  }

  public getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  public getAllPeers(): Map<string, Peer> {
    return this.peers;
  }

  public async createPeerConnection(peerId: string, isInitiator: boolean): Promise<Peer | null> {
    if (this.peers.has(peerId)) {
      logger.debug(`Peer ${peerId} already exists, reusing connection`);
      return this.peers.get(peerId)!;
    }

    if (this.peers.size >= this.MAX_PEERS) {
      logger.warn(`Max peers reached (${this.MAX_PEERS}), not connecting to ${peerId}`);
      return null;
    }

    logger.webrtc(`Creating connection with ${peerId} (initiator: ${isInitiator})`);

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer: Peer = {
      id: peerId,
      connection: pc,
      dataChannel: null,
      isInitiator,
      bitfield: new Map(),
      lastActivity: Date.now()
    };

    // Track candidate types for this peer
    const candidateTypes = new Set<string>();

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        const candidateType = event.candidate.type || 'unknown';
        const candidateStr = event.candidate.candidate || '';
        
        if (candidateType !== 'unknown') {
          candidateTypes.add(candidateType);
        }
        
        logger.debug(`🧊 ICE candidate for ${peerId}:`, {
          type: candidateType,
          protocol: candidateStr.includes('udp') ? 'UDP' : candidateStr.includes('tcp') ? 'TCP' : 'unknown',
          relay: candidateType === 'relay' ? 'TURN' : 'Direct'
        });
        
        try {
          this.ws.send(JSON.stringify({
            type: 'ice-candidate',
            to: peerId,
            candidate: event.candidate
          }));
        } catch (error) {
          logger.error(`Failed to send ICE candidate to ${peerId}:`, error);
        }
      } else if (!event.candidate) {
        const hasRelay = candidateTypes.has('relay');
        logger.debug(`ICE gathering complete for ${peerId}:`, {
          candidateTypes: Array.from(candidateTypes),
          usingTURN: hasRelay ? 'YES' : 'NO - Will fail across networks!'
        });
      }
    };

    // ICE connection state monitoring with restart capability
    pc.oniceconnectionstatechange = async () => {
      logger.debug(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
      
      if (pc.iceConnectionState === 'disconnected') {
        logger.warn(`ICE connection disconnected for ${peerId}, will attempt restart if it fails`);
      } else if (pc.iceConnectionState === 'failed') {
        logger.warn(`ICE connection failed for ${peerId}, attempting ICE restart...`);
        
        // Attempt ICE restart instead of immediately disconnecting
        try {
          if (peer.isInitiator && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            
            this.ws.send(JSON.stringify({
              type: 'offer',
              to: peerId,
              offer: pc.localDescription
            }));
            
            logger.info(`Sent ICE restart offer to ${peerId}`);
          }
        } catch (error) {
          logger.error(`ICE restart failed for ${peerId}:`, error);
        }
      }
    };

    // ICE gathering state monitoring
    pc.onicegatheringstatechange = () => {
      logger.debug(`ICE gathering state for ${peerId}: ${pc.iceGatheringState}`);
    };

    // Connection state handler with centralized timeout management
    pc.onconnectionstatechange = () => {
      logger.debug(`Connection state for ${peerId}: ${pc.connectionState}`);
      
      // Clear any existing timeout for this peer
      const existingTimeout = this.disconnectTimeouts.get(peerId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.disconnectTimeouts.delete(peerId);
      }
      
      if (pc.connectionState === 'connected') {
        logger.webrtc(`Peer connection established with ${peerId}`);
        this.onPeerConnected(peerId);
      } else if (pc.connectionState === 'disconnected') {
        logger.debug(`Peer ${peerId} disconnected (waiting ${P2P_CONFIG.DISCONNECT_GRACE_PERIOD}ms before cleanup)`);
        
        const timeout = setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            logger.info(`Peer ${peerId} still disconnected, cleaning up`);
            this.handlePeerDisconnect(peerId);
          }
          this.disconnectTimeouts.delete(peerId);
        }, P2P_CONFIG.DISCONNECT_GRACE_PERIOD);
        
        this.disconnectTimeouts.set(peerId, timeout);
      } else if (pc.connectionState === 'failed') {
        logger.error(`Peer ${peerId} connection failed`);
        
        // Give ICE restart a chance
        const timeout = setTimeout(() => {
          if (pc.connectionState === 'failed') {
            logger.info(`Peer ${peerId} still failed after ICE restart attempt, cleaning up`);
            this.handlePeerDisconnect(peerId);
          }
          this.disconnectTimeouts.delete(peerId);
        }, P2P_CONFIG.ICE_RESTART_GRACE_PERIOD);
        
        this.disconnectTimeouts.set(peerId, timeout);
      } else if (pc.connectionState === 'closed') {
        logger.debug(`Peer ${peerId} connection closed`);
        this.handlePeerDisconnect(peerId);
      }
    };

    if (isInitiator) {
      // Initiator creates the data channel
      logger.debug(`Creating data channel for ${peerId} (initiator)`);
      const dataChannel = pc.createDataChannel('bittorrent', {
        ordered: true,
        maxRetransmits: 3
      });
      this.setupDataChannel(peerId, dataChannel);
      peer.dataChannel = dataChannel;

      // Create and send offer
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        logger.debug(`Sending offer to ${peerId}`);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'offer',
            to: peerId,
            offer: pc.localDescription
          }));
        }
      } catch (error) {
        logger.error(`Failed to create/send offer to ${peerId}:`, error);
        this.handlePeerDisconnect(peerId);
        return null;
      }
    } else {
      // Answerer receives data channel via ondatachannel event
      logger.debug(`Waiting for data channel from ${peerId} (answerer)`);
      pc.ondatachannel = (event) => {
        logger.debug(`Received data channel from ${peerId}`);
        this.setupDataChannel(peerId, event.channel);
        peer.dataChannel = event.channel;
      };
    }

    this.peers.set(peerId, peer);
    return peer;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    logger.debug(`Setting up data channel for ${peerId} (current state: ${channel.readyState})`);
    channel.binaryType = 'arraybuffer';

    // Track state changes
    let openTimestamp: number | null = null;

    channel.onopen = () => {
      openTimestamp = Date.now();
      logger.webrtc(`Data channel OPEN with ${peerId}`);
      this.onDataChannelOpen(peerId);
    };

    channel.onmessage = (event) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastActivity = Date.now();
      }
      
      this.onDataChannelMessage(peerId, event.data);
    };

    channel.onerror = (error) => {
      logger.error(`Data channel ERROR with ${peerId}:`, error);
    };

    channel.onclose = () => {
      logger.debug(`Data channel CLOSED with ${peerId}`);
    };

    // If channel is already open, trigger the callback immediately
    if (channel.readyState === 'open') {
      logger.debug(`Data channel already open with ${peerId}, triggering callback immediately`);
      openTimestamp = Date.now();
      this.onDataChannelOpen(peerId);
    }
  }

  public async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    logger.debug(`Received offer from ${peerId}`);
    try {
      const peer = await this.createPeerConnection(peerId, false);
      if (!peer) return;
      
      await peer.connection.setRemoteDescription(offer);
      logger.debug(`Set remote description (offer) from ${peerId}`);

      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      logger.debug(`Created and set local description (answer) for ${peerId}`);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        logger.debug(`Sending answer to ${peerId}`);
        this.ws.send(JSON.stringify({
          type: 'answer',
          to: peerId,
          answer: peer.connection.localDescription
        }));
      }
    } catch (error) {
      logger.error(`Failed to handle offer from ${peerId}:`, error);
      this.handlePeerDisconnect(peerId);
    }
  }

  public async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    logger.debug(`Received answer from ${peerId}`);
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        await peer.connection.setRemoteDescription(answer);
        logger.debug(`Set remote description (answer) from ${peerId}`);
      } catch (error) {
        logger.error(`Failed to set remote description from ${peerId}:`, error);
        this.handlePeerDisconnect(peerId);
      }
    } else {
      logger.warn(`Received answer from unknown peer ${peerId}`);
    }
  }

  public async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        await peer.connection.addIceCandidate(candidate);
        logger.debug(`Added ICE candidate from ${peerId} (type: ${candidate.candidate?.split(' ')[7]})`);
      } catch (error) {
        logger.error(`Failed to add ICE candidate from ${peerId}:`, error);
      }
    } else {
      logger.warn(`Received ICE candidate from unknown peer ${peerId}`);
    }
  }

  public handlePeerDisconnect(peerId: string): void {
    // Clear any pending timeout
    const timeout = this.disconnectTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.disconnectTimeouts.delete(peerId);
    }
    
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(peerId);
      this.onPeerDisconnected(peerId);
      logger.info(`Peer ${peerId} disconnected and cleaned up`);
    }
  }

  public disconnectAll(): void {
    logger.info(`Disconnecting all ${this.peers.size} peers`);
    
    // Clear all timeouts
    this.disconnectTimeouts.forEach(timeout => clearTimeout(timeout));
    this.disconnectTimeouts.clear();
    
    this.peers.forEach(peer => {
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();
  }
}