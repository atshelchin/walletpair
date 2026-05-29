/**
 * WalletPair Protocol v1 — Section 14 state machine transitions.
 *
 * Verifies that the dApp and wallet state machines accept valid
 * transitions, reject invalid ones, and handle reconnect and race
 * conditions correctly per the specification.
 */

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// State machine model (pure functions, no SDK dependency)
// ---------------------------------------------------------------------------

type DAppState = 'idle' | 'waiting' | 'pending_accept' | 'connected' | 'disconnected' | 'closed'
type WalletState = 'idle' | 'waiting_accept' | 'connected' | 'disconnected' | 'closed'

type DAppEvent =
  | 'send_create'
  | 'receive_join'
  | 'sealed_join_verified_send_accept'
  | 'user_rejects_send_close'
  | 'receive_ready_connected'
  | 'receive_close'
  | 'receive_terminate'
  | 'timeout'
  | 'transport_disconnected'
  | 'send_create_reconnect'
  | 'receive_channel_exists'
  | 'session_expired'
  | 'give_up'

type WalletEvent =
  | 'send_join'
  | 'receive_ready_connected'
  | 'receive_close'
  | 'receive_terminate'
  | 'timeout'
  | 'transport_disconnected'
  | 'send_join_reconnect'
  | 'receive_channel_not_found'
  | 'session_expired'
  | 'give_up'

/** DApp state machine per Section 14. */
function dappTransition(state: DAppState, event: DAppEvent): DAppState | null {
  switch (state) {
    case 'idle':
      if (event === 'send_create') return 'waiting'
      return null
    case 'waiting':
      if (event === 'receive_join') return 'pending_accept'
      if (event === 'receive_close' || event === 'receive_terminate') return 'closed'
      if (event === 'timeout') return 'closed'
      return null
    case 'pending_accept':
      if (event === 'sealed_join_verified_send_accept') return 'connected'
      if (event === 'user_rejects_send_close') return 'closed'
      if (event === 'receive_terminate') return 'closed'
      if (event === 'timeout') return 'closed'
      return null
    case 'connected':
      if (event === 'receive_close' || event === 'receive_terminate') return 'closed'
      if (event === 'transport_disconnected') return 'disconnected'
      if (event === 'session_expired') return 'closed'
      return null
    case 'disconnected':
      if (event === 'send_create_reconnect') return 'waiting'
      if (event === 'receive_channel_exists') return 'disconnected'
      if (event === 'session_expired') return 'closed'
      if (event === 'give_up') return 'closed'
      return null
    case 'closed':
      return null // terminal state
  }
}

/** Wallet state machine per Section 14. */
function walletTransition(state: WalletState, event: WalletEvent): WalletState | null {
  switch (state) {
    case 'idle':
      if (event === 'send_join') return 'waiting_accept'
      return null
    case 'waiting_accept':
      if (event === 'receive_ready_connected') return 'connected'
      if (event === 'receive_close' || event === 'receive_terminate') return 'closed'
      if (event === 'timeout') return 'closed'
      return null
    case 'connected':
      if (event === 'receive_close' || event === 'receive_terminate') return 'closed'
      if (event === 'transport_disconnected') return 'disconnected'
      if (event === 'session_expired') return 'closed'
      return null
    case 'disconnected':
      if (event === 'send_join_reconnect') return 'waiting_accept'
      if (event === 'receive_channel_not_found') return 'disconnected'
      if (event === 'session_expired') return 'closed'
      if (event === 'give_up') return 'closed'
      return null
    case 'closed':
      return null // terminal state
  }
}

// ---------------------------------------------------------------------------
// DApp state machine tests
// ---------------------------------------------------------------------------

