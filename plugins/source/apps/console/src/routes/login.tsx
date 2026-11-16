// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '../pages/LoginPage';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});
