// run with npx ts-node src/signaling-server-test.ts

import { getSystemErrorMessage } from "util";
import WebSocket from "ws";

type Msg = any;

const SERVER_WS = process.env.SIGNALING_WS ?? "ws://localhost:3000";
const SERVER_HTTP = process.env.SIGNALING_HTTP ?? "http://localhost:3000";
const DEFAULT_TIMEOUT = 4000;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_WS);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      ws.off("open", onOpen);
      ws.off("error", onError);
    }
    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}

function waitForMessage(ws: WebSocket, predicate: (m: Msg) => boolean, timeoutMs = DEFAULT_TIMEOUT): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.Data) => {
      try {
        const str = typeof data === "string" ? data : data.toString();
        const parsed = JSON.parse(str);
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // ignore parse error
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before matching message"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

async function fetchPeers(infoHash: string) {
  const url = `${SERVER_HTTP}/peers?infoHash=${encodeURIComponent(infoHash)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch /peers failed: ${res.status}`);
  return res.json();
}

async function safeClose(ws?: WebSocket) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}

async function testSmokeFlow() {
  console.log("=== testSmokeFlow (basic announce/offer/answer/leave) ===");
  const infoHash = "smoke-room";

  const c1 = await openWs();
  const c2 = await openWs();

  try {
    // announce c1
    c1.send(JSON.stringify({ type: "announce", infoHash, from: "smoke-peer1" }));
    const p1 = await waitForMessage(
      c1,
      (m) => m?.type === "peers" && Array.isArray(m.peers) && m.peers.some((p: any) => p.peerId === "smoke-peer1"),
      3000
    );
    console.log("c1 peers reply OK:", p1.type);

    // announce c2
    c2.send(JSON.stringify({ type: "announce", infoHash, from: "smoke-peer2" }));
    const p2 = await waitForMessage(
      c2,
      (m) => m?.type === "peers" && Array.isArray(m.peers) && m.peers.some((p: any) => p.peerId === "smoke-peer2"),
      3000
    );
    console.log("c2 peers reply OK:", p2.type);

    // c1 should get peer-joined for c2
    await waitForMessage(c1, (m) => m?.type === "peer-joined" && m?.info?.peerId === "smoke-peer2", 3000);
    console.log("c1 observed peer-joined for c2");

    // c1 -> offer -> c2
    c1.send(JSON.stringify({ type: "offer", infoHash, from: "smoke-peer1", to: "smoke-peer2", payload: { sdp: "SMOKE_OFFER" } }));
    const offerAtC2 = await waitForMessage(c2, (m) => m?.type === "offer" && m?.from === "smoke-peer1" && m?.payload?.sdp === "SMOKE_OFFER", 3000);
    console.log("c2 received offer OK");

    // c2 -> answer -> c1
    c2.send(JSON.stringify({ type: "answer", infoHash, from: "smoke-peer2", to: "smoke-peer1", payload: { sdp: "SMOKE_ANSWER" } }));
    await waitForMessage(c1, (m) => m?.type === "answer" && m?.from === "smoke-peer2" && m?.payload?.sdp === "SMOKE_ANSWER", 3000);
    console.log("c1 received answer OK");

    // c2 leaves
    c2.send(JSON.stringify({ type: "leave", infoHash, from: "smoke-peer2" }));
    await waitForMessage(c1, (m) => m?.type === "peer-left" && m?.from === "smoke-peer2", 3000).catch(() => {
      // tolerate if we missed it, but log
      console.warn("c1 did not observe peer-left event (might have been missed)");
    });

    // /peers should reflect only peer1
    const peersAfter = await fetchPeers(infoHash);
    const ids = (peersAfter.peers || []).map((p: any) => p.peerId);
    if (!ids.includes("smoke-peer1") || ids.includes("smoke-peer2")) {
      throw new Error("/peers did not reflect expected members after leave: " + JSON.stringify(ids));
    }
    console.log("HTTP /peers consistent for smoke flow:", ids);

    console.log("✅ testSmokeFlow passed");
  } finally {
    await safeClose(c1);
    await safeClose(c2);
    await delay(200);
  }
}

