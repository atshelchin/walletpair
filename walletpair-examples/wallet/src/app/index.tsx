import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import * as wp from '@/lib/walletpair';
import * as eth from '@/lib/eth';
import * as store from '@/lib/store';
// BLE Peripheral is lazy-loaded only when entering BLE mode.
// This avoids crashing in Expo Go where the native module isn't available.
type BlePeripheralTransport = import('@/lib/ble-peripheral').BlePeripheralTransport;
async function loadBlePeripheral() {
  const mod = await import('@/lib/ble-peripheral');
  return new mod.BlePeripheralTransport();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'closed';
interface PendingReq { id: string; method: string; params: Record<string, unknown> }
interface LogEntry { dir: 'in' | 'out' | 'err'; type: string; detail: string }

// Wallet capabilities (§7)
const WALLET_CAPABILITIES = {
  methods: ['wallet_getAccounts', 'wallet_signMessage'],
  events: ['accountsChanged', 'chainChanged'],
  chains: ['eip155:1'],
};
const WALLET_META = {
  name: 'WalletPair Mobile Wallet',
  description: 'WalletPair example mobile wallet',
  url: 'https://walletpair.dev',
  icon: 'https://walletpair.dev/icon.png',
};

// Mutable session state held in a ref (not React state — avoids stale closures in WS callbacks)
interface Session {
  channelId: string;
  privKey: Uint8Array;
  pubKeyB64: string;
  remotePubKey: Uint8Array | null;
  remotePubKeyB64: string;
  /** wallet→dApp traffic key */
  sendKey: Uint8Array | null;
  /** dApp→wallet traffic key */
  recvKey: Uint8Array | null;
  /** join encryption key (erased after first use) */
  joinEncKey: Uint8Array | null;
  sendSeq: number;
  recvSeq: number;
  relayUrl: string;
  ethKeyHex: string;
  ethAddr: string;
  dappName: string;
  evtCounter: number;
}

const BACKOFF = [1000, 2000, 5000, 10000, 30000];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletScreen() {
  const router = useRouter();
  const { uri } = useLocalSearchParams<{ uri?: string }>();

  // UI state (React state — triggers re-renders)
  const [ethKeyInput, setEthKeyInput] = useState('');
  const [ethAddr, setEthAddr] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pairingCode, setPairingCode] = useState('------');
  const [requests, setRequests] = useState<PendingReq[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Mutable refs (session state + transports)
  const session = useRef<Session | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bleRef = useRef<BlePeripheralTransport | null>(null);
  const transportRef = useRef<'ws' | 'ble'>('ws');
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);
  const phaseRef = useRef<Phase>('idle'); // mirror for callbacks

  // Keep phaseRef in sync
  const updatePhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const addLog = useCallback((dir: LogEntry['dir'], type: string, detail = '') => {
    setLogs(prev => [...prev.slice(-200), { dir, type, detail }]);
  }, []);

  // ---------------------------------------------------------------------------
  // ETH key management
  // ---------------------------------------------------------------------------

  const updateEthKey = useCallback((hex: string, persist = true) => {
    const clean = hex.replace(/^0x/, '').trim().toLowerCase();
    setEthKeyInput(clean);
    if (clean.length === 64 && /^[0-9a-f]+$/.test(clean)) {
      try {
        const addr = eth.privateKeyToAddress(clean);
        setEthAddr(addr);
        if (persist) store.saveEthKey(clean);
      } catch { setEthAddr(''); }
    } else {
      setEthAddr('');
    }
  }, []);

  const generateKey = useCallback(() => {
    const key = eth.generatePrivateKey();
    updateEthKey(key);
  }, [updateEthKey]);

  // Restore ETH key on mount (must complete before URI is processed)
  const [ethReady, setEthReady] = useState(false);
  useEffect(() => {
    store.loadEthKey().then(saved => {
      if (saved) updateEthKey(saved, false);
      setEthReady(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Persistence: save session
  // ---------------------------------------------------------------------------

  const saveSessionData = useCallback(async () => {
    const s = session.current;
    if (!s || !s.sendKey || !s.recvKey) return;
    await store.saveSession({
      channelId: s.channelId,
      privKeyHex: wp.bytesToHex(s.privKey),
      pubKeyB64: s.pubKeyB64,
      remotePubKeyB64: s.remotePubKeyB64,
      sendKeyHex: wp.bytesToHex(s.sendKey),
      recvKeyHex: wp.bytesToHex(s.recvKey),
      sendSeq: s.sendSeq,
      recvSeq: s.recvSeq,
      relayUrl: s.relayUrl,
      ethKeyHex: s.ethKeyHex,
      dappName: s.dappName,
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Send (dispatches to WS or BLE based on transport)
  // ---------------------------------------------------------------------------

  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    if (transportRef.current === 'ble') {
      bleRef.current?.sendMessage(msg);
    } else {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    }
    const t = msg.t as string;
    const detail = t === 'res' ? `id=${(msg.body as any)?.id}` : t === 'evt' ? `id=${(msg.body as any)?.id}` : '';
    addLog('out', t, detail);
  }, [addLog]);

  // ---------------------------------------------------------------------------
  // Build protocol-compliant join message (§8.2)
  // ---------------------------------------------------------------------------

  const buildJoinMessage = useCallback((s: Session, isReconnect: boolean): Record<string, unknown> => {
    let sealedJoin: string | null = null;
    if (!isReconnect && s.joinEncKey) {
      sealedJoin = wp.sealJoin(s.joinEncKey, s.channelId, WALLET_CAPABILITIES, WALLET_META);
      // §6.2: erase join_encryption_key after one-shot use
      s.joinEncKey.fill(0);
      s.joinEncKey = null;
    }
    return {
      v: 1, t: 'join', ch: s.channelId,
      ts: Date.now(), from: s.pubKeyB64,
      body: { sealed_join: sealedJoin },
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Send response (§4.3)
  // ---------------------------------------------------------------------------

  const sendResponse = useCallback((reqId: string, ok: boolean, data: unknown) => {
    const s = session.current;
    if (!s || !s.sendKey) return;
    // Per §4.3: success = { _ok: true, _result: <value> }
    //           error   = { _ok: false, code: "...", message: "..." }
    const sealedData = ok
      ? { _ok: true, _result: data }
      : { _ok: false, ...(data as Record<string, unknown>) };
    const sealed = wp.sealPayload(s.sendKey, s.channelId, s.sendSeq++, sealedData, 'res', s.pubKeyB64, reqId);
    sendRaw({
      v: 1, t: 'res', ch: s.channelId,
      ts: Date.now(), from: s.pubKeyB64,
      body: { id: reqId, sealed },
    });
    saveSessionData();
  }, [sendRaw, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  const handleMessage = useCallback((raw: string) => {
    const msg = JSON.parse(raw);
    const s = session.current!;

    // All messages should have body wrapper per §4.1
    const body = msg.body ?? {};

    switch (msg.t) {
      case 'ready':
        stopReconnect();
        if (body.state === 'waiting') {
          updatePhase('waiting');
          addLog('in', 'ready', 'state=waiting');
        } else if (body.state === 'connected') {
          // §15 rule 15: verify remote matches expected peer
          if (s.remotePubKeyB64 && body.remote !== s.remotePubKeyB64) {
            addLog('err', 'ready', 'remote mismatch — closing');
            sendRaw({
              v: 1, t: 'close', ch: s.channelId,
              ts: Date.now(), from: s.pubKeyB64,
              body: { reason: 'protocol_error' },
            });
            updatePhase('closed');
            break;
          }
          updatePhase('connected');
          addLog('in', 'ready', `state=connected remote=${(body.remote ?? '').slice(0, 12)}...`);
        }
        saveSessionData();
        break;

      case 'req': {
        if (!body.sealed || !body.id || !s.recvKey) {
          addLog('err', 'req', 'missing sealed or id');
          break;
        }
        try {
          // Unseal with AAD header (§6.4)
          const unsealed = wp.unsealPayload(s.recvKey, s.channelId, body.sealed, 'req', msg.from, body.id);
          if (unsealed.seq <= s.recvSeq) {
            addLog('err', 'seq', `rejected: seq ${unsealed.seq} <= last ${s.recvSeq}`);
            break;
          }
          s.recvSeq = unsealed.seq;
          const data = unsealed.data as Record<string, unknown>;

          // §4.3: _method is required in req
          if (typeof data._method !== 'string' || data._method.length === 0) {
            sendResponse(body.id, false, { code: 'invalid_params', message: 'Missing _method' });
            break;
          }
          const method = data._method as string;
          const { _method: _, ...params } = data;

          addLog('in', 'req', `${method} #${body.id}`);

          // Auto-echo for benchmark
          if (method === 'benchmark_echo' && s.sendKey) {
            const receivedSize = typeof params.data === 'string' ? (params.data as string).length : 0;
            sendResponse(body.id, true, { echo: true, receivedBytes: receivedSize, ts: Date.now() });
            addLog('out', 'res', `benchmark: received ${(receivedSize / 1024).toFixed(0)} KB`);
            break;
          }

          setRequests(prev => [...prev, { id: body.id, method, params }]);
        } catch {
          addLog('err', 'decrypt', `failed to decrypt req ${body.id}`);
        }
        break;
      }

      case 'ping':
        addLog('in', 'ping', '');
        sendRaw({ v: 1, t: 'pong', ch: s.channelId, ts: Date.now(), from: s.pubKeyB64, body: {} });
        break;

      case 'pong':
        addLog('in', 'pong', '');
        break;

      case 'close':
        addLog('err', 'close', `reason=${body.reason ?? msg.reason}`);
        if ((body.reason ?? msg.reason) === 'channel_not_found' && phaseRef.current !== 'closed') {
          addLog('in', 'reconnect', 'channel gone, waiting for dApp');
          wsRef.current?.close();
          startReconnect();
        } else if (phaseRef.current !== 'reconnecting') {
          updatePhase('closed');
          intentionalClose.current = true;
        }
        break;

      case 'terminate':
        addLog('err', 'terminate', `reason=${body.reason}`);
        if (phaseRef.current !== 'reconnecting') {
          updatePhase('closed');
          intentionalClose.current = true;
        }
        break;

      default:
        addLog('in', msg.t ?? '?', '');
    }
  }, [addLog, sendRaw, sendResponse, updatePhase, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Derive keys for a fresh pairing
  // ---------------------------------------------------------------------------

  const deriveSessionKeys = useCallback((
    kp: { privateKey: Uint8Array; publicKey: Uint8Array; publicKeyB64: string },
    parsed: wp.PairingParams,
  ) => {
    const remotePub = wp.b64urlDecode(parsed.pubkey);
    const shared = wp.computeSharedSecret(kp.privateKey, remotePub);
    const rootKey = wp.deriveRootKey(shared, parsed.ch);
    shared.fill(0); // erase shared_secret

    const transcriptHash = wp.computeTranscriptHash(
      parsed.ch,
      parsed.pubkey,         // dApp pubkey
      kp.publicKeyB64,       // wallet pubkey
      WALLET_CAPABILITIES,
      WALLET_META,
      parsed.name ?? '',
    );
    const keys = wp.deriveDirectionalKeys(rootKey, transcriptHash);
    const joinEncKey = wp.deriveJoinEncryptionKey(rootKey, parsed.ch);

    // Erase intermediates
    rootKey.fill(0);
    transcriptHash.fill(0);

    return {
      remotePub,
      sendKey: keys.walletToDappKey,
      recvKey: keys.dappToWalletKey,
      joinEncKey,
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Connect to relay and send join (used for fresh first-time connect)
  // ---------------------------------------------------------------------------

  const connectAndJoin = useCallback(() => {
    const s = session.current!;
    const ws = new WebSocket(s.relayUrl, 'walletpair.v1');
    wsRef.current = ws;

    ws.onopen = () => {
      updatePhase('waiting');
      sendRaw(buildJoinMessage(s, false));
    };

    ws.onmessage = (e) => handleMessage(typeof e.data === 'string' ? e.data : '');

    ws.onclose = () => {
      if (intentionalClose.current || phaseRef.current === 'closed') return;
      addLog('err', 'ws_close', 'transport disconnected');
      startReconnect();
    };

    ws.onerror = () => {};
  }, [addLog, buildJoinMessage, handleMessage, sendRaw, updatePhase]);

  // ---------------------------------------------------------------------------
  // Reconnect with backoff
  // ---------------------------------------------------------------------------

  const stopReconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const startReconnect = useCallback(() => {
    stopReconnect();
    if (intentionalClose.current || phaseRef.current === 'closed') return;
    updatePhase('reconnecting');
    let attempt = 0;

    function schedule() {
      if (intentionalClose.current || phaseRef.current === 'closed') return;
      const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      addLog('in', 'reconnect', `attempt ${attempt + 1} in ${delay}ms`);
      reconnectTimer.current = setTimeout(tryConnect, delay);
    }

    function tryConnect() {
      if (intentionalClose.current || phaseRef.current === 'closed') return;
      attempt++;

      const s = session.current;
      if (!s) return;

      let settled = false;

      const ws = new WebSocket(s.relayUrl, 'walletpair.v1');
      wsRef.current = ws;

      ws.onopen = () => {
        // §13: reconnect sends sealed_join=null
        sendRaw(buildJoinMessage(s, true));
      };

      ws.onmessage = (e) => {
        settled = true;
        ws.onmessage = (ev) => handleMessage(typeof ev.data === 'string' ? ev.data : '');
        ws.onclose = () => {
          if (intentionalClose.current || phaseRef.current === 'closed') return;
          addLog('err', 'ws_close', 'transport disconnected');
          startReconnect();
        };
        handleMessage(typeof e.data === 'string' ? e.data : '');
      };

      ws.onclose = () => {
        if (settled) return;
        if (intentionalClose.current || phaseRef.current === 'closed') return;
        schedule();
      };

      ws.onerror = () => {};
    }

    schedule();
  }, [addLog, buildJoinMessage, handleMessage, sendRaw, stopReconnect, updatePhase]);

  // ---------------------------------------------------------------------------
  // BLE: start Peripheral and wait for dApp to connect
  // ---------------------------------------------------------------------------

  const freshJoinBle = useCallback(async (parsed: wp.PairingParams) => {
    const kp = wp.generateX25519KeyPair();
    const derived = deriveSessionKeys(kp, parsed);
    setPairingCode(wp.computeSessionFingerprint(parsed.ch, parsed.pubkey));

    session.current = {
      channelId: parsed.ch,
      privKey: kp.privateKey,
      pubKeyB64: kp.publicKeyB64,
      remotePubKey: derived.remotePub,
      remotePubKeyB64: parsed.pubkey,
      sendKey: derived.sendKey,
      recvKey: derived.recvKey,
      joinEncKey: derived.joinEncKey,
      sendSeq: 0,
      recvSeq: -1,
      relayUrl: '',
      ethKeyHex: ethKeyInput,
      ethAddr,
      dappName: parsed.name ?? '',
      evtCounter: 0,
    };
    transportRef.current = 'ble';
    setRequests([]);

    const ble = await loadBlePeripheral();
    bleRef.current = ble;

    ble.onMessage((msg) => {
      try {
        handleMessage(JSON.stringify(msg));
      } catch (e: any) {
        addLog('err', 'ble', `message handler error: ${e?.message || String(e)}`);
      }
    });

    let bleHasJoined = false;

    ble.onConnected(() => {
      if (bleHasJoined) {
        addLog('in', 'ble', 'dApp reconnected');
        updatePhase('connected');
        return;
      }
      bleHasJoined = true;
      addLog('in', 'ble', 'dApp connected');
      const s = session.current!;
      sendRaw(buildJoinMessage(s, false));
    });

    ble.onDisconnected(() => {
      if (intentionalClose.current || phaseRef.current === 'closed') return;
      addLog('err', 'ble', 'dApp disconnected — still advertising, waiting for reconnect...');
      updatePhase('waiting');
    });

    try {
      if (Platform.OS === 'android') {
        const perms = [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ].filter(Boolean);

        for (const p of perms) {
          const has = await PermissionsAndroid.check(p);
          addLog('in', 'ble', `${p.split('.').pop()}: ${has ? 'granted' : 'not granted'}`);
        }

        const results = await PermissionsAndroid.requestMultiple(perms);
        const denied = Object.entries(results).filter(([, v]) => v !== 'granted');
        if (denied.length > 0) {
          const names = denied.map(([k, v]) => `${k.split('.').pop()}=${v}`).join(', ');
          addLog('err', 'ble', `denied: ${names}`);
          Alert.alert(
            'Bluetooth Permissions Required',
            `Denied: ${names}\n\nIf "never_ask_again", go to Settings > Apps > WalletPair > Permissions and grant Bluetooth + Location manually.\n\nAlso make sure you ran:\nnpx expo prebuild --clean\nnpx expo run:android`,
          );
          updatePhase('closed');
          return;
        }
        addLog('in', 'ble', 'all permissions granted');
      }

      const Device = require('expo-device') as typeof import('expo-device');
      const phoneName = Device.deviceName || Device.modelName || 'Phone';
      await ble.start(`WalletPair ${phoneName}`);
      updatePhase('waiting');
      addLog('in', 'ble', 'advertising... waiting for dApp');
    } catch (err: any) {
      const msg = err?.message || String(err);
      addLog('err', 'ble', `failed to start: ${msg}`);
      Alert.alert('BLE Error', msg);
      updatePhase('closed');
    }
  }, [ethKeyInput, ethAddr, addLog, buildJoinMessage, deriveSessionKeys, handleMessage, sendRaw, updatePhase]);

  // ---------------------------------------------------------------------------
  // Fresh join (from scanned URI — detects WS vs BLE)
  // ---------------------------------------------------------------------------

  const freshJoin = useCallback((pairingUri: string) => {
    if (!ethAddr || ethKeyInput.length !== 64) {
      Alert.alert('Wallet Required', 'Generate or enter an ETH private key first');
      return;
    }

    const parsed = wp.parsePairingUri(pairingUri);
    intentionalClose.current = false;

    // Detect BLE mode: no relay URL in the pairing URI
    if (!parsed.relay) {
      freshJoinBle(parsed);
      return;
    }

    // WebSocket mode
    transportRef.current = 'ws';
    const kp = wp.generateX25519KeyPair();
    const derived = deriveSessionKeys(kp, parsed);
    setPairingCode(wp.computeSessionFingerprint(parsed.ch, parsed.pubkey));

    session.current = {
      channelId: parsed.ch,
      privKey: kp.privateKey,
      pubKeyB64: kp.publicKeyB64,
      remotePubKey: derived.remotePub,
      remotePubKeyB64: parsed.pubkey,
      sendKey: derived.sendKey,
      recvKey: derived.recvKey,
      joinEncKey: derived.joinEncKey,
      sendSeq: 0,
      recvSeq: -1,
      relayUrl: parsed.relay,
      ethKeyHex: ethKeyInput,
      ethAddr,
      dappName: parsed.name ?? '',
      evtCounter: 0,
    };

    setRequests([]);
    connectAndJoin();
  }, [ethAddr, ethKeyInput, connectAndJoin, deriveSessionKeys, freshJoinBle]);

  // ---------------------------------------------------------------------------
  // Handle scanned URI from scan screen
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (ethReady && uri && typeof uri === 'string' && uri.startsWith('walletpair:')) {
      freshJoin(uri);
    }
  }, [uri, ethReady, freshJoin]);

  // ---------------------------------------------------------------------------
  // Restore session on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    (async () => {
      const saved = await store.loadSession();
      if (!saved) return;

      updateEthKey(saved.ethKeyHex);
      const { privKey, sendKey, recvKey } = store.hydrateCrypto(saved);

      session.current = {
        channelId: saved.channelId,
        privKey,
        pubKeyB64: saved.pubKeyB64,
        remotePubKey: saved.remotePubKeyB64 ? wp.b64urlDecode(saved.remotePubKeyB64) : null,
        remotePubKeyB64: saved.remotePubKeyB64,
        sendKey,
        recvKey,
        joinEncKey: null, // not needed for reconnect
        sendSeq: saved.sendSeq,
        recvSeq: saved.recvSeq, // §13: persist recvSeq across reconnects
        relayUrl: saved.relayUrl,
        ethKeyHex: saved.ethKeyHex,
        ethAddr: eth.privateKeyToAddress(saved.ethKeyHex),
        dappName: saved.dappName ?? '',
        evtCounter: 0,
      };

      setPairingCode(wp.computeSessionFingerprint(saved.channelId, saved.remotePubKeyB64 ?? ''));
      addLog('in', 'restore', `ch=${saved.channelId.slice(0, 12)}...`);
      startReconnect();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  const handleRequest = useCallback((reqId: string, approve: boolean) => {
    const s = session.current;
    if (!s || !s.sendKey) return;

    const req = requests.find(r => r.id === reqId);
    if (!req) return;

    if (approve) {
      let result: unknown;
      switch (req.method) {
        case 'wallet_getAccounts':
          result = { accounts: [{ address: s.ethAddr, chains: ['eip155:1'] }] };
          break;
        case 'wallet_signMessage':
          result = { signature: eth.personalSign(s.ethKeyHex, String(req.params.message ?? '')), address: s.ethAddr };
          break;
        default:
          result = { status: 'approved' };
      }
      sendResponse(reqId, true, result);
    } else {
      sendResponse(reqId, false, { code: 'user_rejected', message: 'User rejected the request' });
    }

    setRequests(prev => prev.filter(r => r.id !== reqId));
  }, [requests, sendResponse]);

  // ---------------------------------------------------------------------------
  // Push event (§10, §4.3)
  // ---------------------------------------------------------------------------

  const pushEvent = useCallback((eventName: string) => {
    const s = session.current;
    if (!s || !s.sendKey || phaseRef.current !== 'connected') return;
    const data = eventName === 'accountsChanged'
      ? { accounts: [{ address: s.ethAddr, chains: ['eip155:1'] }] }
      : { chain: 'eip155:1' };
    // §4.3: evt sealed payload = { _event: "<name>", ...data }
    const sealedData = { _event: eventName, ...data };
    const evtId = `evt-${++s.evtCounter}`;
    const sealed = wp.sealPayload(s.sendKey, s.channelId, s.sendSeq++, sealedData, 'evt', s.pubKeyB64, evtId);
    sendRaw({
      v: 1, t: 'evt', ch: s.channelId,
      ts: Date.now(), from: s.pubKeyB64,
      body: { id: evtId, sealed },
    });
    saveSessionData();
  }, [sendRaw, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Close / Reset
  // ---------------------------------------------------------------------------

  const doClose = useCallback(() => {
    intentionalClose.current = true;
    stopReconnect();
    const s = session.current;
    if (s) {
      sendRaw({
        v: 1, t: 'close', ch: s.channelId,
        ts: Date.now(), from: s.pubKeyB64,
        body: { reason: 'normal' },
      });
    }
    wsRef.current?.close();
    bleRef.current?.stop();
    bleRef.current = null;
    updatePhase('closed');
    store.clearSession();
  }, [sendRaw, stopReconnect, updatePhase]);

  const doReset = useCallback(() => {
    doClose();
    session.current = null;
    transportRef.current = 'ws';
    setRequests([]);
    setPairingCode('------');
    updatePhase('idle');
  }, [doClose, updatePhase]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isConnected = phase === 'connected';
  const isIdle = phase === 'idle';
  const dotColor = phase === 'connected' ? C.green : phase === 'closed' ? C.red
    : phase === 'idle' ? C.muted : C.amber;

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>WalletPair Wallet</Text>
          <View style={s.row}>
            <View style={[s.dot, { backgroundColor: dotColor }]} />
            <Text style={s.statusText}>{phase}</Text>
          </View>
        </View>

        {/* Wallet */}
        <View style={s.card}>
          <Text style={s.label}>EOA WALLET</Text>
          <View style={s.row}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              value={ethKeyInput}
              onChangeText={updateEthKey}
              placeholder="Private key (hex)"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={s.btn} onPress={generateKey}>
              <Text style={s.btnText}>Generate</Text>
            </TouchableOpacity>
          </View>
          {ethAddr ? <Text style={s.addr}>{ethAddr}</Text> : null}
        </View>

        {/* Pairing */}
        <View style={s.card}>
          <Text style={s.label}>PAIRING</Text>
          {isIdle ? (
            <View style={s.row}>
              <TouchableOpacity
                style={[s.btn, s.btnPrimary]}
                onPress={() => router.push('/scan')}
                disabled={!ethAddr}
              >
                <Text style={s.btnTextWhite}>Scan QR</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={s.codeLabel}>Session Fingerprint</Text>
              <Text style={s.code}>{pairingCode}</Text>
              <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={doReset}>
                <Text style={s.btnTextWhite}>Reset</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Incoming Requests */}
        {isConnected && (
          <View style={s.card}>
            <Text style={s.label}>INCOMING REQUESTS</Text>
            {requests.length === 0 ? (
              <Text style={s.muted}>No pending requests</Text>
            ) : (
              requests.map(req => (
                <View key={req.id} style={s.reqCard}>
                  <Text style={s.reqMethod}>{req.method} <Text style={s.muted}>#{req.id}</Text></Text>
                  <Text style={s.reqParams}>{JSON.stringify(req.params)}</Text>
                  <View style={s.row}>
                    <TouchableOpacity style={[s.btn, s.btnSuccess]} onPress={() => handleRequest(req.id, true)}>
                      <Text style={s.btnTextWhite}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={() => handleRequest(req.id, false)}>
                      <Text style={s.btnTextWhite}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* Push Events */}
        {isConnected && (
          <View style={s.card}>
            <Text style={s.label}>PUSH EVENT</Text>
            <View style={s.row}>
              <TouchableOpacity style={[s.btn, s.btnPrimary, { flex: 1 }]} onPress={() => pushEvent('accountsChanged')}>
                <Text style={s.btnTextWhite}>accountsChanged</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.btnPrimary, { flex: 1 }]} onPress={() => pushEvent('chainChanged')}>
                <Text style={s.btnTextWhite}>chainChanged</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={[s.btn, s.btnDanger, { marginTop: 8 }]} onPress={doClose}>
              <Text style={s.btnTextWhite}>Close Connection</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Log */}
        <View style={s.card}>
          <Text style={s.label}>LOG</Text>
          {logs.length === 0 ? (
            <Text style={s.muted}>No messages yet</Text>
          ) : (
            logs.slice(-50).map((entry, i) => (
              <View key={i} style={s.logRow}>
                <Text style={[s.logDir, entry.dir === 'out' ? s.logOut : entry.dir === 'in' ? s.logIn : s.logErr]}>
                  {entry.dir === 'out' ? '→' : entry.dir === 'in' ? '←' : '✕'}
                </Text>
                <Text style={s.logType}>{entry.type}</Text>
                <Text style={s.logDetail} numberOfLines={1}>{entry.detail}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Colors & Styles
// ---------------------------------------------------------------------------

const C = {
  bg: '#0d1117', surface: '#161b22', border: '#30363d', text: '#e6edf3',
  muted: '#8b949e', green: '#3fb950', amber: '#d29922', red: '#f85149', blue: '#58a6ff',
};

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { color: C.text, fontSize: 18, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: C.muted, fontSize: 13, textTransform: 'capitalize' },
  card: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 14, gap: 10 },
  label: { fontSize: 11, color: C.muted, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  input: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 6, color: C.text, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, fontFamily: 'monospace' },
  addr: { fontFamily: 'monospace', fontSize: 13, color: C.green },
  codeLabel: { color: C.muted, fontSize: 12, textAlign: 'center' },
  code: { fontFamily: 'monospace', fontSize: 32, fontWeight: '700', color: C.text, textAlign: 'center', letterSpacing: 6, paddingVertical: 8 },
  muted: { color: C.muted, fontSize: 13 },
  btn: { backgroundColor: C.border, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  btnPrimary: { backgroundColor: C.blue },
  btnSuccess: { backgroundColor: C.green },
  btnDanger: { backgroundColor: C.red },
  btnText: { color: C.text, fontSize: 13, fontWeight: '500' },
  btnTextWhite: { color: '#fff', fontSize: 13, fontWeight: '600' },
  reqCard: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 12, gap: 8 },
  reqMethod: { fontFamily: 'monospace', fontWeight: '700', color: C.text, fontSize: 14 },
  reqParams: { fontFamily: 'monospace', fontSize: 11, color: C.muted },
  logRow: { flexDirection: 'row', gap: 6, paddingVertical: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  logDir: { fontFamily: 'monospace', fontSize: 12, width: 14, textAlign: 'center' },
  logOut: { color: C.blue },
  logIn: { color: C.green },
  logErr: { color: C.red },
  logType: { fontFamily: 'monospace', fontSize: 12, color: C.text, fontWeight: '600' },
  logDetail: { fontFamily: 'monospace', fontSize: 12, color: C.muted, flex: 1 },
});
