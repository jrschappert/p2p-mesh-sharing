const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map();

console.log('Signaling server started on port 8080');

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(ws, { id: clientId });

  console.log(`Client ${clientId} connected`);

  ws.send(JSON.stringify({ type: 'welcome', clientId }));

  ws.on('message', (message) => {
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      console.error('Failed to parse message:', message);
      return;
    }

    console.log(`Received message from ${clientId}:`, parsedMessage.type);

    for (const [client, metadata] of clients.entries()) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        parsedMessage.from = clientId;
        client.send(JSON.stringify(parsedMessage));
      }
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    console.log(`Client ${clientInfo.id} disconnected`);
    clients.delete(ws);

    for (const [client, metadata] of clients.entries()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'peer-disconnect', peerId: clientInfo.id }));
        }
    }
  });

  ws.on('error', (error) => {
    const clientInfo = clients.get(ws);
    console.error(`Error from client ${clientInfo?.id}:`, error);
  });
});