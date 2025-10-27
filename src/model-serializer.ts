import { Vector3 } from "@babylonjs/core/Maths/math";

/**
 * Represents a serialized model ready for network transmission
 */
export interface ModelPackage {
  id: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  metadata: {
    prompt?: string;
    timestamp: number;
    authorId: string;
    totalSize: number;
    totalChunks: number;
  };
}

/**
 * Represents a single chunk of model data
 */
export interface ModelChunk {
  modelId: string;
  index: number;
  total: number;
  data: ArrayBuffer;
  checksum: number; // Simple checksum for integrity
}

/**
 * Message types for the network protocol
 */
export enum MessageType {
  MODEL_METADATA = "MODEL_METADATA",
  MODEL_CHUNK = "MODEL_CHUNK",
  CHUNK_ACK = "CHUNK_ACK",
  REQUEST_MISSING_CHUNKS = "REQUEST_MISSING_CHUNKS",
}

export interface NetworkMessage {
  type: MessageType;
  payload: any;
}

/**
 * Handles serialization and chunking of 3D models for P2P transmission
 */
export class ModelSerializer {
  // 15KB chunks to stay safely under WebRTC's 16KB limit
  private static readonly CHUNK_SIZE = 15 * 1024;

  /**
   * Fetches a model from URL and prepares it for transmission
   * @param modelUrl - URL or blob URL of the GLB model
   * @param position - Position in 3D space
   * @param rotation - Rotation in 3D space
   * @param scale - Scale in 3D space
   * @param metadata - Additional metadata (prompt, author, etc.)
   */
  static async prepareModel(
    modelUrl: string,
    position: Vector3,
    rotation: Vector3,
    scale: Vector3,
    metadata: Partial<ModelPackage["metadata"]>
  ): Promise<{ package: ModelPackage; chunks: ModelChunk[] }> {
    // Fetch the GLB file
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch model: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const modelData = new Uint8Array(arrayBuffer);

    // Generate unique ID for this model
    const modelId = this.generateModelId();

    // Create the metadata package
    const totalChunks = Math.ceil(modelData.byteLength / this.CHUNK_SIZE);
    const modelPackage: ModelPackage = {
      id: modelId,
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
      scale: { x: scale.x, y: scale.y, z: scale.z },
      metadata: {
        prompt: metadata.prompt,
        timestamp: Date.now(),
        authorId: metadata.authorId || "unknown",
        totalSize: modelData.byteLength,
        totalChunks,
      },
    };

    // Split into chunks
    const chunks = this.createChunks(modelId, modelData, totalChunks);

    return { package: modelPackage, chunks };
  }

  /**
   * Splits model data into chunks for transmission
   */
  private static createChunks(
    modelId: string,
    data: Uint8Array,
    totalChunks: number
  ): ModelChunk[] {
    const chunks: ModelChunk[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, data.byteLength);
      const chunkData = data.slice(start, end);

      chunks.push({
        modelId,
        index: i,
        total: totalChunks,
        data: chunkData.buffer,
        checksum: this.calculateChecksum(chunkData),
      });
    }

    return chunks;
  }

  /**
   * Simple checksum for chunk integrity verification
   * Uses Adler-32 style algorithm for speed
   */
  private static calculateChecksum(data: Uint8Array): number {
    let a = 1;
    let b = 0;
    const MOD = 65521;

    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % MOD;
      b = (b + a) % MOD;
    }

    return (b << 16) | a;
  }

  /**
   * Verifies chunk integrity
   */
  static verifyChunk(chunk: ModelChunk): boolean {
    const calculatedChecksum = this.calculateChecksum(
      new Uint8Array(chunk.data)
    );
    return calculatedChecksum === chunk.checksum;
  }

  /**
   * Generates a unique model ID
   */
  private static generateModelId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 11);
    return `${timestamp}-${random}`;
  }

  /**
   * Creates a Blob URL from model chunks (for loading into Babylon.js)
   */
  static createBlobFromChunks(chunks: ModelChunk[]): string {
    // Sort chunks by index to ensure correct order
    const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);

    // Calculate total size
    const totalSize = sortedChunks.reduce(
      (sum, chunk) => sum + chunk.data.byteLength,
      0
    );

    // Reassemble the data
    const reassembled = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of sortedChunks) {
      reassembled.set(new Uint8Array(chunk.data), offset);
      offset += chunk.data.byteLength;
    }

    // Create blob and return URL
    const blob = new Blob([reassembled], { type: "model/gltf-binary" });
    return URL.createObjectURL(blob);
  }
}

