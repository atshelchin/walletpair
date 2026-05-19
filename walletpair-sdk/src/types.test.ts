import { describe, it, expect } from 'vitest';
import {
  parseChainId,
  formatChainId,
  evmChainId,
  evmNumericChainId,
} from './types.js';

describe('parseChainId', () => {
  it('parses eip155:1', () => {
    const { namespace, reference } = parseChainId('eip155:1');
    expect(namespace).toBe('eip155');
    expect(reference).toBe('1');
  });

  it('parses solana:mainnet', () => {
    const { namespace, reference } = parseChainId('solana:mainnet');
    expect(namespace).toBe('solana');
    expect(reference).toBe('mainnet');
  });

  it('parses cosmos:cosmoshub-4', () => {
    const { namespace, reference } = parseChainId('cosmos:cosmoshub-4');
    expect(namespace).toBe('cosmos');
    expect(reference).toBe('cosmoshub-4');
  });

  it('throws on missing reference', () => {
    expect(() => parseChainId('eip155')).toThrow('Invalid CAIP-2');
  });

  it('throws on empty string', () => {
    expect(() => parseChainId('')).toThrow('Invalid CAIP-2');
  });

  it('throws on just a colon', () => {
    expect(() => parseChainId(':')).toThrow('Invalid CAIP-2');
  });
});

describe('formatChainId', () => {
  it('formats eip155 + 1', () => {
    expect(formatChainId('eip155', '1')).toBe('eip155:1');
  });

  it('formats solana + mainnet', () => {
    expect(formatChainId('solana', 'mainnet')).toBe('solana:mainnet');
  });

  it('round-trips with parseChainId', () => {
    const caip2 = 'eip155:137';
    const { namespace, reference } = parseChainId(caip2);
    expect(formatChainId(namespace, reference)).toBe(caip2);
  });
});

describe('evmChainId', () => {
  it('converts numeric chain ID to CAIP-2', () => {
    expect(evmChainId(1)).toBe('eip155:1');
    expect(evmChainId(137)).toBe('eip155:137');
    expect(evmChainId(42161)).toBe('eip155:42161');
  });
});

describe('evmNumericChainId', () => {
  it('extracts numeric ID from eip155: prefix', () => {
    expect(evmNumericChainId('eip155:1')).toBe(1);
    expect(evmNumericChainId('eip155:137')).toBe(137);
    expect(evmNumericChainId('eip155:42161')).toBe(42161);
  });

  it('returns null for non-eip155 chains', () => {
    expect(evmNumericChainId('solana:mainnet')).toBeNull();
    expect(evmNumericChainId('cosmos:cosmoshub-4')).toBeNull();
  });

  it('round-trips with evmChainId', () => {
    for (const id of [1, 5, 10, 56, 137, 42161]) {
      expect(evmNumericChainId(evmChainId(id))).toBe(id);
    }
  });
});
