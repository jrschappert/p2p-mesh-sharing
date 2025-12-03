import puppeteer from 'puppeteer';

const CONFIG = {
  baseUrl: 'https://jrschappert.github.io/p2p-mesh-sharing/',
  numClients: 6,
  delayBetweenClients: 50,
  modelPlacementDelay: 100,
  testDuration: 30000,
  headless: true,
  viewport: { width: 800, height: 600 },
};

const TEST_MODELS = [
  'test_model_1.glb',
  'test_model_2.glb',
];
class LoadTestClient {
  constructor(id) {
    this.id = id;
    this.browser = null;
    this.page = null;
    this.modelFile = TEST_MODELS[id % TEST_MODELS.length];
    this.modelPlaced = false;
    this.metrics = {
      startTime: null,
      modelPlacementStart: null,
      modelPlacementEnd: null,
      placementTime: null,
      shareTime: null,
      sharedAt: null,
      sharedModelUrl: null,
      sharedPrompt: null,
      sharedMeshName: null,
      errors: []
    };
  }

  async launch() {
    console.log(`[Client ${this.id}] Launching browser...`);
    
    try {
      this.browser = await puppeteer.launch({ 
        headless: CONFIG.headless,
        args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--no-first-run'
        ]
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport(CONFIG.viewport);

      this.page.on('pageerror', error => {
        console.error(`[Client ${this.id}] Page Error:`, error.message);
        this.metrics.errors.push(error.message);
      });

      this.metrics.startTime = Date.now();
      await this.page.goto(CONFIG.baseUrl);
      console.log(`[Client ${this.id}] Page loaded successfully`);
      await new Promise(resolve => setTimeout(resolve, 5000));

      const diagnostics = await this.page.evaluate(() => {
        const canvas = document.getElementById('renderCanvas');
        const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) : null;
        return {
          hasCanvas: !!canvas,
          hasWebGL: !!gl,
          hasBabylon: !!window.BABYLON,
          hasScene: !!window.scene,
          glVersion: gl ? gl.getParameter(gl.VERSION) : null,
        };
      });

      console.log(`[Client ${this.id}] Diagnostics:`, diagnostics);

      if (!diagnostics.hasScene) {
        console.error(`[Client ${this.id}] Scene not available`);
        this.metrics.errors.push('Scene not available');
        return false;
      }

      await this.page.evaluate(() => {
        if (!window._receivedModels) {
          window._receivedModels = [];
          window._knownMeshIds = new Set();

          setInterval(() => {
            try {
              if (!window.scene || !window.scene.meshes) return;
              const meshes = window.scene.meshes;
              for (let i = 0; i < meshes.length; i++) {
                const m = meshes[i];
                const mid = m.id != null ? String(m.id) : (m.uniqueId != null ? String(m.uniqueId) : null);
                if (mid && window._knownMeshIds.has(mid)) continue;
                
                const meta = m.metadata || {};
                const name = m.name || '';
                const isLoadTest = (meta && meta.__loadTest === true) ||
                                 (meta && meta.modelFile) ||
                                 (typeof name === 'string' && name.indexOf('loadtest-') !== -1) ||
                                 (typeof name === 'string' && name.indexOf('LoadTest-') !== -1);

                if (isLoadTest) {
                  const modelFile = (meta && meta.modelFile) || (() => {
                    const parts = name.split('-');
                    return parts.length ? parts[parts.length - 1] : name;
                  })();
                  const prompt = (meta && meta.prompt) || null;
                  const ts = Date.now();
                  window._receivedModels.push({
                    modelFile,
                    prompt,
                    meshName: name,
                    ts
                  });
                }

                if (mid) window._knownMeshIds.add(mid);
              }
            } catch (e) {
            }
          }, 500);
        }
      });

      console.log(`[Client ${this.id}] Scene is ready and receiver poller installed!`);
      return true;
    } catch (error) {
      console.error(`[Client ${this.id}] Launch error:`, error.message);
      this.metrics.errors.push(error.message);
      return false;
    }
  }

