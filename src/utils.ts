/**
 * Utility functions for bitfield operations and data encoding
 */

/**
 * Creates a bitfield from a set of chunk indices
 */
export function createBitfield(chunks: Set<number>, totalChunks: number): Uint8Array {
  const bitfield = new Uint8Array(Math.ceil(totalChunks / 8));
  chunks.forEach(idx => setBit(bitfield, idx));
  return bitfield;
}

/**
 * Sets a bit in the bitfield at the specified index
 */
export function setBit(bitfield: Uint8Array, index: number): void {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  bitfield[byteIndex] |= (1 << (7 - bitIndex));
}

/**
 * Checks if a bit is set in the bitfield at the specified index
 */
export function hasBit(bitfield: Uint8Array, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  return (bitfield[byteIndex] & (1 << (7 - bitIndex))) !== 0;
}

/**
 * Optimized ArrayBuffer to Base64 conversion
 * Uses spread operator for better performance with smaller chunks
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // For chunks under 64KB, spread operator is faster
  if (bytes.length < 65536) {
    return btoa(String.fromCharCode(...bytes));
  }
  // For larger chunks, use the loop method to avoid stack overflow
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Optimized Base64 to ArrayBuffer conversion
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}