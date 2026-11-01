// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import HomePage from '../pages/HomePage';

export const Route = createFileRoute('/')({
  component: HomePage,
});
