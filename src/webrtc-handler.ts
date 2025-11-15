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

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          to: peerId,
          candidate: event.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        console.log(`✅ Connected to peer ${peerId}`);
        this.onPeerConnected(peerId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.handlePeerDisconnect(peerId);
      }
    };

    if (isInitiator) {
      const dataChannel = pc.createDataChannel('bittorrent', {
        ordered: true,
        maxRetransmits: 3
      });
      this.setupDataChannel(peerId, dataChannel);
      peer.dataChannel = dataChannel;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      if (this.ws) {
        this.ws.send(JSON.stringify({
          type: 'offer',
          to: peerId,
          offer: pc.localDescription
        }));
      }
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(peerId, event.channel);
        peer.dataChannel = event.channel;
      };
    }

    this.peers.set(peerId, peer);
    return peer;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`📡 Data channel open with ${peerId}`);
      this.onDataChannelOpen(peerId);
    };

    channel.onmessage = (event) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastActivity = Date.now();
      }
      this.onDataChannelMessage(peerId, event.data);
    };

    channel.onclose = () => {
      console.log(`📡 Data channel closed with ${peerId}`);
    };
  }

  public async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    const peer = await this.createPeerConnection(peerId, false);
    if (!peer) return;
    
    await peer.connection.setRemoteDescription(offer);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    if (this.ws) {
      this.ws.send(JSON.stringify({
        type: 'answer',
        to: peerId,
        answer: peer.connection.localDescription
      }));
    }
  }

  public async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.connection.setRemoteDescription(answer);
    }
  }

  public async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.connection.addIceCandidate(candidate);
    }
  }

  public handlePeerDisconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(peerId);
      this.onPeerDisconnected(peerId);
      console.log(`❌ Peer ${peerId} disconnected`);
    }
  }

  public disconnectAll() {
    this.peers.forEach(peer => {
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();
  }
}