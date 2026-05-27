/**
 * Exhaustive canonical JSON tests.
 *
 * Tests every edge case, boundary condition, and cross-implementation
 * compatibility concern for the canonicalJson function per protocol §6.2.
 *
 * Categories:
 * A. Key sorting (lexicographic UTF-16 / UTF-8)
 * B. Value types (null, boolean, number, string, array, object)
 * C. Number edge cases
 * D. String edge cases (unicode, escaping, surrogates)
 * E. Structural edge cases (nesting, empty, mixed)
 * F. undefined handling
 * G. Determinism and idempotency
 * H. Cross-implementation compatibility vectors
 */

import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex } from './crypto.js';

// ═══════════════════════════════════════════════════════════════════════
// A. Key sorting
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — key sorting', () => {
  it('sorts ASCII keys lexicographically', () => {
    expect(canonicalJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it('uppercase sorts before lowercase (UTF-16 order)', () => {
    // 'A' = 0x41, 'a' = 0x61 → 'A' < 'a'
    expect(canonicalJson({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  it('digits sort before letters', () => {
    // '0' = 0x30, 'A' = 0x41
    expect(canonicalJson({ a: 1, '0': 2 })).toBe('{"0":2,"a":1}');
  });

  it('empty string key sorts first', () => {
    expect(canonicalJson({ b: 2, '': 0, a: 1 })).toBe('{"":0,"a":1,"b":2}');
  });

  it('underscore sorts between uppercase Z and lowercase a', () => {
    // '_' = 0x5F, 'Z' = 0x5A, 'a' = 0x61
    expect(canonicalJson({ a: 1, _: 2, Z: 3 })).toBe('{"Z":3,"_":2,"a":1}');
  });

  it('numeric string keys sort lexicographically not numerically', () => {
    // "10" < "2" lexicographically because '1' < '2'
    expect(canonicalJson({ '2': 'b', '10': 'a', '1': 'c' })).toBe('{"1":"c","10":"a","2":"b"}');
  });

  it('sorts keys with common prefixes correctly', () => {
    expect(canonicalJson({ ab: 1, abc: 2, a: 3 })).toBe('{"a":3,"ab":1,"abc":2}');
  });

  it('handles single-key object', () => {
    expect(canonicalJson({ x: 1 })).toBe('{"x":1}');
  });

  it('already-sorted keys produce same output', () => {
    expect(canonicalJson({ a: 1, b: 2, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it('reverse-sorted keys are reordered', () => {
    expect(canonicalJson({ c: 3, b: 2, a: 1 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it('sorts unicode keys by UTF-16 code unit order', () => {
    // For BMP characters, UTF-16 and UTF-8 sort order match for ASCII
    // But for non-ASCII: é (U+00E9) vs ê (U+00EA) → é < ê
    expect(canonicalJson({ 'ê': 2, 'é': 1 })).toBe('{"é":1,"ê":2}');
  });

  it('handles keys with special JSON characters', () => {
    expect(canonicalJson({ 'a"b': 1, 'a\\c': 2 })).toBe('{"a\\"b":1,"a\\\\c":2}');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. Value types
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — value types', () => {
  it('null → "null"', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('true → "true"', () => {
    expect(canonicalJson(true)).toBe('true');
  });

  it('false → "false"', () => {
    expect(canonicalJson(false)).toBe('false');
  });

  it('integer → decimal string', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1)).toBe('-1');
  });

  it('string → quoted string', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  it('empty string → \'""\'', () => {
    expect(canonicalJson('')).toBe('""');
  });

  it('array → ordered elements', () => {
    expect(canonicalJson([1, 'two', null, true])).toBe('[1,"two",null,true]');
  });

  it('empty array → "[]"', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('empty object → "{}"', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('nested null in object', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('nested null in array', () => {
    expect(canonicalJson([null, null])).toBe('[null,null]');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. Number edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — numbers', () => {
  it('negative zero → "0"', () => {
    expect(canonicalJson(-0)).toBe('0');
    // Also in object context
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}');
  });

  it('floats use shortest representation', () => {
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(100.0)).toBe('100'); // no trailing .0
  });

  it('large integers', () => {
    expect(canonicalJson(1000000)).toBe('1000000');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  it('very small floats', () => {
    // JS serializes 5e-7 as "5e-7" and 0.000001 as "0.000001"
    expect(canonicalJson(0.000001)).toBe('0.000001');
  });

  it('scientific notation when JS uses it', () => {
    // JS uses scientific notation for very large/small numbers
    const result = canonicalJson(1e20);
    expect(result).toBe('100000000000000000000');
    // 1e21 triggers scientific notation in JS
    expect(canonicalJson(1e21)).toBe('1e+21');
  });

  it('NaN → "null" (JSON.stringify behavior)', () => {
    expect(canonicalJson(NaN)).toBe('null');
  });

  it('Infinity → "null" (JSON.stringify behavior)', () => {
    expect(canonicalJson(Infinity)).toBe('null');
    expect(canonicalJson(-Infinity)).toBe('null');
  });

  it('NaN and Infinity in objects → null values', () => {
    expect(canonicalJson({ a: NaN, b: Infinity })).toBe('{"a":null,"b":null}');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. String edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — strings', () => {
  // --- Control characters ---
  it('escapes all C0 control characters (U+0000–U+001F)', () => {
    // Tab, newline, carriage return use short form
    expect(canonicalJson('\t')).toBe('"\\t"');
    expect(canonicalJson('\n')).toBe('"\\n"');
    expect(canonicalJson('\r')).toBe('"\\r"');
    expect(canonicalJson('\b')).toBe('"\\b"');
    expect(canonicalJson('\f')).toBe('"\\f"');
  });

  it('escapes NUL character', () => {
    const result = canonicalJson('\x00');
    expect(result).toBe('"\\u0000"');
  });

  it('escapes other C0 controls with \\uXXXX', () => {
    // U+0001 through U+001F (excluding those with short forms)
    const result = canonicalJson('\x01');
    expect(result).toBe('"\\u0001"');
    expect(canonicalJson('\x1f')).toBe('"\\u001f"');
  });

  // --- Mandatory escapes ---
  it('escapes backslash', () => {
    expect(canonicalJson('\\')).toBe('"\\\\"');
  });

  it('escapes double quote', () => {
    expect(canonicalJson('"')).toBe('"\\""');
  });

  it('does NOT escape forward slash', () => {
    expect(canonicalJson('/')).toBe('"/"');
    expect(canonicalJson('a/b/c')).toBe('"a/b/c"');
  });

  // --- Unicode ---
  it('preserves non-ASCII Unicode as literal UTF-8', () => {
    expect(canonicalJson('中文')).toBe('"中文"');
    expect(canonicalJson('éàü')).toBe('"éàü"');
    expect(canonicalJson('日本語')).toBe('"日本語"');
  });

  it('handles emoji (supplementary plane)', () => {
    expect(canonicalJson('🔑')).toBe('"🔑"');
    expect(canonicalJson('👨‍👩‍👧')).toBe('"👨‍👩‍👧"');
  });

  it('handles mixed ASCII and non-ASCII', () => {
    expect(canonicalJson('hello 世界 🌍')).toBe('"hello 世界 🌍"');
  });

  // --- Long strings ---
  it('handles very long strings', () => {
    const long = 'x'.repeat(10000);
    const result = canonicalJson(long);
    expect(result).toBe(`"${long}"`);
    expect(result.length).toBe(10002); // quotes
  });

  // --- Strings that look like other types ---
  it('does not confuse string "null" with null', () => {
    expect(canonicalJson('null')).toBe('"null"');
  });

  it('does not confuse string "true" with true', () => {
    expect(canonicalJson('true')).toBe('"true"');
  });

  it('does not confuse string "123" with number', () => {
    expect(canonicalJson('123')).toBe('"123"');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. Structural edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — structural', () => {
  it('deeply nested objects (5 levels)', () => {
    const input = { a: { b: { c: { d: { e: 1 } } } } };
    expect(canonicalJson(input)).toBe('{"a":{"b":{"c":{"d":{"e":1}}}}}');
  });

  it('deeply nested arrays', () => {
    expect(canonicalJson([[[1]]])).toBe('[[[1]]]');
  });

  it('mixed array/object nesting with key sorting at each level', () => {
    const input = { z: [{ b: 2, a: 1 }], a: { y: [3], x: [1, 2] } };
    expect(canonicalJson(input)).toBe('{"a":{"x":[1,2],"y":[3]},"z":[{"a":1,"b":2}]}');
  });

  it('array of objects preserves array order but sorts each object', () => {
    const input = [{ z: 1, a: 2 }, { y: 3, b: 4 }];
    expect(canonicalJson(input)).toBe('[{"a":2,"z":1},{"b":4,"y":3}]');
  });

  it('object with many keys', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 26; i++) {
      obj[String.fromCharCode(122 - i)] = i; // z=0, y=1, ..., a=25
    }
    const result = canonicalJson(obj);
    // Should start with "a" and end with "z"
    expect(result.startsWith('{"a":25')).toBe(true);
    expect(result.endsWith('"z":0}')).toBe(true);
  });

  it('handles object with boolean, null, number, string, array, object values', () => {
    const input = { str: 'hello', num: 42, bool: true, nil: null, arr: [1], obj: { x: 1 } };
    expect(canonicalJson(input)).toBe(
      '{"arr":[1],"bool":true,"nil":null,"num":42,"obj":{"x":1},"str":"hello"}',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F. undefined handling
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — undefined behavior', () => {
  it('top-level undefined → "null"', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('undefined object values are omitted (matches JSON.stringify)', () => {
    // Keys with undefined values are omitted, matching JSON.stringify behavior
    // and RFC 8785 / I-JSON which have no concept of undefined
    const result = canonicalJson({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
    expect(result).not.toContain('"b"');
  });

  it('undefined in array → "null"', () => {
    // JSON.stringify([undefined]) → "[null]"
    expect(canonicalJson([undefined])).toBe('[null]');
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// G. No whitespace
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — no whitespace', () => {
  it('never contains spaces, tabs, or newlines in output', () => {
    const complex = {
      methods: ['wallet_signTransaction', 'wallet_signMessage'],
      events: ['accountsChanged', 'chainChanged'],
      chains: ['eip155:1', 'eip155:137'],
      meta: { name: 'My Wallet', description: 'A test wallet' },
    };
    const result = canonicalJson(complex);
    // Content strings may contain spaces, but structural whitespace should not exist
    // Remove string content to check structural whitespace
    const structural = result.replace(/"[^"]*"/g, '""');
    expect(structural).not.toMatch(/[\s]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// H. Determinism and idempotency
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — determinism', () => {
  it('output is idempotent (parsing output and re-serializing yields same result)', () => {
    const input = { z: [3, 1], a: { y: 'hello', x: true } };
    const first = canonicalJson(input);
    const reparsed = JSON.parse(first);
    const second = canonicalJson(reparsed);
    expect(second).toBe(first);
  });

  it('different insertion order produces same output', () => {
    const a: Record<string, number> = {};
    a.x = 1; a.a = 2; a.m = 3;

    const b: Record<string, number> = {};
    b.a = 2; b.m = 3; b.x = 1;

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('100 runs produce identical output', () => {
    const input = { z: 1, a: [{ c: 3, b: 2 }], m: null };
    const expected = canonicalJson(input);
    for (let i = 0; i < 100; i++) {
      expect(canonicalJson(input)).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// I. Cross-implementation compatibility vectors
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — protocol spec test vectors (all SHA-256 verified)', () => {
  function hash(s: string): string {
    return sha256Hex(new TextEncoder().encode(s));
  }

  it('vector 1: capabilities (key sorting, nested)', () => {
    const output = canonicalJson({
      methods: ['wallet_signTransaction', 'wallet_signMessage'],
      events: ['accountsChanged', 'chainChanged'],
      chains: ['eip155:1', 'eip155:137'],
    });
    const expected = '{"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]}';
    expect(output).toBe(expected);
    expect(hash(output)).toBe('4da366e2aae26b47b3d90fff52410752348733350ce2525dce7d64510f571333');
  });

  it('vector 2: join plaintext (nested objects + meta)', () => {
    const output = canonicalJson({
      capabilities: {
        methods: ['wallet_signTransaction', 'wallet_signMessage'],
        events: ['accountsChanged', 'chainChanged'],
        chains: ['eip155:1', 'eip155:137'],
      },
      meta: { name: 'MyWallet' },
    });
    const expected = '{"capabilities":{"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]},"meta":{"name":"MyWallet"}}';
    expect(output).toBe(expected);
    expect(hash(output)).toBe('925d92d0966ff5e0def4f998a1612bb12a402f14a684173b133ad39fe1bccfe9');
  });

  it('vector 3a: null', () => {
    const output = canonicalJson(null);
    expect(output).toBe('null');
    expect(hash(output)).toBe('74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b');
  });

  it('vector 3b: true', () => {
    const output = canonicalJson(true);
    expect(output).toBe('true');
    expect(hash(output)).toBe('b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b');
  });

  it('vector 3c: 42', () => {
    const output = canonicalJson(42);
    expect(output).toBe('42');
    expect(hash(output)).toBe('73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049');
  });

  it('vector 3d: "hello" (string)', () => {
    const output = canonicalJson('hello');
    expect(output).toBe('"hello"');
    expect(hash(output)).toBe('5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a');
  });

  it('vector 4a: empty object {}', () => {
    const output = canonicalJson({});
    expect(output).toBe('{}');
    expect(hash(output)).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('vector 4b: empty array []', () => {
    const output = canonicalJson([]);
    expect(output).toBe('[]');
    expect(hash(output)).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });

  it('vector 5: negative zero → 0', () => {
    const output = canonicalJson(-0);
    expect(output).toBe('0');
    expect(hash(output)).toBe('5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
  });

  it('vector 6: escaped control character (lowercase hex)', () => {
    const output = canonicalJson('\u0001');
    expect(output).toBe('"\\u0001"');
    expect(hash(output)).toBe('b81cfb0a6715e53b373345b49e8ad94eb55fd777519dc539373d0634973c186e');
  });
});

describe('canonicalJson — additional cross-implementation vectors', () => {
  it('empty capabilities with null meta', () => {
    const output = canonicalJson({ capabilities: { methods: [], events: [], chains: [] }, meta: null });
    expect(output).toBe('{"capabilities":{"chains":[],"events":[],"methods":[]},"meta":null}');
  });

  it('unicode key and value', () => {
    const output = canonicalJson({ name: '钱包', chains: ['eip155:1'] });
    expect(output).toBe('{"chains":["eip155:1"],"name":"钱包"}');
  });

  it('boolean and null mix with sorting', () => {
    const output = canonicalJson({ z: null, a: true, m: false });
    expect(output).toBe('{"a":true,"m":false,"z":null}');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// J. RFC 8785 compliance — specific requirements
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — RFC 8785 specific compliance', () => {
  // --- \uXXXX must be lowercase hex (RFC 8785 §3.2.2.2) ---
  it('\\u escapes use lowercase hex digits', () => {
    // U+0001 → \u0001 (not \u0001 with uppercase)
    const result = canonicalJson('\u0001');
    expect(result).toBe('"\\u0001"');
    expect(result).not.toMatch(/\\u[0-9a-f]*[A-F]/); // no uppercase hex digits
  });

  it('\\u001f uses lowercase f', () => {
    const result = canonicalJson('\u001f');
    expect(result).toBe('"\\u001f"');
    // Verify the 'f' is lowercase (0x66) not uppercase 'F' (0x46)
    expect(result.charAt(6)).toBe('f');
  });

  it('all C0 control characters (U+0000–U+001F) are properly escaped', () => {
    const shortForms: Record<number, string> = {
      0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r',
    };
    for (let cp = 0; cp <= 0x1f; cp++) {
      const result = canonicalJson(String.fromCharCode(cp));
      if (shortForms[cp]) {
        expect(result).toBe(`"${shortForms[cp]}"`);
      } else {
        const hex = cp.toString(16).padStart(4, '0');
        expect(result).toBe(`"\\u${hex}"`);
      }
    }
  });

  // --- Lone surrogates (ES2019 well-formed JSON.stringify) ---
  it('lone high surrogate is escaped as \\udXXX', () => {
    const result = canonicalJson('\uD800');
    expect(result).toBe('"\\ud800"');
  });

  it('lone low surrogate is escaped as \\udcXX', () => {
    const result = canonicalJson('\uDC00');
    expect(result).toBe('"\\udc00"');
  });

  it('valid surrogate pair (emoji) is NOT escaped', () => {
    // U+1F511 = 🔑 = \uD83D\uDD11 (surrogate pair)
    const result = canonicalJson('🔑');
    expect(result).toBe('"🔑"');
    expect(result).not.toContain('\\u');
  });

  // --- Number serialization matches ECMAScript Number.toString() ---
  it('1e20 outputs as full decimal (no scientific notation)', () => {
    expect(canonicalJson(1e20)).toBe('100000000000000000000');
  });

  it('1e21 uses scientific notation (JS threshold)', () => {
    expect(canonicalJson(1e21)).toBe('1e+21');
  });

  it('5e-7 uses scientific notation', () => {
    expect(canonicalJson(5e-7)).toBe('5e-7');
  });

  it('0.000001 uses decimal notation', () => {
    expect(canonicalJson(0.000001)).toBe('0.000001');
  });

  it('Number.MIN_VALUE in scientific notation', () => {
    expect(canonicalJson(Number.MIN_VALUE)).toBe('5e-324');
  });

  it('Number.MAX_SAFE_INTEGER preserves precision', () => {
    expect(canonicalJson(9007199254740991)).toBe('9007199254740991');
  });

  // --- Duplicate key handling ---
  it('JSON.parse deduplicates keys (last value wins)', () => {
    // This tests that our implementation handles the JS-level dedup correctly.
    // True duplicate rejection requires a custom JSON parser, which is out of scope
    // for the SDK (implementers using other languages must reject at parse time).
    const input = JSON.parse('{"a":1,"b":2,"a":3}');
    expect(canonicalJson(input)).toBe('{"a":3,"b":2}');
  });

  // --- Output encoding ---
  it('output bytes are valid UTF-8', () => {
    const output = canonicalJson({ name: '钱包', emoji: '🔑' });
    const bytes = new TextEncoder().encode(output);
    // TextEncoder always produces UTF-8
    // Verify round-trip
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(decoded).toBe(output);
  });

  it('output has no BOM', () => {
    const output = canonicalJson({ test: true });
    const bytes = new TextEncoder().encode(output);
    // UTF-8 BOM = EF BB BF
    expect(bytes[0]).not.toBe(0xef);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// K. Protocol-specific: sealed payload uses canonical JSON
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — seal/unseal round-trip proves canonical encoding', () => {
  it('object with unsorted keys round-trips correctly through seal/unseal', async () => {
    // This proves that sealPayload uses canonicalJson internally,
    // and unsealPayload returns the canonical form
    const { sealPayload, unsealPayload } = await import('./crypto.js');
    const key = new Uint8Array(32).fill(0xdd);
    const ch = 'ee'.repeat(32);

    // Input has keys in reverse order
    const input = { z: 1, a: 2, m: 3 };
    const sealed = sealPayload(key, ch, 0, input);
    const { data, plaintextJson } = unsealPayload(key, ch, sealed);

    // Data round-trips correctly
    expect(data).toEqual(input);
    // The plaintext inside the ciphertext is canonical JSON
    expect(plaintextJson).toBe('{"a":2,"m":3,"z":1}');
  });
});
