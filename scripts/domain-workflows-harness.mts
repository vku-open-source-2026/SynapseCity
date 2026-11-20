// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST ONLY harness: run the City domain workflow artifacts through the
 * real Tier-1 SynapseFlow engine against the real DX HTTP routes with a fake
 * Tier-1 transport (startHarness from the sibling SynapseDX checkout).
 *
 * Asserts the real domain effect, not just the call shape:
 * - incidents.merge closes each duplicate (resolution_type:duplicate,
 *   merged_into, shared notes) and extends the primary's
 *   merged_reporter_ids with only the duplicates that actually closed;
 *   a missing duplicate is reported as failed and never blocks the merge;
 * - incidents.upvote is idempotent per reporter (one upvote, one entry,
 *   no second write);
 * - incidents.comment appends structured comment entries;
 * - incidents.visibility sets the public_visible flag.
 *
 * It never uses a real credential, network, deployment or Docker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const { runWorkflow } = await import(pathToFileURL(path.join(root, 'SynapseOne/apps/workflow-service/src/engine.ts')).href);
const harnessModule = await import(pathToFileURL(path.join(root, 'SynapseDX/apps/capabilities-service/dist/src/testing/harness.js')).href);
const { api, startHarness, createDataset } = harnessModule.default || harnessModule;

