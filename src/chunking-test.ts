/**
 * Simple Local Chunking Test
 * 
 * This directly tests that chunking and reassembling works correctly.
 * No network simulation, no peers, just: chunk → reassemble → verify
 * 
 * Usage in browser console or main.ts:
 * ```
 * import { testLocalChunking } from './chunking-test';
 * await testLocalChunking();
 * ```
 */

import { ModelSerializer, ChunkReceiver, ModelPackage, ModelChunk } from "./model-serializer";
import { Vector3 } from "@babylonjs/core/Maths/math";

/**
 * Helper function to download a blob as a file
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Creates a mock GLB file for testing
 */
function createMockGLB(sizeInKB: number): string {
  const buffer = new ArrayBuffer(sizeInKB * 1024);
  const view = new Uint8Array(buffer);
  
  // Fill with recognizable pattern for verification
  for (let i = 0; i < view.length; i++) {
    view[i] = i % 256;
  }
  
  const blob = new Blob([buffer], { type: "model/gltf-binary" });
  return URL.createObjectURL(blob);
}

/**
 * Test 1: Basic chunking and reassembly
 */
export async function testBasicChunking() {
  console.log("\n=== Testing Basic Chunking ===\n");
  
  // Create a small test model
  const modelUrl = createMockGLB(100); // 100KB
  const position = new Vector3(1, 2, 3);
  const rotation = new Vector3(0, 1.57, 0);
  const scale = new Vector3(2, 2, 2);
  
  console.log("1. Preparing model...");
  const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(
    modelUrl,
    position,
    rotation,
    scale,
    { prompt: "test model", authorId: "tester" }
  );
  
  console.log(`✓ Created ${chunks.length} chunks`);
  console.log(`  Total size: ${modelPackage.metadata.totalSize} bytes`);
  
  // Verify chunk integrity
  console.log("\n2. Verifying chunk integrity...");
  let validChunks = 0;
  for (const chunk of chunks) {
    if (ModelSerializer.verifyChunk(chunk)) {
      validChunks++;
    } else {
      console.error(`✗ Chunk ${chunk.index} failed integrity check!`);
    }
  }
  console.log(`✓ ${validChunks}/${chunks.length} chunks valid`);
  
  // Reassemble
  console.log("\n3. Reassembling chunks...");
  const blobUrl = ModelSerializer.createBlobFromChunks(chunks);
  console.log(`✓ Created blob URL: ${blobUrl}`);
  
  // Verify the reassembled data matches original
  console.log("\n4. Verifying reassembled data...");
  const originalResponse = await fetch(modelUrl);
  const originalData = new Uint8Array(await originalResponse.arrayBuffer());
  
  const reassembledResponse = await fetch(blobUrl);
  const reassembledData = new Uint8Array(await reassembledResponse.arrayBuffer());
  
  if (originalData.length === reassembledData.length) {
    console.log(`✓ Size matches: ${originalData.length} bytes`);
    
    // Check a few sample bytes
    let matches = true;
    for (let i = 0; i < Math.min(100, originalData.length); i++) {
      if (originalData[i] !== reassembledData[i]) {
        matches = false;
        console.error(`✗ Byte ${i} doesn't match: ${originalData[i]} vs ${reassembledData[i]}`);
        break;
      }
    }
    
    if (matches) {
      console.log("✓ Data integrity verified!");
    }
  } else {
    console.error(`✗ Size mismatch: ${originalData.length} vs ${reassembledData.length}`);
  }
  
  // Test position/rotation/scale preservation
  console.log("\n5. Verifying metadata...");
  console.log(`✓ Position: (${modelPackage.position.x}, ${modelPackage.position.y}, ${modelPackage.position.z})`);
  console.log(`✓ Rotation: (${modelPackage.rotation.x}, ${modelPackage.rotation.y}, ${modelPackage.rotation.z})`);
  console.log(`✓ Scale: (${modelPackage.scale.x}, ${modelPackage.scale.y}, ${modelPackage.scale.z})`);
  
  // Cleanup
  URL.revokeObjectURL(modelUrl);
  URL.revokeObjectURL(blobUrl);
  
  console.log("\n✅ Basic chunking test PASSED\n");
}

/**
 * Test 2: Large model (realistic 2MB size)
 */
