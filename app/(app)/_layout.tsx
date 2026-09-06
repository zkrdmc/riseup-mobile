/**
 * The signed-in stack.
 *
 * Tabs at the root, everything else pushed over them. `headerShown` is off
 * throughout: each screen draws its own header, because the summary screen's
 * header carries a data-quality banner and a status pill that no native title
 * bar can hold.
 */

import { Stack } from 'expo-router';

import { ink, surface } from '../../src/theme/tokens';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: surface.bg0 },
        headerTintColor: ink[1],
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="match/[id]" />
      <Stack.Screen
        name="match/player"
        options={{
          // A player is a detail of the match already on screen, not a new
          // place. The sheet keeps the summary visible behind it, which is
          // what "quick view" in §7 is asking for.
          presentation: 'modal',
        }}
      />
    </Stack>
  );
}
