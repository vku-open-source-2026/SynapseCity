// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import BudgetCreate from '@/pages/budgets/BudgetCreate';

export const Route = createFileRoute('/admin/budgets/create')({
  component: BudgetCreate,
});
