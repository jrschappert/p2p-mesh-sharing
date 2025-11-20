import P2PClient from "./p2p-client";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3, Color3 } from "@babylonjs/core/Maths/math";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import "@babylonjs/core/Collisions/collisionCoordinator";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { fal } from "@fal-ai/client";
import { Effect } from "@babylonjs/core/Materials/effect";
import { SCENE_CONFIG, PROGRESS_CONFIG, P2P_CONFIG } from './constants';
import { logger } from './logger';

Effect.ResetCache();

// Add center cursor CSS and modal styles
const style = document.createElement('style');
style.textContent = `
  #cursor {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 4px;
    height: 4px;
    background: white;
    border: 2px solid black;
    border-radius: 50%;
    pointer-events: none;
    z-index: 1000;
  }
  
  #promptModal {
    display: none;
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    padding: 30px;
    border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 2000;
    min-width: 400px;
  }
  
  #promptModal h2 {
    margin: 0 0 20px 0;
    color: #333;
    font-family: system-ui, sans-serif;
  }
  
  #promptModal input {
    width: 100%;
    padding: 10px;
    font-size: 16px;
    border: 2px solid #ddd;
    border-radius: 5px;
    box-sizing: border-box;
    margin-bottom: 15px;
  }
  
  #promptModal button {
    padding: 10px 20px;
    font-size: 16px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    margin-right: 10px;
  }
  
  #promptModal .generate {
    background: #4CAF50;
    color: white;
  }
  
  #promptModal .cancel {
    background: #f44336;
    color: white;
  }
  
  #promptModal .loading {
    color: #666;
    margin-top: 15px;
    display: none;
  }
  
  #progressContainer {
    display: none;
    margin-top: 20px;
  }
  
  #progressBar {
    width: 100%;
    height: 30px;
    background: #f0f0f0;
    border-radius: 5px;
    overflow: hidden;
    position: relative;
  }
  
  #progressFill {
    height: 100%;
    background: linear-gradient(90deg, #4CAF50, #45a049);
    width: 0%;
    transition: width 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-weight: bold;
    font-size: 14px;
  }
  
  #progressText {
    margin-top: 10px;
    color: #666;
    font-size: 14px;
    text-align: center;
  }
  
  #modalOverlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    z-index: 1999;
  }
`;
document.head.appendChild(style);

const cursor = document.createElement('div');
cursor.id = 'cursor';
document.body.appendChild(cursor);

// Setup HUD text management
const hudElement = document.getElementById('hud') as HTMLElement;

function updateHudWithP2PStatus() {
  const isLocked = document.pointerLockElement === canvas;
  const peerCount = (window as any).p2pClient?.getConnectedPeers().length || 0;
  const peerStatus = peerCount > 0 ? ` • 🌐 ${peerCount} peer${peerCount !== 1 ? 's' : ''}` : ' • 🔴 No peers';
  
  if (isLocked) {
    hudElement.innerHTML = `Click to Place Model • Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>${peerStatus}`;
  } else {
    hudElement.innerHTML = `Click to lock mouse • Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>${peerStatus}`;
  }
}

// Listen for pointer lock changes
document.addEventListener('pointerlockchange', () => {
  updateHudWithP2PStatus();
});


// Create modal for prompt input
const overlay = document.createElement('div');
overlay.id = 'modalOverlay';
document.body.appendChild(overlay);

const modal = document.createElement('div');
modal.id = 'promptModal';
modal.innerHTML = `
  <h2>Generate 3D Model</h2>
  <input type="text" id="promptInput" placeholder="Enter your prompt (e.g., 'A cartoon rainbow zebra')" />
  <div>
    <button class="generate" id="generateBtn">Generate</button>
    <button class="generate" id="testBtn" style="background: #2196F3;">Use Test Model</button>
    <button class="cancel" id="cancelBtn">Cancel</button>
  </div>
  <div class="loading" id="loadingText">Generating model, please wait...</div>
  <div id="progressContainer">
    <div id="progressBar">
      <div id="progressFill">0%</div>
    </div>
    <div id="progressText">Initializing...</div>
  </div>
`;
document.body.appendChild(modal);


