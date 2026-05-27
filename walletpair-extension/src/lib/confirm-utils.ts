/**
 * Pure utility functions for the confirmation popup.
 * Extracted from confirm/App.svelte for testability.
 */

export function formatMethod(m: string): string {
  switch (m) {
    case 'eth_sendTransaction': return 'Send Transaction';
    case 'eth_signTransaction': return 'Sign Transaction';
    case 'personal_sign': return 'Sign Message';
    case 'eth_signTypedData_v4': return 'Sign Typed Data';
    case 'eth_signTypedData_v3': return 'Sign Typed Data';
    default: return m;
  }
}

export function formatValue(wei: string | undefined): string {
  if (!wei || wei === '0x0' || wei === '0x') return '0 ETH';
  const val = parseInt(wei, 16) / 1e18;
  return `${val.toFixed(6)} ETH`;
}

export function shortenAddr(addr: string | undefined): string {
  if (!addr) return 'Unknown';
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export function truncateHex(hex: string | undefined, max = 120): string {
  if (!hex) return '';
  if (hex.length <= max) return hex;
  return hex.slice(0, max) + '…';
}

export function tryDecodeHex(s: string | undefined): string {
  if (!s) return '';
  if (!s.startsWith('0x')) return s;
  try {
    const hex = s.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return s;
  }
}

export function formatTypedData(params: any): string {
  try {
    const data = typeof params === 'string' ? JSON.parse(params)
      : params?.data ? (typeof params.data === 'string' ? JSON.parse(params.data) : params.data)
      : params?.[1] ? (typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1])
      : params;
    if (data?.domain) {
      return `Domain: ${data.domain.name ?? 'Unknown'}\nType: ${data.primaryType ?? 'Unknown'}`;
    }
    return JSON.stringify(data, null, 2).slice(0, 300);
  } catch {
    return String(params).slice(0, 300);
  }
}
