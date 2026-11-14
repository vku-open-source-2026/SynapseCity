// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import IncidentDetail from '@/pages/incidents/IncidentDetail';

export const Route = createFileRoute('/admin/incidents/$id')({
  component: IncidentDetail,
});
