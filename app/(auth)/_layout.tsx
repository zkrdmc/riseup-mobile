/**
 * The unauthenticated stack.
 *
 * This file exists to make `(auth)` a real route group. Without a layout, the
 * router flattens the folder and the only child is `(auth)/sign-in` — so the
 * root layout's `<Stack.Screen name="(auth)" />` names a route that does not
 * exist, and every navigation logs:
 *
 *   No route named "(auth)" exists in nested children: ["(app)", "(auth)/sign-in"]
 *
 * Harmless in itself, and worth fixing rather than silencing: the warning is
 * the router saying the declared structure and the real one disagree, and that
 * disagreement is what makes a redirect land somewhere unexpected once there is
 * a second screen in here — a password reset, or an invitation accept.
 */

import { Stack } from 'expo-router';

import { surface } from '../../src/theme/tokens';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: surface.bg0 },
      }}
    >
      <Stack.Screen name="sign-in" />
    </Stack>
  );
}
