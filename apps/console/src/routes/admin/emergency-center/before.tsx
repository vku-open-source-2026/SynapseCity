// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';

import BeforeDisasterBoardPage from '@/pages/emergency/phases/BeforeDisasterBoardPage';

export const Route = createFileRoute('/admin/emergency-center/before')({
  component: BeforeDisasterBoardPage,
});
