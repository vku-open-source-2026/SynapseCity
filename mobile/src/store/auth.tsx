// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cityApi } from '../api/city';
import type { AuthResponse, AuthUser } from '../api/types';
import { clearSession, loadSession, saveSession, type Session } from '../lib/storage';

interface AuthContextValue {
  session: Session | null;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    email: string;
    password: string;
    full_name: string;
    phone?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    loadSession()
      .then((stored) => {
        if (active) setSession(stored);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const applyAuth = useCallback(async (response: AuthResponse) => {
    const next: Session = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      user: response.user,
    };
    setSession(next);
    await saveSession(next);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      await applyAuth(await cityApi.login(username, password));
    },
    [applyAuth],
  );

  const register = useCallback(
    async (input: {
      username: string;
      email: string;
      password: string;
      full_name: string;
      phone?: string;
    }) => {
      await applyAuth(await cityApi.register(input));
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    const current = session;
    setSession(null);
    await clearSession();
    if (current) {
      cityApi.logout(current.accessToken, current.refreshToken).catch(() => undefined);
    }
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      token: session?.accessToken ?? null,
      loading,
      login,
      register,
      logout,
    }),
    [session, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
