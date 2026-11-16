// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export type AppRouteName =
  | 'home'
  | 'map'
  | 'scan'
  | 'report'
  | 'alerts'
  | 'account'
  | 'settings'
  | 'asset'
  | 'incident'
  | 'widget-help';

export interface AppRoute {
  name: AppRouteName;
  params?: Record<string, string>;
}

export function parseDeepLink(url: string | null | undefined): AppRoute | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+|\/+$/g, '');
    const [first, second] = path.split('/');
    switch (first) {
      case 'asset':
        return second ? { name: 'asset', params: { code: decodeURIComponent(second) } } : { name: 'home' };
      case 'incident':
        return second ? { name: 'incident', params: { reference: decodeURIComponent(second) } } : { name: 'alerts' };
      case 'scan':
        return { name: 'scan' };
      case 'report':
        return { name: 'report', params: second ? { assetCode: decodeURIComponent(second) } : undefined };
      case 'alerts':
        return { name: 'alerts' };
      case 'map':
        return { name: 'map' };
      case 'settings':
        return { name: 'settings' };
      case 'widget':
        return { name: 'widget-help' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