describe('Section 14 — DApp state machine', () => {
  describe('valid transitions: idle -> waiting -> pending_accept -> connected -> closed', () => {
    it('full happy path', () => {
      let state: DAppState = 'idle'
      state = dappTransition(state, 'send_create') ?? 'closed'
      expect(state).toBe('waiting')
      state = dappTransition(state, 'receive_join') ?? 'closed'
      expect(state).toBe('pending_accept')
      state = dappTransition(state, 'sealed_join_verified_send_accept') ?? 'closed'
      expect(state).toBe('connected')
    })

    it('close from connected', () => {
      expect(dappTransition('connected', 'receive_close')).toBe('closed')
    })

    it('terminate from connected', () => {
      expect(dappTransition('connected', 'receive_terminate')).toBe('closed')
    })

    it('session expiry from connected', () => {
      expect(dappTransition('connected', 'session_expired')).toBe('closed')
    })
  })

  describe('invalid transitions are rejected', () => {
    it('cannot receive join in idle', () => {
      expect(dappTransition('idle', 'receive_join')).toBeNull()
    })

    it('cannot send create in waiting', () => {
      expect(dappTransition('waiting', 'send_create')).toBeNull()
    })

    it('cannot send create in pending_accept', () => {
      expect(dappTransition('pending_accept', 'send_create')).toBeNull()
    })

    it('cannot receive join in pending_accept', () => {
      expect(dappTransition('pending_accept', 'receive_join')).toBeNull()
    })

    it('cannot send create in connected', () => {
      expect(dappTransition('connected', 'send_create')).toBeNull()
    })

    it('closed is terminal — all events rejected', () => {
      const events: DAppEvent[] = [
        'send_create',
        'receive_join',
        'sealed_join_verified_send_accept',
        'receive_close',
        'receive_terminate',
        'timeout',
        'transport_disconnected',
        'send_create_reconnect',
      ]
      for (const event of events) {
        expect(dappTransition('closed', event)).toBeNull()
      }
    })
  })

  describe('close and timeout paths', () => {
    it('waiting -> close on receive_close', () => {
      expect(dappTransition('waiting', 'receive_close')).toBe('closed')
    })

    it('waiting -> closed on timeout', () => {
      expect(dappTransition('waiting', 'timeout')).toBe('closed')
    })

    it('pending_accept -> closed on user_rejects_send_close', () => {
      expect(dappTransition('pending_accept', 'user_rejects_send_close')).toBe('closed')
    })

    it('pending_accept -> closed on timeout', () => {
      expect(dappTransition('pending_accept', 'timeout')).toBe('closed')
    })
  })

  describe('reconnect: disconnected -> waiting with same ch', () => {
    it('transport disconnect moves to disconnected', () => {
      expect(dappTransition('connected', 'transport_disconnected')).toBe('disconnected')
    })

    it('send_create_reconnect from disconnected goes to waiting', () => {
      expect(dappTransition('disconnected', 'send_create_reconnect')).toBe('waiting')
    })

    it('session expiry from disconnected goes to closed', () => {
      expect(dappTransition('disconnected', 'session_expired')).toBe('closed')
    })

    it('give up from disconnected goes to closed', () => {
      expect(dappTransition('disconnected', 'give_up')).toBe('closed')
    })
  })

  describe('race condition: channel_exists handling', () => {
    it('receive_channel_exists stays in disconnected (transient failure)', () => {
      expect(dappTransition('disconnected', 'receive_channel_exists')).toBe('disconnected')
    })
  })
})

// ---------------------------------------------------------------------------
// Wallet state machine tests
// ---------------------------------------------------------------------------

