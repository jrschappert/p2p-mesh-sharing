import { Peer } from './types';

const getRTCConfig = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];

  if (import.meta.env.VITE_STUN_URL) {
    iceServers.push({ urls: import.meta.env.VITE_STUN_URL });
  }

  if (import.meta.env.VITE_TURN_URLS) {
    const turnUrls = import.meta.env.VITE_TURN_URLS.split(',');
    for (const url of turnUrls) {
      iceServers.push({
        urls: url,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      });
    }
  }

  return { iceServers };
};

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
      console.log(`⚠️ Peer ${peerId} already exists, reusing connection`);
      return this.peers.get(peerId)!;
    }

    if (this.peers.size >= this.MAX_PEERS) {
      console.warn(`⚠️ Max peers reached (${this.MAX_PEERS}), not connecting to ${peerId}`);
      return null;
    }

    console.log(`🤝 Creating connection with ${peerId} (initiator: ${isInitiator})`);

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer: Peer = {
      id: peerId,
      connection: pc,
      dataChannel: null,
      isInitiator,
      bitfield: new Map(),
      lastActivity: Date.now()
    };

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        console.log(`🧊 Sending ICE candidate to ${peerId} (type: ${event.candidate.type})`);
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          to: peerId,
          candidate: event.candidate
        }));
      } else if (!event.candidate) {
        console.log(`🧊 ICE gathering complete for ${peerId}`);
      }
    };

    // ICE connection state monitoring
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn(`⚠️ ICE connection ${pc.iceConnectionState} for ${peerId}`);
      }
    };

    // ICE gathering state monitoring
    pc.onicegatheringstatechange = () => {
      console.log(`🌐 ICE gathering state for ${peerId}: ${pc.iceGatheringState}`);
    };

    // Connection state handler
    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection state for ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        console.log(`✅ Peer connection established with ${peerId}`);
        this.onPeerConnected(peerId);
      } else if (pc.connectionState === 'disconnected') {
        console.log(`⚠️ Peer ${peerId} disconnected (might reconnect)`);
      } else if (pc.connectionState === 'failed') {
        console.error(`❌ Peer ${peerId} connection failed`);
        this.handlePeerDisconnect(peerId);
      } else if (pc.connectionState === 'closed') {
        console.log(`❌ Peer ${peerId} connection closed`);
        this.handlePeerDisconnect(peerId);
      }
    };

    if (isInitiator) {
      // Initiator creates the data channel
      console.log(`📡 Creating data channel for ${peerId} (initiator)`);
      const dataChannel = pc.createDataChannel('bittorrent', {
        ordered: true,
        maxRetransmits: 3
      });
      this.setupDataChannel(peerId, dataChannel);
      peer.dataChannel = dataChannel;

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      console.log(`📤 Sending offer to ${peerId}`);
      if (this.ws) {
        this.ws.send(JSON.stringify({
          type: 'offer',
          to: peerId,
          offer: pc.localDescription
        }));
      }
    } else {
      // Answerer receives data channel via ondatachannel event
      console.log(`📡 Waiting for data channel from ${peerId} (answerer)`);
      pc.ondatachannel = (event) => {
        console.log(`📡 Received data channel from ${peerId}`);
        this.setupDataChannel(peerId, event.channel);
        peer.dataChannel = event.channel;
      };
    }

    this.peers.set(peerId, peer);
    return peer;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    console.log(`📡 Setting up data channel for ${peerId} (state: ${channel.readyState})`);
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`✅ Data channel OPEN with ${peerId}`);
      this.onDataChannelOpen(peerId);
    };

    channel.onmessage = (event) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastActivity = Date.now();
      }
      
      // Log first 100 chars of message for debugging
      const preview = typeof event.data === 'string' 
        ? event.data.substring(0, 100) 
        : `[Binary: ${event.data.byteLength} bytes]`;
      console.log(`📨 Message from ${peerId}: ${preview}${preview.length >= 100 ? '...' : ''}`);
      
      this.onDataChannelMessage(peerId, event.data);
    };

    channel.onerror = (error) => {
      console.error(`❌ Data channel error with ${peerId}:`, error);
    };

    channel.onclose = () => {
      console.log(`📡 Data channel closed with ${peerId}`);
    };

    // If channel is already open, trigger the callback immediately
    if (channel.readyState === 'open') {
      console.log(`📡 Data channel already open with ${peerId}, triggering callback`);
      this.onDataChannelOpen(peerId);
    }
  }

  public async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    console.log(`📥 Received offer from ${peerId}`);
    const peer = await this.createPeerConnection(peerId, false);
    if (!peer) return;
    
    await peer.connection.setRemoteDescription(offer);
    console.log(`✅ Set remote description (offer) from ${peerId}`);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    console.log(`✅ Created and set local description (answer) for ${peerId}`);

    if (this.ws) {
      console.log(`📤 Sending answer to ${peerId}`);
      this.ws.send(JSON.stringify({
        type: 'answer',
        to: peerId,
        answer: peer.connection.localDescription
      }));
    }
  }

  public async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    console.log(`📥 Received answer from ${peerId}`);
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.connection.setRemoteDescription(answer);
      console.log(`✅ Set remote description (answer) from ${peerId}`);
    } else {
      console.warn(`⚠️ Received answer from unknown peer ${peerId}`);
    }
  }

  public async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        await peer.connection.addIceCandidate(candidate);
        console.log(`🧊 Added ICE candidate from ${peerId} (type: ${candidate.candidate?.split(' ')[7]})`);
      } catch (error) {
        console.error(`❌ Failed to add ICE candidate from ${peerId}:`, error);
      }
    } else {
      console.warn(`⚠️ Received ICE candidate from unknown peer ${peerId}`);
    }
  }

  public handlePeerDisconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(peerId);
      this.onPeerDisconnected(peerId);
      console.log(`❌ Peer ${peerId} disconnected and cleaned up`);
    }
  }

  public disconnectAll() {
    console.log(`🧹 Disconnecting all ${this.peers.size} peers`);
    this.peers.forEach(peer => {
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();
  }
}