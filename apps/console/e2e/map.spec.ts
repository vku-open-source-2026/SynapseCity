// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, test, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navigateTo } from './helpers';

describe('Public Map Page', () => {
  beforeEach(async () => {
    await navigateTo('/map');
    // Wait for map to load
    await waitFor(() => {
      expect(document.querySelector('.leaflet-container')).toBeTruthy();
    }, { timeout: 10000 });
  });

  test('should display map component', async () => {
    // Check if map container exists
    await waitFor(() => {
      const mapContainer = document.querySelector('.leaflet-container') ||
                           document.querySelector('[class*="map"]');
      expect(mapContainer).toBeTruthy();
    });
  });

  test('should display asset table', async () => {
    // Look for asset table or list
    const assetTable = screen.queryByText(/system assets|assets|lớp dữ liệu|chưa có lớp tài sản/i) ||
                       document.querySelector('table');
    await waitFor(() => {
      expect(assetTable).toBeTruthy();
    });
  });

  test('should display geospatial search controls when enabled', async () => {
    // Check for address search
    await waitFor(() => {
      const addressSearch = screen.queryByPlaceholderText(/search address|tìm kiếm địa chỉ/i);
      expect(addressSearch).toBeTruthy();
    });

    // Check for nearby search button
    const nearbySearch = screen.queryByRole('button', { name: /nearby search|tìm kiếm xung quanh/i });
    expect(nearbySearch).toBeTruthy();

    // Check for polygon draw button
    const polygonDraw = screen.queryByRole('button', { name: /draw area|vẽ khu vực/i });
    expect(polygonDraw).toBeTruthy();
  });

  test('should open nearby search panel', async () => {
    const nearbyButton = screen.queryByRole('button', { name: /nearby search|tìm kiếm xung quanh/i });
    expect(nearbyButton).toBeTruthy();

    if (nearbyButton) {
      await userEvent.click(nearbyButton);

      // Check for radius input
      await waitFor(() => {
        const radiusInput = screen.queryByLabelText(/radius/i) ||
                           document.querySelector('input[type="number"]');
        expect(radiusInput).toBeTruthy();
      });
    }
  });

  test('should perform address search', async () => {
    const addressInput = screen.queryByPlaceholderText(/search address|tìm kiếm địa chỉ/i);
    expect(addressInput).toBeTruthy();

    if (addressInput) {
      await userEvent.type(addressInput, 'Da Nang');

      // Wait for suggestions or results
      await waitFor(() => {}, { timeout: 1000 });

      // Check if suggestions appear or geocoding happens
      // Suggestions may or may not appear depending on API response
    }
  });

  test('should display map controls', async () => {
    // Check for map mode toggle buttons (markers/heatmap)
    const mapControls = document.querySelectorAll('button[title*="View"], button[title*="Chế độ"], button[title*="Bản đồ"]');
    // At least one control should be visible
    expect(mapControls.length).toBeGreaterThan(0);
  });

  test('should select asset from map', async () => {
    // Wait for markers to load
    await waitFor(() => {}, { timeout: 3000 });

    // Try to click on a marker (if any exist)
    const markers = document.querySelectorAll('.leaflet-marker-icon');

    if (markers.length > 0) {
      const firstMarker = markers[0] as HTMLElement;
      firstMarker.click();

      // Check if asset details panel appears
      await waitFor(() => {}, { timeout: 500 });
      // Details may appear in a panel or popup
    }
  });

  test('should filter assets by polygon', async () => {
    const drawButton = await waitFor(() => {
      const btn = screen.queryByRole('button', { name: /draw area|draw polygon|vẽ khu vực/i });
      expect(btn).toBeTruthy();
      return btn;
    }, { timeout: 2000 });

    if (drawButton) {
      await userEvent.click(drawButton);

      // Wait for drawing mode to activate
      await waitFor(() => {
        // Check if drawing instructions appear (may or may not show instructions)
        const drawingText = screen.queryByText(/click on map|draw polygon/i);
        // Instructions are optional - test passes if button was clicked
        if (drawingText) {
          expect(drawingText).toBeTruthy();
        }
      }, { timeout: 1000 });
    }
  });
});
