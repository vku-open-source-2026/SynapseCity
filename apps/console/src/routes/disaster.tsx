// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import DisasterMap from '../pages/DisasterMap';

export const Route = createFileRoute('/disaster')({
  component: DisasterMap,
});
