// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import ReportList from '@/pages/reports/ReportList';

export const Route = createFileRoute('/admin/reports/')({
  component: ReportList,
});
