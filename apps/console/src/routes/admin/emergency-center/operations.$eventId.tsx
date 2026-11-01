// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';

import RescueOperationPage from '@/pages/emergency/RescueOperationPage';

export const Route = createFileRoute('/admin/emergency-center/operations/$eventId')({
  component: RescueOperationPage,
});
