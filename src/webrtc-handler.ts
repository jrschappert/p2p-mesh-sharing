import { Peer } from './types';

const getRTCConfig = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];

  if (import.meta.env.VITE_STUN_URL) {
    iceServers.push({ urls: import.meta.env.VITE_STUN_URL });
    console.log('STUN configured:', import.meta.env.VITE_STUN_URL);
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
    console.log(`TURN configured: ${turnUrls.length} server(s)`);
  }

  return {
    iceServers,
    iceCandidatePoolSize: 10,
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
  private readonly MAX_PEERS = 50;

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
      console.log(`Peer ${peerId} already exists, reusing connection`);
      return this.peers.get(peerId)!;
    }

    if (this.peers.size >= this.MAX_PEERS) {
      console.warn(`Max peers reached (${this.MAX_PEERS}), not connecting to ${peerId}`);
      return null;
    }

    console.log(`Creating connection with ${peerId} (initiator: ${isInitiator})`);

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
        
        console.log(`🧊 ICE candidate for ${peerId}:`, {
          type: candidateType,
          protocol: candidateStr.includes('udp') ? 'UDP' : candidateStr.includes('tcp') ? 'TCP' : 'unknown',
          relay: candidateType === 'relay' ? 'TURN' : 'Direct'
        });
        
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          to: peerId,
          candidate: event.candidate
        }));
      } else if (!event.candidate) {
        const hasRelay = candidateTypes.has('relay');
        console.log(`ICE gathering complete for ${peerId}:`, {
          candidateTypes: Array.from(candidateTypes),
          usingTURN: hasRelay ? 'YES' : 'NO - Will fail across networks!'
        });
      }
    };

    // ICE connection state monitoring with restart capability
    pc.oniceconnectionstatechange = async () => {
      console.log(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
      
      if (pc.iceConnectionState === 'disconnected') {
        console.warn(`ICE connection disconnected for ${peerId}, will attempt restart if it fails`);
      } else if (pc.iceConnectionState === 'failed') {
        console.warn(`ICE connection failed for ${peerId}, attempting ICE restart...`);
        
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
            
            console.log(`Sent ICE restart offer to ${peerId}`);
          }
        } catch (error) {
          console.error(`ICE restart failed for ${peerId}:`, error);
        }
      }
    };

    // ICE gathering state monitoring
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state for ${peerId}: ${pc.iceGatheringState}`);
    };

    // Connection state handler with timeout before cleanup
    let disconnectTimeout: NodeJS.Timeout | null = null;
    
    pc.onconnectionstatechange = () => {
      console.log(`Connection state for ${peerId}: ${pc.connectionState}`);
      
      if (pc.connectionState === 'connected') {
        console.log(`Peer connection established with ${peerId}`);
        // Clear any pending disconnect timeout
        if (disconnectTimeout) {
          clearTimeout(disconnectTimeout);
          disconnectTimeout = null;
        }
        this.onPeerConnected(peerId);
      } else if (pc.connectionState === 'disconnected') {
        console.log(`Peer ${peerId} disconnected (waiting 10s before cleanup)`);
        
        // Wait 10 seconds before cleaning up - might reconnect
        if (!disconnectTimeout) {
          disconnectTimeout = setTimeout(() => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
              console.log(`Peer ${peerId} still disconnected after 10s, cleaning up`);
              this.handlePeerDisconnect(peerId);
            }
          }, 10000);
        }
      } else if (pc.connectionState === 'failed') {
        console.error(`Peer ${peerId} connection failed`);
        
        // Clear disconnect timeout and cleanup immediately on failure
        if (disconnectTimeout) {
          clearTimeout(disconnectTimeout);
          disconnectTimeout = null;
        }
        
        // Give ICE restart a chance (5 second grace period)
        setTimeout(() => {
          if (pc.connectionState === 'failed') {
            console.log(`Peer ${peerId} still failed after ICE restart attempt, cleaning up`);
            this.handlePeerDisconnect(peerId);
          }
        }, 5000);
      } else if (pc.connectionState === 'closed') {
        console.log(`Peer ${peerId} connection closed`);
        if (disconnectTimeout) {
          clearTimeout(disconnectTimeout);
          disconnectTimeout = null;
        }
        this.handlePeerDisconnect(peerId);
      }
    };

    if (isInitiator) {
      // Initiator creates the data channel
      console.log(`Creating data channel for ${peerId} (initiator)`);
      const dataChannel = pc.createDataChannel('bittorrent', {
        ordered: true,
        maxRetransmits: 3
      });
      this.setupDataChannel(peerId, dataChannel);
      peer.dataChannel = dataChannel;

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      console.log(`Sending offer to ${peerId}`);
      if (this.ws) {
        this.ws.send(JSON.stringify({
          type: 'offer',
          to: peerId,
          offer: pc.localDescription
        }));
      }
    } else {
      // Answerer receives data channel via ondatachannel event
      console.log(`Waiting for data channel from ${peerId} (answerer)`);
      pc.ondatachannel = (event) => {
        console.log(`Received data channel from ${peerId}`);
        this.setupDataChannel(peerId, event.channel);
        peer.dataChannel = event.channel;
      };
    }

    this.peers.set(peerId, peer);
    return peer;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    console.log(`Setting up data channel for ${peerId} (current state: ${channel.readyState})`);
    channel.binaryType = 'arraybuffer';

    // Track state changes
    let openTimestamp: number | null = null;

    channel.onopen = () => {
      openTimestamp = Date.now();
      console.log(`Data channel OPEN with ${peerId}`);
      this.onDataChannelOpen(peerId);
    };

    channel.onmessage = (event) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastActivity = Date.now();
      }
      
      // Log message receipt with timing
      const timeSinceOpen = openTimestamp ? Date.now() - openTimestamp : 'N/A';
      
      // Parse and log message type
      let messageInfo = '';
      try {
        if (typeof event.data === 'string') {
          const parsed = JSON.parse(event.data);
          messageInfo = `type: ${parsed.type}`;
        } else {
          messageInfo = `[Binary: ${event.data.byteLength} bytes]`;
        }
      } catch (e) {
        messageInfo = '[Parse error]';
      }
      
      console.log(`Message from ${peerId} (${timeSinceOpen}ms since open): ${messageInfo}`);
      
      this.onDataChannelMessage(peerId, event.data);
    };

    channel.onerror = (error) => {
      console.error(`Data channel ERROR with ${peerId}:`, error);
    };

    channel.onclose = () => {
      console.log(`Data channel CLOSED with ${peerId}`);
    };

    // If channel is already open, trigger the callback immediately
    if (channel.readyState === 'open') {
      console.log(`Data channel already open with ${peerId}, triggering callback immediately`);
      openTimestamp = Date.now();
      this.onDataChannelOpen(peerId);
    }
  }

  public async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    console.log(`Received offer from ${peerId}`);
    const peer = await this.createPeerConnection(peerId, false);
    if (!peer) return;
    
    await peer.connection.setRemoteDescription(offer);
    console.log(`Set remote description (offer) from ${peerId}`);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    console.log(`Created and set local description (answer) for ${peerId}`);

    if (this.ws) {
      console.log(`Sending answer to ${peerId}`);
      this.ws.send(JSON.stringify({
        type: 'answer',
        to: peerId,
        answer: peer.connection.localDescription
      }));
    }
  }

  public async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    console.log(`Received answer from ${peerId}`);
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.connection.setRemoteDescription(answer);
      console.log(`Set remote description (answer) from ${peerId}`);
    } else {
      console.warn(`Received answer from unknown peer ${peerId}`);
    }
  }

  public async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        await peer.connection.addIceCandidate(candidate);
        console.log(`Added ICE candidate from ${peerId} (type: ${candidate.candidate?.split(' ')[7]})`);
      } catch (error) {
        console.error(`Failed to add ICE candidate from ${peerId}:`, error);
      }
    } else {
      console.warn(`Received ICE candidate from unknown peer ${peerId}`);
    }
  }

  public handlePeerDisconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(peerId);
      this.onPeerDisconnected(peerId);
      console.log(`Peer ${peerId} disconnected and cleaned up`);
    }
  }

  public disconnectAll() {
    console.log(`Disconnecting all ${this.peers.size} peers`);
    this.peers.forEach(peer => {
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();
  }
}