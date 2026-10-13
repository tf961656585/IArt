'use client';

export type MediaState = 'active' | 'dormant';
export type MediaType = 'video' | 'image';
type MediaActivationReason = 'hover' | 'playing';

const HOVER_ACTIVATE_DELAY_MS = 200;

interface MediaEntry {
  key: string;
  url: string;
  type: MediaType;
  state: MediaState;
  refCount: number;
  reasons: Set<MediaActivationReason>;
  hoverTimer: number | null;
}

class MediaLifecycleManager {
  private entries = new Map<string, MediaEntry>();
  private listeners = new Map<string, Set<() => void>>();

  register(key: string, url: string, type: MediaType): MediaState {
    if (!key) return 'active';
    const nextUrl = typeof url === 'string' ? url.trim() : '';
    const entry = this.entries.get(key);
    if (entry) {
      entry.refCount += 1;
      if (nextUrl && entry.url !== nextUrl) {
        entry.url = nextUrl;
        entry.type = type;
        entry.reasons.delete('playing');
        this.syncState(entry, key);
      }
      return entry.state;
    }

    const nextEntry: MediaEntry = {
      key,
      url: nextUrl,
      type,
      state: 'dormant',
      refCount: 1,
      reasons: new Set(),
      hoverTimer: null,
    };
    this.entries.set(key, nextEntry);
    return nextEntry.state;
  }

  unregister(key: string): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount <= 0) {
      this.clearHoverTimer(entry);
      this.entries.delete(key);
      this.listeners.delete(key);
    }
  }

  setPlaying(key: string, playing: boolean): void {
    this.setReason(key, 'playing', playing);
  }

  onHoverEnter(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.reasons.has('hover')) return;
    if (entry.hoverTimer !== null) return;

    entry.hoverTimer = window.setTimeout(() => {
      entry.hoverTimer = null;
      if (!this.entries.has(key)) return;
      this.setReason(key, 'hover', true);
    }, HOVER_ACTIVATE_DELAY_MS);
  }

  onHoverLeave(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    this.clearHoverTimer(entry);
    this.setReason(key, 'hover', false);
  }

  getState(key: string): MediaState {
    if (!key) return 'active';
    const entry = this.entries.get(key);
    return entry !== undefined ? entry.state : 'dormant';
  }

  subscribe(key: string, callback: () => void): () => void {
    if (!key) return () => {};
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (set && set.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.clearHoverTimer(entry);
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private setReason(key: string, reason: MediaActivationReason, enabled: boolean): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;

    const had = entry.reasons.has(reason);
    if (enabled) {
      if (had) return;
      entry.reasons.add(reason);
    } else {
      if (!had) return;
      entry.reasons.delete(reason);
    }

    this.syncState(entry, key);
  }

  private syncState(entry: MediaEntry, key: string): void {
    const nextState: MediaState = entry.reasons.size > 0 ? 'active' : 'dormant';
    if (entry.state === nextState) return;
    entry.state = nextState;
    this.notify(key);
  }

  private clearHoverTimer(entry: MediaEntry): void {
    if (entry.hoverTimer === null) return;
    window.clearTimeout(entry.hoverTimer);
    entry.hoverTimer = null;
  }

  private notify(key: string): void {
    const listeners = this.listeners.get(key);
    if (listeners === undefined) return;
    listeners.forEach((cb) => cb());
  }
}

export const mediaLifecycleManager = new MediaLifecycleManager();
