/**
 * The in-app inbox.
 *
 * §6: "Push, with a matching in-app inbox so nothing is only ever a
 * notification." That sentence is doing real work. A push notification is the
 * least reliable delivery mechanism a product has — the OS drops them under
 * memory pressure, a user swipes one away on the lock screen, Do Not Disturb
 * eats it, and the phone may simply have been off. If the only record that a
 * match finished processing was a banner nobody saw, the match silently never
 * happened as far as the coach is concerned.
 *
 * So every notification is recorded locally when it arrives, whether the app
 * was foreground, background, or launched cold by the tap.
 *
 * WHAT THIS IS NOT: the source of truth. The inbox is a local mirror, and a
 * phone that was off for a week has no record of what it missed. The server
 * side of §6 — a real notification history endpoint — is in
 * `docs/BACKEND-GAPS.md`. Until it exists, the honest framing is what this
 * screen shows: recent messages on this device, not "everything that happened".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { InboxItem } from './types';

const STORAGE_KEY = 'riseup.inbox.v1';

/** Enough to cover a season's worth of tapping back, cheap to keep. */
const MAX_ITEMS = 200;

type Listener = () => void;

class Inbox {
  private items: InboxItem[] = [];
  private listeners = new Set<Listener>();
  private hydrated = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): InboxItem[] => this.items;

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        this.items = JSON.parse(raw) as InboxItem[];
        this.emit();
      }
    } catch {
      this.items = [];
    }
  }

  /**
   * Record an arrival.
   *
   * Deduplicated on id, because the same notification can be seen twice: once
   * by the foreground listener and again by the response listener when the
   * user taps it. Two identical rows in the inbox is a small bug that makes
   * the whole screen look untrustworthy.
   */
  add(item: InboxItem): void {
    if (this.items.some((existing) => existing.id === item.id)) {
      return;
    }
    this.items = [item, ...this.items].slice(0, MAX_ITEMS);
    this.emit();
  }

  markRead(id: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id === id && !item.read) {
        changed = true;
        return { ...item, read: true };
      }
      return item;
    });
    if (changed) {
      this.emit();
    }
  }

  markAllRead(): void {
    if (this.items.every((item) => item.read)) {
      return;
    }
    this.items = this.items.map((item) => (item.read ? item : { ...item, read: true }));
    this.emit();
  }

  clear(): void {
    this.items = [];
    this.emit();
  }

  unreadCount(): number {
    return this.items.reduce((n, item) => (item.read ? n : n + 1), 0);
  }

  private emit(): void {
    this.items = [...this.items];
    for (const listener of this.listeners) {
      listener();
    }
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.items)).catch(() => {
      // The list still works this session; it just will not survive a restart.
    });
  }
}

export const inbox = new Inbox();
