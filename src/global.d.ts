export {};

declare global {
  interface Window {
    p2pClientInstance?: import("../p2p-client").P2PClient;
  }
}
