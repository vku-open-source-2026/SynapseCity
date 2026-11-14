#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseCity plugin-bundle sync CLI (Tier 3 -> Tier 2 DX).
 *
 * Commands:
 *   check  [--file plugins/<name>.plugin.json] [--require-checksum] [--json]
 *   reseal [--file plugins/<name>.plugin.json] [--dry-run]
 *   export --id <dxPluginId> [--out plugins/<name>.plugin.json] [--dry-run] [--force] [--remap-source]
 *   import --file plugins/<name>.plugin.json [--dry-run]
 *   sync   --id <dxPluginId> [--out plugins/<name>.plugin.json] [--dry-run] [--remap-source]
 *
 * Remote commands read the DX administrator access token from the
 * `SYNAPSEDX_TOKEN` environment variable and talk HTTPS only. The CLI never
 * prints the token, never runs git, never executes bundle or TSX content and
 * never pushes to a repository.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PRODUCT,
    PRODUCT_SPEC,
    bundleChecksum,
    normalizeDxBaseUrl,
    planBundleTarget,
    readBundleFile,
    resolvePluginsPath,
    sameProvenance,
    sanitizeRemoteErrorCode,
    serializeBundle,
    validateBundle,
} from './lib/plugin-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_API = '/v1/capabilities/workspaces';
const PLUGIN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const USAGE = `SynapseCity plugin bundles (product: ${PRODUCT})

Usage:
  node scripts/plugin-bundle.mjs check  [--file plugins/<name>.plugin.json] [--require-checksum] [--json]
  node scripts/plugin-bundle.mjs reseal [--file plugins/<name>.plugin.json] [--dry-run]
  node scripts/plugin-bundle.mjs export --id <dxPluginId> [--out plugins/<name>.plugin.json] [--dry-run] [--force] [--remap-source]
  node scripts/plugin-bundle.mjs import --file plugins/<name>.plugin.json [--dry-run]
  node scripts/plugin-bundle.mjs sync   --id <dxPluginId> [--out plugins/<name>.plugin.json] [--dry-run] [--remap-source]

Remote options:
  --base-url <url>   DX base URL (default $SYNAPSEDX_BASE_URL or https://synapsedx.sbs; HTTPS only)
  SYNAPSEDX_TOKEN    DX administrator session access token (env only; never printed)

Local paths must stay inside this repository's plugins/ directory. Bundles are
declarative JSON; the CLI never imports or executes bundle content and never
runs git. Checksums cover the canonical \`plugin\` definition, matching DX.
`;

class CliError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

function parseArgs(argv) {
    const flags = {};
    const valueFlags = new Set(['id', 'out', 'file', 'base-url']);
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            flags.help = true;
            continue;
        }
        if (!arg.startsWith('--')) throw new CliError(`unexpected argument: ${arg}`, 2);
        const name = arg.slice(2);
        if (valueFlags.has(name)) {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) throw new CliError(`--${name} requires a value`, 2);
            flags[name] = value;
            index += 1;
            continue;
        }
        if (['dry-run', 'force', 'json', 'require-checksum', 'remap-source'].includes(name)) {
            flags[name] = true;
            continue;
        }
        throw new CliError(`unknown option: --${name}`, 2);
    }
    return flags;
}

function readToken() {
    const token = (process.env.SYNAPSEDX_TOKEN || '').trim();
    if (!token) throw new CliError('SYNAPSEDX_TOKEN is required for remote operations (export/import/sync)', 2);
    return token;
}

