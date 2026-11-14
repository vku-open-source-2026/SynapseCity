// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import BudgetList from '@/pages/budgets/BudgetList';

export const Route = createFileRoute('/admin/budgets/')({
  component: BudgetList,
});
