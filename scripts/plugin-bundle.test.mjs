// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BUNDLE_FORMAT,
    PRODUCT,
    PRODUCT_SPEC,
    bundleChecksum,
    canonicalJson,
    normalizeDxBaseUrl,
    planBundleTarget,
    readBundleFile,
    resolvePluginsPath,
    sameProvenance,
    sanitizeRemoteErrorCode,
    validateBundle,
} from './lib/plugin-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'plugin-bundle.mjs');
const REPO = PRODUCT_SPEC.repository;
const MAIN_RESOURCE = PRODUCT === 'city' ? 'assets' : 'events';
const REMOTE_REPO = PRODUCT === 'city'
    ? 'https://github.com/vku-open-source-2026/SynapseCitySOS'
    : 'https://github.com/vku-open-source-2026/SynapseCity';

function baseBundle(overrides = {}) {
    return {
        format: BUNDLE_FORMAT,
        formatVersion: 1,
        plugin: {
            product: PRODUCT,
            name: 'Test plugin',
            slug: 'test-plugin',
            audience: 'admin',
            roles: ['admin'],
            widgets: [
                { id: 'intro', type: 'text', title: 'Intro', text: 'Plain text only.', width: 'full' },
            ],
            ...(overrides.plugin || {}),
        },
        source: {
            repository: REPO,
            path: 'plugins/test-plugin.plugin.json',
            revision: 'test',
            ...(overrides.source || {}),
        },
        ...(overrides.bundle || {}),
    };
}

test('provenance comparison detects repository, path and revision changes', () => {
    const base = { repository: REPO, path: 'plugins/test-plugin.plugin.json', revision: 'abc' };
    assert.equal(sameProvenance(base, { ...base }), true);
    assert.equal(sameProvenance({ ...base, revision: '' }, { repository: REPO, path: base.path }), true);
    assert.equal(sameProvenance(base, { ...base, repository: REMOTE_REPO }), false);
    assert.equal(sameProvenance(base, { ...base, path: 'plugins/other.plugin.json' }), false);
    assert.equal(sameProvenance(base, { ...base, revision: 'def' }), false);
    assert.equal(sameProvenance(null, base), false);
});

function errorsFor(overrides, options = {}) {
    const result = validateBundle(baseBundle(overrides), { product: PRODUCT, ...options });
    return result.errors;
}

function legacyChecksum(bundle) {
    const payload = {
        format: bundle.format,
        formatVersion: bundle.formatVersion,
        plugin: bundle.plugin,
        source: bundle.source,
    };
    return `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`;
}

test('checked-in bundles are valid and checksummed', () => {
    const files = fs.readdirSync(path.join(ROOT, 'plugins'))
        .filter((name) => name.endsWith('.plugin.json'))
        .map((name) => `plugins/${name}`);
    assert.ok(files.length >= 2);
    for (const file of files) {
        const { parsed, result } = readBundleFile(ROOT, file, { product: PRODUCT, requireChecksum: true });
        assert.deepEqual(result.errors, [], file);
        assert.equal(parsed.plugin.product, PRODUCT);
        assert.equal(parsed.plugin.slug, path.basename(file, '.plugin.json'));
        assert.match(parsed.checksum, /^sha256:[a-f0-9]{64}$/);
    }
});

test('canonical serialization sorts object keys and keeps array order', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, 1], c: { z: true, y: null } }), '{"a":[2,1],"b":1,"c":{"y":null,"z":true}}');
});

test('checksum matches the DX plugin-definition algorithm, not the wrapper', () => {
    const bundle = baseBundle();
    const checksum = bundleChecksum(bundle);
    assert.equal(checksum, 'sha256:81f10915175c2724d63e1a3411a988bfe904b08231e5214757f2bcf24330379d');
    assert.equal(checksum, `sha256:${createHash('sha256').update(canonicalJson(bundle.plugin), 'utf8').digest('hex')}`);
    // DX checksums the layout: widget edits break the seal ...
    bundle.plugin.widgets[0].text = 'Changed text.';
    assert.notEqual(bundleChecksum(bundle), checksum);
    // ... while provenance-only edits (revision/path) do not.
    const provenanceOnly = baseBundle();
    provenanceOnly.source.revision = '2026-11-15';
    provenanceOnly.source.path = 'plugins/renamed.plugin.json';
    assert.equal(bundleChecksum(provenanceOnly), checksum);
    const withChecksum = { ...bundle, checksum };
    assert.ok(validateBundle(withChecksum, { product: PRODUCT }).errors.includes('checksum does not match the plugin definition'));
});

