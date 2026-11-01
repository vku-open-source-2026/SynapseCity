// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';

import DuringDisasterBoardPage from '@/pages/emergency/phases/DuringDisasterBoardPage';

export const Route = createFileRoute('/admin/emergency-center/during')({
  component: DuringDisasterBoardPage,
});
