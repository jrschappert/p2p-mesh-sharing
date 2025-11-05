const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const peers = new Map(); // ws → { id, models: Set<modelId> }

const swarms = new Map(); // modelId → Map<peerId, peerInfo>

// Swarm info structure:
// {
//   peerId: string,
//   complete: boolean,  // has all chunks?
//   chunks: Set<number>, // which chunks (if not complete)
//   lastSeen: number,   // timestamp
//   uploaded: number,   // bytes uploaded (stats)
//   downloaded: number  // bytes downloaded (stats)
// }

console.log(`BitTorrent-style tracker started on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const peerId = uuidv4();
  const peerInfo = {
    id: peerId,
    ws: ws,
    models: new Set(), // Models this peer has announced
    connectedAt: Date.now(),
    ip: req.socket.remoteAddress
  };
  
  peers.set(ws, peerInfo);

  console.log(`Peer ${peerId} connected (${peers.size} total peers)`);

  ws.send(JSON.stringify({ 
    type: 'welcome', 
    peerId,
    timestamp: Date.now()
  }));

  ws.on('message', (message) => {
    let parsedMessage;
    
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      console.error(`Invalid JSON from ${peerId}`);
      return;
    }

    // add sender ID
    parsedMessage.from = peerId;

    console.log(`${peerId} → ${parsedMessage.type}`);

    switch (parsedMessage.type) {
      case 'announce':
        handleAnnounce(ws, peerInfo, parsedMessage);
        break;

      case 'get-swarm-info':
        handleSwarmInfo(ws, parsedMessage);
        break;

      case 'unannounce':
        handleUnannounce(peerInfo, parsedMessage);
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handleSignaling(ws, peerInfo, parsedMessage);
        break;

      default:
        console.warn(`Unknown message type: ${parsedMessage.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`Peer ${peerId} disconnected`);
    
    peerInfo.models.forEach(modelId => {
      const swarm = swarms.get(modelId);
      if (swarm) {
        swarm.delete(peerId);
        console.log(`Removed from swarm: ${modelId}`);
        
        if (swarm.size === 0) {
          swarms.delete(modelId);
          console.log(`Swarm ${modelId} is now empty`);
        }
      }
    });

    peers.delete(ws);

    for (const [peer, metadata] of peers.entries()) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ 
          type: 'peer-disconnect', 
          peerId: peerId
        }));
      }
    }
    
    console.log(`${clients.size} peers, ${swarms.size} active swarms`);
  });

  ws.on('error', (error) => {
    console.error(`Error from ${clientId}:`, error.message);
  });
});

/**
 * Peer announces they have a model
 */
function handleAnnounce(ws, peerInfo, message) {
  const { modelId, complete, chunks, uploaded, downloaded } = message;
  
  if (!modelId) {
    console.error('Missing modelId');
    return;
  }

  if (!swarms.has(modelId)) {
    swarms.set(modelId, new Map());
    console.log(`New swarm created for model: ${modelId}`);
  }

  const swarm = swarms.get(modelId);
  
  swarm.set(peerInfo.id, {
    peerId: peerInfo.id,
    complete: complete || false,
    chunks: chunks ? new Set(chunks) : new Set(),
    lastSeen: Date.now(),
    uploaded: uploaded || 0,
    downloaded: downloaded || 0
  });

  peerInfo.models.add(modelId);

  console.log(`${peerInfo.id} announced ${modelId} ` + `(complete: ${complete}, swarm size: ${swarm.size})`);

  const stats = getSwarmStats(modelId);
  ws.send(JSON.stringify({
    type: 'announce',
    modelId,
    ...stats
  }));

  broadcastToSwarm(modelId, {
    type: 'peer-joined',
    modelId,
    peerId: peerInfo.id,
    complete: complete || false
  }, peerInfo.id);
}

/**
 * Peer asks for swarm info, can ask for multiple models at once
 */