  async placeTestModel() {
    if (this.modelPlaced) {
      console.log(`[Client ${this.id}] Model already placed`);
      return;
    }

    console.log(`[Client ${this.id}] Placing test model: ${this.modelFile}`);
    this.metrics.modelPlacementStart = Date.now();

    try {
      const res = await this.page.evaluate(async (modelFile, clientId) => {
        try {
          if (!window.scene || !window.SceneLoader || !window.Vector3) {
            console.error(`Client ${clientId}: Required Babylon APIs missing`);
            return { success: false };
          }

          const modelUrl = new URL(`models/${modelFile}`, window.location.href).href;
          const x = (Math.random() * 10) - 5;
          const z = (Math.random() * 10) - 5;
          const rotationAngle = Math.random() * Math.PI * 2;

          const t0 = Date.now();
          const result = await window.SceneLoader.ImportMeshAsync("", "", modelUrl, window.scene);
          const tLocalDone = Date.now();

          if (!result || !result.meshes || result.meshes.length === 0) {
            console.error(`Client ${clientId}: No meshes returned for model ${modelFile}`);
            return { success: false, localMs: tLocalDone - t0 };
          }

          let rootMesh = result.meshes[0];
          for (let m of result.meshes) {
            if (!m.parent) { rootMesh = m; break; }
          }

          const uniqueName = `loadtest-${clientId}-${modelFile}-${Date.now()}`;
          rootMesh.name = uniqueName;
          rootMesh.metadata = rootMesh.metadata || {};
          rootMesh.metadata.__loadTest = true;
          rootMesh.metadata.modelFile = modelFile;
          const prompt = `LoadTest-${clientId}-${modelFile}-${Date.now()}`;
          rootMesh.metadata.prompt = prompt;

          const y = (rootMesh.position && typeof rootMesh.position.y === 'number') ? rootMesh.position.y : 0;
          rootMesh.position = new window.Vector3(x, y, z);
          rootMesh.rotation = rootMesh.rotation || new window.Vector3(0,0,0);
          rootMesh.rotation.y = rotationAngle;
          if (!rootMesh.scaling) rootMesh.scaling = new window.Vector3(1,1,1);

          const localPlacementMs = tLocalDone - t0;

          let shareMs = null;
          let sharedAt = null;
          if (window.p2pClient && typeof window.p2pClient.shareModel === 'function') {
            try {
              sharedAt = Date.now();
              await window.p2pClient.shareModel(
                modelUrl,
                new window.Vector3(x, y, z),
                new window.Vector3(0, rotationAngle, 0),
                new window.Vector3(rootMesh.scaling.x, rootMesh.scaling.y, rootMesh.scaling.z),
                prompt
              );
              shareMs = Date.now() - sharedAt;
            } catch (shareErr) {
              console.error(`Client ${clientId}: shareModel error`, shareErr);
            }
          } else {
            console.log(`Client ${clientId}: p2pClient.shareModel not available`);
          }

          window._lastSharedModel = { modelFile, modelUrl, prompt, sharedAt };

          return {
            success: true,
            localPlacementMs,
            shareMs,
            sharedAt,
            modelFile,
            modelUrl,
            prompt,
            meshName: uniqueName
          };

        } catch (err) {
          console.error(`Client ${clientId}: Exception during placement`, err);
          return { success: false };
        }
      }, this.modelFile, this.id);

      if (res && res.success) {
        this.metrics.modelPlacementEnd = Date.now();
        this.metrics.placementTime = res.localPlacementMs || (this.metrics.modelPlacementEnd - this.metrics.modelPlacementStart);
        this.metrics.shareTime = res.shareMs || null;
        this.metrics.sharedAt = res.sharedAt || null;
        this.metrics.sharedModelUrl = res.modelUrl || null;
        this.metrics.sharedPrompt = res.prompt || null;
        this.metrics.sharedMeshName = res.meshName || null;
        this.modelPlaced = true;

        console.log(`[Client ${this.id}] Model placed locally in ${this.metrics.placementTime}ms; shareTime=${this.metrics.shareTime}ms`);
      } else {
        this.metrics.modelPlacementEnd = Date.now();
        this.metrics.placementTime = this.metrics.modelPlacementEnd - this.metrics.modelPlacementStart;
        this.metrics.errors.push('Placement or load failed');
        console.error(`[Client ${this.id}] Placement failed`);
      }

      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error(`[Client ${this.id}] Model placement error:`, error.message);
      this.metrics.errors.push(error.message);
    }
  }

