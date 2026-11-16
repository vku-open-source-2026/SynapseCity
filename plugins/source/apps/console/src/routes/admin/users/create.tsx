// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import UserCreate from '@/pages/admin/UserCreate';

export const Route = createFileRoute('/admin/users/create')({
  component: UserCreate,
});
