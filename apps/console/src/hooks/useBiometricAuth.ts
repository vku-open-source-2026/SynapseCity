// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * WebAuthn Biometric Authentication Hook
 * Supports fingerprint, face recognition on supported devices
 */

import { useState, useCallback, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../types/user';

// Storage keys
const BIOMETRIC_ENABLED_KEY = 'biometric_enabled';
const BIOMETRIC_CREDENTIAL_KEY = 'biometric_credential_id';
const BIOMETRIC_USER_KEY = 'biometric_user_data';
// Session tokens are scoped to the tab and never persisted in localStorage.
const BIOMETRIC_TOKENS_KEY = 'biometric_session_tokens';

/**
 * Biometrics are a mobile/tablet convenience. Desktop browsers often expose a
 * platform authenticator (Windows Hello/Touch ID) and would otherwise show a
 * setup prompt after every password login; the product requirement is to keep
 * desktop sign-in password-only.
 */
export function isBiometricDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua);
  const tablet = /iPad|Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
  return mobile || tablet;
}

interface BiometricState {
  isAvailable: boolean;
  isEnabled: boolean;
  isLoading: boolean;
  error: string | null;
}

interface StoredCredential {
  credentialId: string;
  username: string;
  user: User;
}

interface BiometricSessionTokens {
  accessToken: string;
  refreshToken: string;
}

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

const getErrorName = (error: unknown): string | null => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string'
  ) {
    return (error as { name: string }).name;
  }
  return null;
};

export function useBiometricAuth() {
  const { login } = useAuthStore();
  const [state, setState] = useState<BiometricState>({
    isAvailable: false,
    isEnabled: false,
    isLoading: false,
    error: null,
  });

  // Check if WebAuthn is available
  useEffect(() => {
    const checkAvailability = async () => {
      try {
        const available = 
          window.PublicKeyCredential !== undefined &&
          typeof window.PublicKeyCredential === 'function';
        
        if (available) {
          // Check if platform authenticator (fingerprint/face) is available
          const platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          const enabled = localStorage.getItem(BIOMETRIC_ENABLED_KEY) === 'true';
          const supportedDevice = isBiometricDevice();
          
          setState(prev => ({
            ...prev,
            isAvailable: platformAvailable && supportedDevice,
            isEnabled: enabled && platformAvailable && supportedDevice,
          }));
        }
      } catch (error) {
        console.error('Error checking biometric availability:', error);
      }
    };

    checkAvailability();
  }, []);

  // Generate random challenge
  const generateChallenge = useCallback((): ArrayBuffer => {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    return challenge.buffer as ArrayBuffer;
  }, []);

  // Convert ArrayBuffer to Base64
  const bufferToBase64 = useCallback((buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  // Convert Base64 to ArrayBuffer
  const base64ToBuffer = useCallback((base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }, []);

  // Register biometric credential after successful login
  const registerBiometric = useCallback(async (
    username: string,
    accessToken: string,
    refreshToken: string,
    user: User
  ): Promise<boolean> => {
    if (!state.isAvailable) {
      setState(prev => ({ ...prev, error: 'Biometric not available on this device' }));
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const challenge = generateChallenge();
      const userId = new TextEncoder().encode(username);

      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: {
          name: 'SynapseCity',
          id: window.location.hostname,
        },
        user: {
          id: userId,
          name: username,
          displayName: user.full_name || username,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },   // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // Use device biometric
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      };

      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      }) as PublicKeyCredential;

      if (!credential) {
        throw new Error('Failed to create credential');
      }

      // Store credential info locally (for demo - in production, send to server)
      const storedCredential: StoredCredential = {
        credentialId: bufferToBase64(credential.rawId),
        username,
        user,
      };

      localStorage.setItem(BIOMETRIC_CREDENTIAL_KEY, storedCredential.credentialId);
      localStorage.setItem(BIOMETRIC_USER_KEY, JSON.stringify(storedCredential));
      sessionStorage.setItem(BIOMETRIC_TOKENS_KEY, JSON.stringify({ accessToken, refreshToken } satisfies BiometricSessionTokens));
      localStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');

      setState(prev => ({ ...prev, isLoading: false, isEnabled: true }));
      return true;
    } catch (error: unknown) {
      console.error('Biometric registration error:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: getErrorMessage(error, 'Failed to register biometric'),
      }));
      return false;
    }
  }, [state.isAvailable, generateChallenge, bufferToBase64]);

  // Authenticate using biometric
  const authenticateWithBiometric = useCallback(async (): Promise<boolean> => {
    if (!state.isEnabled) {
      setState(prev => ({ ...prev, error: 'Biometric not enabled' }));
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const storedData = localStorage.getItem(BIOMETRIC_USER_KEY);
      if (!storedData) {
        throw new Error('No stored credentials found');
      }

      const stored: StoredCredential = JSON.parse(storedData);
      const challenge = generateChallenge();

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge,
        rpId: window.location.hostname,
        allowCredentials: [
          {
            id: base64ToBuffer(stored.credentialId),
            type: 'public-key',
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60000,
      };

      const assertion = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions,
      }) as PublicKeyCredential;

      if (!assertion) {
        throw new Error('Authentication failed');
      }

      // Biometric verified. Tokens live only in this tab's session storage; a
      // missing session requires a fresh login through the identity provider.
      const tokensRaw = sessionStorage.getItem(BIOMETRIC_TOKENS_KEY);
      if (!tokensRaw) {
        throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      }
      const tokens = JSON.parse(tokensRaw) as BiometricSessionTokens;
      login(tokens.accessToken, tokens.refreshToken, stored.user);
      
      setState(prev => ({ ...prev, isLoading: false }));
      return true;
    } catch (error: unknown) {
      console.error('Biometric authentication error:', error);
      
      // Handle user cancellation
      if (getErrorName(error) === 'NotAllowedError') {
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: 'Authentication cancelled',
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: getErrorMessage(error, 'Biometric authentication failed'),
        }));
      }
      return false;
    }
  }, [state.isEnabled, generateChallenge, base64ToBuffer, login]);

  // Disable biometric
  const disableBiometric = useCallback(() => {
    localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
    localStorage.removeItem(BIOMETRIC_CREDENTIAL_KEY);
    localStorage.removeItem(BIOMETRIC_USER_KEY);
    sessionStorage.removeItem(BIOMETRIC_TOKENS_KEY);
    setState(prev => ({ ...prev, isEnabled: false }));
  }, []);

  // Update stored tokens (after token refresh)
  const updateStoredTokens = useCallback((accessToken: string, refreshToken: string) => {
    if (localStorage.getItem(BIOMETRIC_USER_KEY)) {
      sessionStorage.setItem(BIOMETRIC_TOKENS_KEY, JSON.stringify({ accessToken, refreshToken } satisfies BiometricSessionTokens));
    }
  }, []);

  return {
    ...state,
    registerBiometric,
    authenticateWithBiometric,
    disableBiometric,
    updateStoredTokens,
  };
}
