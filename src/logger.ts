/**
 * Centralized logging utility with log levels
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private isDev: boolean;

  constructor() {
    this.isDev = import.meta.env.DEV || false;
  }

  debug(message: string, ...args: any[]): void {
    if (this.isDev) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    console.log(`[INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[WARN] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }

  // Specialized logging for P2P operations
  p2p(message: string, ...args: any[]): void {
    if (this.isDev) {
      console.log(`[P2P] ${message}`, ...args);
    }
  }

  // Specialized logging for WebRTC operations
  webrtc(message: string, ...args: any[]): void {
    if (this.isDev) {
      console.log(`[WebRTC] ${message}`, ...args);
    }
  }

  // Specialized logging for swarm operations
  swarm(message: string, ...args: any[]): void {
    if (this.isDev) {
      console.log(`[Swarm] ${message}`, ...args);
    }
  }
}

export const logger = new Logger();