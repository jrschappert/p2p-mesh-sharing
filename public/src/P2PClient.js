// P2PClient.ts
// Implements WebRTC handshake logic: signaling, peer connection, and message handling
export class P2PClient {
    constructor(localId, signalingSend) {
        this.peerConnection = null;
        this.dataChannel = null;
        this.dataChannelReady = false;
        this.sendQueue = [];
        this.remoteId = null;
        /**
         * Hook: called when data channel opens
         */
        /**
         * Event: Data channel opened
         */
        this.onChannelOpen = null;
        /**
         * Event: Data channel closed
         */
        this.onChannelClose = null;
        /**
         * Event: Data channel error
         */
        this.onChannelError = null;
        /**
         * Event: Data channel message received
         */
        this.onChannelMessage = null;
        this.localId = localId;
        this.signalingSend = signalingSend;
    }
    /**
     * Call to initiate a connection to a remote peer
     */
    async connectTo(remoteId) {
        this.remoteId = remoteId;
        this.createPeerConnection();
        // Create the data channel for sending model chunks
        this.dataChannel = this.peerConnection.createDataChannel('data', {
            ordered: true, // preserve chunk order
            maxRetransmits: 10, // tune for reliability/latency
        });
        this.setupDataChannel();
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        this.signalingSend({
            type: 'offer',
            from: this.localId,
            to: remoteId,
            data: offer,
        });
    }
    /**
     * Handle incoming signaling messages
     */
    async handleSignal(msg) {
        if (!this.peerConnection) {
            this.createPeerConnection();
        }
        switch (msg.type) {
            case 'offer':
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.data));
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                this.signalingSend({
                    type: 'answer',
                    from: this.localId,
                    to: msg.from,
                    data: answer,
                });
                break;
            case 'answer':
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.data));
                break;
            case 'ice':
                if (msg.data) {
                    try {
                        await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.data));
                    }
                    catch (e) {
                        console.warn('Error adding ICE candidate', e);
                    }
                }
                break;
        }
    }
    /**
     * Create and configure the RTCPeerConnection
     */
    createPeerConnection() {
        if (this.peerConnection)
            return;
        this.peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
            ],
        });
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.remoteId) {
                this.signalingSend({
                    type: 'ice',
                    from: this.localId,
                    to: this.remoteId,
                    data: event.candidate,
                });
            }
        };
        this.peerConnection.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this.setupDataChannel();
        };
    }
    /**
     * Setup data channel event handlers
     */
    setupDataChannel() {
        if (!this.dataChannel)
            return;
        this.dataChannel.onopen = () => {
            this.dataChannelReady = true;
            console.log('Data channel open');
            // Flush queued messages
            while (this.sendQueue.length > 0 && this.dataChannel && this.dataChannel.readyState === 'open') {
                const msg = this.sendQueue.shift();
                if (typeof msg === 'string') {
                    this.dataChannel.send(msg);
                }
                else if (msg instanceof ArrayBuffer) {
                    // RTCDataChannel.send accepts ArrayBufferView, so wrap in Uint8Array
                    this.dataChannel.send(new Uint8Array(msg));
                }
                else {
                    // fallback: try to stringify
                    this.dataChannel.send(JSON.stringify(msg));
                }
            }
            this.onDataChannelOpen();
        };
        this.dataChannel.onclose = () => {
            this.dataChannelReady = false;
            console.log('Data channel closed');
            this.onDataChannelClose();
        };
        this.dataChannel.onerror = (e) => {
            console.error('Data channel error', e);
            this.onDataChannelError(e);
        };
        this.dataChannel.onmessage = (event) => {
            // Model chunk or control message received
            this.onDataChannelMessage(event.data);
        };
    }
    onDataChannelOpen() {
        if (this.onChannelOpen)
            this.onChannelOpen();
    }
    /**
     * Hook: called when data channel closes
     */
    onDataChannelClose() {
        if (this.onChannelClose)
            this.onChannelClose();
    }
    /**
     * Hook: called on data channel error
     */
    onDataChannelError(e) {
        if (this.onChannelError)
            this.onChannelError(e);
    }
    /**
     * Hook: called when a message is received (model chunk or control)
     */
    onDataChannelMessage(data) {
        if (this.onChannelMessage)
            this.onChannelMessage(data);
    }
    /**
     * Send a message over the data channel
     */
    /**
     * Send a message or chunk over the data channel. Queues if not open yet.
     * Data can be string, ArrayBuffer, or Blob.
     */
    send(data) {
        let msg;
        if (typeof data === 'string') {
            msg = data;
        }
        else if (data instanceof ArrayBuffer) {
            msg = data;
        }
        else {
            msg = JSON.stringify(data);
        }
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            if (typeof msg === 'string') {
                this.dataChannel.send(msg);
            }
            else if (msg instanceof ArrayBuffer) {
                this.dataChannel.send(new Uint8Array(msg));
            }
            else {
                this.dataChannel.send(JSON.stringify(msg));
            }
        }
        else {
            // Queue until channel is open
            this.sendQueue.push(msg);
            if (!this.dataChannel) {
                console.warn('Data channel not created yet, message queued');
            }
            else {
                console.warn('Data channel not open, message queued');
            }
        }
    }
    /**
     * Returns true if the data channel is open and ready for sending
     */
    isDataChannelOpen() {
        return !!this.dataChannel && this.dataChannel.readyState === 'open';
    }
    /**
     * Send a model chunk to the peer
     */
    sendChunk(chunk) {
        this.send({ type: 'chunk', payload: chunk });
    }
    /**
     * Request specific chunk indices from the peer
     */
    requestChunks(modelId, indices) {
        this.send({ type: 'request_chunks', payload: { modelId, indices } });
    }
    /**
     * Send a chunk acknowledgment to the peer
     */
    sendChunkAck(modelId, index) {
        this.send({ type: 'chunk_ack', payload: { modelId, index } });
    }
}
