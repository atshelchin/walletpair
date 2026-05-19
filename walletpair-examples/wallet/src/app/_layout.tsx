import '@/lib/polyfill'; // must be first — polyfills crypto.getRandomValues for Hermes
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0d1117' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen
          name="scan"
          options={{ presentation: 'fullScreenModal' }}
        />
      </Stack>
    </>
  );
}
