// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import UserList from '@/pages/admin/UserList';

export const Route = createFileRoute('/admin/users/')({
  component: UserList,
});