  async monitorScene() {
    try {
      const sceneData = await this.page.evaluate(() => {
        const data = {
          meshCount: 0,
          peerCount: 0,
          cameraPosition: null
        };

        if (window.scene) {
          data.meshCount = window.scene.meshes ? window.scene.meshes.length : 0;
          if (window.scene.activeCamera) {
            data.cameraPosition = {
              x: Math.round(window.scene.activeCamera.position.x),
              y: Math.round(window.scene.activeCamera.position.y),
              z: Math.round(window.scene.activeCamera.position.z)
            };
          }
        }

        if (window.peerConnections) {
          data.peerCount = Object.keys(window.peerConnections).length;
        } else if (window.peers) {
          data.peerCount = window.peers.length || 0;
        }

        return data;
      });

      return sceneData;
    } catch (error) {
      return null;
    }
  }

  async getReceivedModels() {
    try {
      const received = await this.page.evaluate(() => {
        return {
          received: window._receivedModels || [],
          lastShared: window._lastSharedModel || null
        };
      });
      return received;
    } catch (e) {
      return { received: [], lastShared: null };
    }
  }

  async cleanup() {
    console.log(`[Client ${this.id}] Cleaning up...`);
    if (this.browser) {
      await this.browser.close();
    }
  }

  getMetrics() {
    return {
      clientId: this.id,
      modelFile: this.modelFile,
      modelPlaced: this.modelPlaced,
      totalTime: this.metrics.modelPlacementEnd 
        ? this.metrics.modelPlacementEnd - this.metrics.startTime 
        : Date.now() - this.metrics.startTime,
      placementTime: this.metrics.placementTime,
      shareTime: this.metrics.shareTime,
      sharedAt: this.metrics.sharedAt,
      sharedModelUrl: this.metrics.sharedModelUrl,
      sharedPrompt: this.metrics.sharedPrompt,
      sharedMeshName: this.metrics.sharedMeshName,
      errors: this.metrics.errors
    };
  }
}

class LoadTestRunner {
  constructor(config) {
    this.config = config;
    this.clients = [];
    this.running = false;
  }

  async run() {
    console.log('='.repeat(60));
    console.log('P2P Mesh Sharing - Load Test');
    console.log('='.repeat(60));
    console.log(`Clients: ${this.config.numClients}`);
    console.log(`Duration: ${this.config.testDuration}ms (${this.config.testDuration/1000}s)`);
    console.log(`Headless: ${this.config.headless}`);
    console.log('='.repeat(60));
    console.log('');

    this.running = true;

    console.log('Launching all browser clients...');
    for (let i = 0; i < this.config.numClients; i++) {
      const client = new LoadTestClient(i);
      this.clients.push(client);

      const success = await client.launch();

      if (!success) {
        console.error(`Client ${i} failed to launch — continuing with remaining clients`);
      } else {
        console.log(`Client ${i} launched successfully`);
      }

      if (i < this.config.numClients - 1) {
        await this.delay(this.config.delayBetweenClients);
      }
    }

    console.log('');
    console.log(`All ${this.clients.length} clients launched. Beginning model placements...`);
    console.log('');

    for (let i = 0; i < this.clients.length; i++) {
      const client = this.clients[i];

      const monitorInterval = setInterval(() => {
        if (this.running) {
          client.monitorScene();
        }
      }, 15000);

      client.monitorInterval = monitorInterval;

      const placementDelay = this.config.modelPlacementDelay * i;
      setTimeout(() => {
        if (this.running) {
          client.placeTestModel();
        }
      }, placementDelay);
    }

    console.log(`Test running for ${this.config.testDuration}ms...`);
    console.log('');

    await this.delay(this.config.testDuration);

    await this.cleanup();
  }

