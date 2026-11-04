// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesError } from '@synapsedx/capabilities';
import { DATA_LICENSE, DATASETS, ensureDataset } from './domain';

test('every City dataset uses the PDDL-1.0 data license', () => {
  assert.equal(DATA_LICENSE, 'PDDL-1.0');
  for (const dataset of Object.values(DATASETS)) {
    assert.equal(dataset.license, 'PDDL-1.0', `${dataset.id} must use PDDL-1.0`);
  }
});

test('only the public projection datasets are marked public', () => {
  assert.equal(DATASETS.assets.public, true);
  assert.equal(DATASETS.incidents.public, true);
  for (const key of Object.keys(DATASETS) as Array<keyof typeof DATASETS>) {
    if (key === 'assets' || key === 'incidents') continue;
    assert.equal(DATASETS[key].public, false, `${DATASETS[key].id} must stay private`);
  }
  assert.equal(DATASETS.users.public, false);
});

test('ensureDataset reconciles an old public City dataset to PDDL and private visibility', async () => {
  const revoked: string[] = [];
  const updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  const existing = {
    id: 'city-users',
    slug: 'city-users',
    name: 'SynapseCity users',
    entityType: 'CityUser',
    license: 'CC-BY-4.0',
    description: 'Domain operator profiles',
    public: true,
    schemaVersion: '1.0.0',
    status: 'published',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const client = {
    datasets: {
      get: async () => existing,
      revoke: async (id: string) => { revoked.push(id); return { ...existing, status: 'revoked' }; },
      update: async (id: string, input: Record<string, unknown>) => { updated.push({ id, input }); return { ...existing, ...input, id }; },
    },
  } as any;

  const dataset = await ensureDataset(client, DATASETS.users);
  assert.deepEqual(revoked, ['city-users']);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].input.license, 'PDDL-1.0');
  assert.equal(updated[0].input.public, false);
  assert.equal(dataset.license, 'PDDL-1.0');
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
  assert.equal(created[0].license, 'PDDL-1.0');
  assert.equal(published, 'city-assets');
});
