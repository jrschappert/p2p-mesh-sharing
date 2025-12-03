/**
 * Application-wide constants
 */

export const P2P_CONFIG = {
  MAX_PEERS: 50,
  REQUEST_TIMEOUT: 30000,
  DISCONNECT_GRACE_PERIOD: 10000,
  ICE_RESTART_GRACE_PERIOD: 5000,
  PEER_STATUS_UPDATE_INTERVAL: 2000,
  RECONNECT_DELAY: 3000,
  CONNECTION_REQUEST_DELAY: 1000,
  
  // Data transfer
  CHUNK_SIZE: 16 * 1024,
  CHUNKS_PER_REQUEST: 5,
  
  // WebRTC configuration
  ICE_CANDIDATE_POOL_SIZE: 10,
  SHADOW_MAP_SIZE: 2048,
} as const;

export const SCENE_CONFIG = {
  // World dimensions
  GROUND_SIZE: 200,
  
  // Camera settings
  CAMERA_HEIGHT: 2,
  CAMERA_START_Z: -6,
  CAMERA_SPEED: 0.35,
  CAMERA_INERTIA: 0.7,
  CAMERA_MIN_Z: 0.05,
  
  // Player collision
  PLAYER_ELLIPSOID: { x: 0.5, y: 0.9, z: 0.5 },
  
  // Gravity
  GRAVITY: -0.5,
  
  // Lighting
  DIRECTIONAL_LIGHT_INTENSITY: 0.3,
  AMBIENT_LIGHT_INTENSITY: 0.9,
  SHADOW_BIAS: 0.00001,
  SHADOW_NORMAL_BIAS: 0.05,
  SHADOW_DARKNESS: 0,
  
  // Model placement
  PREVIEW_CUBE_SIZE: 2,
  PREVIEW_ALPHA: 0.5,
  TARGET_MODEL_SIZE: 2,
  
  // Scene colors
  GROUND_COLOR: { r: 0.7, g: 0.7, b: 0.7 },
  BOX_COLOR: { r: 0.1, g: 0.2, b: 0.5 },
  PREVIEW_COLOR: { r: 0.2, g: 0.8, b: 0.2 },
  SKY_COLOR: { r: 0.53, g: 0.81, b: 0.92, a: 1 },
  
  // Object counts
  NUM_BOXES: 30,
  BOX_SIZE: 2,
} as const;

export const PROGRESS_CONFIG = {
  // Progress milestones for AI generation
  INIT: 0 as number,
  FLUX_QUEUE: 10 as number,
  FLUX_PROGRESS_START: 10 as number,
  FLUX_PROGRESS_END: 38 as number,
  FLUX_COMPLETE: 40 as number,
  TRELLIS_START: 42 as number,
  TRELLIS_QUEUE: 45 as number,
  TRELLIS_PROGRESS_START: 50 as number,
  TRELLIS_PROGRESS_END: 92 as number,
  TRELLIS_COMPLETE: 95 as number,
  LOADING_SCENE: 97 as number,
  COMPLETE: 100 as number,
  
  // Progress increment
  FLUX_INCREMENT: 5 as number,
  TRELLIS_INCREMENT: 3 as number,
};