const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

// FAL API Configuration
const FAL_KEY = (import.meta as any).env.VITE_FAL_KEY || "";
fal.config({ credentials: FAL_KEY });

// Progress tracking - allow resets for retries
let currentProgress = 0;
let progressPhase: 'flux' | 'trellis' | 'loading' | null = null;

function updateProgress(percentage: number, message: string, phase?: 'flux' | 'trellis' | 'loading') {
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  
  // Allow progress to reset when changing phases
  if (phase && phase !== progressPhase) {
    progressPhase = phase;
    currentProgress = percentage;
  } else if (percentage > currentProgress) {
    currentProgress = percentage;
  }
  
  if (progressFill && progressText) {
    progressFill.style.width = `${currentProgress}%`;
    progressFill.textContent = `${Math.round(currentProgress)}%`;
    progressText.textContent = message;
  }
}

function resetProgress() {
  currentProgress = 0;
  progressPhase = null;
}

// FAL API helper functions
async function generateFluxImage(prompt: string): Promise<string> {
  logger.info("Submitting FLUX request...");
  updateProgress(PROGRESS_CONFIG.INIT, "Starting image generation...", 'flux');
  
  let fluxProgress = PROGRESS_CONFIG.FLUX_PROGRESS_START;
  
  const result: any = await fal.subscribe("fal-ai/flux-pro/v1.1", {
    input: {
      prompt,
      image_size: "square",
      output_format: "png",
    },
    logs: true,
    onQueueUpdate: (update) => {
      logger.debug("FLUX update:", update);
      
      if (update.status === "IN_QUEUE") {
        updateProgress(PROGRESS_CONFIG.FLUX_QUEUE, "Waiting in queue for image generation...", 'flux');
        fluxProgress = PROGRESS_CONFIG.FLUX_QUEUE;
      } else if (update.status === "IN_PROGRESS") {
        fluxProgress = Math.min(fluxProgress + PROGRESS_CONFIG.FLUX_INCREMENT, PROGRESS_CONFIG.FLUX_PROGRESS_END);
        updateProgress(fluxProgress, "Generating image with AI...", 'flux');
      }
    },
  });

  const imageUrl = result?.data?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("No image URL returned from FLUX");
  }
  
  updateProgress(PROGRESS_CONFIG.FLUX_COMPLETE, "✓ Image generated successfully!", 'flux');
  return imageUrl;
}

async function generateTrellisModel(imageUrl: string): Promise<string> {
  logger.info("Submitting Trellis request...");
  updateProgress(PROGRESS_CONFIG.TRELLIS_START, "Starting 3D model conversion...", 'trellis');
  
  let trellisProgress = PROGRESS_CONFIG.TRELLIS_START;
  let hasStartedProcessing = false;
  
  const result: any = await fal.subscribe("fal-ai/trellis", {
    input: {
      image_url: imageUrl,
    },
    logs: true,
    onQueueUpdate: (update) => {
      logger.debug("Trellis update:", update);
      
      if (update.status === "IN_QUEUE") {
        updateProgress(PROGRESS_CONFIG.TRELLIS_QUEUE, "Waiting in queue for 3D conversion...", 'trellis');
        trellisProgress = PROGRESS_CONFIG.TRELLIS_QUEUE;
      } else if (update.status === "IN_PROGRESS") {
        if (!hasStartedProcessing) {
          hasStartedProcessing = true;
          trellisProgress = PROGRESS_CONFIG.TRELLIS_PROGRESS_START;
          updateProgress(trellisProgress, "Processing image for 3D conversion...", 'trellis');
        } else {
          trellisProgress = Math.min(trellisProgress + PROGRESS_CONFIG.TRELLIS_INCREMENT, PROGRESS_CONFIG.TRELLIS_PROGRESS_END);
          
          let message = "Converting to 3D model...";
          if (trellisProgress < 60) {
            message = "Analyzing image depth...";
          } else if (trellisProgress < 75) {
            message = "Building 3D mesh...";
          } else if (trellisProgress < 88) {
            message = "Generating textures...";
          } else {
            message = "Finalizing 3D model...";
          }
          
          updateProgress(trellisProgress, message, 'trellis');
        }
      }
    },
  });

  const modelUrl = result?.data?.model_mesh?.url;
  if (!modelUrl) {
    throw new Error("No model URL returned from Trellis");
  }
  
  updateProgress(PROGRESS_CONFIG.TRELLIS_COMPLETE, "✓ 3D model generated successfully!", 'trellis');
  return modelUrl;
}