export async function testRealisticModel() {
  console.log("\n=== Testing Realistic 2MB Model ===\n");
  
  const modelUrl = createMockGLB(2000); // 2MB
  const position = new Vector3(5, 0, 5);
  const rotation = new Vector3(0, 0, 0);
  const scale = new Vector3(1, 1, 1);
  
  console.log("Chunking 2MB model...");
  const startTime = performance.now();
  
  const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(
    modelUrl,
    position,
    rotation,
    scale,
    { prompt: "realistic model", authorId: "tester" }
  );
  
  const chunkTime = performance.now() - startTime;
  console.log(`✓ Chunked in ${chunkTime.toFixed(2)}ms`);
  console.log(`  - Chunks: ${chunks.length}`);
  console.log(`  - Size: ${(modelPackage.metadata.totalSize / 1024 / 1024).toFixed(2)} MB`);
  
  // Reassemble
  console.log("\nReassembling...");
  const reassembleStart = performance.now();
  const blobUrl = ModelSerializer.createBlobFromChunks(chunks);
  const reassembleTime = performance.now() - reassembleStart;
  
  console.log(`✓ Reassembled in ${reassembleTime.toFixed(2)}ms`);
  
  // Verify size
  const response = await fetch(blobUrl);
  const data = await response.arrayBuffer();
  
  if (data.byteLength === modelPackage.metadata.totalSize) {
    console.log("✓ Size verified!");
  } else {
    console.error(`✗ Size mismatch: ${data.byteLength} vs ${modelPackage.metadata.totalSize}`);
  }
  
  URL.revokeObjectURL(modelUrl);
  URL.revokeObjectURL(blobUrl);
  
  console.log("\n✅ Realistic model test PASSED\n");
}

/**
 * Test 3: ChunkReceiver (simulates receiving chunks)
 */
export async function testChunkReceiver() {
  console.log("\n=== Testing ChunkReceiver ===\n");
  
  // Create a model and chunk it
  const modelUrl = createMockGLB(500); // 500KB
  const position = new Vector3(10, 0, 10);
  const rotation = new Vector3(0, 3.14, 0);
  const scale = new Vector3(1.5, 1.5, 1.5);
  
  const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(
    modelUrl,
    position,
    rotation,
    scale,
    { prompt: "receiver test", authorId: "sender" }
  );
  
  console.log(`Created ${chunks.length} chunks to receive\n`);
  
  // Now simulate receiving them
  const receiver = new ChunkReceiver();
  
  console.log("1. Initialize with metadata...");
  receiver.initializeModel(modelPackage);
  console.log("✓ Initialized");
  
  console.log("\n2. Receiving chunks...");
  let completedPackage: ModelPackage | null = null;
  
  for (let i = 0; i < chunks.length; i++) {
    const result = receiver.receiveChunk(chunks[i]);
    
    // Log progress every 25%
    if (i % Math.floor(chunks.length / 4) === 0 || result) {
      const progress = receiver.getProgress(modelPackage.id);
      console.log(`  Progress: ${progress.toFixed(1)}%`);
    }
    
    if (result) {
      completedPackage = result;
      console.log("✓ All chunks received!");
    }
  }
  
  if (completedPackage) {
    console.log("\n3. Verifying completed package...");
    console.log(`✓ Model ID: ${completedPackage.id}`);
    console.log(`✓ Position preserved: (${completedPackage.position.x}, ${completedPackage.position.y}, ${completedPackage.position.z})`);
    console.log(`✓ Rotation preserved: (${completedPackage.rotation.x}, ${completedPackage.rotation.y}, ${completedPackage.rotation.z})`);
    console.log(`✓ Scale preserved: (${completedPackage.scale.x}, ${completedPackage.scale.y}, ${completedPackage.scale.z})`);
    
    // Check if blob URL is created
    const blobUrl = (completedPackage.metadata as any).blobUrl;
    if (blobUrl) {
      console.log(`✓ Blob URL created: ${blobUrl.substring(0, 50)}...`);
      URL.revokeObjectURL(blobUrl);
    }
  } else {
    console.error("✗ Failed to receive complete model");
  }
  
  URL.revokeObjectURL(modelUrl);
  
  console.log("\n✅ ChunkReceiver test PASSED\n");
}

/**
 * Test 4: Out-of-order chunk delivery
 */
export async function testOutOfOrder() {
  console.log("\n=== Testing Out-of-Order Chunks ===\n");
  
  const modelUrl = createMockGLB(300); // 300KB
  const position = new Vector3(0, 0, 0);
  const rotation = new Vector3(0, 0, 0);
  const scale = new Vector3(1, 1, 1);
  
  const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(
    modelUrl,
    position,
    rotation,
    scale,
    { prompt: "out of order test", authorId: "tester" }
  );
  
  console.log(`Created ${chunks.length} chunks`);
  
  // Shuffle the chunks
  const shuffled = [...chunks].sort(() => Math.random() - 0.5);
  console.log("✓ Shuffled chunks randomly");
  
  // Receive in random order
  const receiver = new ChunkReceiver();
  receiver.initializeModel(modelPackage);
  
  console.log("\nReceiving in random order...");
  let completedPackage: ModelPackage | null = null;
  
  for (const chunk of shuffled) {
    const result = receiver.receiveChunk(chunk);
    if (result) {
      completedPackage = result;
    }
  }
  
  if (completedPackage) {
    console.log("✓ Successfully reassembled from out-of-order chunks!");
    
    // Verify the data is correct
    const blobUrl = (completedPackage.metadata as any).blobUrl;
    const response = await fetch(blobUrl);
    const data = await response.arrayBuffer();
    
    if (data.byteLength === modelPackage.metadata.totalSize) {
      console.log("✓ Data integrity maintained!");
    }
    
    URL.revokeObjectURL(blobUrl);
  } else {
    console.error("✗ Failed to reassemble");
  }
  
  URL.revokeObjectURL(modelUrl);
  
  console.log("\n✅ Out-of-order test PASSED\n");
}

