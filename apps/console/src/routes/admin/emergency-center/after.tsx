// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';

import AfterDisasterBoardPage from '@/pages/emergency/phases/AfterDisasterBoardPage';

export const Route = createFileRoute('/admin/emergency-center/after')({
  component: AfterDisasterBoardPage,
});
