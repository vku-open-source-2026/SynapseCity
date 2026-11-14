// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import DataIngest from '../../pages/admin/DataIngest';

export const Route = createFileRoute('/admin/ingest')({
  component: DataIngest,
});
