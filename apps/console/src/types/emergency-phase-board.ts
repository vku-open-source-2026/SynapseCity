// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export type DisasterPhase = 'before' | 'during' | 'after';

export interface SectionStubItem {
  id: string;
  title: string;
  description: string;
  extensionHint: string;
}

export interface PhaseBoardDefinition {
  phase: DisasterPhase;
  routePath: string;
  tabLabel: string;
  title: string;
  subtitle: string;
  teamBoundary: string;
  dataSourceStubs: SectionStubItem[];
  kpiStubs: SectionStubItem[];
  actionQueueStubs: SectionStubItem[];
}
