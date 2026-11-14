// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import SensorDetail from '@/pages/iot/SensorDetail';

export const Route = createFileRoute('/admin/iot/$id')({
  component: SensorDetail,
});