function handleSwarmInfo(ws, message) {
  const { modelIds } = message;
  
  const results = {};
  
  (modelIds || []).forEach(modelId => {
    const stats = getSwarmStats(modelId);
    results[modelId] = stats;
  });

  ws.send(JSON.stringify({
    type: 'swarm-info',
    results
  }));

  console.log(`Swarm info request for ${modelIds?.length || 0} models`);
}

/**
 * Peer leaves swarm
 */
function handleUnannounce(peerInfo, message) {
  const { modelId } = message;
  
  if (!modelId) return;

  const swarm = swarms.get(modelId);
  if (swarm) {
    swarm.delete(peerInfo.id);
    console.log(`${peerInfo.id} left swarm ${modelId}`);
    
    if (swarm.size === 0) {
      swarms.delete(modelId);
      console.log(`Swarm ${modelId} is now empty`);
    }
  }

  peerInfo.models.delete(modelId);
}

/**
 * Get stats for a swarm
 */
function getSwarmStats(modelId) {
  const swarm = swarms.get(modelId);
  
  if (!swarm) {
    return {
      seeders: 0,
      leechers: 0,
      peers: [],
      complete: 0,
      incomplete: 0
    };
  }

  let seeders = 0;
  let leechers = 0;
  const peers = [];

  swarm.forEach((peerInfo, peerId) => {
    if (peerInfo.complete) {
      seeders++;
    } else {
      leechers++;
    }
    
    peers.push({
      id: peerId,
      complete: peerInfo.complete,
      chunks: peerInfo.chunks ? Array.from(peerInfo.chunks) : []
    });
  });

  return {
    seeders,
    leechers,
    peers,
    complete: seeders,
    incomplete: leechers
  };
}

/**
 * Broadcast message to all peers in a swarm
 */
function broadcastToSwarm(modelId, message, excludePeerId = null) {
  const swarm = swarms.get(modelId);
  if (!swarm) return;

  const messageStr = JSON.stringify(message);
  let sent = 0;

  swarm.forEach((peerInfo, peerId) => {
    if (peerId === excludePeerId) return;
    
    // Find the websocket for this peer
    for (const [ws, peerInfo] of peers.entries()) {
      if (peerInfo.id === peerId && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
        sent++;
        break;
      }
    }
  });

  console.log(`Broadcast to ${sent} peers in swarm ${modelId}`);
}

/**
 * Handle standard WebRTC signaling
 */
function handleSignaling(ws, peerInfo, message) {
  if (message.to) {
    const targetPeer = Array.from(peers.entries())
      .find(([_, info]) => info.id === message.to);
    
    if (targetPeer && targetPeer[0].readyState === WebSocket.OPEN) {
      targetPeer[0].send(JSON.stringify(message));
    }
    return;
  }

  // broadcast to all
  for (const [peer, metadata] of peers.entries()) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(message));
    }
  }
}

// cleanup of stale swarms
setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

  swarms.forEach((swarm, modelId) => {
    swarm.forEach((peerInfo, peerId) => {
      if (now - peerInfo.lastSeen > STALE_THRESHOLD) {
        console.log(`Removing stale peer ${peerId} from swarm ${modelId}`);
        swarm.delete(peerId);
      }
    });

    if (swarm.size === 0) {
      swarms.delete(modelId);
    }
  });
}, 60000);

setInterval(() => {
  console.log(`Stats: ${clients.size} peers, ${swarms.size} active swarms`);
  
  const topSwarms = Array.from(swarms.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5);
  
  topSwarms.forEach(([modelId, swarm]) => {
    const stats = getSwarmStats(modelId);
    console.log(`${modelId}: ${stats.seeders}S/${stats.leechers}L`);
  });
}, 30000); // Every 30 seconds

// graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('Shutting down tracker...');
  
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tracker-shutdown' }));
      ws.close();
    }
  }

  wss.close(() => {
    console.log('Tracker closed');
    process.exit(0);
  });
}