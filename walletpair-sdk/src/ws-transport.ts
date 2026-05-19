/**
 * WebSocket transport for WalletPair protocol.
 *
 * Works in browsers, Node.js 22+, Deno, Bun — anything with a global WebSocket.
 */

import type { Transport, TransportState, ProtocolMessage } from './types.js';

export interface WebSocketTransportOptions {
  url: string;
  protocols?: string[];
}

export class WebSocketTransport implements Transport {
  state: TransportState = 'disconnected';

  private ws: WebSocket | null = null;
  private url: string;
  private protocols: string[];

  private messageHandler: ((msg: ProtocolMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private openHandler: (() => void) | null = null;

  constructor(options: WebSocketTransportOptions | string) {
    if (typeof options === 'string') {
      this.url = options;
      this.protocols = ['walletpair.v1'];
    } else {
      this.url = options.url;
      this.protocols = options.protocols ?? ['walletpair.v1'];
    }
  }

  onMessage(handler: (msg: ProtocolMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onOpen(handler: () => void): void { this.openHandler = handler; }

  /** Update the relay URL (useful for reconnect to a different relay). */
  setUrl(url: string): void {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.state = 'connecting';
      const ws = new WebSocket(this.url, this.protocols);

      ws.onopen = () => {
        this.state = 'connected';
        this.ws = ws;
        this.openHandler?.();
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.messageHandler) {
          try { this.messageHandler(JSON.parse(event.data as string)); } catch { /* bad json */ }
        }
      };

      ws.onclose = () => {
        const wasConnected = this.state === 'connected';
        this.state = 'disconnected';
        this.ws = null;
        if (wasConnected) {
          this.closeHandler?.();
        } else {
          reject(new Error('WebSocket connection failed'));
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror, which handles the reject
      };
    });
  }

  send(msg: ProtocolMessage): void {
    if (!this.ws || this.state !== 'connected') return;
    this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
  }
}
