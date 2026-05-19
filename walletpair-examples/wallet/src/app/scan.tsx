import { useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);

  function handleBarCode({ data }: { data: string }) {
    if (scanned.current) return;
    if (data.startsWith('walletpair:')) {
      scanned.current = true;
      router.replace({ pathname: '/', params: { uri: data } });
    }
  }

  if (!permission) return <View style={s.container} />;

  if (!permission.granted) {
    return (
      <View style={s.container}>
        <Text style={s.text}>Camera permission is required to scan QR codes</Text>
        <TouchableOpacity style={s.btn} onPress={requestPermission}>
          <Text style={s.btnText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnCancel} onPress={() => router.back()}>
          <Text style={s.text}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <CameraView
        facing="back"
        onBarcodeScanned={handleBarCode}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        style={StyleSheet.absoluteFill}
      />
      {/* Overlay with hole */}
      <View style={s.overlay}>
        <Text style={s.hint}>Scan WalletPair QR code</Text>
        <View style={s.frame} />
        <TouchableOpacity style={s.btnCancel} onPress={() => router.back()}>
          <Text style={s.btnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: '#58a6ff',
    borderRadius: 16,
  },
  hint: {
    color: '#e6edf3',
    fontSize: 16,
    fontWeight: '600',
  },
  text: { color: '#e6edf3', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  btn: {
    backgroundColor: '#58a6ff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnCancel: {
    backgroundColor: '#30363d',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