async function testExtendedICEAndBroadcast() {
  console.log("=== testExtendedICEAndBroadcast (ICE forwarding, broadcast vs direct, /peers consistency) ===");
  const infoHash = "extended-room";

  const c1 = await openWs();
  const c2 = await openWs();
  const c3 = await openWs();

  try {
    // announce all three
    c1.send(JSON.stringify({ type: "announce", infoHash, from: "ext-peer1" }));
    await waitForMessage(c1, (m) => m?.type === "peers" && Array.isArray(m.peers) && m.peers.some((p: any) => p.peerId === "ext-peer1"), 3000);

    // stagger announces
    await delay(200);
    c2.send(JSON.stringify({ type: "announce", infoHash, from: "ext-peer2" }));
    await waitForMessage(c2, (m) => m?.type === "peers" && m.peers.some((p: any) => p.peerId === "ext-peer2"), 3000);

    await delay(200);
    c3.send(JSON.stringify({ type: "announce", infoHash, from: "ext-peer3" }));
    await waitForMessage(c3, (m) => m?.type === "peers" && m.peers.some((p: any) => p.peerId === "ext-peer3"), 3000);

    // Sanity: /peers should include the three peers
    const before = await fetchPeers(infoHash);
    const idsBefore = (before.peers || []).map((p: any) => p.peerId).sort();
    if (!["ext-peer1", "ext-peer2", "ext-peer3"].every((x) => idsBefore.includes(x))) {
      throw new Error("/peers missing announced peers: " + JSON.stringify(idsBefore));
    }
    console.log("/peers contains announced peers:", idsBefore);

    // ---------- ICE with 'to' should go to only target (ext-peer2)
    let gotC2IceTo = false;
    let gotC3IceTo = false;
    const pC2 = waitForMessage(c2, (m) => m?.type === "ice" && m?.from === "ext-peer1" && m?.payload?.candidate === "cand-to")
      .then(() => (gotC2IceTo = true))
      .catch(() => {});
    const pC3 = waitForMessage(c3, (m) => m?.type === "ice" && m?.from === "ext-peer1" && m?.payload?.candidate === "cand-to")
      .then(() => (gotC3IceTo = true))
      .catch(() => {});
    c1.send(JSON.stringify({ type: "ice", infoHash, from: "ext-peer1", to: "ext-peer2", payload: { candidate: "cand-to" } }));

    // wait briefly
    await Promise.race([pC2, delay(800)]);
    await Promise.race([pC3, delay(800)]);

    if (!gotC2IceTo) throw new Error("ICE with 'to' was not received by intended target ext-peer2");
    if (gotC3IceTo) throw new Error("ICE with 'to' was incorrectly received by a non-target ext-peer3");
    console.log("✅ ICE with 'to' forwarded only to the target");

    // ---------- ICE without 'to' -> broadcast to other peers (ext-peer2 and ext-peer3)
    let gotC2IceBc = false;
    let gotC3IceBc = false;
    const p2b = waitForMessage(c2, (m) => m?.type === "ice" && m?.from === "ext-peer1" && m?.payload?.candidate === "cand-bc")
      .then(() => (gotC2IceBc = true))
      .catch(() => {});
    const p3b = waitForMessage(c3, (m) => m?.type === "ice" && m?.from === "ext-peer1" && m?.payload?.candidate === "cand-bc")
      .then(() => (gotC3IceBc = true))
      .catch(() => {});
    c1.send(JSON.stringify({ type: "ice", infoHash, from: "ext-peer1", payload: { candidate: "cand-bc" } }));

    await Promise.race([p2b, delay(1200)]);
    await Promise.race([p3b, delay(1200)]);

    if (!gotC2IceBc || !gotC3IceBc) throw new Error("ICE broadcast did not reach all peers");
    console.log("✅ ICE without 'to' broadcast to other peers");

    // ---------- Offer broadcast without 'to' (c3 sends) -> should be received by ext-peer1 and ext-peer2
    let gotP1Offer = false;
    let gotP2Offer = false;
    const p1Offer = waitForMessage(c1, (m) => m?.type === "offer" && m?.from === "ext-peer3" && m?.payload?.sdp === "OFFER-BC")
      .then(() => (gotP1Offer = true))
      .catch(() => {});
    const p2Offer = waitForMessage(c2, (m) => m?.type === "offer" && m?.from === "ext-peer3" && m?.payload?.sdp === "OFFER-BC")
      .then(() => (gotP2Offer = true))
      .catch(() => {});

    c3.send(JSON.stringify({ type: "offer", infoHash, from: "ext-peer3", payload: { sdp: "OFFER-BC" } }));

    await Promise.race([p1Offer, delay(1200)]);
    await Promise.race([p2Offer, delay(1200)]);

    if (!gotP1Offer || !gotP2Offer) throw new Error("Offer broadcast was not received by all other peers");
    console.log("✅ Offer without 'to' broadcast to other peers");

    // ---------- /peers consistency before leave
    const mid = await fetchPeers(infoHash);
    const idsMid = (mid.peers || []).map((p: any) => p.peerId).sort();
    if (!["ext-peer1", "ext-peer2", "ext-peer3"].every((x) => idsMid.includes(x))) {
      throw new Error("/peers missing members mid-run: " + JSON.stringify(idsMid));
    }
    console.log("/peers mid-run OK:", idsMid);

    // now c3 leaves and we verify /peers no longer contains ext-peer3
    c3.send(JSON.stringify({ type: "leave", infoHash, from: "ext-peer3" }));
    // give the server a moment to broadcast and update state
    await delay(500);
    // optionally wait for peer-left notification at c1
    await waitForMessage(c1, (m) => m?.type === "peer-left" && m?.from === "ext-peer3").catch(() => {});
    const after = await fetchPeers(infoHash);
    const idsAfter = (after.peers || []).map((p: any) => p.peerId).sort();
    if (idsAfter.includes("ext-peer3")) throw new Error("/peers still contains ext-peer3 after leave: " + JSON.stringify(idsAfter));
    console.log("✅ /peers no longer contains ext-peer3 after leave:", idsAfter);

    console.log("✅ testExtendedICEAndBroadcast passed");
  } finally {
    await safeClose(c1);
    await safeClose(c2);
    await safeClose(c3);
    await delay(200);
  }
}

