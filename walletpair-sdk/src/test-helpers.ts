/**
 * Shared test helpers — mock transport for unit testing sessions.
 */

import type { Transport, TransportState, ProtocolMessage } from './types.js';

/**
 * In-memory transport for testing. Two MockTransports can be linked
 * to simulate a relay (messages sent on one arrive on the other).
 */
export class MockTransport implements Transport {
  state: TransportState = 'disconnected';
  sent: ProtocolMessage[] = [];

  private messageHandler: ((msg: ProtocolMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private openHandler: (() => void) | null = null;

  /** Link to the peer's transport. */
  peer: MockTransport | null = null;

  onMessage(handler: (msg: ProtocolMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onOpen(handler: () => void): void { this.openHandler = handler; }

  async connect(): Promise<void> {
    this.state = 'connected';
    this.openHandler?.();
  }

  send(msg: ProtocolMessage): void {
    this.sent.push(msg);
    // Deliver to peer asynchronously (simulates relay)
    if (this.peer) {
      const peer = this.peer;
      queueMicrotask(() => peer.receive(msg));
    }
  }

  disconnect(): void {
    this.state = 'disconnected';
  }

  /** Simulate receiving a message from the relay. */
  receive(msg: ProtocolMessage): void {
    this.messageHandler?.(msg);
  }

  /** Simulate transport close (disconnect from relay). */
  simulateClose(): void {
    this.state = 'disconnected';
    this.closeHandler?.();
  }
}

/**
 * Create a pair of linked mock transports.
 * Messages sent on dapp arrive on wallet and vice versa.
 */
export function createLinkedTransports(): { dapp: MockTransport; wallet: MockTransport } {
  const dapp = new MockTransport();
  const wallet = new MockTransport();
  dapp.peer = wallet;
  wallet.peer = dapp;
  return { dapp, wallet };
}

/**
 * Simulate the relay's role: when dApp sends "create", respond with "ready.waiting".
 * When wallet sends "join", forward to dApp and respond with "ready.waiting".
 * When dApp sends "accept", respond with "ready.connected" to both.
 */
export class MockRelay {
  private dappTransport: MockTransport;
  private walletTransport: MockTransport;

  constructor(dapp: MockTransport, wallet: MockTransport) {
    this.dappTransport = dapp;
    this.walletTransport = wallet;

    // Intercept sends and inject relay behavior
    const origDappSend = dapp.send.bind(dapp);
    dapp.send = (msg: ProtocolMessage) => {
      origDappSend(msg);
      this.handleDappMessage(msg);
    };

    const origWalletSend = wallet.send.bind(wallet);
    wallet.send = (msg: ProtocolMessage) => {
      origWalletSend(msg);
      this.handleWalletMessage(msg);
    };

    // Don't forward to peer directly — relay controls message flow
    dapp.peer = null;
    wallet.peer = null;
  }

  private handleDappMessage(msg: ProtocolMessage): void {
    if (msg.t === 'create') {
      queueMicrotask(() => {
        this.dappTransport.receive({
          v: 1, t: 'ready', ch: msg.ch,
          ts: Date.now(), from: '_adapter',
          body: { state: 'waiting', resume: 'dapp-resume-token', remote: null },
        } as ProtocolMessage);
      });
    } else if (msg.t === 'accept') {
      queueMicrotask(() => {
        const target = (msg.body as any).target;
        this.dappTransport.receive({
          v: 1, t: 'ready', ch: msg.ch,
          ts: Date.now(), from: '_adapter',
          body: { state: 'connected', resume: 'dapp-resume-token-2', remote: target },
        } as ProtocolMessage);
        this.walletTransport.receive({
          v: 1, t: 'ready', ch: msg.ch,
          ts: Date.now(), from: '_adapter',
          body: { state: 'connected', resume: 'wallet-resume-token-2', remote: msg.from },
        } as ProtocolMessage);
      });
    } else if (msg.t === 'req') {
      // Forward to wallet
      queueMicrotask(() => this.walletTransport.receive(msg));
    } else if (msg.t === 'ping') {
      // Forward to wallet
      queueMicrotask(() => this.walletTransport.receive(msg));
    } else if (msg.t === 'close') {
      queueMicrotask(() => this.walletTransport.receive(msg));
    }
  }

  private handleWalletMessage(msg: ProtocolMessage): void {
    if (msg.t === 'join') {
      queueMicrotask(() => {
        // Relay sends ready.waiting to wallet
        this.walletTransport.receive({
          v: 1, t: 'ready', ch: msg.ch,
          ts: Date.now(), from: '_adapter',
          body: { state: 'waiting', resume: 'wallet-resume-token', remote: null },
        } as ProtocolMessage);
        // Relay forwards join to dApp
        this.dappTransport.receive(msg);
      });
    } else if (msg.t === 'res') {
      // Forward to dApp
      queueMicrotask(() => this.dappTransport.receive(msg));
    } else if (msg.t === 'evt') {
      queueMicrotask(() => this.dappTransport.receive(msg));
    } else if (msg.t === 'pong') {
      queueMicrotask(() => this.dappTransport.receive(msg));
    } else if (msg.t === 'close') {
      queueMicrotask(() => this.dappTransport.receive(msg));
    }
  }
}
