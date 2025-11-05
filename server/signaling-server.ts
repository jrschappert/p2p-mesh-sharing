const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
const { WebSocketServer } = require("ws");
// (no explicit WebSocket alias — rely on runtime `ws` import and `any` for untyped values)

type PeerInfo = {
  peerId: string;
  lastSeen: number;
  meta?: any; // optional metadata (e.g., isSeeder, caps)
};

type SignalMessage = {
  type: string; // "announce" | "leave" | "offer" | "answer" | "ice" | "get-peers"
  infoHash?: string; // manifest / model id
  from?: string; // sender peerId
  to?: string; // (optional) target peerId for direct forwarding
  payload?: any;
  meta?: any;
};

const app = express();
app.use(cors());
app.use(express.json());

// serve static files (use absolute path so running from `server/` or repo root works)
const publicDir = path.join(process.cwd(), "public");
try {
  app.use(express.static(publicDir));
} catch (e) {
  console.error("Failed to mount static public dir:", e);
}

console.log("starting signaling server file. publicDir=", publicDir);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT || 3000);
// infoHash -> Map(peerId -> { ws, info })
const rooms = new Map<string, Map<string, { ws: any; info: PeerInfo }>>();

const STALE_MS = 60_000 * 3; // 3 minutes

// HTTP endpoint for lightweight peer list (useful for non-WS clients)
app.get("/peers", (req: any, res: any) => {
  const infoHash = String(req.query.infoHash || "");
  if (!infoHash) return res.status(400).json({ error: "missing infoHash" });
  const map = rooms.get(infoHash);
  const peers: PeerInfo[] = [];
  if (map) {
    for (const [, { info }] of map) peers.push(info);
  }
  res.json({ infoHash, peers });
});

wss.on("connection", (ws: any) => {
  // store peer's infoHash/peerId after announce
  let announcedInfoHash: string | null = null;
  let announcedPeerId: string | null = null;

  ws.on("message", (raw: any) => {
    let msg: SignalMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      console.warn("invalid JSON message", e);
      return;
    }

    const { type, infoHash, from, to, payload, meta } = msg;

    switch (type) {
      case "announce": {
        if (!infoHash || !from) return;
        announcedInfoHash = infoHash;
        announcedPeerId = from;

        let room = rooms.get(infoHash);
        if (!room) {
          room = new Map();
          rooms.set(infoHash, room);
        }
        room.set(from, {
          ws,
          info: { peerId: from, lastSeen: Date.now(), meta },
        });

        // reply with current peer list
        const peers = Array.from(room.values()).map((r) => r.info);
        ws.send(JSON.stringify({ type: "peers", infoHash, peers }));

        // notify others that a peer joined
        broadcastToRoom(infoHash, { type: "peer-joined", info: { peerId: from, meta } }, ws);
        break;
      }

      case "leave": {
        if (!infoHash || !from) return;
        removePeer(infoHash, from);
        broadcastToRoom(infoHash, { type: "peer-left", from }, ws);
        break;
      }

      case "get-peers": {
        if (!infoHash) return;
        const room = rooms.get(infoHash);
        const peers = room ? Array.from(room.values()).map((r) => r.info) : [];
        ws.send(JSON.stringify({ type: "peers", infoHash, peers }));
        break;
      }

      // SDP / ICE forwarding
      case "offer":
      case "answer":
      case "ice": {
        if (!infoHash || !from || (!to && type !== "ice" && type !== "offer" && type !== "answer" && !to)) {
          // require infoHash + from; to is optional for broadcast
        }
        // update lastSeen for sender
        if (infoHash && from) touchPeer(infoHash, from, meta);

        if (to) {
          // direct forward to target peer
          if (!infoHash || !from) return;
          const target = rooms.get(infoHash)?.get(to);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify({ type, infoHash, from, payload }));
          }
        } else {
          // broadcast to all other peers in the room
          if (infoHash) broadcastToRoom(infoHash, { type, infoHash, from, payload }, ws);
        }
        break;
      }

      default:
        console.warn("unknown message type", type);
    }
  });

  ws.on("close", () => {
    if (announcedInfoHash && announcedPeerId) {
      removePeer(announcedInfoHash, announcedPeerId);
      broadcastToRoom(announcedInfoHash, { type: "peer-left", from: announcedPeerId }, ws);
    }
  });
});

function broadcastToRoom(infoHash: string, msg: any, except?: any) {
  const room = rooms.get(infoHash);
  if (!room) return;
  const raw = JSON.stringify(msg);
  for (const [, { ws }] of room) {
    if (ws.readyState === WebSocket.OPEN && ws !== except) ws.send(raw);
  }
}

function removePeer(infoHash: string, peerId: string) {
  const room = rooms.get(infoHash);
  if (!room) return;
  room.delete(peerId);
  if (room.size === 0) rooms.delete(infoHash);
}

function touchPeer(infoHash: string, peerId: string, meta?: any) {
  const room = rooms.get(infoHash);
  if (!room) return;
  const rec = room.get(peerId);
  if (!rec) return;
  rec.info.lastSeen = Date.now();
  if (meta) rec.info.meta = { ...rec.info.meta, ...meta };
}

// periodic cleanup of stale peers (in case of abrupt disconnect)
setInterval(() => {
  const now = Date.now();
  for (const [infoHash, room] of rooms.entries()) {
    for (const [peerId, { info }] of room.entries()) {
      if (now - info.lastSeen > STALE_MS) {
        room.delete(peerId);
        broadcastToRoom(infoHash, { type: "peer-left", from: peerId });
      }
    }
    if (room.size === 0) rooms.delete(infoHash);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Signaling/tracker server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint ws://localhost:${PORT}`);
});

// surface runtime errors so they appear in the console instead of silently failing
server.on("error", (err: any) => {
  console.error("HTTP Server error:", (err && (err as Error).message) || String(err));
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", (err && (err as Error).stack) || String(err));
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});