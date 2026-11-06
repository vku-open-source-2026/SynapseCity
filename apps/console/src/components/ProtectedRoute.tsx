// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useEffect, useRef, useState } from 'react';
import { authApi } from '../api/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'admin' | 'technician' | 'citizen';
  requiredPermission?: string;
}

export function ProtectedRoute({
  children,
  requiredRole,
  requiredPermission
}: ProtectedRouteProps) {
  const { isAuthenticated, user, refreshToken, setTokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const navigate = useNavigate();
  // Refresh at most once per mount. setTokens() changes refreshToken, which
  // would otherwise re-run this effect and rotate the token forever.
  const refreshAttempted = useRef(false);

  useEffect(() => {
    const checkAuth = async () => {
      if (!isAuthenticated) {
        setIsChecking(false);
        return;
      }

      // Check role if required
      if (requiredRole && user?.role !== requiredRole) {
        navigate({ to: '/' });
        setIsChecking(false);
        return;
      }

      // Check permission if required
      if (requiredPermission && !user?.permissions.includes(requiredPermission)) {
        navigate({ to: '/' });
        setIsChecking(false);
        return;
      }

      // Refresh at most once per mount; a rotating refresh token must not
      // retrigger this effect. A real 401 is handled by httpClient.
      if (refreshToken && !refreshAttempted.current) {
        refreshAttempted.current = true;
        try {
          const response = await authApi.refreshToken(refreshToken);
          setTokens(response.access_token, response.refresh_token);
        } catch {
          // Token refresh failed, will be handled by httpClient interceptor
        }
      }

      setIsChecking(false);
    };

    checkAuth();
  }, [isAuthenticated, user, requiredRole, requiredPermission, refreshToken, setTokens, navigate]);

  if (isChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
}
