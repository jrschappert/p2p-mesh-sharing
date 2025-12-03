/**
 * Centralized logging utility with log levels
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  debug(message: string, ...args: any[]): void {
    console.log(`[DEBUG] ${message}`, ...args);
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

  p2p(message: string, ...args: any[]): void {
    console.log(`[P2P] ${message}`, ...args);
  }

  webrtc(message: string, ...args: any[]): void {
    console.log(`[WebRTC] ${message}`, ...args);
  }

  swarm(message: string, ...args: any[]): void {
    console.log(`[Swarm] ${message}`, ...args);
  }
}

export const logger = new Logger();