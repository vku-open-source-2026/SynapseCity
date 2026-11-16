// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import IncidentList from '@/pages/incidents/IncidentList';

export const Route = createFileRoute('/admin/incidents/')({
  component: IncidentList,
});
