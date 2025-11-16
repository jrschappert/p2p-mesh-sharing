// Expose P2PClient test for browser console
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
import "@babylonjs/core/Collisions/collisionCoordinator"; // enables collisions
import "@babylonjs/core/Helpers/sceneHelpers"; // for inspector shortcut
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent"; // enables shadows

import { Effect } from "@babylonjs/core/Materials/effect";
Effect.ResetCache();
// Optional: uncomment to enable the debug inspector via Shift+Ctrl+Alt+I
// import "@babylonjs/core/Debug/debugLayer";
// import "@babylonjs/inspector";

// Import loaders for GLB files
import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";

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

function updateHudText(isLocked: boolean) {
  if (isLocked) {
    hudElement.innerHTML = 'Click to Place Model • Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>';
  } else {
    hudElement.innerHTML = 'Click to lock mouse • Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>';
  }
}

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

// Initialize HUD with unlocked state
updateHudText(false);

// Listen for pointer lock changes
document.addEventListener('pointerlockchange', () => {
  const isLocked = document.pointerLockElement === canvas;
  updateHudText(isLocked);
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


// Import FAL client at the top of the file
import { fal } from "@fal-ai/client";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

// FAL API Configuration
const FAL_KEY = (import.meta as any).env.VITE_FAL_KEY || "";
fal.config({ credentials: FAL_KEY });

// Progress tracking
interface ProgressState {
  percentage: number;
  message: string;
}

let currentProgress = 0;

function updateProgress(percentage: number, message: string) {
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  
  // Only update if progress is moving forward
  if (percentage > currentProgress) {
    currentProgress = percentage;
  }
  
  if (progressFill && progressText) {
    progressFill.style.width = `${currentProgress}%`;
    progressFill.textContent = `${Math.round(currentProgress)}%`;
    progressText.textContent = message;
  }
}

// FAL API helper functions using official client
async function generateFluxImage(prompt: string): Promise<string> {
  console.log("Submitting FLUX request...");
  updateProgress(5, "Starting image generation...");
  
  let fluxProgress = 5;
  
  const result: any = await fal.subscribe("fal-ai/flux-pro/v1.1", {
    input: {
      prompt,
      image_size: "square",
      output_format: "png",
    },
    logs: true,
    onQueueUpdate: (update) => {
      console.log("FLUX update:", update);
      
      if (update.status === "IN_QUEUE") {
        updateProgress(10, "Waiting in queue for image generation...");
        fluxProgress = 10;
      } else if (update.status === "IN_PROGRESS") {
        // Gradually increase progress
        fluxProgress = Math.min(fluxProgress + 5, 38);
        updateProgress(fluxProgress, "Generating image with AI...");
      }
    },
  });

  const imageUrl = result?.data?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("No image URL returned from FLUX");
  }
  
  updateProgress(40, "✓ Image generated successfully!");
  return imageUrl;
}

async function generateTrellisModel(imageUrl: string): Promise<string> {
  console.log("Submitting Trellis request...");
  updateProgress(42, "Starting 3D model conversion...");
  
  let trellisProgress = 42;
  let hasStartedProcessing = false;
  
  const result: any = await fal.subscribe("fal-ai/trellis", {
    input: {
      image_url: imageUrl,
    },
    logs: true,
    onQueueUpdate: (update) => {
      console.log("Trellis update:", update);
      
      if (update.status === "IN_QUEUE") {
        updateProgress(45, "Waiting in queue for 3D conversion...");
        trellisProgress = 45;
      } else if (update.status === "IN_PROGRESS") {
        if (!hasStartedProcessing) {
          hasStartedProcessing = true;
          trellisProgress = 50;
          updateProgress(trellisProgress, "Processing image for 3D conversion...");
        } else {
          // Gradually increase from 50% to 92%
          trellisProgress = Math.min(trellisProgress + 3, 92);
          
          // Update message based on progress range
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
          
          updateProgress(trellisProgress, message);
        }
      }
    },
  });

  const modelUrl = result?.data?.model_mesh?.url;
  if (!modelUrl) {
    throw new Error("No model URL returned from Trellis");
  }
  
  updateProgress(95, "✓ 3D model generated successfully!");
  return modelUrl;
}

async function generateModelFromPrompt(prompt: string): Promise<string> {
  console.log("Generating image with FLUX...");
  const imageUrl = await generateFluxImage(prompt);
  console.log("Image generated:", imageUrl);

  console.log("🧩 Converting to 3D with Trellis...");
  const modelUrl = await generateTrellisModel(imageUrl);
  console.log("Model generated:", modelUrl);

  return modelUrl;
}


function createScene(): Scene {
const scene = new Scene(engine);


// Lighting - Directional light for shadows (from behind player)
const light = new DirectionalLight("dirLight", new Vector3(0, -1, 1), scene);
light.position = new Vector3(0, 50, -20);
light.intensity = .3;

// Add ambient light so shadows are visible
const ambientLight = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
ambientLight.intensity = .9;

// Shadow generator
const shadowGenerator = new ShadowGenerator(2048, light);
shadowGenerator.usePercentageCloserFiltering = true;
shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
shadowGenerator.bias = 0.00001; // Fixes shadow acne
shadowGenerator.normalBias = 0.05; // Additional fix for acne
shadowGenerator.darkness = 0; // Make shadows more visible (0 = black, 1 = no shadow)


// Collisions + gravity
scene.collisionsEnabled = true;
scene.gravity = new Vector3(0, -0.5, 0);


// Camera (first-person)
const camera = new UniversalCamera("fpCamera", new Vector3(0, 2, -6), scene);
camera.attachControl(canvas, true);
camera.checkCollisions = true;
camera.applyGravity = true;
camera.ellipsoid = new Vector3(0.5, 0.9, 0.5); // player collision capsule
camera.minZ = 0.05;
camera.speed = 0.35; // tune movement speed
camera.inertia = 0.7; // mouse look smoothing (lower = snappier)


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
  const ground = MeshBuilder.CreateGround("ground", { width: 200, height: 200 }, scene);
  ground.checkCollisions = true;
  ground.receiveShadows = true;
  
  // Add material to ground
  const groundMaterial = new StandardMaterial("groundMat", scene);
  groundMaterial.diffuseColor = new Color3(0.7, 0.7, 0.7); // light gray
  ground.material = groundMaterial;


  // A few boxes to weave around
  const boxMaterial = new StandardMaterial("boxMat", scene);
  boxMaterial.diffuseColor = new Color3(0.1, 0.2, 0.5); // dark blue
  
  for (let i = 0; i < 30; i++) {
  const box = MeshBuilder.CreateBox(`box_${i}`, { size: 2 }, scene);
  box.position = new Vector3((Math.random() - 0.5) * 60, 1, (Math.random() - 0.5) * 60);
  box.checkCollisions = true;
  box.material = boxMaterial;
  
  // Add to shadow caster
  shadowGenerator.addShadowCaster(box);
  box.receiveShadows = true;
  }

  // Placement preview cube
  const previewCube = MeshBuilder.CreateBox("previewCube", { size: 2 }, scene);
  const previewMaterial = new StandardMaterial("previewMat", scene);
  previewMaterial.diffuseColor = new Color3(0.2, 0.8, 0.2); // green
  previewMaterial.alpha = 0.5; // semi-transparent
  previewCube.material = previewMaterial;
  previewCube.position = new Vector3(0, 1, 0);
  previewCube.checkCollisions = false; // don't collide with camera
  previewCube.isPickable = false; // don't interfere with raycasting
  
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
    updateProgress(97, "Loading model into scene...");

    if (pendingPlacement && pendingRotation !== null) {
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
        
        // Scale to approximately match preview cube size (2 units)
        const targetSize = 2;
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
        
        updateProgress(100, "Model placed successfully!");
        
        // Share with peers via P2P if requested
        if (shareWithPeers && (window as any).p2pClient) {
          console.log('Sharing model with peers...');
          await (window as any).p2pClient.shareModel(
            modelUrl,
            new Vector3(pendingPlacement.x, rootMesh.position.y, pendingPlacement.z),
            new Vector3(0, rotationAngle, 0),
            new Vector3(scale, scale, scale),
            prompt
          );
          console.log('Model shared with peers');
        }
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
    
    currentProgress = 0;
    updateProgress(10, "Loading test model...");

    try {
      // Use the cached test model URL - convert to absolute URL for P2P sharing
      const testModelUrl = new URL("models/test_model_1.glb", window.location.href).href;
      
      updateProgress(50, "Preparing test model...");
      
      // Load and place the model and share with peers
      await loadAndPlaceModel(testModelUrl, true, "Test Model");
      
      updateProgress(100, "Test model placed!");
      await new Promise(resolve => setTimeout(resolve, 500));

      // Close modal
      overlay.style.display = 'none';
      modal.style.display = 'none';
      pendingPlacement = null;
      pendingRotation = null;

    } catch (error) {
      console.error('Error loading test model:', error);
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
    
    currentProgress = 0; // Reset progress
    updateProgress(0, "Initializing...");

    try {
      // Generate model
      const modelUrl = await generateModelFromPrompt(prompt);
      
      // Load and place the model and share with peers
      await loadAndPlaceModel(modelUrl, true, prompt);
      
      // Wait a moment to show 100% completion
      await new Promise(resolve => setTimeout(resolve, 500));

      // Close modal
      overlay.style.display = 'none';
      modal.style.display = 'none';
      promptInput.value = '';
      pendingPlacement = null;
      pendingRotation = null;

    } catch (error) {
      console.error('Error generating model:', error);
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


  // Simple sky tint via clear color
  scene.clearColor.set(0.53, 0.81, 0.92, 1); // light blue


  // Debug inspector hotkey (Shift+Ctrl+Alt+I)
  // window.addEventListener("keydown", (ev) => {
  // if (ev.shiftKey && ev.ctrlKey && ev.altKey && ev.code === "KeyI") {
  // if ((scene as any).debugLayer.isVisible()) (scene as any).debugLayer.hide();
  // else (scene as any).debugLayer.show();
  // }
  // });


  return scene;
}


const scene = createScene();

// Initialize P2P Client for multi-tab model sharing
const p2pClient = new P2PClient(scene, 'wss://p2p-mesh-sharing.onrender.com');

// Expose to window for debugging
(window as any).p2pClient = p2pClient;

// Setup P2P callbacks
p2pClient.setOnPeerConnected((peerId) => {
  console.log(`Connected to peer: ${peerId}`);
  updateHudWithP2PStatus();
});

p2pClient.setOnPeerDisconnected((peerId) => {
  console.log(`Peer disconnected: ${peerId}`);
  updateHudWithP2PStatus();
});

p2pClient.setOnModelReceived((modelPackage) => {
  console.log(`Received model from peer: ${modelPackage.id}`);
  // Model is automatically loaded into scene by P2PClient
  updateHudWithP2PStatus();
});

p2pClient.setOnDownloadProgress((modelId, progress) => {
  console.log(`Download progress for ${modelId}: ${progress.toFixed(1)}%`);
});

// Update HUD periodically to show peer status
setInterval(() => {
  if (document.pointerLockElement !== canvas) {
    updateHudWithP2PStatus();
  }
}, 2000);

engine.runRenderLoop(() => {
  scene.render();
});


window.addEventListener("resize", () => {
  engine.resize();
});