test('legacy full-payload checksums are rejected with a reseal hint', () => {
    const bundle = baseBundle();
    bundle.checksum = legacyChecksum(bundle);
    const result = validateBundle(bundle, { product: PRODUCT });
    assert.ok(result.errors.some((error) => error.includes('legacy full-payload algorithm')));
    assert.ok(result.errors.some((error) => error.includes('reseal')));
});

test('rejects wrong format, product and server-owned plugin keys', () => {
    assert.ok(errorsFor({ bundle: { format: 'other' } }).some((error) => error.includes('format must be')));
    assert.ok(errorsFor({ bundle: { formatVersion: 2 } }).some((error) => error.includes('formatVersion')));
    assert.ok(errorsFor({ plugin: { product: PRODUCT === 'city' ? 'sos' : 'city' } }).some((error) => error.includes('plugin.product')));
    assert.ok(errorsFor({ plugin: { id: 'server-owned' } }).some((error) => error.includes('unknown keys')));
    assert.ok(errorsFor({ bundle: { tenant_id: 'x' } }).some((error) => error.includes('unknown top-level keys')));
});

test('rejects public roles, mixed-product and URL resources', () => {
    assert.ok(errorsFor({ plugin: { roles: ['citizen'] } }).some((error) => error.includes(`unsupported ${PRODUCT} role`)));
    assert.ok(errorsFor({ plugin: { roles: [] } }).some((error) => error.includes('plugin.roles')));
    assert.ok(errorsFor({ plugin: { roles: ['admin', 'admin'] } }).some((error) => error.includes('duplicate role')));
    const urlWidget = { id: 'bad', type: 'metric', title: 'Bad', resource: 'https://evil.example/data' };
    assert.ok(errorsFor({ plugin: { widgets: [urlWidget] } }).some((error) => error.includes('catalog key')));
    const foreignResource = PRODUCT === 'city' ? 'dispatch' : 'assets';
    const foreignWidget = { id: 'bad', type: 'metric', title: 'Bad', resource: foreignResource };
    assert.ok(errorsFor({ plugin: { widgets: [foreignWidget] } }).some((error) => error.includes('catalog key')));
});

test('rejects HTML, control characters and duplicate widget ids', () => {
    const html = { id: 'bad', type: 'text', title: 'Bad', text: '<script>alert(1)</script>' };
    assert.ok(errorsFor({ plugin: { widgets: [html] } }).some((error) => error.includes('plain text')));
    const control = { id: 'bad', type: 'text', title: 'Bad\u0007title', text: 'ok' };
    assert.ok(errorsFor({ plugin: { widgets: [control] } }).some((error) => error.includes('title')));
    const duplicate = [
        { id: 'same', type: 'text', title: 'A', text: 'a' },
        { id: 'same', type: 'text', title: 'B', text: 'b' },
    ];
    assert.ok(errorsFor({ plugin: { widgets: duplicate } }).some((error) => error.includes('duplicated')));
});

