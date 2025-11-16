import { Peer } from './types';

const getRTCConfig = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];

  if (import.meta.env.VITE_STUN_URL) {
    iceServers.push({ urls: import.meta.env.VITE_STUN_URL });
    console.log('STUN server configured:', import.meta.env.VITE_STUN_URL);
  } else {
    console.warn('No STUN server configured!');
  }

  if (import.meta.env.VITE_TURN_URLS) {
    const turnUrls = import.meta.env.VITE_TURN_URLS.split(',');
    for (const url of turnUrls) {
      iceServers.push({
        urls: url.trim(),
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      });
    }
    console.log('TURN servers configured:', turnUrls.length, 'server(s)');
    console.log('URLs:', turnUrls.map((u: string) => u.trim()));
    console.log('Username:', import.meta.env.VITE_TURN_USERNAME);
    console.log('Credential:', import.meta.env.VITE_TURN_CREDENTIAL ? '***' : 'MISSING!');
  } else {
    console.error('NO TURN SERVERS CONFIGURED! Cross-network connections WILL FAIL!');
    console.error('   Add VITE_TURN_URLS to your .env file');
  }

  console.log('Final ICE servers config:', iceServers);
  
  // Test TURN connectivity
  if (iceServers.length > 0) {
    testTURNConnectivity(iceServers);
  }
  
  return { 
    iceServers,
    iceCandidatePoolSize: 10, // Gather more candidates
    iceTransportPolicy: 'all' // Try all connection types including relay
  };
};

// Test if TURN servers are reachable
async function testTURNConnectivity(iceServers: RTCIceServer[]) {
  console.log('Testing TURN server connectivity...');
  
  const pc = new RTCPeerConnection({ iceServers });
  const candidateTypes = new Set<string>();
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const type = event.candidate.type || 'unknown';
      candidateTypes.add(type);
      console.log(`Test candidate type: ${type}`);
    } else {
      const hasRelay = candidateTypes.has('relay');
      console.log('TURN test result:', {
        candidateTypes: Array.from(candidateTypes),
        turnWorking: hasRelay ? 'YES - TURN is working!' : 'NO - TURN not reachable!'
      });
      
      if (!hasRelay) {
        console.error('TURN servers are configured but not generating relay candidates!');
      }
      
      pc.close();
    }
  };
  
  // Create a dummy data channel to trigger ICE gathering
  pc.createDataChannel('test');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
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

    // ICE connection state monitoring
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn(`ICE connection ${pc.iceConnectionState} for ${peerId}`);
      }
    };

    // ICE gathering state monitoring
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state for ${peerId}: ${pc.iceGatheringState}`);
    };

    // Connection state handler
    pc.onconnectionstatechange = () => {
      console.log(`Connection state for ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        console.log(`Peer connection established with ${peerId}`);
        this.onPeerConnected(peerId);
      } else if (pc.connectionState === 'disconnected') {
        console.log(`Peer ${peerId} disconnected (might reconnect)`);
      } else if (pc.connectionState === 'failed') {
        console.error(`Peer ${peerId} connection failed`);
        this.handlePeerDisconnect(peerId);
      } else if (pc.connectionState === 'closed') {
        console.log(`Peer ${peerId} connection closed`);
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
      
      // Test send immediately
      try {
        channel.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        console.log(`Sent test ping to ${peerId}`);
      } catch (error) {
        console.error(`Failed to send test ping to ${peerId}:`, error);
      }
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
          
          // Special handling for test ping
          if (parsed.type === 'ping') {
            console.log(`Received test ping from ${peerId}`);
            return; // Don't process further
          }
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