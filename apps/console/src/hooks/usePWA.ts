// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useCallback, useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
  interface Window {
    /** Set by the inline script in index.html, which runs before the app loads. */
    __synapseInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

/*
 * The browser fires `beforeinstallprompt` once per page load, often before
 * React has mounted the home page. Listening only inside a component meant the
 * event was missed (or lost after navigating away and back), so the install
 * button came and went. The prompt now lives in one module-level store that
 * starts with whatever index.html already caught.
 */
interface InstallState {
  prompt: BeforeInstallPromptEvent | null;
  installed: boolean;
}

const listeners = new Set<() => void>();
let state: InstallState = { prompt: null, installed: false };

function setState(next: Partial<InstallState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    document.referrer.includes('android-app://')
  );
}

if (typeof window !== 'undefined') {
  state = { prompt: window.__synapseInstallPrompt ?? null, installed: isStandalone() };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__synapseInstallPrompt = e;
    setState({ prompt: e });
  });
  window.addEventListener('appinstalled', () => {
    window.__synapseInstallPrompt = null;
    setState({ prompt: null, installed: true });
  });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
    setState({ installed: e.matches });
  });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getSnapshot = () => state;

export function usePWA() {
  const { prompt, installed } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const promptInstall = useCallback(async () => {
    if (!prompt) return false;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // A prompt can only be shown once; the browser fires a fresh event later.
      window.__synapseInstallPrompt = null;
      setState({ prompt: null });
      return outcome === 'accepted';
    } catch (error) {
      console.error('Error prompting install:', error);
      return false;
    }
  }, [prompt]);

  return {
    isInstalled: installed,
    isInstallable: prompt !== null,
    promptInstall,
    canShowInstallButton: prompt !== null && !installed,
  };
}