describe('Section 14 — Wallet state machine', () => {
  describe('valid transitions: idle -> waiting_accept -> connected -> closed', () => {
    it('full happy path', () => {
      let state: WalletState = 'idle'
      state = walletTransition(state, 'send_join') ?? 'closed'
      expect(state).toBe('waiting_accept')
      state = walletTransition(state, 'receive_ready_connected') ?? 'closed'
      expect(state).toBe('connected')
    })

    it('close from connected', () => {
      expect(walletTransition('connected', 'receive_close')).toBe('closed')
    })

    it('terminate from connected', () => {
      expect(walletTransition('connected', 'receive_terminate')).toBe('closed')
    })
  })

  describe('invalid transitions are rejected', () => {
    it('cannot receive_ready_connected in idle', () => {
      expect(walletTransition('idle', 'receive_ready_connected')).toBeNull()
    })

    it('cannot send_join in waiting_accept', () => {
      expect(walletTransition('waiting_accept', 'send_join')).toBeNull()
    })

    it('cannot send_join in connected', () => {
      expect(walletTransition('connected', 'send_join')).toBeNull()
    })

    it('closed is terminal — all events rejected', () => {
      const events: WalletEvent[] = [
        'send_join',
        'receive_ready_connected',
        'receive_close',
        'receive_terminate',
        'timeout',
        'transport_disconnected',
        'send_join_reconnect',
      ]
      for (const event of events) {
        expect(walletTransition('closed', event)).toBeNull()
      }
    })
  })

  describe('close and timeout paths', () => {
    it('waiting_accept -> closed on receive_close', () => {
      expect(walletTransition('waiting_accept', 'receive_close')).toBe('closed')
    })

    it('waiting_accept -> closed on timeout', () => {
      expect(walletTransition('waiting_accept', 'timeout')).toBe('closed')
    })
  })

  describe('reconnect: disconnected -> waiting_accept with same ch', () => {
    it('transport disconnect moves to disconnected', () => {
      expect(walletTransition('connected', 'transport_disconnected')).toBe('disconnected')
    })

    it('send_join_reconnect from disconnected goes to waiting_accept', () => {
      expect(walletTransition('disconnected', 'send_join_reconnect')).toBe('waiting_accept')
    })

    it('session expiry from disconnected goes to closed', () => {
      expect(walletTransition('disconnected', 'session_expired')).toBe('closed')
    })

    it('give up from disconnected goes to closed', () => {
      expect(walletTransition('disconnected', 'give_up')).toBe('closed')
    })
  })

  describe('race condition: channel_not_found handling', () => {
    it('receive_channel_not_found stays in disconnected (transient failure)', () => {
      expect(walletTransition('disconnected', 'receive_channel_not_found')).toBe('disconnected')
    })
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting state machine properties
// ---------------------------------------------------------------------------

describe('Section 14 — Cross-cutting properties', () => {
  it('closed is terminal for dApp — no outgoing transitions', () => {
    const allDappEvents: DAppEvent[] = [
      'send_create',
      'receive_join',
      'sealed_join_verified_send_accept',
      'user_rejects_send_close',
      'receive_ready_connected',
      'receive_close',
      'receive_terminate',
      'timeout',
      'transport_disconnected',
      'send_create_reconnect',
      'receive_channel_exists',
      'session_expired',
      'give_up',
    ]
    for (const event of allDappEvents) {
      expect(dappTransition('closed', event)).toBeNull()
    }
  })

  it('closed is terminal for wallet — no outgoing transitions', () => {
    const allWalletEvents: WalletEvent[] = [
      'send_join',
      'receive_ready_connected',
      'receive_close',
      'receive_terminate',
      'timeout',
      'transport_disconnected',
      'send_join_reconnect',
      'receive_channel_not_found',
      'session_expired',
      'give_up',
    ]
    for (const event of allWalletEvents) {
      expect(walletTransition('closed', event)).toBeNull()
    }
  })

  it('reconnect path reuses the full handshake flow (create/join/accept)', () => {
    // DApp: disconnected -> waiting (via create) -> pending_accept (via join) -> connected
    let dapp: DAppState = 'disconnected'
    dapp = dappTransition(dapp, 'send_create_reconnect') ?? 'closed'
    expect(dapp).toBe('waiting')
    dapp = dappTransition(dapp, 'receive_join') ?? 'closed'
    expect(dapp).toBe('pending_accept')
    dapp = dappTransition(dapp, 'sealed_join_verified_send_accept') ?? 'closed'
    expect(dapp).toBe('connected')

    // Wallet: disconnected -> waiting_accept (via join) -> connected
    let wallet: WalletState = 'disconnected'
    wallet = walletTransition(wallet, 'send_join_reconnect') ?? 'closed'
    expect(wallet).toBe('waiting_accept')
    wallet = walletTransition(wallet, 'receive_ready_connected') ?? 'closed'
    expect(wallet).toBe('connected')
  })

  it('race condition recovery: multiple channel_exists before successful reconnect', () => {
    let state: DAppState = 'disconnected'
    // Multiple transient failures
    state = dappTransition(state, 'receive_channel_exists') ?? 'closed'
    expect(state).toBe('disconnected')
    state = dappTransition(state, 'receive_channel_exists') ?? 'closed'
    expect(state).toBe('disconnected')
    // Eventually succeeds
    state = dappTransition(state, 'send_create_reconnect') ?? 'closed'
    expect(state).toBe('waiting')
  })

  it('race condition recovery: multiple channel_not_found before wallet reconnects', () => {
    let state: WalletState = 'disconnected'
    // Multiple transient failures
    state = walletTransition(state, 'receive_channel_not_found') ?? 'closed'
    expect(state).toBe('disconnected')
    state = walletTransition(state, 'receive_channel_not_found') ?? 'closed'
    expect(state).toBe('disconnected')
    // Eventually succeeds
    state = walletTransition(state, 'send_join_reconnect') ?? 'closed'
    expect(state).toBe('waiting_accept')
  })
})
