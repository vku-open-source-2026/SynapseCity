// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, test, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navigateTo, signOut } from './helpers';

describe('Navigation Flow', () => {
  beforeEach(async () => {
        signOut();
    await navigateTo('/');
    await waitFor(() => document.body, { timeout: 5000 });
  });

  test('should navigate from homepage to map', async () => {
    // Look for link or button to map
    // The home page links to the map from the header, hero and footer, so take the first one.
    const mapLink = screen.queryAllByRole('link', { name: /map|bản\sđồ/i })[0] ||
                    screen.queryAllByRole('button', { name: /map|explore|bản\sđồ/i })[0];

    if (mapLink) {
      await userEvent.click(mapLink);
      await waitFor(() => {
        expect(window.location.pathname).toMatch(/.*map/);
      });
    }
  });

  test('should navigate between public pages', async () => {
    // Test navigation to map
    await navigateTo('/map');
    await waitFor(() => {
      expect(window.location.pathname).toMatch(/.*map/);
    }, { timeout: 5000 });

    // Test navigation to public report
    await navigateTo('/public/report');
    await waitFor(() => {
      expect(window.location.pathname).toMatch(/.*report/);
    }, { timeout: 5000 });
  });

  test('should expose city public routes in the header', async () => {
    await navigateTo('/');
    await waitFor(() => {
      expect(document.querySelector('header')).toBeTruthy();
    }, { timeout: 5000 });

    const hrefs = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('header a')
    ).map((anchor) => anchor.getAttribute('href') ?? '');

    expect(hrefs).toContain('/public/report');
    expect(hrefs).toContain('/map');
    expect(hrefs).toContain('/docs');
  });

});
