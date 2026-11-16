// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { IncidentStatusPage } from '../../pages/incidents/IncidentStatusPage';

export const Route = createFileRoute('/public/incidents/$incidentId')({
    component: IncidentStatusPage,
});