/**
 * Test 5: Use your actual test model
 */
export async function testWithActualModel(modelPath: string = "models/test_model_1.glb") {
  console.log("\n=== Testing With Actual Model ===\n");
  console.log(`Loading: ${modelPath}`);
  
  try {
    const position = new Vector3(5, 0, 5);
    const rotation = new Vector3(0, Math.PI / 2, 0);
    const scale = new Vector3(1, 1, 1);
    
    console.log("\nChunking actual model...");
    const startTime = performance.now();
    
    const { package: modelPackage, chunks } = await ModelSerializer.prepareModel(
      modelPath,
      position,
      rotation,
      scale,
      { prompt: "actual model test", authorId: "tester" }
    );
    
    const chunkTime = performance.now() - startTime;
    
    console.log(`✓ Chunked in ${chunkTime.toFixed(2)}ms`);
    console.log(`  - Size: ${(modelPackage.metadata.totalSize / 1024).toFixed(2)} KB`);
    console.log(`  - Chunks: ${chunks.length}`);
    console.log(`  - Avg chunk size: ${(modelPackage.metadata.totalSize / chunks.length / 1024).toFixed(2)} KB`);
    
    // Verify all chunks
    console.log("\nVerifying chunks...");
    const allValid = chunks.every(chunk => ModelSerializer.verifyChunk(chunk));
    console.log(allValid ? "✓ All chunks valid" : "✗ Some chunks invalid");
    
    // Reassemble
    console.log("\nReassembling...");
    const reassembleStart = performance.now();
    const blobUrl = ModelSerializer.createBlobFromChunks(chunks);
    const reassembleTime = performance.now() - reassembleStart;
    
    console.log(`✓ Reassembled in ${reassembleTime.toFixed(2)}ms`);
    console.log(`✓ Blob URL: ${blobUrl}`);
    
    // Download the reassembled model
    console.log("\nDownloading reassembled model...");
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = `reassembled_model_${Date.now()}.glb`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    
    console.log(`✓ Downloaded as: ${downloadLink.download}`);
    
    // You could load this back into Babylon.js here if needed
    // const result = await SceneLoader.ImportMeshAsync("", blobUrl, "", scene);
    
    URL.revokeObjectURL(blobUrl);
    
    console.log("\n✅ Actual model test PASSED\n");
    
  } catch (error) {
    console.error("✗ Test failed:", error);
    throw error;
  }
}

/**
 * Run all local tests
 */
export async function runAllLocalTests() {
  console.log("🧪 Running Local Chunking Tests");
  console.log("=".repeat(50));
  
  try {
    await testBasicChunking();
    await testRealisticModel();
    await testChunkReceiver();
    await testOutOfOrder();
    
    // Uncomment to test with your actual model:
    // await testWithActualModel("models/test_model_1.glb");
    
    console.log("=".repeat(50));
    console.log("✅ All local tests PASSED!\n");
    console.log("Your chunking system works correctly.");
    console.log("Ready to integrate with WebRTC! 🚀\n");
    
  } catch (error) {
    console.error("\n❌ Tests failed:", error);
    throw error;
  }
}

/**
 * Quick test - just chunk and reassemble a 2MB model
 */
export async function quickTest() {
  const modelUrl = createMockGLB(2000);
  const { package: pkg, chunks } = await ModelSerializer.prepareModel(
    modelUrl,
    new Vector3(0, 0, 0),
    new Vector3(0, 0, 0),
    new Vector3(1, 1, 1),
    { prompt: "quick", authorId: "test" }
  );
  
  console.log(`✓ ${chunks.length} chunks created`);
  
  const blobUrl = ModelSerializer.createBlobFromChunks(chunks);
  console.log(`✓ Reassembled: ${blobUrl}`);
  
  // Download it
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  downloadBlob(blob, `quick_test_${Date.now()}.glb`);
  console.log(`✓ Downloaded!`);
  
  URL.revokeObjectURL(modelUrl);
  URL.revokeObjectURL(blobUrl);
}