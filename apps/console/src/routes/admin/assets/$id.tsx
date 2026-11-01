// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import AssetDetail from '@/pages/admin/AssetDetail';

export const Route = createFileRoute('/admin/assets/$id')({
  component: AssetDetail,
});
