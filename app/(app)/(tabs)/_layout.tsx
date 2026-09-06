/**
 * Bottom tabs.
 *
 * Five, which is the ceiling — a sixth turns the bar into a row of unreadable
 * 10px labels and pushes the tap targets under 44pt. The five are the four
 * jobs from PRD §1 plus settings:
 *
 *   Matches  — glance analytics (§7)
 *   Capture  — film a match (§4)
 *   Uploads  — get footage off the phone (§5)
 *   Inbox    — know when analysis is ready (§6)
 *   Settings
 *
 * ROLE AWARENESS (§2) IS THE INITIAL ROUTE, NOT THE TAB SET. An Operator opens
 * on Capture and an Analyst on Matches, but both see all five tabs. Hiding
 * tabs by role would mean an Operator who did once need the match list has no
 * way to reach it, and a volunteer under time pressure is the last person who
 * should have to find a settings toggle to see a screen.
 */

import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { useAppRole } from '../../../src/auth/role';
import { font, ink, line, space, surface, tracking, type } from '../../../src/theme/tokens';

export default function TabsLayout() {
  const { role, loaded } = useAppRole();

  // Routing before the stored role is read would flash the match list at an
  // Operator on every cold start. Rendering nothing for one frame is cheaper
  // than the flicker, and the splash screen is still up.
  if (!loaded) {
    return null;
  }

  if (role === 'operator') {
    return <Redirect href="/capture" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarActiveTintColor: ink[1],
        tabBarInactiveTintColor: ink.subtle,
        // The tab bar sits on the canvas, divided by a hairline. Not a floating
        // translucent slab — panels do not float in this system.
        tabBarBackground: () => null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Matches',
          tabBarIcon: ({ color, size }) => <Ionicons name="list" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: 'Capture',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="videocam-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="uploads"
        options={{
          title: 'Uploads',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cloud-upload-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: surface.bg0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: line.rule,
    paddingTop: space[1],
  },
  label: {
    fontFamily: font.mono,
    fontSize: type.micro,
    letterSpacing: tracking.label,
    textTransform: 'uppercase',
  },
});
