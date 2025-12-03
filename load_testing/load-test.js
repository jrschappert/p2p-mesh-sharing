// Run with: node loadTest.js

import puppeteer from 'puppeteer';

const CONFIG = {
  baseUrl: 'http://localhost:5173',
  numClients: 2,
  delayBetweenClients: 2000, 
  modelPlacementDelay: 5000,
  testDuration: 60000,
  headless: false,
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
      errors: []
    };
  }

  async launch() {
    console.log(`[Client ${this.id}] Launching browser...`);
    
    try {
      this.browser = await puppeteer.launch({ 
        headless: CONFIG.headless 
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport(CONFIG.viewport);

      this.page.on('console', msg => {
        const text = msg.text();
        if (!text.includes('Download the Vue Devtools') && !text.includes('[vite]')) {
          console.log(`[Client ${this.id}] Console: ${text}`);
        }
      });

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

      console.log(`[Client ${this.id}] Scene is ready!`);
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
      const success = await this.page.evaluate(async (modelFile, clientId) => {
        try {
          if (!window.scene || !window.SceneLoader || !window.Vector3) {
            console.error(`Client ${clientId}: Required Babylon APIs (scene/SceneLoader/Vector3) missing`);
            return false;
          }

          const modelUrl = new URL(`models/${modelFile}`, window.location.href).href;

          // Pick a random X/Z in [-5, 5] (10x10 square)
          const x = (Math.random() * 10) - 5;
          const z = (Math.random() * 10) - 5;

          // Random rotation around Y
          const rotationAngle = Math.random() * Math.PI * 2;

          console.log(`Client ${clientId}: Importing ${modelUrl} at (${x.toFixed(2)}, ?, ${z.toFixed(2)})`);

          const result = await window.SceneLoader.ImportMeshAsync("", "", modelUrl, window.scene);

          if (!result || !result.meshes || result.meshes.length === 0) {
            console.error(`Client ${clientId}: No meshes returned for model ${modelFile}`);
            return false;
          }

          let rootMesh = result.meshes[0];
          for (let m of result.meshes) {
            if (!m.parent) { rootMesh = m; break; }
          }

          const y = (rootMesh.position && typeof rootMesh.position.y === 'number') ? rootMesh.position.y : 0;

          rootMesh.position = new window.Vector3(x, y, z);
          rootMesh.rotation = rootMesh.rotation || new window.Vector3(0, 0, 0);
          rootMesh.rotation.y = rotationAngle;
          if (!rootMesh.scaling) rootMesh.scaling = new window.Vector3(1, 1, 1);

          console.log(`Client ${clientId}: Model placed locally at (${x.toFixed(2)}, ${y}, ${z.toFixed(2)})`);

          const scale = (rootMesh.scaling && typeof rootMesh.scaling.x === 'number') ? rootMesh.scaling.x : 1;
          const prompt = `LoadTest-${clientId}-${modelFile}`;
          if (window.logger && typeof window.logger.info === 'function') {
            window.logger.info('Sharing model with peers...');
          } else {
            console.log(`Client ${clientId}: Sharing model with peers...`);
          }
          if (window.p2pClient && typeof window.p2pClient.shareModel === 'function') {
            try {
              await window.p2pClient.shareModel(
                modelUrl,
                new window.Vector3(x, 1, z),
                new window.Vector3(0, rotationAngle, 0),
                new window.Vector3(scale, scale, scale),
                prompt
              );

              if (window.logger && typeof window.logger.info === 'function') {
                window.logger.info('Model shared with peers');
              } else {
                console.log(`Client ${clientId}: Model shared with peers`);
              }
            } catch (shareErr) {
              console.error(`Client ${clientId}: Error sharing model with peers:`, shareErr);
            }
          } else {
            console.log(`Client ${clientId}: window.p2pClient.shareModel not available — skipping share`);
          }

          return true;
        } catch (err) {
          console.error(`Client ${clientId}: Exception during placement`, err);
          return false;
        }
      }, this.modelFile, this.id);

      await new Promise(resolve => setTimeout(resolve, 1000));

      this.metrics.modelPlacementEnd = Date.now();
      this.modelPlaced = success;

      const placementTime = this.metrics.modelPlacementEnd - this.metrics.modelPlacementStart;

      if (success) {
        console.log(`[Client ${this.id}] Model placed successfully in ${placementTime}ms`);
      } else {
        console.error(`[Client ${this.id}] Model placement failed after ${placementTime}ms`);
        this.metrics.errors.push('Model placement failed');
      }

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

      console.log(`[Client ${this.id}] Scene - Meshes: ${sceneData.meshCount}, Peers: ${sceneData.peerCount}`);
      return sceneData;
    } catch (error) {
      return null;
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
      placementTime: this.metrics.modelPlacementEnd && this.metrics.modelPlacementStart
        ? this.metrics.modelPlacementEnd - this.metrics.modelPlacementStart
        : null,
      errors: this.metrics.errors
    };
  }
}

class LoadTestRunner {
  constructor(config) {
    this.config = config;
    this.clients = [];
    this.running = false;
    this.monitoringInterval = null;
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

    for (let i = 0; i < this.config.numClients; i++) {
      const client = new LoadTestClient(i);
      this.clients.push(client);

      const success = await client.launch();
      
      if (success) {
        setTimeout(() => {
          if (this.running) {
            client.placeTestModel();
          }
        }, this.config.modelPlacementDelay);

        setInterval(() => {
          if (this.running) {
            client.monitorScene();
          }
        }, 15000);
      }

      if (i < this.config.numClients - 1) {
        await this.delay(this.config.delayBetweenClients);
      }
    }

    console.log('');
    console.log(`All ${this.clients.length} clients launched. Test running...`);
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

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    const metrics = this.clients.map(client => client.getMetrics());
    
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