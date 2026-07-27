import type { BrowserBridge } from "../../plugin-sdk/browser-bridge.js";

export const BROWSER_BRIDGES = new Map<
  string,
  {
    bridge: BrowserBridge;
    containerName: string;
    runtimeId: string;
    authToken?: string;
    authPassword?: string;
  }
>();
