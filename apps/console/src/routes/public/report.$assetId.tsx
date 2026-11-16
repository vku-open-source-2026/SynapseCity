// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { ReportAssetIncident } from '../../pages/incidents/ReportAssetIncident';

export const Route = createFileRoute('/public/report/$assetId')({
    component: ReportAssetIncident,
});