async function generateModelFromPrompt(prompt: string): Promise<string> {
  logger.info("Generating image with FLUX...");
  const imageUrl = await generateFluxImage(prompt);
  logger.info("Image generated:", imageUrl);

  logger.info("Converting to 3D with Trellis...");
  const modelUrl = await generateTrellisModel(imageUrl);
  logger.info("Model generated:", modelUrl);

  return modelUrl;
}


function createScene(): {scene: Scene, shadowGenerator: ShadowGenerator} {
const scene = new Scene(engine);


// Lighting
const light = new DirectionalLight("dirLight", new Vector3(0, -1, 1), scene);
light.position = new Vector3(0, 50, -20);
light.intensity = SCENE_CONFIG.DIRECTIONAL_LIGHT_INTENSITY;

const ambientLight = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
ambientLight.intensity = SCENE_CONFIG.AMBIENT_LIGHT_INTENSITY;

// Shadow generator
const shadowGenerator = new ShadowGenerator(P2P_CONFIG.SHADOW_MAP_SIZE, light);
shadowGenerator.usePercentageCloserFiltering = true;
shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
shadowGenerator.bias = SCENE_CONFIG.SHADOW_BIAS;
shadowGenerator.normalBias = SCENE_CONFIG.SHADOW_NORMAL_BIAS;
shadowGenerator.darkness = SCENE_CONFIG.SHADOW_DARKNESS;

// Collisions + gravity
scene.collisionsEnabled = true;
scene.gravity = new Vector3(0, SCENE_CONFIG.GRAVITY, 0);

// Camera (first-person)
const camera = new UniversalCamera("fpCamera", new Vector3(0, SCENE_CONFIG.CAMERA_HEIGHT, SCENE_CONFIG.CAMERA_START_Z), scene);
camera.attachControl(canvas, true);
camera.checkCollisions = true;
camera.applyGravity = true;
camera.ellipsoid = new Vector3(SCENE_CONFIG.PLAYER_ELLIPSOID.x, SCENE_CONFIG.PLAYER_ELLIPSOID.y, SCENE_CONFIG.PLAYER_ELLIPSOID.z);
camera.minZ = SCENE_CONFIG.CAMERA_MIN_Z;
camera.speed = SCENE_CONFIG.CAMERA_SPEED;
camera.inertia = SCENE_CONFIG.CAMERA_INERTIA;


// WASD bindings (in addition to arrow keys)
camera.keysUp.push(87); // W
camera.keysDown.push(83); // S
camera.keysLeft.push(65); // A
camera.keysRight.push(68); // D


  // Pointer lock on click for immersive mouse look
  canvas.addEventListener("click", () => {
  canvas.requestPointerLock?.();
  });


  // Ground
  const ground = MeshBuilder.CreateGround("ground", { width: SCENE_CONFIG.GROUND_SIZE, height: SCENE_CONFIG.GROUND_SIZE }, scene);
  ground.checkCollisions = true;
  ground.receiveShadows = true;
  
  const groundMaterial = new StandardMaterial("groundMat", scene);
  groundMaterial.diffuseColor = new Color3(SCENE_CONFIG.GROUND_COLOR.r, SCENE_CONFIG.GROUND_COLOR.g, SCENE_CONFIG.GROUND_COLOR.b);
  ground.material = groundMaterial;

  // Boxes to weave around
  const boxMaterial = new StandardMaterial("boxMat", scene);
  boxMaterial.diffuseColor = new Color3(SCENE_CONFIG.BOX_COLOR.r, SCENE_CONFIG.BOX_COLOR.g, SCENE_CONFIG.BOX_COLOR.b);
  
  // Seed random for consistent box placement
  let seed = 12345; // Fixed seed for consistent positions
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let i = 0; i < SCENE_CONFIG.NUM_BOXES; i++) {
    const box = MeshBuilder.CreateBox(`box_${i}`, { size: SCENE_CONFIG.BOX_SIZE }, scene);
    box.position = new Vector3((seededRandom() - 0.5) * 60, 1, (seededRandom() - 0.5) * 60);
    box.checkCollisions = true;
    box.material = boxMaterial;
    shadowGenerator.addShadowCaster(box);
    box.receiveShadows = true;
  }

  // Placement preview cube
  const previewCube = MeshBuilder.CreateBox("previewCube", { size: SCENE_CONFIG.PREVIEW_CUBE_SIZE }, scene);
  const previewMaterial = new StandardMaterial("previewMat", scene);
  previewMaterial.diffuseColor = new Color3(SCENE_CONFIG.PREVIEW_COLOR.r, SCENE_CONFIG.PREVIEW_COLOR.g, SCENE_CONFIG.PREVIEW_COLOR.b);
  previewMaterial.alpha = SCENE_CONFIG.PREVIEW_ALPHA;
  previewCube.material = previewMaterial;
  previewCube.position = new Vector3(0, 1, 0);
  previewCube.checkCollisions = false;
  previewCube.isPickable = false;
  
  // Update preview cube position based on where player is looking
  scene.registerBeforeRender(() => {
    // Cast ray from center of screen (camera forward)
    const ray = camera.getForwardRay(100);
    const hit = scene.pickWithRay(ray);
    
    if (hit && hit.pickedMesh === ground && hit.pickedPoint) {
      // Snap to ground
      previewCube.position.x = hit.pickedPoint.x;
      previewCube.position.z = hit.pickedPoint.z;
      previewCube.position.y = 1; // half the cube size to sit on ground

      // Check if preview cube overlaps with any other mesh (except ground and preview itself)
      let overlapping = false;
      for (const mesh of scene.meshes) {
        if (mesh !== previewCube && mesh !== ground && mesh.isVisible && mesh.isEnabled()) {
          // Check if meshes intersect using bounding boxes
          if (previewCube.intersectsMesh(mesh, false)) {
            overlapping = true;
            break;
          }
        }
      }
      
      // Only show preview if not overlapping
      previewCube.isVisible = !overlapping;
    } else {
      // Hide if not pointing at ground
      previewCube.isVisible = false;
    }
  });
  
  // Place model on click
  let pendingPlacement: Vector3 | null = null;
  let pendingRotation: number | null = null;

  // Function to load and place a model in the scene
  async function loadAndPlaceModel(modelUrl: string, shareWithPeers: boolean = true, prompt?: string) {
    updateProgress(PROGRESS_CONFIG.LOADING_SCENE, "Loading model into scene...", 'loading');

    if (pendingPlacement && pendingRotation !== null) {
      try {
        const result = await SceneLoader.ImportMeshAsync("", modelUrl, "", scene);
        const meshes = result.meshes;

        if (meshes.length > 0) {
        const rootMesh = meshes[0];
        
        // Calculate bounding box for the entire model
        let minY = Infinity;
        let maxY = -Infinity;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        
        meshes.forEach(mesh => {
          if (mesh !== rootMesh && mesh.getBoundingInfo) {
            const boundingInfo = mesh.getBoundingInfo();
            const min = boundingInfo.boundingBox.minimumWorld;
            const max = boundingInfo.boundingBox.maximumWorld;
            
            if (min.y < minY) minY = min.y;
            if (max.y > maxY) maxY = max.y;
            if (min.x < minX) minX = min.x;
            if (max.x > maxX) maxX = max.x;
            if (min.z < minZ) minZ = min.z;
            if (max.z > maxZ) maxZ = max.z;
            
            if (mesh.material instanceof PBRMaterial) {
              mesh.material.unlit = true;
            }
          }
        });
        
        // If we couldn't get bounds, use defaults
        if (minY === Infinity) {
          minY = 0;
          maxY = 2;
          minX = -1;
          maxX = 1;
          minZ = -1;
          maxZ = 1;
        }
        
        // Calculate model dimensions
        const modelHeight = maxY - minY;
        const modelWidth = Math.max(maxX - minX, maxZ - minZ);
        const modelSize = Math.max(modelHeight, modelWidth);
        
        // Scale to approximately match preview cube size
        const targetSize = SCENE_CONFIG.TARGET_MODEL_SIZE;
        const scale = modelSize > 0 ? targetSize / modelSize : 1;
        rootMesh.scaling = new Vector3(scale, scale, scale);
                
        // Rotate to face the camera FIRST (before positioning)
        const rotationAngle = pendingRotation + Math.PI;
        rootMesh.rotationQuaternion = null;
        rootMesh.rotation.y = rotationAngle;
        
        // Also rotate all child meshes if root is just a container
        meshes.forEach(mesh => {
          if (mesh !== rootMesh && mesh.parent === rootMesh) {
            // Child meshes inherit parent rotation, but set it explicitly if needed
          } else if (mesh !== rootMesh && !mesh.parent) {
            // If meshes are not parented, rotate them individually
            mesh.rotationQuaternion = null;
            mesh.rotation.y = rotationAngle;
          }
        });
                
        // Position at the clicked location
        rootMesh.position.x = pendingPlacement.x;
        rootMesh.position.z = pendingPlacement.z;
        
        // Snap to ground - account for scaling
        rootMesh.position.y = -minY * scale;
        
        // Enable collisions and shadows for all meshes
        meshes.forEach(mesh => {
          if (mesh !== rootMesh) {
            mesh.checkCollisions = true;
            mesh.receiveShadows = true;
            shadowGenerator.addShadowCaster(mesh);
          }
        });
        
        updateProgress(PROGRESS_CONFIG.COMPLETE, "Model placed successfully!", 'loading');
        
        // Share with peers via P2P if requested
        if (shareWithPeers && (window as any).p2pClient) {
          logger.info('Sharing model with peers...');
          await (window as any).p2pClient.shareModel(
            modelUrl,
            new Vector3(pendingPlacement.x, rootMesh.position.y, pendingPlacement.z),
            new Vector3(0, rotationAngle, 0),
            new Vector3(scale, scale, scale),
            prompt
          );
          logger.info('Model shared with peers');
        }
      }
      } catch (error) {
        logger.error('Failed to load and place model:', error);
        throw error;
      }
    }
  }

  window.addEventListener("click", () => {
    if (previewCube.isVisible && document.pointerLockElement === canvas) {
      // Store the position and camera rotation
      pendingPlacement = previewCube.position.clone();
      
      // Get camera's current Y rotation (horizontal facing direction)
      const cameraForward = camera.getDirection(Vector3.Forward());
      pendingRotation = Math.atan2(cameraForward.x, cameraForward.z);
            
      // Exit pointer lock to interact with modal
      document.exitPointerLock();
      
      // Show modal
      overlay.style.display = 'block';
      modal.style.display = 'block';
      (document.getElementById('promptInput') as HTMLInputElement).focus();
    }
  });

  // Modal button handlers
  document.getElementById('cancelBtn')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    modal.style.display = 'none';
    pendingPlacement = null;
    pendingRotation = null;
  });

  // Test button handler - uses cached model
  document.getElementById('testBtn')?.addEventListener('click', async () => {
    const progressContainer = document.getElementById('progressContainer') as HTMLElement;
    const generateBtn = document.getElementById('generateBtn') as HTMLButtonElement;
    const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
    const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
    
    progressContainer.style.display = 'block';
    generateBtn.disabled = true;
    testBtn.disabled = true;
    cancelBtn.disabled = true;
    
    resetProgress();
    updateProgress(10, "Loading test model...");

    try {
      const testModelUrl = new URL("models/test_model_1.glb", window.location.href).href;
      
      updateProgress(50, "Preparing test model...");
      await loadAndPlaceModel(testModelUrl, true, "Test Model");
      
      updateProgress(PROGRESS_CONFIG.COMPLETE, "Test model placed!");
      await new Promise(resolve => setTimeout(resolve, 500));

      overlay.style.display = 'none';
      modal.style.display = 'none';
      pendingPlacement = null;
      pendingRotation = null;

    } catch (error) {
      logger.error('Error loading test model:', error);
      alert('Failed to load test model. Check console for details.');
    } finally {
      progressContainer.style.display = 'none';
      generateBtn.disabled = false;
      testBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  document.getElementById('generateBtn')?.addEventListener('click', async () => {
    const promptInput = document.getElementById('promptInput') as HTMLInputElement;
    const prompt = promptInput.value.trim();
    
    if (!prompt) {
      alert('Please enter a prompt');
      return;
    }

    if (!FAL_KEY) {
      alert('Please set VITE_FAL_KEY in your .env file');
      return;
    }

    // Show loading and progress
    const loadingText = document.getElementById('loadingText') as HTMLElement;
    const progressContainer = document.getElementById('progressContainer') as HTMLElement;
    const generateBtn = document.getElementById('generateBtn') as HTMLButtonElement;
    const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
    
    loadingText.style.display = 'none';
    progressContainer.style.display = 'block';
    generateBtn.disabled = true;
    cancelBtn.disabled = true;
    
    resetProgress();
    updateProgress(PROGRESS_CONFIG.INIT, "Initializing...");

    try {
      const modelUrl = await generateModelFromPrompt(prompt);
      await loadAndPlaceModel(modelUrl, true, prompt);
      
      await new Promise(resolve => setTimeout(resolve, 500));

      overlay.style.display = 'none';
      modal.style.display = 'none';
      promptInput.value = '';
      pendingPlacement = null;
      pendingRotation = null;

    } catch (error) {
      logger.error('Error generating model:', error);
      alert('Failed to generate model. Check console for details.');
    } finally {
      progressContainer.style.display = 'none';
      loadingText.style.display = 'none';
      generateBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  // Allow Enter key to submit
  document.getElementById('promptInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('generateBtn')?.click();
    }
  });


  // Sky color
  scene.clearColor.set(SCENE_CONFIG.SKY_COLOR.r, SCENE_CONFIG.SKY_COLOR.g, SCENE_CONFIG.SKY_COLOR.b, SCENE_CONFIG.SKY_COLOR.a);

  return { scene, shadowGenerator };
}


const {scene, shadowGenerator} = createScene();

// Initialize P2P Client for multi-tab model sharing
const p2pClient = new P2PClient(scene, shadowGenerator);

// Expose to window for debugging
(window as any).p2pClient = p2pClient;

// Setup P2P callbacks
p2pClient.setOnPeerConnected((peerId) => {
  logger.info(`Connected to peer: ${peerId}`);
  updateHudWithP2PStatus();
});

p2pClient.setOnPeerDisconnected((peerId) => {
  logger.info(`Peer disconnected: ${peerId}`);
  updateHudWithP2PStatus();
});

p2pClient.setOnModelReceived((modelPackage) => {
  logger.info(`Received model from peer: ${modelPackage.id}`);
  updateHudWithP2PStatus();
});

p2pClient.setOnDownloadProgress((modelId, progress) => {
  logger.debug(`Download progress for ${modelId}: ${progress.toFixed(1)}%`);
});

// Update HUD periodically
setInterval(() => {
  updateHudWithP2PStatus();
}, P2P_CONFIG.PEER_STATUS_UPDATE_INTERVAL);

engine.runRenderLoop(() => {
  scene.render();
});


window.addEventListener("resize", () => {
  engine.resize();
});