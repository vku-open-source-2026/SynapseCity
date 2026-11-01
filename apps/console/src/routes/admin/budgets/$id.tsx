// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import BudgetDetail from '@/pages/budgets/BudgetDetail';

export const Route = createFileRoute('/admin/budgets/$id')({
  component: BudgetDetail,
});
