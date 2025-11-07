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
