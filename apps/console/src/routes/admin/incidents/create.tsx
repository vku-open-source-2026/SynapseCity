// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import IncidentCreate from '@/pages/incidents/IncidentCreate';

export const Route = createFileRoute('/admin/incidents/create')({
  component: IncidentCreate,
});
