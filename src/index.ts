/**
 * mv3-fetch-bridge — cookie-authenticated fetch bridge for Chrome MV3
 * extensions.
 *
 * Worker side (background service worker): createFetchBridge
 * Caller side (side panel / popup / content script): createBridgeClient
 * Shared protocol types: BridgeRequest / BridgeResponse / BridgeErrorType
 */

export type {
  BridgeErrorType,
  BridgeFailure,
  BridgeMode,
  BridgeRequest,
  BridgeRequestOptions,
  BridgeResponse,
  BridgeSuccess,
} from './types.js';

export {
  createFetchBridge,
  type FetchBridge,
  type FetchBridgeConfig,
} from './worker.js';

export {
  createBridgeClient,
  mapWithConcurrency,
  type BridgeCall,
  type BridgeClient,
  type BridgeClientOptions,
} from './client.js';

export {
  createSlidingWindowLimiter,
  isAllowedByPolicy,
  isPrivateOrLocalHostname,
  isSafePublicHttpsUrl,
  tryParseUrl,
  type AllowlistPolicy,
  type RateLimiter,
} from './url-policy.js';
