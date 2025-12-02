import type { Scene } from "@babylonjs/core";

declare global {
  interface Window {
    loadAndPlaceModel?: (url: string, useCache?: boolean, label?: string) => Promise<any>;
  }
}

export {};
