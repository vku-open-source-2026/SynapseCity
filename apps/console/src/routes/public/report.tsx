// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import PublicIncidentReport from '@/pages/incidents/PublicIncidentReport';

export const Route = createFileRoute('/public/report')({
  component: PublicIncidentReport,
});