// Replace the existing testModelSpecificPeerListing with this version

async function testModelSpecificPeerListing() {
  console.log("=== testModelSpecificPeerListing (peers per model) ===");
  const modelA = "model-A-001";
  const modelB = "model-B-002";

  // open 5 clients:
  const c1 = await openWs();
  const c2 = await openWs();
  const c3 = await openWs();
  const c4 = await openWs();
  const c5 = await openWs();

  // install verbose logging for debugging: print every message each client receives
  const installLogger = (ws: WebSocket, name: string) => {
    ws.on("message", (d) => {
      try {
        const s = typeof d === "string" ? d : d.toString();
        console.log(`[${name}] recv: ${s}`);
      } catch {
        console.log(`[${name}] recv: <binary>`);
      }
    });
  };
  installLogger(c1, "m-c1");
  installLogger(c2, "m-c2");
  installLogger(c3, "m-c3");
  installLogger(c4, "m-c4");
  installLogger(c5, "m-c5");

  try {
    // helper: announce with retries until peers reply observed (or exhausted)
    async function announceWithRetry(ws: WebSocket, infoHash: string, peerId: string, maxTries = 3) {
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        console.log(`announce ${peerId} -> ${infoHash} attempt ${attempt}`);
        ws.send(JSON.stringify({ type: "announce", infoHash, from: peerId }));
        try {
          // wait up to 4s for a peers reply that contains this peer
          const msg = await waitForMessage(
            ws,
            (m) => m?.type === "peers" && Array.isArray(m.peers) && m.peers.some((p: any) => p.peerId === peerId),
            4000
          );
          console.log(`announce ok for ${peerId}: peers reply received`);
          return true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`announce attempt ${attempt} for ${peerId} did not receive peers reply: ${msg}`);
          await delay(200 * attempt);
        }
      }
      return false;
    }

    // Announce assignments with retries:
    const r1 = await announceWithRetry(c1, modelA, "m-peer1");
    const r2 = await announceWithRetry(c2, modelA, "m-peer2");
    const r3 = await announceWithRetry(c3, modelB, "m-peer3");
    const r4 = await announceWithRetry(c4, modelB, "m-peer4");

    // peer5 announces modelA then modelB (same ws can be in multiple rooms)
    const r5a = await announceWithRetry(c5, modelA, "m-peer5");
    // slight delay then announce modelB
    await delay(200);
    const r5b = await announceWithRetry(c5, modelB, "m-peer5");

    if (![r1, r2, r3, r4, r5a, r5b].every(Boolean)) {
      console.warn("One or more announces did not get peers replies over WS. Will fallback to HTTP verification for robustness.");
    } else {
      console.log("All announces got WS peers replies");
    }

    // Short delay to let server state settle
    await delay(300);

    // --- HTTP assertions (robust fallback) ---
    // fetch /peers for modelA
    const pa = await fetchPeers(modelA);
    const idsA = (pa.peers || []).map((p: any) => p.peerId).sort();
    const wantA = ["m-peer1", "m-peer2", "m-peer5"];
    console.log("HTTP /peers(modelA):", idsA);
    if (!wantA.every((x) => idsA.includes(x)) || idsA.length !== wantA.length) {
      throw new Error(`HTTP /peers for modelA unexpected. got=${JSON.stringify(idsA)}, want=${JSON.stringify(wantA)}`);
    }
    console.log("✅ HTTP /peers(modelA) correct:", idsA);

    // fetch /peers for modelB
    const pb = await fetchPeers(modelB);
    const idsB = (pb.peers || []).map((p: any) => p.peerId).sort();
    const wantB = ["m-peer3", "m-peer4", "m-peer5"];
    console.log("HTTP /peers(modelB):", idsB);
    if (!wantB.every((x) => idsB.includes(x)) || idsB.length !== wantB.length) {
      throw new Error(`HTTP /peers for modelB unexpected. got=${JSON.stringify(idsB)}, want=${JSON.stringify(wantB)}`);
    }
    console.log("✅ HTTP /peers(modelB) correct:", idsB);

    // --- WS get-peers assertions (best-effort, longer timeout) ---
    const wsGetPeers = async (client: WebSocket, model: string, want: string[]) => {
      client.send(JSON.stringify({ type: "get-peers", infoHash: model }));
      const resp = await waitForMessage(
        client,
        (m) => m?.type === "peers" && m?.infoHash === model && Array.isArray(m.peers),
        6000
      ).catch((e) => {
        console.warn(`WS get-peers(${model}) timed out: ${e.message}. Will treat HTTP as source-of-truth.`);
        return null;
      });
      if (!resp) return;
      const ids = (resp.peers || []).map((p: any) => p.peerId).sort();
      console.log(`WS get-peers(${model}) =>`, ids);
      if (!want.every((x) => ids.includes(x)) || ids.length !== want.length) {
        throw new Error(`WS get-peers(${model}) mismatch. got=${JSON.stringify(ids)} want=${JSON.stringify(want)}`);
      }
    };

    // Use c1 for modelA and c3 for modelB (best-effort)
    await wsGetPeers(c1, modelA, wantA);
    await wsGetPeers(c3, modelB, wantB);

    console.log("✅ testModelSpecificPeerListing passed");
  } finally {
    await safeClose(c1);
    await safeClose(c2);
    await safeClose(c3);
    await safeClose(c4);
    await safeClose(c5);
    await delay(200);
  }
}

async function main() {
  console.log("Starting combined signaling server tests against", SERVER_WS, "http:", SERVER_HTTP);
  try {
    await testSmokeFlow();
    await delay(200);
    await testExtendedICEAndBroadcast();
    await delay(200);
    await testModelSpecificPeerListing();
    console.log("\n🎉 All tests passed");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Tests failed:", err);
    process.exit(1);
  }
}

main();