const h = await startHarness();
h.config.publicUrl = h.base;
const originalFetch = globalThis.fetch;
try {
  for (const slug of ['city-incidents', 'city-maintenance']) {
    const dataset = await createDataset(h, { slug, name: slug, public: false }, { token: 'admin-token' });
    assert.equal(dataset.status, 201, JSON.stringify(dataset.body));
  }
  globalThis.fetch = (async (url: any, options: any) => {
    const target = String(url);
    return originalFetch(target.startsWith('https://synapsedx.sbs/') ? h.base + target.slice('https://synapsedx.sbs'.length) : url, options);
  }) as typeof fetch;

  const run = async (workflow: string, resource: string, fields: Record<string, unknown>, action = 'update') => {
    const definition = JSON.parse(fs.readFileSync(path.join(root, `SynapseCity/plugins/workflows/${workflow}.workflow.json`), 'utf8'));
    for (const node of definition.nodes) if (node.parameters?.auth?.credentialRef) node.parameters.auth.credentialId = 'bound-test-credential';
    return runWorkflow(definition, {
      pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource, action,
      submittedBy: 'member-test', submittedAt: new Date().toISOString(), fields,
    }, {
      name: workflow,
      principal: { sub: 'member-test', kind: 'user' },
      credentialResolver: async (id: string) => id === 'bound-test-credential' ? { kind: 'api-key', secret: 'workflow-org-key' } : null,
    });
  };
  const createIncident = async (title: string) => {
    const created = await api(h, '/v1/capabilities/datasets/city-incidents/records', {
      token: 'admin-token', method: 'POST',
      body: { data: { type: 'Incident', title, category: 'damage', severity: 'high', status: 'reported', incident_number: 'INC-' + title }, publish: false },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return String(created.body.id);
  };
  const readIncident = async (id: string) => {
    const read = await api(h, `/v1/capabilities/datasets/city-incidents/records/${id}`, { token: 'admin-token' });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body;
  };

  // --- incidents.comment: append structured comment entries ---
  const commentTarget = await createIncident('Pothole on Le Loi street');
  const firstComment = await run('city-incident-comment', 'incidents', { incident_id: commentTarget, comment: 'Crew dispatched to the site', is_internal: true });
  assert.equal(firstComment.status, 'success', firstComment.error);
  const secondComment = await run('city-incident-comment', 'incidents', { incident_id: commentTarget, comment: 'Patch completed', is_internal: false });
  assert.equal(secondComment.status, 'success', secondComment.error);
  let commentRecord = (await readIncident(commentTarget)).data;
  assert.equal(commentRecord.comments.length, 2);
  assert.equal(commentRecord.comments[0].comment, 'Crew dispatched to the site');
  assert.equal(commentRecord.comments[0].is_internal, true);
  assert.equal(commentRecord.comments[0].user_id, 'member-test');
  assert.equal(commentRecord.comments[1].is_internal, false);
  assert.equal(commentRecord.title, 'Pothole on Le Loi street', 'commenting erased unrelated fields');
  const badComment = await run('city-incident-comment', 'incidents', { incident_id: commentTarget });
  assert.equal(badComment.status, 'error');
  assert.match(String(badComment.error || ''), /comment_required/);

  // --- incidents.visibility: internal clears public_visible ---
  const visibilityTarget = await createIncident('Broken street lamp');
  const visibility = await run('city-incident-visibility', 'incidents', { incident_id: visibilityTarget, visibility: 'internal' });
  assert.equal(visibility.status, 'success', visibility.error);
  let visibilityRecord = (await readIncident(visibilityTarget)).data;
  assert.equal(visibilityRecord.public_visible, false);
  assert.equal(visibilityRecord.title, 'Broken street lamp', 'visibility erased unrelated fields');
  const publicVisibility = await run('city-incident-visibility', 'incidents', { incident_id: visibilityTarget, visibility: 'public' });
  assert.equal(publicVisibility.status, 'success', publicVisibility.error);
  visibilityRecord = (await readIncident(visibilityTarget)).data;
  assert.equal(visibilityRecord.public_visible, true);
  const badVisibility = await run('city-incident-visibility', 'incidents', { incident_id: visibilityTarget, visibility: 'secret' });
  assert.equal(badVisibility.status, 'error');
  assert.match(String(badVisibility.error || ''), /visibility_invalid/);

  // --- incidents.upvote: idempotent per reporter ---
  const upvoteTarget = await createIncident('Flooded alley after storm');
  const firstVote = await run('city-incident-upvote', 'incidents', { incident_id: upvoteTarget });
  assert.equal(firstVote.status, 'success', firstVote.error);
  const afterFirst = await readIncident(upvoteTarget);
  const versionAfterFirst = afterFirst.version;
  assert.equal(afterFirst.data.upvotes, 1);
  assert.deepEqual(afterFirst.data.upvoters, ['member-test']);
  const secondVote = await run('city-incident-upvote', 'incidents', { incident_id: upvoteTarget });
  assert.equal(secondVote.status, 'success', secondVote.error);
  assert.equal(secondVote.output.upvoted, false, 'a second upvote by the same reporter must not count');
  assert.equal(secondVote.output.reason, 'already_upvoted');
  const afterSecond = await readIncident(upvoteTarget);
  assert.equal(afterSecond.data.upvotes, 1, 'upvote is not idempotent per reporter');
  assert.deepEqual(afterSecond.data.upvoters, ['member-test']);
  assert.equal(afterSecond.version, versionAfterFirst, 'the idempotent branch made a second write');

  // --- incidents.merge: close duplicates, annotate the primary ---
  const primary = await createIncident('Sinkhole at the market junction');
  const dupOne = await createIncident('Sinkhole market junction');
  const dupTwo = await createIncident('Sinkhole near market');
  const merge = await run('city-incident-merge', 'incidents', {
    incident_id: primary,
    duplicate_ids: `${dupOne}, ${dupTwo}, ghost-dup`,
    merge_notes: 'Consolidated sinkhole reports',
  });
  assert.equal(merge.status, 'success', merge.error);
  assert.deepEqual(merge.output.closed.sort(), [dupOne, dupTwo].sort());
  assert.equal(merge.output.failed.length, 1);
  assert.equal(merge.output.failed[0].id, 'ghost-dup');
  assert.equal(merge.output.failed[0].error, 'not_found');
  for (const duplicate of [dupOne, dupTwo]) {
    const record = (await readIncident(duplicate)).data;
    assert.equal(record.status, 'closed', `${duplicate} was not closed`);
    assert.equal(record.resolution_type, 'duplicate');
    assert.equal(record.merged_into, primary);
    assert.equal(record.resolution_notes, 'Consolidated sinkhole reports');
    assert.ok(record.title.startsWith('Sinkhole'), 'merge erased the duplicate title');
  }
  let primaryRecord = (await readIncident(primary)).data;
  assert.deepEqual(primaryRecord.merged_reporter_ids, [dupOne, dupTwo].sort());
  assert.equal(primaryRecord.status, 'reported', 'merge changed the primary status');
  const ghost = await api(h, '/v1/capabilities/datasets/city-incidents/records/ghost-dup', { token: 'admin-token' });
  assert.equal(ghost.status, 404, 'the missing duplicate was created');

  // Re-running the merge must not duplicate anything.
  const mergeAgain = await run('city-incident-merge', 'incidents', {
    incident_id: primary,
    duplicate_ids: `${dupOne}, ${dupTwo}`,
  });
  assert.equal(mergeAgain.status, 'success', mergeAgain.error);
  assert.deepEqual(mergeAgain.output.closed.sort(), [dupOne, dupTwo].sort());
  primaryRecord = (await readIncident(primary)).data;
  assert.deepEqual(primaryRecord.merged_reporter_ids, [dupOne, dupTwo].sort(), 're-running the merge duplicated reporter ids');

  const selfMerge = await run('city-incident-merge', 'incidents', { incident_id: primary, duplicate_ids: dupOne + ', ' + primary });
  assert.equal(selfMerge.status, 'error');
  assert.match(String(selfMerge.error || ''), /duplicate_is_primary/);

  // --- maintenance.schedule: anchor a preventive schedule on a work order ---
  const createWorkOrder = async (title: string, completedAt: string | null) => {
    const created = await api(h, '/v1/capabilities/datasets/city-maintenance/records', {
      token: 'admin-token', method: 'POST',
      body: {
        data: {
          type: 'corrective', title, asset_id: 'AST_BRIDGE_1', priority: 'high', status: completedAt ? 'completed' : 'scheduled',
          ...(completedAt ? { completed_at: completedAt } : {}),
        },
        publish: false,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return String(created.body.id);
  };
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
  const overdueAnchor = await createWorkOrder('Quarterly drainage inspection', daysAgo(40));
  const freshAnchor = await createWorkOrder('Lamp housing inspection', daysAgo(0));
  for (const [anchor, cycle] of [[overdueAnchor, 30], [freshAnchor, 90]] as Array<[string, number]>) {
    const schedule = await run('city-maintenance-schedule', 'maintenance', {
      work_order_id: anchor, cycle_days: cycle, warning_days: 7, responsible_team: 'Roads team',
    });
    assert.equal(schedule.status, 'success', schedule.error);
  }
  const overdueRecord = (await api(h, `/v1/capabilities/datasets/city-maintenance/records/${overdueAnchor}`, { token: 'admin-token' })).body;
  assert.equal(overdueRecord.data.preventive_schedule.cycle_days, 30);
  assert.ok(Date.parse(overdueRecord.data.preventive_schedule.next_maintenance_date) < Date.now(), 'the overdue schedule did not anchor on the completion date');

  // --- maintenance.schedule-check: one preventive order per due schedule, once ---
  const preventiveOrders = async () => (await api(h, '/v1/capabilities/datasets/city-maintenance/records/query', {
    token: 'admin-token', method: 'POST', body: { where: { type: 'preventive' }, limit: 100 },
  })).body;
  const firstCheck = await run('city-maintenance-schedule-check', 'maintenance', {}, 'execute');
  assert.equal(firstCheck.status, 'success', firstCheck.error);
  assert.equal(firstCheck.output.created, 1, 'the overdue schedule did not produce exactly one order');
  assert.equal(firstCheck.output.created_ids.length, 1);
  let orders = (await preventiveOrders()).items;
  assert.equal(orders.length, 1, 'the schedule check created more than one order');
  const planned = orders[0];
  assert.equal(String(planned.data.schedule_source_id), overdueAnchor);
  assert.equal(String(planned.data.schedule_run_date), new Date().toISOString().slice(0, 10));
  assert.equal(String(planned.data.status), 'scheduled');
  assert.equal(String(planned.data.priority), 'high', 'the preventive order did not inherit the anchor priority');
  assert.ok(Date.parse(String(planned.data.schedule_next_due)) > Date.now(), 'the order did not advance the next due date');
  assert.notEqual(String((await api(h, `/v1/capabilities/datasets/city-maintenance/records/${freshAnchor}`, { token: 'admin-token' })).body.data.preventive_schedule.next_maintenance_date), undefined, 'the fresh schedule vanished');

  const secondCheck = await run('city-maintenance-schedule-check', 'maintenance', {}, 'execute');
  assert.equal(secondCheck.status, 'success', secondCheck.error);
  assert.equal(secondCheck.output.created, 0, 're-running the check duplicated a preventive order');
  orders = (await preventiveOrders()).items;
  assert.equal(orders.length, 1, 're-running the check created a second order');
  const lookaheadCheck = await run('city-maintenance-schedule-check', 'maintenance', { lookahead_days: 90 }, 'execute');
  assert.equal(lookaheadCheck.status, 'success', lookaheadCheck.error);
  assert.equal(lookaheadCheck.output.created, 1, 'the lookahead window did not pick up the fresh schedule');

  console.log(JSON.stringify({
    passed: true,
    engine: 'real Tier-1',
    capability: 'real DX HTTP routes',
    persistence: 'fake Tier-1 test transport',
    comments: commentRecord.comments.length,
    upvotes: afterSecond.data.upvotes,
    mergedDuplicates: merge.output.closed.length,
    mergeFailures: merge.output.failed.length,
    scheduleOrdersCreated: firstCheck.output.created + lookaheadCheck.output.created,
    scheduleRecheckCreated: secondCheck.output.created,
    productAPICalls: 0,
  }));
} finally {
  globalThis.fetch = originalFetch;
  await h.close();
}