test('plain text matches DX: tabs/newlines allowed, URLs and script schemes rejected', () => {
    assert.deepEqual(errorsFor({
        plugin: { widgets: [{ id: 'multi', type: 'text', title: 'Multi', text: 'Line one\nLine two\tend' }] },
    }), []);
    assert.deepEqual(errorsFor({
        plugin: { widgets: [{ id: 'empty', type: 'text', title: 'Empty', text: '' }] },
    }), []);
    for (const text of ['see https://evil.example/x', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
        assert.ok(errorsFor({ plugin: { widgets: [{ id: 'bad', type: 'text', title: 'Bad', text }] } })
            .some((error) => error.includes('plain text')), text);
    }
    assert.ok(errorsFor({ plugin: { name: 'See https://evil.example' } }).some((error) => error.includes('plugin.name')));
    const leaked = 'wsp_abcdefghijklmnopqrstuvwx123456';
    assert.ok(errorsFor({ plugin: { widgets: [{ id: 'tok', type: 'text', title: 'Tok', text: `token ${leaked}` }] } })
        .some((error) => error.includes('plain text')));
});

test('widget kinds reject fields DX rejects', () => {
    const textWithAction = { id: 't', type: 'text', title: 'T', text: 'x', action: 'create' };
    assert.ok(errorsFor({ plugin: { widgets: [textWithAction] } }).some((error) => error.includes('must not define action')));
    const tableWithText = { id: 't', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: ['id'], text: 'x' };
    assert.ok(errorsFor({ plugin: { widgets: [tableWithText] } }).some((error) => error.includes('must not define text')));
    const formWithColumns = {
        id: 'f', type: 'form', title: 'F', resource: MAIN_RESOURCE, columns: ['id'],
        fields: [{ name: 'title', label: 'Title', type: 'text' }],
    };
    assert.ok(errorsFor({ plugin: { widgets: [formWithColumns] } }).some((error) => error.includes('must not define columns')));
    const metricWithFields = {
        id: 'm', type: 'metric', title: 'M', resource: MAIN_RESOURCE,
        fields: [{ name: 'title', label: 'Title', type: 'text' }],
    };
    assert.ok(errorsFor({ plugin: { widgets: [metricWithFields] } }).some((error) => error.includes('must not define fields')));
});

test('bounds widget counts, columns and form fields at DX defaults', () => {
    const widgets = Array.from({ length: 41 }, (_, index) => ({ id: `w${index}`, type: 'text', title: `W${index}`, text: 'x' }));
    assert.ok(errorsFor({ plugin: { widgets } }).some((error) => error.includes('1..40')));
    const twentyOne = Array.from({ length: 21 }, (_, index) => `col${index}`);
    assert.ok(errorsFor({ plugin: { widgets: [{ id: 'table', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: twentyOne }] } })
        .some((error) => error.includes('1..20')));
    const twenty = Array.from({ length: 20 }, (_, index) => `col${index}`);
    assert.deepEqual(errorsFor({ plugin: { widgets: [{ id: 'table', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: twenty }] } }), []);
    const badColumns = { id: 'table', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: ['id', 'id'] };
    assert.ok(errorsFor({ plugin: { widgets: [badColumns] } }).some((error) => error.includes('duplicates')));
    const badColumnName = { id: 'table', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: ['id;drop table'] };
    assert.ok(errorsFor({ plugin: { widgets: [badColumnName] } }).some((error) => error.includes('column identifiers')));
    const upperColumns = { id: 'table', type: 'table', title: 'T', resource: MAIN_RESOURCE, columns: ['Asset_ID'] };
    assert.deepEqual(errorsFor({ plugin: { widgets: [upperColumns] } }), []);
    const badField = {
        id: 'form', type: 'form', title: 'F', resource: MAIN_RESOURCE, action: 'create',
        fields: [{ name: 'title', label: 'Title', type: 'json' }],
    };
    assert.ok(errorsFor({ plugin: { widgets: [badField] } }).some((error) => error.includes('type is not supported')));
    const badAction = {
        id: 'form', type: 'form', title: 'F', resource: MAIN_RESOURCE, action: 'destroy',
        fields: [{ name: 'title', label: 'Title', type: 'text' }],
    };
    assert.ok(errorsFor({ plugin: { widgets: [badAction] } }).some((error) => error.includes('action')));
    const fields31 = Array.from({ length: 31 }, (_, index) => ({ name: `f${index}`, label: `F${index}`, type: 'text' }));
    assert.ok(errorsFor({ plugin: { widgets: [{ id: 'form', type: 'form', title: 'F', resource: MAIN_RESOURCE, fields: fields31 }] } })
        .some((error) => error.includes('1..30')));
    const roles13 = Array.from({ length: 13 }, () => 'admin');
    assert.ok(errorsFor({ plugin: { roles: roles13 } }).some((error) => error.includes('1..12')));
});

test('form fields accept DX identifiers and a missing workflow binding', () => {
    const form = {
        id: 'form', type: 'form', title: 'Create', resource: MAIN_RESOURCE, action: 'create',
        fields: [{ name: 'Field_Name', label: 'Title', type: 'text', required: true }],
    };
    assert.deepEqual(errorsFor({ plugin: { widgets: [form] } }), []);
    const unbound = { ...form, action: undefined, workflowRef: undefined };
    assert.deepEqual(errorsFor({ plugin: { widgets: [unbound] } }), []);
});

test('form widgets may carry a portable workflowRef but never server pins', () => {
    const form = {
        id: 'form', type: 'form', title: 'Create', resource: MAIN_RESOURCE, action: 'create',
        fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
        workflowRef: { name: 'city-incident-create', slug: 'city-incident-create' },
    };
    assert.deepEqual(errorsFor({ plugin: { widgets: [form] } }), []);
    const badSlug = { ...form, workflowRef: { name: 'city-incident-create', slug: 'Bad Slug' } };
    assert.ok(errorsFor({ plugin: { widgets: [badSlug] } }).some((error) => error.includes('workflowRef.slug')));
    const badChecksum = { ...form, workflowRef: { name: 'city-incident-create', checksum: 'sha256:abc' } };
    assert.ok(errorsFor({ plugin: { widgets: [badChecksum] } }).some((error) => error.includes('workflowRef.checksum')));
    const pin = { ...form, workflowArtifactId: 'env-specific-id' };
    assert.ok(errorsFor({ plugin: { widgets: [pin] } }).some((error) => error.includes('unknown keys')));
    const notForm = { ...form, type: 'text', text: 'no', fields: undefined, workflowRef: { name: 'x' } };
    assert.ok(errorsFor({ plugin: { widgets: [notForm] } }).some((error) => error.includes('only valid on a form')));
});

test('slug, name and revision follow the DX schema', () => {
    assert.ok(errorsFor({ plugin: { slug: 'a' } }).some((error) => error.includes('plugin.slug')));
    assert.deepEqual(errorsFor({ plugin: { slug: 'a'.repeat(64) } }), []);
    assert.ok(errorsFor({ plugin: { slug: 'a'.repeat(65) } }).some((error) => error.includes('plugin.slug')));
    assert.ok(errorsFor({ plugin: { name: 'x'.repeat(161) } }).some((error) => error.includes('plugin.name')));
    assert.ok(errorsFor({ plugin: { name: ' padded ' } }).some((error) => error.includes('surrounding whitespace')));
    assert.deepEqual(errorsFor({ source: { revision: 'v1.2.3-rc_1' } }), []);
    assert.ok(errorsFor({ source: { revision: 'release/1.0' } }).some((error) => error.includes('source.revision')));
});

test('provenance must name this repository and a tracked bundle path', () => {
    assert.ok(errorsFor({ source: { repository: 'http://github.com/x/y' } }).some((error) => error.includes('GitHub HTTPS')));
    assert.ok(errorsFor({ source: { repository: REMOTE_REPO } }).some((error) => error.includes('must be this repository')));
    assert.deepEqual(errorsFor({ source: { repository: `${REPO}.git` } }), []);
    assert.ok(errorsFor({ source: { path: 'plugins/../../etc/passwd.json' } }).some((error) => error.includes('safe plugins')));
    assert.ok(errorsFor({ source: { path: '/absolute/plugins/x.json' } }).some((error) => error.includes('safe plugins')));
    assert.ok(errorsFor({ source: { path: 'apps/x.plugin.json' } }).some((error) => error.includes('safe plugins')));
    assert.ok(errorsFor({ source: { path: 'plugins/x.json' } }).some((error) => error.includes('safe plugins')));
    assert.ok(errorsFor({ source: { path: 'plugins/./x.plugin.json' } }).some((error) => error.includes('safe plugins')));
    assert.ok(errorsFor({ source: { revision: 'bad\u0000revision' } }).some((error) => error.includes('revision')));
    assert.ok(validateBundle({ ...baseBundle(), source: undefined }, { product: PRODUCT }).errors.some((error) => error.includes('source is required')));
    assert.ok(errorsFor({ bundle: { checksum: 'sha256:deadbeef' } }).some((error) => error.includes('sha256')));
    const bundle = baseBundle();
    bundle.checksum = 'sha256:' + '0'.repeat(64);
    assert.ok(validateBundle(bundle, { product: PRODUCT }).errors.some((error) => error.includes('does not match')));
    assert.ok(validateBundle(baseBundle(), { product: PRODUCT, requireChecksum: true }).errors.some((error) => error.includes('checksum is required')));
});

test('plugin file paths must stay inside plugins/ and reject traversal segments', () => {
    const checkedIn = fs.readdirSync(path.join(ROOT, 'plugins'))
        .find((name) => name.endsWith('.plugin.json'));
    assert.equal(resolvePluginsPath(ROOT, `plugins/${checkedIn}`), path.join(ROOT, 'plugins', checkedIn));
    for (const candidate of [
        '/etc/passwd.json',
        '../outside.json',
        'plugins/../outside.json',
        'plugins/sub/../../outside.json',
        'plugins/foo/../bar.plugin.json',
        'plugins/./canonical.plugin.json',
        'plugins//double.plugin.json',
        'plugins/not-json.txt',
        'plugins\\windows.json',
        '',
    ]) {
        assert.throws(() => resolvePluginsPath(ROOT, candidate), undefined, candidate);
    }
    assert.throws(() => resolvePluginsPath(ROOT, 'plugins/foo/../bar.plugin.json'), /path_must_not_traverse/);
    assert.throws(() => resolvePluginsPath(ROOT, 'plugins/missing-dir/x.json'), /path_parent_missing/);
    assert.throws(() => readBundleFile(ROOT, 'plugins/missing.plugin.json'), /path_not_found/);

    const link = path.join(ROOT, 'plugins', '.symlink-test.json');
    try {
        fs.symlinkSync(path.join(ROOT, 'package.json'), link);
        assert.throws(() => resolvePluginsPath(ROOT, 'plugins/.symlink-test.json'), /path_symlink_not_allowed/);
    } finally {
        fs.rmSync(link, { force: true });
    }
});

test('planBundleTarget keeps provenance aligned with the tracked path', () => {
    const noSource = baseBundle();
    delete noSource.source;
    delete noSource.checksum;
    const synthesized = planBundleTarget(noSource, { root: ROOT });
    assert.equal(synthesized.relativePath, 'plugins/test-plugin.plugin.json');
    assert.equal(synthesized.bundle.source.repository, REPO);
    assert.equal(synthesized.bundle.source.path, 'plugins/test-plugin.plugin.json');
    assert.equal(synthesized.bundle.checksum, bundleChecksum(noSource));
    assert.deepEqual(validateBundle(synthesized.bundle, { product: PRODUCT, requireChecksum: true }).errors, []);

    const wrongRepo = baseBundle({ source: { repository: REMOTE_REPO } });
    assert.throws(() => planBundleTarget(wrongRepo, { root: ROOT }), /bundle_source_repository_mismatch/);

    const mismatched = baseBundle();
    assert.throws(
        () => planBundleTarget(mismatched, { root: ROOT, out: 'plugins/other.plugin.json' }),
        /bundle_source_path_mismatch/,
    );
    const remapped = planBundleTarget(mismatched, { root: ROOT, out: 'plugins/other.plugin.json', remapSource: true });
    assert.equal(remapped.relativePath, 'plugins/other.plugin.json');
    assert.equal(remapped.bundle.source.path, 'plugins/other.plugin.json');
    assert.equal(remapped.bundle.checksum, bundleChecksum(mismatched));
    assert.equal(remapped.remapped, true);

    const unsafeSourcePath = baseBundle({ source: { path: 'apps/plugin.json' } });
    assert.throws(() => planBundleTarget(unsafeSourcePath, { root: ROOT }), /bundle_source_path_invalid/);
    assert.equal(
        planBundleTarget(unsafeSourcePath, { root: ROOT, out: 'plugins/apps-remap.plugin.json', remapSource: true }).relativePath,
        'plugins/apps-remap.plugin.json',
    );

    const tampered = baseBundle({ bundle: { checksum: 'sha256:' + '1'.repeat(64) } });
    assert.throws(() => planBundleTarget(tampered, { root: ROOT }), /bundle_checksum_mismatch/);

    const crossProduct = baseBundle({ plugin: { product: PRODUCT === 'city' ? 'sos' : 'city' } });
    assert.throws(() => planBundleTarget(crossProduct, { root: ROOT }), /bundle_product_mismatch/);

    assert.throws(() => planBundleTarget(baseBundle({ source: { token: 'wsp_x' } }), { root: ROOT }), /bundle_source_unknown_keys/);
    assert.throws(() => planBundleTarget({ ...baseBundle(), source: 'nope' }, { root: ROOT }), /bundle_source_invalid/);

    const traversal = baseBundle();
    assert.throws(() => planBundleTarget(traversal, { root: ROOT, out: 'plugins/../escape.plugin.json' }), /path_must_not_traverse/);
});

test('remote error codes never echo the token', () => {
    const secret = 'wsp_unit_test_secret_123';
    assert.equal(sanitizeRemoteErrorCode('invalid_token', secret), 'invalid_token');
    assert.equal(sanitizeRemoteErrorCode(`bad ${secret}`, secret), 'bad');
    assert.equal(sanitizeRemoteErrorCode(secret, secret), '');
    assert.equal(sanitizeRemoteErrorCode('error with spaces', secret), '');
    assert.equal(sanitizeRemoteErrorCode('x'.repeat(500), secret), '');
});

test('DX base URL must be public HTTPS without credentials or query', () => {
    assert.equal(normalizeDxBaseUrl('https://synapsedx.sbs/'), 'https://synapsedx.sbs');
    assert.equal(normalizeDxBaseUrl('https://dx.example.test/api/'), 'https://dx.example.test/api');
    for (const candidate of [
        'http://synapsedx.sbs',
        'https://localhost:8443',
        'https://127.0.0.1',
        'https://10.0.0.5',
        'https://192.168.1.10',
        'https://172.16.4.2',
        'https://[::1]',
        'https://[fd00::1]',
        'https://[fe80::1]',
        'https://[::ffff:127.0.0.1]',
        'https://intranet',
        'https://user:pass@synapsedx.sbs',
        'https://synapsedx.sbs?token=abc',
        'https://synapsedx.sbs#fragment',
        'not-a-url',
    ]) {
        assert.throws(() => normalizeDxBaseUrl(candidate), undefined, candidate);
    }
    assert.equal(normalizeDxBaseUrl('https://136.85.84.73'), 'https://136.85.84.73');
    assert.equal(normalizeDxBaseUrl('https://[2001:db8::1]'), 'https://[2001:db8::1]');
});

function runCli(args, env = {}) {
    try {
        const stdout = execFileSync(process.execPath, [CLI, ...args], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stdout, stderr: '' };
    } catch (error) {
        return {
            status: typeof error.status === 'number' ? error.status : 1,
            stdout: String(error.stdout || ''),
            stderr: String(error.stderr || ''),
        };
    }
}

test('CLI check accepts the checked-in bundles', () => {
    const result = runCli(['check', '--require-checksum']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.plugin\.json/);
});

test('CLI check --json writes only parseable JSON to stdout', () => {
    const result = runCli(['check', '--require-checksum', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.product, PRODUCT);
    assert.ok(parsed.bundles.length >= 2);
    assert.ok(parsed.bundles.every((entry) => entry.ok === true));
});

test('CLI check rejects an invalid bundle file', () => {
    const file = path.join(ROOT, 'plugins', '.invalid-test.plugin.json');
    const foreign = PRODUCT === 'city' ? 'sos' : 'city';
    fs.writeFileSync(file, JSON.stringify({
        format: BUNDLE_FORMAT,
        formatVersion: 1,
        plugin: { product: foreign, name: 'Bad', slug: 'bad', audience: 'public', roles: ['citizen'], widgets: [] },
        source: { repository: 'http://evil.example/x', path: '../x.json' },
    }, null, 2));
    try {
        const result = runCli(['check', '--file', 'plugins/.invalid-test.plugin.json']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /error/);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('CLI check rejects a tracked-path/source.path mismatch', () => {
    const file = 'plugins/.provenance-test.plugin.json';
    const bundle = baseBundle({ source: { path: 'plugins/other.plugin.json' } });
    bundle.checksum = bundleChecksum(bundle);
    fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(bundle, null, 2)}\n`);
    try {
        const result = runCli(['check', '--file', file, '--require-checksum']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /must equal the tracked path/);
    } finally {
        fs.rmSync(path.join(ROOT, file), { force: true });
    }
});

test('CLI reseal migrates a legacy checksum without touching the plugin', () => {
    const file = 'plugins/.reseal-test.plugin.json';
    const bundle = baseBundle({ source: { path: file } });
    bundle.checksum = legacyChecksum(bundle);
    const originalPlugin = JSON.parse(JSON.stringify(bundle.plugin));
    fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(bundle, null, 2)}\n`);
    try {
        const reseal = runCli(['reseal', '--file', file]);
        assert.equal(reseal.status, 0, reseal.stderr);
        const sealed = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
        assert.deepEqual(sealed.plugin, originalPlugin);
        assert.equal(sealed.checksum, bundleChecksum(sealed));
        assert.equal(sealed.source.path, file);
        const check = runCli(['check', '--file', file, '--require-checksum']);
        assert.equal(check.status, 0, check.stderr);
        assert.deepEqual(fs.readdirSync(path.join(ROOT, 'plugins')).filter((name) => name.includes('.tmp-')), []);
    } finally {
        fs.rmSync(path.join(ROOT, file), { force: true });
    }
});

test('CLI reseal refuses an invalid bundle and leaves it byte-identical', () => {
    const file = 'plugins/.reseal-invalid-test.plugin.json';
    const bundle = baseBundle({ source: { path: file } });
    bundle.checksum = legacyChecksum(bundle);
    bundle.plugin.widgets[0].script = 'alert(1)';
    const target = path.join(ROOT, file);
    const before = JSON.stringify(bundle, null, 2) + "\n";
    fs.writeFileSync(target, before);
    try {
        const result = runCli(['reseal', '--file', file]);
        assert.equal(result.status, 1);
        assert.equal(fs.readFileSync(target, 'utf8'), before);
        assert.deepEqual(fs.readdirSync(path.join(ROOT, 'plugins')).filter((name) => name.includes('.tmp-')), []);
    } finally {
        fs.rmSync(target, { force: true });
    }
});

test('CLI rejects a path outside plugins/ and a non-HTTPS base URL without leaking the token', () => {
    const outside = runCli(['check', '--file', '/etc/passwd']);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /path_must_be_relative/);

    const secret = 'unit-test-token-must-not-leak';
    const insecure = runCli(['export', '--id', 'abc', '--base-url', 'http://localhost:8080'], { SYNAPSEDX_TOKEN: secret });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /base_url_must_be_https/);
    assert.ok(!`${insecure.stdout}${insecure.stderr}`.includes(secret));
});

test('CLI remote commands require SYNAPSEDX_TOKEN and never print it', () => {
    const secret = 'unit-test-token-must-not-leak';
    const missing = runCli(['export', '--id', 'abc']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /SYNAPSEDX_TOKEN/);

    const file = path.join(ROOT, 'plugins', '.import-test.plugin.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'wrong' }, null, 2));
    try {
        const result = runCli(['import', '--file', 'plugins/.import-test.plugin.json'], { SYNAPSEDX_TOKEN: secret });
        assert.equal(result.status, 1);
        assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('CLI source never runs git or executes bundle content', () => {
    const source = fs.readFileSync(CLI, 'utf8');
    assert.ok(!/child_process|execSync|spawnSync|\bgit\b\s/.test(source.replace(/never runs git/g, '')));
    assert.ok(!/\bimport\s*\(/.test(source), 'must not dynamically import bundle content');
    assert.ok(!/\beval\s*\(/.test(source));
});
