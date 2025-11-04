import { P2PClient } from "./P2PClient";

// Simple in-memory signaling relay for two peers

// Wire up signaling between two clients
function wireSignaling(a: P2PClient, b: P2PClient) {
  (a as any).signalingSend = (msg: any) => b.handleSignal(msg);
  (b as any).signalingSend = (msg: any) => a.handleSignal(msg);
}

// Test function
export async function testP2PClient() {
  const alice = new P2PClient("alice", () => {});
  const bob = new P2PClient("bob", () => {});
  wireSignaling(alice, bob);

  let aliceOpen = false;
  let bobOpen = false;
  let bobReceived: any = null;

  alice.onChannelOpen = () => {
    aliceOpen = true;
    console.log("Alice: channel open");
  };
  bob.onChannelOpen = () => {
    bobOpen = true;
    console.log("Bob: channel open");
  };
  bob.onChannelMessage = (data) => {
    bobReceived = data;
    console.log("Bob received:", data);
  };

  // Start connection
  alice.connectTo("bob");

  // Wait for data channel to open
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (aliceOpen && bobOpen) {
    alice.sendChunk({ test: "hello from Alice" });
  } else {
    throw new Error("Data channel did not open");
  }

  // Wait for message to be received
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (bobReceived && typeof bobReceived === "string") {
    const parsed = JSON.parse(bobReceived);
    if (parsed.type === "chunk" && parsed.payload.test === "hello from Alice") {
      console.log("Test passed: Bob received correct chunk message");
      return true;
    }
  }
  throw new Error("Test failed: Bob did not receive correct message");
}

// If running directly in browser, you can call testP2PClient() from the console.
(window as any).testP2PClient = testP2PClient;
