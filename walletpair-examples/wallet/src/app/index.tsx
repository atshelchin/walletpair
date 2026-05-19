import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'closed';
interface PendingReq { id: string; method: string; params: Record<string, unknown> }
interface LogEntry { dir: 'in' | 'out' | 'err'; type: string; detail: string }

// Mutable session state held in a ref (not React state — avoids stale closures in WS callbacks)
interface Session {
  channelId: string;
  privKey: Uint8Array;
  pubKeyB64: string;
  remotePubKey: Uint8Array | null;
  sessionKey: Uint8Array | null;
  sendSeq: number;
  resumeToken: string | null;
  relayUrl: string;
  ethKeyHex: string;
  ethAddr: string;
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

  // Mutable refs (session state + WebSocket)
  const session = useRef<Session | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);
  const phaseRef = useRef<Phase>('idle'); // mirror for WS callbacks

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

  const updateEthKey = useCallback((hex: string) => {
    const clean = hex.replace(/^0x/, '').trim().toLowerCase();
    setEthKeyInput(clean);
    if (clean.length === 64 && /^[0-9a-f]+$/.test(clean)) {
      try {
        const addr = eth.privateKeyToAddress(clean);
        setEthAddr(addr);
      } catch { setEthAddr(''); }
    } else {
      setEthAddr('');
    }
  }, []);

  const generateKey = useCallback(() => {
    const key = eth.generatePrivateKey();
    updateEthKey(key);
  }, [updateEthKey]);

  // ---------------------------------------------------------------------------
  // Persistence: save session
  // ---------------------------------------------------------------------------

  const saveSessionData = useCallback(async () => {
    const s = session.current;
    if (!s || !s.sessionKey) return;
    await store.saveSession({
      channelId: s.channelId,
      privKeyHex: wp.bytesToHex(s.privKey),
      pubKeyB64: s.pubKeyB64,
      remotePubKeyB64: s.remotePubKey ? wp.b64urlEncode(s.remotePubKey) : '',
      sessionKeyHex: wp.bytesToHex(s.sessionKey),
      sendSeq: s.sendSeq,
      resumeToken: s.resumeToken,
      relayUrl: s.relayUrl,
      ethKeyHex: s.ethKeyHex,
    });
  }, []);

  // ---------------------------------------------------------------------------
  // WebSocket send
  // ---------------------------------------------------------------------------

  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
    const t = msg.t as string;
    const detail = t === 'res' ? `id=${msg.id} ok=${msg.ok}` : t === 'evt' ? `event=${msg.event}` : '';
    addLog('out', t, detail);
  }, [addLog]);

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  const handleMessage = useCallback((raw: string) => {
    const msg = JSON.parse(raw);
    const s = session.current!;

    switch (msg.t) {
      case 'ready':
        s.resumeToken = msg.resume;
        stopReconnect();
        if (msg.state === 'waiting') {
          updatePhase('waiting');
          addLog('in', 'ready', 'state=waiting');
        } else if (msg.state === 'connected') {
          updatePhase('connected');
          addLog('in', 'ready', `state=connected remote=${(msg.remote ?? '').slice(0, 12)}...`);
        }
        saveSessionData();
        break;

      case 'req': {
        let params: Record<string, unknown> = {};
        if (msg.sealed && s.sessionKey) {
          try { params = wp.unsealPayload(s.sessionKey, s.channelId, msg.sealed).data as Record<string, unknown>; }
          catch { addLog('err', 'decrypt', `failed to decrypt req ${msg.id}`); }
        }
        addLog('in', 'req', `${msg.method} #${msg.id}`);
        setRequests(prev => [...prev, { id: msg.id, method: msg.method, params }]);
        break;
      }

      case 'ping':
        addLog('in', 'ping', '');
        sendRaw({ v: 1, t: 'pong', ch: s.channelId, from: s.pubKeyB64, ts: Date.now() });
        break;

      case 'pong':
        addLog('in', 'pong', '');
        break;

      case 'close':
        addLog('err', 'close', `reason=${msg.reason}`);
        if (msg.reason === 'invalid_resume' && phaseRef.current !== 'closed') {
          s.resumeToken = null;
          addLog('in', 'reconnect', 'resume rejected, re-joining');
          wsRef.current?.close();
          connectAndJoin(false);
        } else if (msg.reason === 'channel_not_found' && phaseRef.current !== 'closed') {
          addLog('in', 'reconnect', 'channel gone, waiting for dApp');
          wsRef.current?.close();
          startReconnect();
        } else if (phaseRef.current !== 'reconnecting') {
          updatePhase('closed');
          intentionalClose.current = true;
        }
        break;

      default:
        addLog('in', msg.t ?? '?', '');
    }
  }, [addLog, sendRaw, updatePhase, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Connect to relay and send join (used for fresh first-time connect)
  // ---------------------------------------------------------------------------

  const connectAndJoin = useCallback((useResume: boolean) => {
    const s = session.current!;
    const ws = new WebSocket(s.relayUrl, 'walletpair.v1');
    wsRef.current = ws;

    ws.onopen = () => {
      updatePhase('waiting');
      const msg: Record<string, unknown> = {
        v: 1, t: 'join', ch: s.channelId,
        from: s.pubKeyB64, pubkey: s.pubKeyB64,
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        meta: { name: 'WalletPair Mobile Wallet', address: s.ethAddr },
      };
      if (useResume && s.resumeToken) msg.resume = s.resumeToken;
      sendRaw(msg);
    };

    ws.onmessage = (e) => handleMessage(typeof e.data === 'string' ? e.data : '');

    ws.onclose = () => {
      if (intentionalClose.current || phaseRef.current === 'closed') return;
      addLog('err', 'ws_close', 'transport disconnected');
      startReconnect();
    };

    ws.onerror = () => {};
  }, [addLog, handleMessage, sendRaw, updatePhase]);

  // ---------------------------------------------------------------------------
  // Reconnect with backoff
  //
  // Self-contained loop: each attempt creates a new WebSocket. On failure
  // (onclose fires before any message arrives), schedules the next attempt.
  // Once a message arrives, switches to normal mode (connectAndJoin handlers).
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
      const useResume = attempt === 0 && !!session.current?.resumeToken;
      attempt++;

      const s = session.current;
      if (!s) return;

      let settled = false; // true once we receive a message from the relay

      const ws = new WebSocket(s.relayUrl, 'walletpair.v1');
      wsRef.current = ws;

      ws.onopen = () => {
        const msg: Record<string, unknown> = {
          v: 1, t: 'join', ch: s.channelId,
          from: s.pubKeyB64, pubkey: s.pubKeyB64,
          capabilities: {
            methods: ['wallet_getAccounts', 'wallet_signMessage'],
            events: ['accountsChanged', 'chainChanged'],
            chains: ['eip155:1'],
          },
        };
        if (useResume) msg.resume = s.resumeToken;
        sendRaw(msg);
      };

      ws.onmessage = (e) => {
        settled = true;
        // Reconnect succeeded — switch to normal handlers
        ws.onmessage = (ev) => handleMessage(typeof ev.data === 'string' ? ev.data : '');
        ws.onclose = () => {
          if (intentionalClose.current || phaseRef.current === 'closed') return;
          addLog('err', 'ws_close', 'transport disconnected');
          startReconnect();
        };
        // Process this first message through the normal handler
        handleMessage(typeof e.data === 'string' ? e.data : '');
      };

      ws.onclose = () => {
        if (settled) return; // already handed off to normal handlers
        if (intentionalClose.current || phaseRef.current === 'closed') return;
        // Connection failed before getting any response — retry
        schedule();
      };

      ws.onerror = () => {};
    }

    schedule();
  }, [addLog, handleMessage, sendRaw, stopReconnect, updatePhase]);

  // ---------------------------------------------------------------------------
  // Fresh join (from scanned URI)
  // ---------------------------------------------------------------------------

  const freshJoin = useCallback((pairingUri: string) => {
    if (!ethAddr || ethKeyInput.length !== 64) {
      Alert.alert('Wallet Required', 'Generate or enter an ETH private key first');
      return;
    }

    const parsed = wp.parsePairingUri(pairingUri);
    intentionalClose.current = false;

    const kp = wp.generateX25519KeyPair();
    const remotePub = wp.b64urlDecode(parsed.pubkey);
    const shared = wp.computeSharedSecret(kp.privateKey, remotePub);
    const sessionKey = wp.deriveSessionKey(shared, parsed.ch);
    const code = wp.computePairingCode(sessionKey, parsed.ch);
    setPairingCode(code);

    session.current = {
      channelId: parsed.ch,
      privKey: kp.privateKey,
      pubKeyB64: kp.publicKeyB64,
      remotePubKey: remotePub,
      sessionKey,
      sendSeq: 0,
      resumeToken: null,
      relayUrl: parsed.relay,
      ethKeyHex: ethKeyInput,
      ethAddr,
    };

    setRequests([]);
    connectAndJoin(false);
  }, [ethAddr, ethKeyInput, connectAndJoin]);

  // ---------------------------------------------------------------------------
  // Handle scanned URI from scan screen
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (uri && typeof uri === 'string' && uri.startsWith('walletpair:')) {
      freshJoin(uri);
    }
  }, [uri, freshJoin]);

  // ---------------------------------------------------------------------------
  // Restore session on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    (async () => {
      const saved = await store.loadSession();
      if (!saved) return;

      updateEthKey(saved.ethKeyHex);
      const { privKey, sessionKey } = store.hydrateCrypto(saved);

      session.current = {
        channelId: saved.channelId,
        privKey,
        pubKeyB64: saved.pubKeyB64,
        remotePubKey: saved.remotePubKeyB64 ? wp.b64urlDecode(saved.remotePubKeyB64) : null,
        sessionKey,
        sendSeq: saved.sendSeq,
        resumeToken: saved.resumeToken,
        relayUrl: saved.relayUrl,
        ethKeyHex: saved.ethKeyHex,
        ethAddr: eth.privateKeyToAddress(saved.ethKeyHex),
      };

      setPairingCode(wp.computePairingCode(sessionKey, saved.channelId));
      addLog('in', 'restore', `ch=${saved.channelId.slice(0, 12)}...`);
      startReconnect();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  const handleRequest = useCallback((reqId: string, approve: boolean) => {
    const s = session.current;
    if (!s || !s.sessionKey) return;

    const req = requests.find(r => r.id === reqId);
    if (!req) return;

    if (approve) {
      let result: unknown;
      switch (req.method) {
        case 'wallet_getAccounts':
          result = [s.ethAddr];
          break;
        case 'wallet_signMessage':
          result = { signature: eth.personalSign(s.ethKeyHex, String(req.params.message ?? '')), address: s.ethAddr };
          break;
        default:
          result = { status: 'approved' };
      }
      const msg: Record<string, unknown> = { v: 1, t: 'res', ch: s.channelId, id: reqId, from: s.pubKeyB64, ok: true };
      msg.sealed = wp.sealPayload(s.sessionKey, s.channelId, s.sendSeq++, result);
      sendRaw(msg);
    } else {
      const error = { code: 'user_rejected', message: 'User rejected the request' };
      const msg: Record<string, unknown> = { v: 1, t: 'res', ch: s.channelId, id: reqId, from: s.pubKeyB64, ok: false };
      msg.sealed = wp.sealPayload(s.sessionKey, s.channelId, s.sendSeq++, error);
      sendRaw(msg);
    }

    setRequests(prev => prev.filter(r => r.id !== reqId));
    saveSessionData();
  }, [requests, sendRaw, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Push event
  // ---------------------------------------------------------------------------

  const pushEvent = useCallback((eventName: string) => {
    const s = session.current;
    if (!s || !s.sessionKey || phaseRef.current !== 'connected') return;
    const data = eventName === 'accountsChanged' ? { accounts: [s.ethAddr] } : { chainId: 'eip155:1' };
    const msg: Record<string, unknown> = { v: 1, t: 'evt', ch: s.channelId, from: s.pubKeyB64, event: eventName };
    msg.sealed = wp.sealPayload(s.sessionKey, s.channelId, s.sendSeq++, data);
    sendRaw(msg);
    saveSessionData();
  }, [sendRaw, saveSessionData]);

  // ---------------------------------------------------------------------------
  // Close / Reset
  // ---------------------------------------------------------------------------

  const doClose = useCallback(() => {
    intentionalClose.current = true;
    stopReconnect();
    const s = session.current;
    if (s && wsRef.current?.readyState === WebSocket.OPEN) {
      sendRaw({ v: 1, t: 'close', ch: s.channelId, from: s.pubKeyB64, reason: 'normal' });
    }
    wsRef.current?.close();
    updatePhase('closed');
    store.clearSession();
  }, [sendRaw, stopReconnect, updatePhase]);

  const doReset = useCallback(() => {
    doClose();
    session.current = null;
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
              <Text style={s.codeLabel}>Pairing Code</Text>
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