function baseUrl(flags) {
    return normalizeDxBaseUrl(flags['base-url'] || process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs');
}

function repoRelative(file) {
    return path.relative(ROOT, file).split(path.sep).join('/');
}

function trackedPath(file) {
    return repoRelative(resolvePluginsPath(ROOT, file));
}

function localBundles() {
    const pluginsDir = path.join(ROOT, 'plugins');
    if (!fs.existsSync(pluginsDir)) return [];
    return fs.readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.plugin.json'))
        .map((entry) => `plugins/${entry.name}`)
        .sort();
}

function validateLocal(file, flags) {
    const { parsed, result } = readBundleFile(ROOT, file, {
        product: PRODUCT,
        requireChecksum: Boolean(flags['require-checksum']),
    });
    return { parsed, result };
}

function reportValidation(label, result) {
    for (const warning of result.warnings) console.warn(`warn  ${label}: ${warning}`);
    for (const error of result.errors) console.error(`error ${label}: ${error}`);
}

function addProvenanceError(result, relative, parsed) {
    if (result.ok && parsed?.source?.path !== relative) {
        result.ok = false;
        result.errors.push(`source.path "${String(parsed?.source?.path ?? '')}" must equal the tracked path "${relative}"`);
    }
}

function writeBundle(relativePath, bundle) {
    const target = resolvePluginsPath(ROOT, relativePath);
    const directory = path.dirname(target);
    const temp = path.join(
        directory,
        `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
    );
    let descriptor;
    try {
        descriptor = fs.openSync(temp, 'wx');
        fs.writeFileSync(descriptor, serializeBundle(bundle));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temp, target);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* best effort */ }
        }
        try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
        throw error;
    }
    return target;
}

async function dxRequest(base, token, method, route, body) {
    let response;
    try {
        response = await fetch(`${base}${WORKSPACE_API}${route}`, {
            method,
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            // Never follow a redirect: it could move the bearer token to
            // another origin. A public HTTPS DX endpoint answers directly.
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: AbortSignal.timeout(20_000),
        });
    } catch (error) {
        throw new CliError(`DX request failed: ${error instanceof Error ? error.name : 'network_error'}`);
    }
    const declared = Number(response.headers.get('content-length') || '');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new CliError('DX response is too large');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new CliError('DX response is too large');
    }
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
    }
    return { status: response.status, body: parsed };
}

function remoteError(action, response, token) {
    const raw = response.body && typeof response.body === 'object'
        ? String(response.body.error || response.body.code || '')
        : '';
    const code = sanitizeRemoteErrorCode(raw, token);
    return new CliError(`${action} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`);
}

async function exportBundle(flags) {
    if (!flags.id) throw new CliError('export requires --id <dxPluginId>', 2);
    if (!PLUGIN_ID_RE.test(flags.id)) throw new CliError('--id contains unsupported characters', 2);

    const token = readToken();
    const base = baseUrl(flags);
    const response = await dxRequest(base, token, 'GET', `/plugins/${encodeURIComponent(flags.id)}/export`);
    if (response.status !== 200) throw remoteError('export', response, token);

    const body = response.body;
    if (body && typeof body === 'object' && 'bundle' in body && !('format' in body)) {
        throw new CliError('export response must be the bundle itself, not a wrapper object');
    }
    const plan = planBundleTarget(body, {
        root: ROOT,
        out: flags.out,
        remapSource: Boolean(flags['remap-source']),
    });
    const result = validateBundle(plan.bundle, { product: PRODUCT, requireChecksum: true });
    if (!result.ok) {
        reportValidation(plan.relativePath, result);
        throw new CliError('DX export did not produce a valid bundle');
    }
    if (plan.remapped) {
        console.warn(`warn  ${plan.relativePath}: provenance source.path was remapped from the DX snapshot`);
    }
    return { bundle: plan.bundle, checksum: plan.bundle.checksum, relativePath: plan.relativePath };
}

async function runCheck(flags) {
    const files = flags.file ? [flags.file] : localBundles();
    if (files.length === 0) throw new CliError('no plugins/*.plugin.json bundles found');
    const summary = [];
    let failed = false;
    for (const file of files) {
        const relative = trackedPath(file);
        const { parsed, result } = validateLocal(relative, flags);
        addProvenanceError(result, relative, parsed);
        reportValidation(relative, result);
        const entry = {
            file: relative,
            product: PRODUCT_SPEC.product,
            ok: result.ok,
            widgets: Array.isArray(parsed?.plugin?.widgets) ? parsed.plugin.widgets.length : 0,
            checksum: result.checksum || (result.ok ? bundleChecksum(parsed) : undefined),
        };
        summary.push(entry);
        if (!result.ok) {
            failed = true;
        } else if (!flags.json) {
            console.log(`ok    ${relative} (${entry.widgets} widgets, ${entry.checksum})`);
        }
    }
    if (flags.json) {
        const safe = summary.map((entry) => ({ ...entry, checksum: entry.ok ? entry.checksum : undefined }));
        console.log(JSON.stringify({ product: PRODUCT, bundles: safe }, null, 2));
    }
    if (failed) throw new CliError('one or more plugin bundles are invalid');
}

async function runReseal(flags) {
    const files = flags.file ? [flags.file] : localBundles();
    if (files.length === 0) throw new CliError('no plugins/*.plugin.json bundles found');
    let failed = false;
    for (const file of files) {
        const relative = trackedPath(file);
        const { parsed } = readBundleFile(ROOT, relative, { product: PRODUCT });
        const checksum = bundleChecksum(parsed);
        const candidate = { ...parsed, checksum };
        const result = validateBundle(candidate, { product: PRODUCT, requireChecksum: true });
        addProvenanceError(result, relative, candidate);
        if (!result.ok) {
            reportValidation(relative, result);
            failed = true;
            continue;
        }
        if (parsed.checksum === checksum) {
            console.log(`sealed ${relative} (${checksum})`);
            continue;
        }
        if (flags['dry-run']) {
            console.log(`dry-run reseal ${relative}: ${parsed.checksum || 'no checksum'} -> ${checksum}`);
            continue;
        }
        writeBundle(relative, candidate);
        console.log(`${parsed.checksum ? 'resealed' : 'sealed'} ${relative} (${checksum})`);
    }
    if (failed) throw new CliError('one or more plugin bundles are invalid');
}

async function runExport(flags) {
    const { bundle, checksum, relativePath } = await exportBundle(flags);
    const target = resolvePluginsPath(ROOT, relativePath);
    if (fs.existsSync(target) && !flags.force) {
        throw new CliError(`${relativePath} already exists; pass --force to overwrite it`);
    }
    if (flags['dry-run']) {
        console.log(`dry-run export ${flags.id}: valid ${PRODUCT} bundle (${bundle.plugin.slug}, ${bundle.plugin.widgets.length} widgets) -> ${relativePath}`);
        return;
    }
    writeBundle(relativePath, bundle);
    console.log(`exported ${flags.id} -> ${relativePath} (${checksum})`);
    console.log('Review the diff before committing. This CLI never runs git.');
}

async function runImport(flags) {
    if (!flags.file) throw new CliError('import requires --file plugins/<name>.plugin.json', 2);
    const token = readToken();
    const base = baseUrl(flags);
    const relative = trackedPath(flags.file);
    const { parsed, result } = validateLocal(relative, flags);
    addProvenanceError(result, relative, parsed);
    reportValidation(relative, result);
    if (!result.ok) throw new CliError('refusing to import an invalid bundle');
    if (flags['dry-run']) {
        console.log(`dry-run import ${relative}: valid ${PRODUCT} bundle (${parsed.plugin.slug}, ${parsed.plugin.widgets.length} widgets)`);
        return;
    }
    const response = await dxRequest(base, token, 'POST', '/import', parsed);
    if (response.status !== 200 && response.status !== 201) throw remoteError('import', response, token);
    const created = response.body && typeof response.body === 'object' ? response.body : {};
    const id = String(created.id || '').slice(0, 128);
    const slug = String(created.slug || parsed.plugin.slug).slice(0, 80);
    const status = String(created.status || 'draft').slice(0, 40);
    console.log(`imported ${relative} -> DX draft ${slug}${id ? ` (id ${id})` : ''} [${status}]`);
    console.log('The imported plugin is a DRAFT; install/publish it from the DX admin UI.');
}

async function runSync(flags) {
    if (!flags.id) throw new CliError('sync requires --id <dxPluginId>', 2);
    const { bundle, checksum, relativePath } = await exportBundle(flags);
    const target = resolvePluginsPath(ROOT, relativePath);

    let localParsed = null;
    let localResult = null;
    if (fs.existsSync(target)) {
        try {
            localParsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        } catch {
            console.warn(`warn  ${relativePath}: local bundle is not valid JSON and will be replaced`);
        }
        if (localParsed !== null) {
            localResult = validateBundle(localParsed, { product: PRODUCT });
            if (!localResult.ok) {
                reportValidation(relativePath, localResult);
                console.warn(`warn  ${relativePath}: local bundle is invalid and will be replaced by the DX snapshot`);
            }
        }
    }
    if (localParsed !== null && localResult?.ok && localParsed.checksum === checksum
        && sameProvenance(localParsed.source, bundle.source)) {
        console.log(`in-sync ${relativePath} (${checksum})`);
        return;
    }
    if (flags['dry-run']) {
        console.log(`dry-run sync ${flags.id}: ${relativePath} would be updated (${checksum})`);
        return;
    }
    writeBundle(relativePath, bundle);
    console.log(`updated ${relativePath} from DX snapshot (${checksum})`);
    console.log('Review the diff before committing. This CLI never runs git.');
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseArgs(rest);
    if (!command || command === 'help' || flags.help) {
        console.log(USAGE);
        return 0;
    }
    switch (command) {
        case 'check':
            await runCheck(flags);
            return 0;
        case 'reseal':
            await runReseal(flags);
            return 0;
        case 'export':
            await runExport(flags);
            return 0;
        case 'import':
            await runImport(flags);
            return 0;
        case 'sync':
            await runSync(flags);
            return 0;
        default:
            throw new CliError(`unknown command: ${command}`, 2);
    }
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        if (error instanceof CliError) {
            console.error(`error: ${error.message}`);
            process.exitCode = error.exitCode;
        } else {
            // Never dump an exception that could embed a token or full response.
            // Emit a short snake_case message produced by our own validators;
            // anything else (network, fs, unexpected) is reduced to its name.
            const message = error instanceof Error ? error.message : '';
            const safe = /^[a-z][a-z0-9_]*(?:: .{0,180})?$/s.test(message);
            console.error(`error: ${safe ? message : (error instanceof Error ? error.name : 'unexpected_error')}`);
            process.exitCode = 1;
        }
    });