/**
 * Manages incoming model chunks and tracks assembly progress
 */
export class ChunkReceiver {
  private pendingModels = new Map<
    string,
    {
      package: ModelPackage;
      receivedChunks: Map<number, ModelChunk>;
      totalChunks: number;
    }
  >();

  /**
   * Initialize a new model transfer with metadata
   */
  initializeModel(modelPackage: ModelPackage): void {
    if (this.pendingModels.has(modelPackage.id)) {
      console.warn(`Model ${modelPackage.id} already initialized`);
      return;
    }

    this.pendingModels.set(modelPackage.id, {
      package: modelPackage,
      receivedChunks: new Map(),
      totalChunks: modelPackage.metadata.totalChunks,
    });

    console.log(
      `Initialized model ${modelPackage.id} (${modelPackage.metadata.totalChunks} chunks)`
    );
  }

  /**
   * Process an incoming chunk
   * @returns The complete model package if all chunks received, null otherwise
   */
  receiveChunk(chunk: ModelChunk): ModelPackage | null {
    // Verify the model has been initialized
    if (!this.pendingModels.has(chunk.modelId)) {
      console.error(`Received chunk for unknown model: ${chunk.modelId}`);
      return null;
    }

    // Verify chunk integrity
    if (!ModelSerializer.verifyChunk(chunk)) {
      console.error(
        `Chunk ${chunk.index} failed integrity check for model ${chunk.modelId}`
      );
      return null;
    }

    const pending = this.pendingModels.get(chunk.modelId)!;

    // Check for duplicate chunks
    if (pending.receivedChunks.has(chunk.index)) {
      console.warn(
        `Duplicate chunk ${chunk.index} for model ${chunk.modelId}`
      );
      return null;
    }

    // Store the chunk
    pending.receivedChunks.set(chunk.index, chunk);

    console.log(
      `Received chunk ${chunk.index + 1}/${chunk.total} for model ${chunk.modelId} (${this.getProgress(chunk.modelId).toFixed(1)}%)`
    );

    // Check if all chunks received
    if (pending.receivedChunks.size === pending.totalChunks) {
      return this.finalizeModel(chunk.modelId);
    }

    return null;
  }

  /**
   * Finalize and return complete model
   */
  private finalizeModel(modelId: string): ModelPackage {
    const pending = this.pendingModels.get(modelId)!;

    // Convert chunks map to array
    const chunks = Array.from(pending.receivedChunks.values());

    // Create blob URL
    const blobUrl = ModelSerializer.createBlobFromChunks(chunks);

    console.log(`Model ${modelId} complete! Blob URL: ${blobUrl}`);

    // Clean up
    this.pendingModels.delete(modelId);

    // Return the package with the blob URL stored in a non-standard field
    // The consumer will need to handle loading this
    return {
      ...pending.package,
      metadata: {
        ...pending.package.metadata,
        blobUrl, // Add blob URL to metadata for easy access
      } as any,
    };
  }

  /**
   * Get download progress for a model (0-100)
   */
  getProgress(modelId: string): number {
    const pending = this.pendingModels.get(modelId);
    if (!pending) return 0;

    return (pending.receivedChunks.size / pending.totalChunks) * 100;
  }

  /**
   * Get list of missing chunk indices for a model
   */
  getMissingChunks(modelId: string): number[] {
    const pending = this.pendingModels.get(modelId);
    if (!pending) return [];

    const missing: number[] = [];
    for (let i = 0; i < pending.totalChunks; i++) {
      if (!pending.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  /**
   * Check if a model transfer is complete
   */
  isComplete(modelId: string): boolean {
    return !this.pendingModels.has(modelId);
  }

  /**
   * Cancel and clean up a pending model transfer
   */
  cancelTransfer(modelId: string): void {
    this.pendingModels.delete(modelId);
    console.log(`Cancelled transfer for model ${modelId}`);
  }

  /**
   * Get all pending model IDs
   */
  getPendingModelIds(): string[] {
    return Array.from(this.pendingModels.keys());
  }
}
