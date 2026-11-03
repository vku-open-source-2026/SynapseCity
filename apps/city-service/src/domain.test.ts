// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesError } from '@synapsedx/capabilities';
import { DATASETS, ensureDataset } from './domain';

test('only the public projection datasets are marked public', () => {
  assert.equal(DATASETS.assets.public, true);
  assert.equal(DATASETS.incidents.public, true);
  for (const key of Object.keys(DATASETS) as Array<keyof typeof DATASETS>) {
    if (key === 'assets' || key === 'incidents') continue;
    assert.equal(DATASETS[key].public, false, `${DATASETS[key].id} must stay private`);
  }
  assert.equal(DATASETS.users.public, false);
});

test('ensureDataset creates city-users private and does not publish it', async () => {
  const created: Array<Record<string, unknown>> = [];
  let published = false;
  const client = {
    datasets: {
      get: async () => { throw new CapabilitiesError('not found', { status: 404 }); },
      create: async (input: Record<string, unknown>) => { created.push(input); return { ...input, id: input.slug, status: 'draft' }; },
      publish: async (id: string) => { published = true; return { id, status: 'published' }; },
    },
  } as any;

  const dataset = await ensureDataset(client, DATASETS.users);
  assert.equal(dataset.id, 'city-users');
  assert.equal(created.length, 1);
  assert.equal(created[0].public, false);
  assert.equal(published, false, 'city-users must never be published');
});

test('ensureDataset creates and publishes city-assets as a public projection', async () => {
  const created: Array<Record<string, unknown>> = [];
  let published = '';
  const client = {
    datasets: {
      get: async () => { throw new CapabilitiesError('not found', { status: 404 }); },
      create: async (input: Record<string, unknown>) => { created.push(input); return { ...input, id: input.slug, status: 'draft' }; },
      publish: async (id: string) => { published = id; return { id, status: 'published' }; },
    },
  } as any;

  await ensureDataset(client, DATASETS.assets);
  assert.equal(created[0].public, true);
  assert.equal(published, 'city-assets');
});
