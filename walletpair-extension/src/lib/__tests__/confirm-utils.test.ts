import { describe, it, expect } from 'vitest';
import {
  formatMethod,
  formatValue,
  shortenAddr,
  truncateHex,
  tryDecodeHex,
  formatTypedData,
} from '../confirm-utils.js';

// ── formatMethod ────────────────────────────────────────────────────

describe('formatMethod', () => {
  it('maps known methods to human labels', () => {
    expect(formatMethod('eth_sendTransaction')).toBe('Send Transaction');
    expect(formatMethod('eth_signTransaction')).toBe('Sign Transaction');
    expect(formatMethod('personal_sign')).toBe('Sign Message');
    expect(formatMethod('eth_signTypedData_v4')).toBe('Sign Typed Data');
    expect(formatMethod('eth_signTypedData_v3')).toBe('Sign Typed Data');
  });

  it('returns raw method name for unknown methods', () => {
    expect(formatMethod('eth_call')).toBe('eth_call');
    expect(formatMethod('')).toBe('');
  });
});

// ── formatValue ─────────────────────────────────────────────────────

describe('formatValue', () => {
  it('returns 0 ETH for zero/empty values', () => {
    expect(formatValue(undefined)).toBe('0 ETH');
    expect(formatValue('0x0')).toBe('0 ETH');
    expect(formatValue('0x')).toBe('0 ETH');
    expect(formatValue('')).toBe('0 ETH');
  });

  it('converts wei hex to ETH', () => {
    // 1 ETH = 0xDE0B6B3A7640000
    expect(formatValue('0xDE0B6B3A7640000')).toBe('1.000000 ETH');
  });

  it('handles small values', () => {
    // 1 wei = 0x1
    expect(formatValue('0x1')).toBe('0.000000 ETH');
  });

  it('handles large values', () => {
    // 10 ETH = 0x8AC7230489E80000
    expect(formatValue('0x8AC7230489E80000')).toBe('10.000000 ETH');
  });
});

// ── shortenAddr ─────────────────────────────────────────────────────

describe('shortenAddr', () => {
  it('returns Unknown for undefined/empty', () => {
    expect(shortenAddr(undefined)).toBe('Unknown');
  });

  it('shortens a standard Ethereum address', () => {
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    expect(shortenAddr(addr)).toBe('0xd8dA6B...A96045');
  });

  it('handles short strings gracefully', () => {
    // slice(0,8) + ... + slice(-6) on short strings overlaps
    expect(shortenAddr('0x123')).toBe('0x123...0x123');
  });
});

// ── truncateHex ─────────────────────────────────────────────────────

describe('truncateHex', () => {
  it('returns empty for undefined', () => {
    expect(truncateHex(undefined)).toBe('');
  });

  it('returns full string if within limit', () => {
    expect(truncateHex('0xabcdef')).toBe('0xabcdef');
  });

  it('truncates long strings', () => {
    const long = '0x' + 'ab'.repeat(100);
    const result = truncateHex(long, 20);
    expect(result.length).toBe(21); // 20 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects custom max parameter', () => {
    expect(truncateHex('0x1234567890', 5)).toBe('0x123…');
  });
});

// ── tryDecodeHex ────────────────────────────────────────────────────

describe('tryDecodeHex', () => {
  it('returns empty for undefined/empty', () => {
    expect(tryDecodeHex(undefined)).toBe('');
    expect(tryDecodeHex('')).toBe('');
  });

  it('returns non-hex strings as-is', () => {
    expect(tryDecodeHex('Hello World')).toBe('Hello World');
  });

  it('decodes hex-encoded UTF-8 string', () => {
    // "Hello" in hex = 48656c6c6f
    expect(tryDecodeHex('0x48656c6c6f')).toBe('Hello');
  });

  it('decodes longer messages', () => {
    // "Sign this message" encoded
    const msg = 'Sign this message';
    const hex = '0x' + Array.from(new TextEncoder().encode(msg))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    expect(tryDecodeHex(hex)).toBe(msg);
  });

  it('returns original on malformed hex gracefully', () => {
    // Odd length hex — parseInt will produce NaN for some pairs but shouldn't throw
    const result = tryDecodeHex('0xZZZZ');
    expect(typeof result).toBe('string');
  });

  it('handles empty hex payload', () => {
    expect(tryDecodeHex('0x')).toBe('');
  });
});

// ── formatTypedData ─────────────────────────────────────────────────

describe('formatTypedData', () => {
  it('formats domain + primaryType from object', () => {
    const data = {
      domain: { name: 'MyDApp', version: '1' },
      primaryType: 'Mail',
      types: {},
      message: {},
    };
    expect(formatTypedData(data)).toBe('Domain: MyDApp\nType: Mail');
  });

  it('formats from JSON string', () => {
    const data = JSON.stringify({
      domain: { name: 'TestDApp' },
      primaryType: 'Order',
    });
    expect(formatTypedData(data)).toBe('Domain: TestDApp\nType: Order');
  });

  it('formats from params.data (string)', () => {
    const params = {
      data: JSON.stringify({
        domain: { name: 'Nested' },
        primaryType: 'Permit',
      }),
    };
    expect(formatTypedData(params)).toBe('Domain: Nested\nType: Permit');
  });

  it('formats from params.data (object)', () => {
    const params = {
      data: {
        domain: { name: 'Direct' },
        primaryType: 'Transfer',
      },
    };
    expect(formatTypedData(params)).toBe('Domain: Direct\nType: Transfer');
  });

  it('formats from params[1] (MetaMask style)', () => {
    const params = [
      '0xaddr',
      JSON.stringify({
        domain: { name: 'MMStyle' },
        primaryType: 'Swap',
      }),
    ];
    expect(formatTypedData(params)).toBe('Domain: MMStyle\nType: Swap');
  });

  it('falls back to JSON.stringify for non-domain data', () => {
    const data = { foo: 'bar' };
    const result = formatTypedData(data);
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
  });

  it('truncates large JSON to 300 chars', () => {
    const data = { longField: 'x'.repeat(500) };
    const result = formatTypedData(data);
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it('handles invalid JSON string gracefully', () => {
    const result = formatTypedData('not valid json {{{');
    expect(typeof result).toBe('string');
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it('handles null/undefined gracefully', () => {
    expect(typeof formatTypedData(null)).toBe('string');
    expect(typeof formatTypedData(undefined)).toBe('string');
  });

  it('handles domain without name', () => {
    const data = { domain: {}, primaryType: 'Test' };
    expect(formatTypedData(data)).toBe('Domain: Unknown\nType: Test');
  });
});
