/**
 * Polyfill globalThis.crypto for Hermes (React Native JS engine).
 *
 * Noble crypto libraries and our own code use crypto.getRandomValues().
 * Hermes does not provide it. expo-crypto bridges to the native CSPRNG.
 *
 * Import this file ONCE at the app entry point (_layout.tsx) before
 * any crypto code runs.
 */

import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto === 'undefined') {
  // @ts-expect-error — partial polyfill, only what noble needs
  globalThis.crypto = { getRandomValues };
} else if (!globalThis.crypto.getRandomValues) {
  // @ts-expect-error — attach to existing object
  globalThis.crypto.getRandomValues = getRandomValues;
}
