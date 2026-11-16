// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import UserDetail from '@/pages/admin/UserDetail';

export const Route = createFileRoute('/admin/users/$id')({
  component: UserDetail,
});
