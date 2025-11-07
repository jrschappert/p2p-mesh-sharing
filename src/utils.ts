export function createBitfield(chunks: Set<number>, totalChunks: number): Uint8Array {
  const bitfield = new Uint8Array(Math.ceil(totalChunks / 8));
  chunks.forEach(idx => setBit(bitfield, idx));
  return bitfield;
}

export function setBit(bitfield: Uint8Array, index: number) {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  bitfield[byteIndex] |= (1 << (7 - bitIndex));
}

export function hasBit(bitfield: Uint8Array, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  return (bitfield[byteIndex] & (1 << (7 - bitIndex))) !== 0;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}