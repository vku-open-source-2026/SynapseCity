// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import AlertList from '@/pages/alerts/AlertList';

export const Route = createFileRoute('/admin/alerts/list')({
  component: AlertList,
});
