// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { RegisterPage } from '../pages/RegisterPage';

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});