  async cleanup() {
    console.log('');
    console.log('='.repeat(60));
    console.log('Test Complete - Collecting Metrics');
    console.log('='.repeat(60));

    this.running = false;

    for (const client of this.clients) {
      if (client.monitorInterval) {
        clearInterval(client.monitorInterval);
      }
    }

    const metrics = this.clients.map(client => client.getMetrics());

    const clientReceivedMaps = {};
    for (const client of this.clients) {
      clientReceivedMaps[client.id] = await client.getReceivedModels();
    }

    const sharedModels = [];
    for (const client of this.clients) {
      const m = client.getMetrics();
      if (m.sharedModelUrl && m.sharedAt) {
        sharedModels.push({
          originClient: m.clientId,
          modelFile: m.modelFile,
          modelUrl: m.sharedModelUrl,
          sharedAt: m.sharedAt,
          prompt: m.sharedPrompt || null,
          placementTime: m.placementTime || null,
          shareTime: m.shareTime || null
        });
      }
    }

    console.log('');
    console.log('TEST SUMMARY:');
    console.log('-'.repeat(60));
    console.log(`Total Clients Launched: ${this.clients.length}`);
    console.log(`Models Successfully Placed: ${metrics.filter(m => m.modelPlaced).length}/${this.clients.length}`);
    console.log(`Total Errors: ${metrics.reduce((sum, m) => sum + m.errors.length, 0)}`);
    
    const placementTimes = metrics
      .filter(m => m.placementTime !== null)
      .map(m => m.placementTime);
    
    if (placementTimes.length > 0) {
      const avgPlacementTime = placementTimes.reduce((a, b) => a + b, 0) / placementTimes.length;
      const minPlacementTime = Math.min(...placementTimes);
      const maxPlacementTime = Math.max(...placementTimes);
      
      console.log(`Average Placement Time: ${avgPlacementTime.toFixed(2)}ms`);
      console.log(`Min/Max Placement Time: ${minPlacementTime}ms / ${maxPlacementTime}ms`);
    }

    const shareTimes = metrics
      .filter(m => m.shareTime !== null)
      .map(m => m.shareTime);
    
    if (shareTimes.length > 0) {
      const avgShareTime = shareTimes.reduce((a, b) => a + b, 0) / shareTimes.length;
      console.log(`Average Share Time: ${avgShareTime.toFixed(2)}ms`);
    }

    const successRate = (metrics.filter(m => m.modelPlaced).length / this.clients.length * 100).toFixed(1);
    console.log(`Success Rate: ${successRate}%`);

    console.log('');
    console.log('DETAILED CLIENT METRICS:');
    console.log('-'.repeat(60));
    metrics.forEach(m => {
      console.log(`Client ${m.clientId}:`);
      console.log(`  Model: ${m.modelFile}`);
      console.log(`  Placed: ${m.modelPlaced ? '✓' : '✗'}`);
      console.log(`  Total Time: ${m.totalTime}ms`);
      if (m.placementTime) {
        console.log(`  Placement Time: ${m.placementTime}ms`);
      }
      if (m.shareTime) {
        console.log(`  Share Time: ${m.shareTime}ms`);
      }
      if (m.errors.length > 0) {
        console.log(`  Errors: ${m.errors.length}`);
        m.errors.forEach(err => console.log(`    - ${err}`));
      }
      console.log('');
    });

    console.log('Closing all browser instances...');
    for (const client of this.clients) {
      await client.cleanup();
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('Load Test Finished');
    console.log('='.repeat(60));
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

(async () => {
  try {
    const runner = new LoadTestRunner(CONFIG);
    await runner.run();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();