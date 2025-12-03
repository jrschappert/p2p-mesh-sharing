const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map(); // ws → { id, models: Set<modelId> }

const swarms = new Map(); // modelId → Map<peerId, peerInfo>

const STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

console.log(`BitTorrent-style tracker started on port ${PORT}`);

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  const clientInfo = {
    id: clientId,
    ws: ws,
    models: new Set()
  };
  
  clients.set(ws, clientInfo);

  console.log(`Peer ${clientId} connected (${clients.size} total peers)`);

  ws.send(JSON.stringify({
    type: 'welcome',
    clientId
  }));

  ws.on('message', (message) => {
    let parsedMessage;
    
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      console.error(`Invalid JSON from ${clientId}`);
      return;
    }

    parsedMessage.from = clientId;

    switch (parsedMessage.type) {
      case 'announce':
        handleAnnounce(ws, clientInfo, parsedMessage);
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handleSignaling(ws, clientInfo, parsedMessage);
        break;

      case 'request-connection':
        handleConnectionRequest(ws, clientInfo, parsedMessage);
        break;

      default:
        console.warn(`Unknown message type: ${parsedMessage.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`Peer ${clientId} disconnected`);
    
    clientInfo.models.forEach(modelId => {
      const swarm = swarms.get(modelId);
      if (swarm) {
        swarm.delete(clientId);
        console.log(`Removed from swarm: ${modelId}`);
        
        broadcastToSwarm(modelId, {
          type: 'peer-left-swarm',
          modelId,
          peerId: clientId
        }, clientId);
        
        if (swarm.size === 0) {
          swarms.delete(modelId);
          console.log(`Swarm ${modelId} is now empty`);
        }
      }
    });

    clients.delete(ws);
    console.log(`${clients.size} peers, ${swarms.size} active swarms`);
  });

  ws.on('error', (error) => {
    console.error(`Error from ${clientId}:`, error.message);
  });
});

/**
 * Peer announces they have a model
 */
function handleAnnounce(ws, clientInfo, message) {
  const { modelId, complete } = message;
  
  if (!modelId) {
    console.error('Announce missing modelId');
    return;
  }

  if (!swarms.has(modelId)) {
    swarms.set(modelId, new Map());
    console.log(`New swarm created: ${modelId}`);
  }

  const swarm = swarms.get(modelId);
  
  swarm.set(clientInfo.id, {
    peerId: clientInfo.id,
    complete: complete || false,
    lastSeen: Date.now()
  });

  clientInfo.models.add(modelId);

  console.log(
    `${clientInfo.id} announced ${modelId} ` +
    `(complete: ${complete}, swarm size: ${swarm.size})`
  );

  const stats = getSwarmStats(modelId);
  ws.send(JSON.stringify({
    type: 'announce-response',
    modelId,
    ...stats
  }));

  broadcastToSwarm(modelId, {
    type: 'peer-joined-swarm',
    modelId,
    peerId: clientInfo.id,
    complete: complete || false,
    peers: stats.peers
  }, clientInfo.id);
}

function handleSignaling(ws, clientInfo, message) {
  const { to } = message;
  
  if (to) {
    const targetClient = Array.from(clients.entries())
      .find(([_, info]) => info.id === to);
    
    if (targetClient && targetClient[0].readyState === WebSocket.OPEN) {
      targetClient[0].send(JSON.stringify(message));
      console.log(`Forwarded to ${to}`);
    } else {
      console.warn(`Target ${to} not found or not ready`);
    }
  }
}

/**
 * Handle connection request - broadcast to all peers
 */
function handleConnectionRequest(ws, clientInfo) {
  console.log(`${clientInfo.id} requesting connections`);

  for (const [client] of clients.entries()) {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'request-connection',
        from: clientInfo.id
      }));
    }
  }
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
      complete: peerInfo.complete
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
    
    for (const [ws, clientInfo] of clients.entries()) {
      if (clientInfo.id === peerId && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
        sent++;
        break;
      }
    }
  });

  if (sent > 0) {
    console.log(`Broadcast to ${sent} peers in swarm ${modelId}`);
  }
}

/**
 * Periodic cleanup of stale swarms
 */
setInterval(() => {
  const now = Date.now();

  swarms.forEach((swarm, modelId) => {
    swarm.forEach((peerInfo, peerId) => {
      if (now - peerInfo.lastSeen > STALE_TIMEOUT) {
        console.log(`Removing stale peer ${peerId} from swarm ${modelId}`);
        swarm.delete(peerId);
        
        broadcastToSwarm(modelId, {
          type: 'peer-left-swarm',
          modelId,
          peerId
        }, peerId);
      }
    });

    if (swarm.size === 0) {
      swarms.delete(modelId);
      console.log(`Removed empty swarm ${modelId}`);
    }
  });
}, 60000);

/**
 * Periodic stats logging
 */
setInterval(() => {
  console.log(`\n Stats: ${clients.size} peers, ${swarms.size} active swarms`);
  
  const topSwarms = Array.from(swarms.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5);
  
  if (topSwarms.length > 0) {
    console.log('Top swarms:');
    topSwarms.forEach(([modelId, swarm]) => {
      const stats = getSwarmStats(modelId);
      console.log(`   ${modelId.substring(0, 12)}...: ${stats.seeders}S/${stats.leechers}L (${swarm.size} total)`);
    });
  }
  console.log('');
}, 30000);

console.log(`Ready to track swarms!\n`);