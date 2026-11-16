// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthUser } from '../api/types';
import { clearSession, type Session } from '../lib/storage';

/**
 * Tier-3 login/session management is retired (2026-11-14 workspace contract).
 * Operator authentication belongs to the SynapseDX workspace, so this shell
 * never calls the retired `/v1/auth/*` routes. Public mobile surfaces continue
 * to work anonymously.
 */
interface AuthContextValue {
  session: Session | null;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    // Drop a session left by a previous app version; it would only target
    // retired City auth routes.
    clearSession()
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const logout = useCallback(async () => {
    await clearSession();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      token: session?.accessToken ?? null,
      loading,
      logout,
    }),
    [session, loading, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
