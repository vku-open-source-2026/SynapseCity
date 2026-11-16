// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_URL,
  isMovedWorkspacePath,
  isPublicProductPath,
  workspaceRedirectHref,
} from './workspace';

describe('isMovedWorkspacePath', () => {
  it.each([
    '/login',
    '/login/',
    '/register',
    '/admin',
    '/admin/',
    '/admin/assets',
    '/admin/assets/create',
    '/admin/incidents/abc?tab=log',
    '/technician',
    '/technician/tasks/42',
    '/workspace',
    '/workspace/builder',
  ])('redirects %s', (path) => {
    expect(isMovedWorkspacePath(path)).toBe(true);
  });

  it.each([
    '/',
    '/map',
    '/about',
    '/docs',
    '/asset/asset-1',
    '/public/report',
    '/public/report/asset-1',
    '/public/incidents/incident-1',
    '/administrator',
    '/login-help',
    '/adminx/assets',
  ])('keeps public path %s', (path) => {
    expect(isMovedWorkspacePath(path)).toBe(false);
  });
});

describe('workspaceRedirectHref', () => {
  it('keeps every public page on this origin', () => {
    expect(workspaceRedirectHref('/')).toBeNull();
    expect(workspaceRedirectHref('/map')).toBeNull();
    expect(workspaceRedirectHref('/map?assetId=a1')).toBeNull();
    expect(workspaceRedirectHref('/public/report')).toBeNull();
    expect(workspaceRedirectHref('/public/incidents/abc?tab=log')).toBeNull();
    expect(workspaceRedirectHref('/asset/asset-1')).toBeNull();
    expect(workspaceRedirectHref('/docs')).toBeNull();
  });

  it('sends every retired path to one fixed DX URL', () => {
    expect(workspaceRedirectHref('/login')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/admin/assets')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/technician/tasks/9')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/workspace')).toBe(WORKSPACE_URL);
    expect(WORKSPACE_URL).toBe('https://synapsedx.sbs/workspace');
  });

  it('never copies query values, credentials or return targets', () => {
    const href = workspaceRedirectHref('/login?redirect=%2Fmap&token=super-secret');
    expect(href).toBe(WORKSPACE_URL);
    expect(href).not.toContain('?');
    expect(href).not.toContain('super-secret');
    expect(workspaceRedirectHref('/admin?next=%2Fmap')).toBe(WORKSPACE_URL);
  });
});

describe('isPublicProductPath', () => {
  it('covers the public surface only', () => {
    expect(isPublicProductPath('/')).toBe(true);
    expect(isPublicProductPath('/map')).toBe(true);
    expect(isPublicProductPath('/public/report')).toBe(true);
    expect(isPublicProductPath('/admin')).toBe(false);
  });
});
