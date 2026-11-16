import { studioActionError, actionReferenceErrors } from "./studio-actions.mjs";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseCity plugin-bundle validation and sync helpers.
 *
 * These helpers are the executable form of the workspace plugin contract
 * (`WORKSPACE_PLUGIN_CONTRACT.md`) and mirror the Tier-2 SynapseDX workspace
 * schema so a bundle exported by DX validates here and a bundle tracked here
 * validates in DX. Product code stays in this repository; the bundle only
 * names catalog resource keys and widgets.
 *
 * Rules enforced here:
 * - strict schema (unknown keys rejected) and product ownership (`city`);
 * - provenance must name this repository and a `plugins/*.plugin.json` path;
 * - no public/anonymous roles, no mixed-product resources, no arbitrary URLs;
 * - bounded widget/field/column counts and plain-text titles/text;
 * - safe repository-relative paths inside `plugins/`;
 * - HTTPS-only DX base URL with no credentials, query or localhost/private IP;
 * - `checksum` (`sha256:<hex>`) over the canonical JSON of `plugin`, which is
 *   exactly what DX stores and verifies on import.
 *
 * This module never imports or executes bundle content, never runs git and
 * never prints a token.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUNDLE_FORMAT = 'synapsedx-plugin';
export const BUNDLE_FORMAT_VERSION = 1;
export const PLUGIN_SOURCE_FORMAT = 'synapsedx-plugin-source';

export const PRODUCT = 'city';

/** Repository provenance and role/resource allow-lists for this product. */
export const PRODUCT_SPEC = {
    product: 'city',
    repository: 'https://github.com/vku-open-source-2026/SynapseCity',
    publicOrigin: 'https://synapsecity.sbs',
    /** Non-public City roles that may receive a workspace plugin. */
    roles: ['admin', 'manager', 'technician', 'volunteer'],
    /** Catalog resource keys owned by City. Values are never URLs. */
    resources: [
        'assets', 'incidents', 'maintenance', 'iot', 'iotReadings', 'alerts',
        'budgets', 'budgetTransactions', 'reports', 'users', 'geofences', 'ingest',
        'files', 'notifications',
    ],
};

/**
 * Defaults match `workspaceLimits()` in the Tier-2 capabilities service. The
 * local limits may be stricter for authoring, never looser than the default DX
 * schema, so a bundle validated here is accepted by a default DX deployment.
 */
export const LIMITS = {
    maxFileBytes: 1024 * 1024,
    maxWidgets: 64,
    maxColumns: 20,
    maxFields: 30,
    maxRoles: 12,
    maxTextLength: 4000,
    maxTitleLength: 200,
};

const BUNDLE_KEYS = new Set(['format', 'formatVersion', 'plugin', 'source', 'checksum']);
const PLUGIN_KEYS = new Set(['product', 'name', 'slug', 'audience', 'roles', 'widgets']);
const SOURCE_KEYS = new Set(['repository', 'path', 'revision']);
const COMMON_RESOURCES = ['commonProjects', 'commonTasks', 'commonWorkspaces', 'commonPages', 'commonInbox', 'commonComments', 'commonForms', 'commonProcesses', 'commonProcessInstances', 'commonReports', 'commonDashboards', 'commonFiles', 'commonOcr', 'commonPeople', 'commonKpis', 'commonTimesheets', 'commonAgents', 'commonAgentRuns', 'commonKnowledge', 'commonAssistant', 'commonApprovals'];
const WIDGET_KEYS = new Set(['onLoad','onSubmit','onRowClick','onChange','onExport','chartType','aggregation','operation','onClick','code','section','presentation','groupBy','groups','updateForm','id', 'type', 'title', 'text', 'resource', 'columns', 'fields', 'action', 'width', 'workflowRef', 'links', 'value', 'module']);
const FIELD_KEYS = new Set(['name','label','type','required','options','optionsResource','optionsAction','uploadAction','editor','selectionPath','accept','maxBytes','defaultValue']);
const WORKFLOW_REF_KEYS = new Set(['name', 'slug', 'checksum']);
const FIELD_TYPES = new Set(['text','number','textarea','select','date','datetime-local','checkbox','email','json','markdown','file']);
const WIDGET_ACTIONS = new Set(['create', 'update', 'delete', 'execute']);
const WIDGET_TYPES = new Set(['text', 'metric', 'table', 'form', 'heading', 'divider', 'alert', 'navigation', 'button', 'tabs', 'progress', 'chart', 'list', 'map', 'kanban', 'timeline', 'markdown', 'capability', 'code', 'action']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_PATH_RE = /^[A-Za-z0-9._/-]{1,300}$/;
const SOURCE_REVISION_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CHECKSUM_RE = /^sha256:[a-f0-9]{64}$/;
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
// Same policy as DX `plainText`: tab/newline are allowed, other control
// characters and angle brackets are not.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_SCHEME_RE = /(?:javascript|vbscript|data|file|mailto|tel)\s*:/i;
const ANY_URL_SCHEME_RE = /\b[a-z][a-z0-9+.-]*:\/\//i;
// A DX workspace runtime token must never travel inside portable content.
const SECRET_TOKEN_RE = /\bwsp_[A-Za-z0-9_-]{16,}/;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(object, allowed) {
    return Object.keys(object).every((key) => allowed.has(key));
}

function isText(value, maxLength, options = {}) {
    if (typeof value !== 'string') return false;
    if (!options.allowEmpty && value.trim().length === 0) return false;
    if (value.length > maxLength) return false;
    if (/[<>]/.test(value)) return false;
    if (CONTROL_RE.test(value)) return false;
    if (UNSAFE_SCHEME_RE.test(value) || ANY_URL_SCHEME_RE.test(value)) return false;
    if (SECRET_TOKEN_RE.test(value)) return false;
    return true;
}

/** Deterministic JSON with lexicographically sorted object keys. */
export function canonicalJson(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Canonical checksum payload. DX checksums the portable plugin definition, not
 * the provenance wrapper, so a revision bump does not invalidate the identity
 * of the imported layout.
 */
export function checksumPayload(bundle) {
    return isPlainObject(bundle) ? bundle.plugin : null;
}

/** `sha256:<hex>` over the canonical JSON of `plugin` (DX-compatible). */
export function bundleChecksum(bundle) {
    const digest = createHash('sha256').update(canonicalJson(checksumPayload(bundle)), 'utf8').digest('hex');
    return `sha256:${digest}`;
}

/**
 * The pre-2026-11-14 local algorithm hashed the whole wrapper. It is only used
 * to explain a stale checksum, never to accept one.
 */
function legacyFullPayloadChecksum(bundle) {
    const payload = {
        format: bundle.format,
        formatVersion: bundle.formatVersion,
        plugin: bundle.plugin,
        source: bundle.source,
    };
    return `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`;
}

/** Normalize a GitHub repository URL for provenance comparison. */
export function normalizeRepositoryUrl(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/** True when `value` names the same repository as this product's repo. */
export function repositoryMatches(value, expected = PRODUCT_SPEC.repository) {
    return normalizeRepositoryUrl(value) === normalizeRepositoryUrl(expected);
}

/** Compare portable provenance before reporting a sync as already in-sync. */
export function sameProvenance(left, right) {
    const a = isPlainObject(left) ? left : {};
    const b = isPlainObject(right) ? right : {};
    return a.repository === b.repository
        && a.path === b.path
        && (a.revision ?? '') === (b.revision ?? '');
}

/**
 * Validate a repository-relative plugin file path.
 * Only `plugins/**.json` inside `root` is accepted; absolute paths, `..`
 * traversal, backslashes, symlinked files and symlinked parent directories that
 * escape `plugins/` are rejected.
 */
export function resolvePluginsPath(root, candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('path_required');
    if (candidate.includes('\0')) throw new Error('path_invalid');
    if (candidate.includes('\\')) throw new Error('path_must_use_forward_slashes');
    if (path.isAbsolute(candidate)) throw new Error('path_must_be_relative');

    const relative = candidate.replace(/^(?:\.\/)+/, '');
    if (relative.includes('//')) throw new Error('path_invalid');
    if (relative.split('/').includes('..')) throw new Error('path_must_not_traverse');
    if (relative.split('/').includes('.')) throw new Error('path_must_be_canonical');

    const pluginsRoot = path.resolve(root, 'plugins');
    const resolved = path.resolve(root, relative);
    if (resolved !== pluginsRoot && !resolved.startsWith(`${pluginsRoot}${path.sep}`)) {
        throw new Error('path_outside_plugins');
    }
    if (!resolved.endsWith('.json')) throw new Error('path_must_end_with_json');

    const realPluginsRoot = fs.existsSync(pluginsRoot) ? fs.realpathSync(pluginsRoot) : pluginsRoot;
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) throw new Error('path_parent_missing');
    const realParent = fs.realpathSync(parent);
    if (realParent !== realPluginsRoot && !realParent.startsWith(`${realPluginsRoot}${path.sep}`)) {
        throw new Error('path_symlink_escape');
    }
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
        throw new Error('path_symlink_not_allowed');
    }
    return resolved;
}

/** Validate a public HTTPS DX base URL. */
export function normalizeDxBaseUrl(value, fallback = 'https://synapsedx.sbs') {
    const raw = String(value || fallback).trim();
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('base_url_invalid');
    }
    if (url.protocol !== 'https:') throw new Error('base_url_must_be_https');
    if (url.username || url.password) throw new Error('base_url_must_not_contain_credentials');
    if (url.search || url.hash) throw new Error('base_url_must_not_contain_query_or_fragment');
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]' || host === '::1') {
        throw new Error('base_url_must_be_public');
    }
    if (host.startsWith('[') && host.endsWith(']')) {
        const address = host.slice(1, -1);
        const first = address.split(':')[0];
        if (!address || address === '::' || address === '::1' || address.startsWith('::ffff:')) {
            throw new Error('base_url_must_be_public');
        }
        if (/^f[cd][0-9a-f]{0,2}$/.test(first)) throw new Error('base_url_must_be_public'); // fc00::/7
        if (/^fe[89ab][0-9a-f]$/.test(first)) throw new Error('base_url_must_be_public'); // fe80::/10
    } else if (!host.includes('.')) {
        // A single-label host is an intranet/Docker name, never a public DX.
        throw new Error('base_url_must_be_public');
    }
    if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) throw new Error('base_url_must_be_public');
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw new Error('base_url_must_be_public');
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

/** Keep a short remote error code without ever echoing a token. */
export function sanitizeRemoteErrorCode(value, secret) {
    // Reject an over-long message instead of truncating it: a truncation could
    // cut through a token and echo a fragment of the secret.
    if (typeof value !== 'string' || value.length > 120) return '';
    const redacted = (secret ? value.split(secret).join('') : value).trim();
    return /^[A-Za-z0-9_.:-]{1,120}$/.test(redacted) ? redacted : '';
}

/** A tracked bundle path: `plugins/<name>.plugin.json`, no traversal. */
export function isSafeBundlePath(value) {
    return typeof value === 'string'
        && value.startsWith('plugins/')
        && value.endsWith('.plugin.json')
        && SOURCE_PATH_RE.test(value)
        && !value.includes('//')
        && !value.split('/').includes('..')
        && !value.split('/').includes('.');
}

function validateSource(source, errors) {
    if (!isPlainObject(source)) {
        errors.push('source is required: a repository bundle must carry provenance');
        return;
    }
    if (!hasOnlyKeys(source, SOURCE_KEYS)) errors.push('source has unknown keys');
    if (typeof source.repository !== 'string' || !GITHUB_RE.test(source.repository)) {
        errors.push('source.repository must be a public GitHub HTTPS URL');
    } else if (!repositoryMatches(source.repository)) {
        errors.push(`source.repository must be this repository (${PRODUCT_SPEC.repository})`);
    }
    if (!isSafeBundlePath(source.path)) {
        errors.push('source.path must be a safe plugins/*.plugin.json path');
    }
    if (source.revision !== undefined && (typeof source.revision !== 'string' || !SOURCE_REVISION_RE.test(source.revision))) {
        errors.push('source.revision must be 1..100 characters of A-Z a-z 0-9 . _ -');
    }
}

function validateWorkflowRef(ref, label, errors) {
    if (!isPlainObject(ref)) {
        errors.push(`${label} must be an object`);
        return;
    }
    if (!hasOnlyKeys(ref, WORKFLOW_REF_KEYS)) errors.push(`${label} has unknown keys`);
    if (!isText(ref.name, 160)) errors.push(`${label}.name must be plain text`);
    if (ref.slug !== undefined && (typeof ref.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(ref.slug))) {
        errors.push(`${label}.slug has an unsupported format`);
    }
    if (ref.checksum !== undefined && (typeof ref.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(ref.checksum))) {
        errors.push(`${label}.checksum must be 64 lowercase hex characters`);
    }
}

function validateWidget(widget, index, errors, seenIds) {
    const label = `widgets[${index}]`;
    if (!isPlainObject(widget)) {
        errors.push(`${label} must be an object`);
        return;
    }
    if (!hasOnlyKeys(widget, WIDGET_KEYS)) errors.push(`${label} has unknown keys`);
    if (typeof widget.id !== 'string' || !WIDGET_ID_RE.test(widget.id)) {
        errors.push(`${label}.id must be a lower-case slug`);
    } else if (seenIds.has(widget.id)) {
        errors.push(`${label}.id is duplicated`);
    } else {
        seenIds.add(widget.id);
    }
    if (!WIDGET_TYPES.has(widget.type)) errors.push(`${label}.type is not supported`);
    if (!isText(widget.title, LIMITS.maxTitleLength)) errors.push(`${label}.title must be plain text`);
    if (widget.width !== undefined && !['full','half','third','quarter'].includes(widget.width)) {
        errors.push(`${label}.width must be full or half`);
    }

    const textTypes = ['text', 'heading', 'alert','markdown'];
    const navTypes = ['navigation', 'button', 'tabs'];
    const allowed = new Set(['id','type','title','width','section']);
    if(widget.section!==undefined&&(typeof widget.section!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(widget.section)))errors.push(`${label}.section is invalid`);
    if(widget.presentation!==undefined&&!['inline','dialog'].includes(widget.presentation))errors.push(`${label}.presentation is invalid`);
    if(widget.type==='kanban'){for(const key of ['groupBy','groups','updateForm'])allowed.add(key);if(widget.groupBy!==undefined&&(!FIELD_NAME_RE.test(widget.groupBy)||!widget.columns?.includes(widget.groupBy)))errors.push(`${label}.groupBy must name a declared column`);if(widget.updateForm!==undefined&&!WIDGET_ID_RE.test(widget.updateForm))errors.push(`${label}.updateForm is invalid`);if(widget.groups!==undefined&&(!Array.isArray(widget.groups)||widget.groups.length>20||widget.groups.some(value=>!isText(value,80))))errors.push(`${label}.groups is invalid`);}
    for(const [event,types] of Object.entries({onLoad:['metric','table','chart','list','map','kanban','timeline'],onSubmit:['form'],onRowClick:['table','list','map','kanban','timeline'],onChange:['kanban'],onExport:['table','list','map','kanban','timeline']}))if(types.includes(widget.type)){allowed.add(event);if(widget[event]!==undefined&&(typeof widget[event]!=='string'||!WIDGET_ID_RE.test(widget[event])))errors.push(event+' must reference a named action');}
    if(widget.type==='chart'){allowed.add('chartType');allowed.add('aggregation');if(widget.chartType!==undefined&&!['bar','line','area','pie','donut'].includes(widget.chartType))errors.push('Invalid chart type');if(widget.aggregation!==undefined&&!['none','count','sum','average'].includes(widget.aggregation))errors.push('Invalid aggregation');}
    if (textTypes.includes(widget.type)) allowed.add('text');
    if (navTypes.includes(widget.type)) allowed.add('links');
    if (widget.type === 'progress') allowed.add('value');
    if (widget.type === 'action') allowed.add('operation');
    if (widget.type === 'button') allowed.add('onClick');
    if (widget.type === 'code') allowed.add('code');
    if (widget.type === 'capability') allowed.add('module');
    if (['metric', 'table', 'chart', 'list', 'map', 'kanban', 'timeline', 'form'].includes(widget.type)) allowed.add('resource');
    if (['table', 'chart', 'list', 'map', 'kanban', 'timeline'].includes(widget.type)) allowed.add('columns');
    if (widget.type === 'form') for (const key of ['fields','action','workflowRef','presentation']) allowed.add(key);
    for (const key of Object.keys(widget)) if (!allowed.has(key)) errors.push(`${label} ${widget.type} widget must not define ${key}`);
    if (widget.type === 'action') {
      const issue=studioActionError(widget.operation);
      if(issue) errors.push(issue);
      return;
    }
    if(widget.type==='button' && widget.onClick!==undefined && (typeof widget.onClick!=='string'||!WIDGET_ID_RE.test(widget.onClick)))errors.push('Invalid button action id');
    if (widget.type === 'code') {
      const code = widget.code;
      if (!isPlainObject(code) || !hasOnlyKeys(code,new Set(['html','css','javascript','inputs','actions','height']))) { errors.push(`${label}.code is invalid`); return; }
      for (const key of ['html','css','javascript']) if(typeof code[key]!=='string' || code[key].length>32768 || code[key].includes('\0')) errors.push(`${label}.code.${key} exceeds source limits`);
      if(['html','css','javascript'].reduce((n,key)=>n+(typeof code[key]==='string'?code[key].length:0),0)>65536)errors.push(`${label}.code exceeds combined source limit`);
      for(const key of ['inputs','actions']) if(!Array.isArray(code[key]) || code[key].length>20 || code[key].some(id=>typeof id!=='string'||!WIDGET_ID_RE.test(id)) || new Set(code[key]).size!==code[key].length) errors.push(`${label}.code.${key} must contain up to 20 unique widget ids`);
      if(!Number.isInteger(code.height)||code.height<120||code.height>1200)errors.push(`${label}.code.height must be 120..1200`);
      return;
    }
    if (widget.type === 'capability') { if (!['inbox', 'workspace', 'people', 'projects', 'tasks', 'forms', 'reports', 'quality', 'ocr', 'agents', 'assistant'].includes(widget.module)) errors.push(`${label}.module is not allowed`); return; }
    if (['heading', 'alert', 'markdown', 'divider', 'progress', ...navTypes].includes(widget.type)) {
        if (textTypes.includes(widget.type) && widget.text !== undefined && !isText(widget.text, LIMITS.maxTextLength, { allowEmpty: true })) errors.push(`${label}.text must be plain text`);
        if (widget.type === 'progress' && (typeof widget.value !== 'number' || !Number.isFinite(widget.value) || widget.value < 0 || widget.value > 100)) errors.push(`${label}.value must be 0..100`);
        if (navTypes.includes(widget.type) && !widget.onClick) {
            const modules = ['inbox', 'workspace', 'people', 'projects', 'tasks', 'forms', 'reports', 'quality', 'ocr', 'agents', 'assistant'];
            if (!Array.isArray(widget.links) || widget.links.length < 1 || widget.links.length > 12) errors.push(`${label}.links must contain 1..12 destinations`);
            else widget.links.forEach((link) => {
                if (!isPlainObject(link) || link.actionId!==undefined&&(typeof link.actionId!=='string'||!WIDGET_ID_RE.test(link.actionId)) || !hasOnlyKeys(link, new Set(['label', 'target', 'actionId'])) || !isText(link.label, 80) || typeof link.target !== 'string' || (!/^(page|section):[a-z0-9][a-z0-9-]{1,63}$/.test(link.target) && !(link.target.startsWith('module:') && modules.includes(link.target.slice(7))))) errors.push(`${label} has an invalid navigation destination`);
            });
        }
        return;
    }

    if (widget.type === 'text') {
        if (widget.text !== undefined && !isText(widget.text, LIMITS.maxTextLength, { allowEmpty: true })) {
            errors.push(`${label}.text must be plain text`);
        }
        for (const key of ['resource', 'columns', 'fields', 'action']) {
            if (widget[key] !== undefined) errors.push(`${label} text widget must not define ${key}`);
        }
        if (widget.workflowRef !== undefined) errors.push(`${label}.workflowRef is only valid on a form widget`);
        return;
    }

    if (widget.text !== undefined) errors.push(`${label} ${widget.type} widget must not define text`);
    if (!PRODUCT_SPEC.resources.includes(widget.resource)&&!COMMON_RESOURCES.includes(widget.resource)) {
        errors.push(`${label}.resource must be a ${PRODUCT} catalog key`);
    }

    if (widget.type === 'metric') {
        for (const key of ['columns', 'fields', 'action']) {
            if (widget[key] !== undefined) errors.push(`${label} metric widget must not define ${key}`);
        }
        if (widget.workflowRef !== undefined) errors.push(`${label}.workflowRef is only valid on a form widget`);
        return;
    }

    if (['table', 'chart', 'list', 'map', 'kanban', 'timeline'].includes(widget.type)) {
        if (widget.action !== undefined) errors.push(`${label} table widget must not define action`);
        if (widget.fields !== undefined) errors.push(`${label} table widget must not define fields`);
        if (!Array.isArray(widget.columns) || widget.columns.length === 0 || widget.columns.length > LIMITS.maxColumns) {
            errors.push(`${label}.columns must contain 1..${LIMITS.maxColumns} entries`);
        } else if (!widget.columns.every((column) => typeof column === 'string' && FIELD_NAME_RE.test(column))) {
            errors.push(`${label}.columns must be column identifiers`);
        } else if (new Set(widget.columns).size !== widget.columns.length) {
            errors.push(`${label}.columns contains duplicates`);
        }
        if (widget.workflowRef !== undefined) errors.push(`${label}.workflowRef is only valid on a form widget`);
        return;
    }

    // form
    if (widget.columns !== undefined) errors.push(`${label} form widget must not define columns`);
    if (widget.action !== undefined && !WIDGET_ACTIONS.has(widget.action)) {
        errors.push(`${label}.action must be create, update, delete or execute`);
    }
    if (!Array.isArray(widget.fields) || widget.fields.length === 0 || widget.fields.length > LIMITS.maxFields) {
        errors.push(`${label}.fields must contain 1..${LIMITS.maxFields} entries`);
    } else {
        const names = new Set();
        widget.fields.forEach((field, fieldIndex) => {
            const fieldLabel = `${label}.fields[${fieldIndex}]`;
            if (!isPlainObject(field)) {
                errors.push(`${fieldLabel} must be an object`);
                return;
            }
            if (!hasOnlyKeys(field, FIELD_KEYS)) errors.push(`${fieldLabel} has unknown keys`);
            if (typeof field.name !== 'string' || !FIELD_NAME_RE.test(field.name)) {
                errors.push(`${fieldLabel}.name must be an identifier`);
            } else if (names.has(field.name)) {
                errors.push(`${fieldLabel}.name is duplicated`);
            } else {
                names.add(field.name);
            }
            if (!isText(field.label, LIMITS.maxTitleLength)) errors.push(`${fieldLabel}.label must be plain text`);
            if (!FIELD_TYPES.has(field.type)) errors.push(`${fieldLabel}.type is not supported`);
            if(field.options!==undefined&&(!Array.isArray(field.options)||field.options.length>100||field.options.some(value=>!isText(value,200))))errors.push(`${fieldLabel}.options is invalid`);
            if(field.optionsAction!==undefined&&(typeof field.optionsAction!=='string'||!WIDGET_ID_RE.test(field.optionsAction)))errors.push(`${fieldLabel}.optionsAction is invalid`);
            if(field.optionsResource!==undefined&&!COMMON_RESOURCES.includes(field.optionsResource))errors.push(`${fieldLabel}.optionsResource is invalid`);
            if(field.type!=='select'&&(field.options!==undefined||field.optionsResource!==undefined))errors.push(`${fieldLabel} options require a select field`);
            if(['uploadAction','accept','maxBytes'].some(key=>field[key]!==undefined)&&field.type!=='file')errors.push(`${fieldLabel}: upload settings require a file field`);
            if(field.uploadAction!==undefined&&(typeof field.uploadAction!=='string'||!WIDGET_ID_RE.test(field.uploadAction)))errors.push(`${fieldLabel}: invalid upload action`);
            if(field.maxBytes!==undefined&&(!Number.isInteger(field.maxBytes)||field.maxBytes<1||field.maxBytes>20971520))errors.push(`${fieldLabel}: invalid upload limit`);
            if(field.accept!==undefined&&(typeof field.accept!=='string'||field.accept.length>300||!field.accept.split(',').every(type=>/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(type.trim()))))errors.push(`${fieldLabel}: invalid accepted MIME types`);
            if(field.selectionPath!==undefined&&(typeof field.selectionPath!=='string'||field.selectionPath.length>200||field.selectionPath.split('.').length>6||!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field.selectionPath)||field.selectionPath.split('.').some(key=>['__proto__','prototype','constructor'].includes(key))))errors.push(`${fieldLabel}: invalid selected-record binding`);
            if(field.editor!==undefined&&(field.type!=='json'||!['json','schema','query','geometry'].includes(field.editor)))errors.push(`${fieldLabel}: invalid structured editor`);
            if(field.type==='file'&&field.defaultValue)errors.push(`${fieldLabel}: file fields cannot contain default uploads`);
            if(field.defaultValue!==undefined&&(typeof field.defaultValue!=='string'||field.defaultValue.length>4000))errors.push(`${fieldLabel}.defaultValue is invalid`);
            if (field.required !== undefined && typeof field.required !== 'boolean') {
                errors.push(`${fieldLabel}.required must be a boolean`);
            }
        });
    }
    // A form without a workflow reference is allowed: DX reports it as
    // non-submittable (`canSubmit: false`) instead of executing anything.
    if (widget.workflowRef !== undefined) {
        validateWorkflowRef(widget.workflowRef, `${label}.workflowRef`, errors);
    }
}

/**
 * Validate a parsed bundle.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], checksum?: string }}
 */
export function validateBundle(raw, options = {}) {
    const { product = PRODUCT, requireChecksum = false } = options;
    const errors = [];
    const warnings = [];

    if (!isPlainObject(raw)) {
        return { ok: false, errors: ['bundle must be a JSON object'], warnings };
    }
    if (!hasOnlyKeys(raw, BUNDLE_KEYS)) errors.push('bundle has unknown top-level keys');
    if (raw.format !== BUNDLE_FORMAT) errors.push(`format must be "${BUNDLE_FORMAT}"`);
    if (raw.formatVersion !== BUNDLE_FORMAT_VERSION) errors.push(`formatVersion must be ${BUNDLE_FORMAT_VERSION}`);

    const plugin = raw.plugin;
    if (!isPlainObject(plugin)) {
        errors.push('plugin must be an object');
    } else {
        if (!hasOnlyKeys(plugin, PLUGIN_KEYS)) {
            errors.push('plugin has unknown keys (id, status, version and tenant fields are server-owned)');
        }
        if (plugin.product !== product) errors.push(`plugin.product must be "${product}"`);
        if (!isText(plugin.name, 160) || plugin.name !== plugin.name.trim()) {
            // DX trims names on save; a padded name would round-trip with a
            // different checksum after the first import/export.
            errors.push('plugin.name must be plain text without surrounding whitespace');
        }
        if (typeof plugin.slug !== 'string' || !SLUG_RE.test(plugin.slug)) {
            errors.push('plugin.slug must be 2..64 lower-case characters, digits or dashes');
        }
        if (!['admin', 'member'].includes(plugin.audience)) errors.push('plugin.audience must be admin or member');
        if (!Array.isArray(plugin.roles) || plugin.roles.length === 0 || plugin.roles.length > LIMITS.maxRoles) {
            errors.push(`plugin.roles must contain 1..${LIMITS.maxRoles} roles`);
        } else {
            const unique = new Set();
            for (const role of plugin.roles) {
                if (typeof role !== 'string' || !PRODUCT_SPEC.roles.includes(role)) {
                    errors.push(`plugin.roles contains an unsupported ${product} role: ${String(role)}`);
                } else if (unique.has(role)) {
                    errors.push(`plugin.roles contains a duplicate role: ${role}`);
                } else {
                    unique.add(role);
                }
            }
        }
        if (!Array.isArray(plugin.widgets) || plugin.widgets.length === 0 || plugin.widgets.filter(w=>w?.type!=="action").length > LIMITS.maxWidgets || (Array.isArray(plugin.widgets) && plugin.widgets.filter(w=>w?.type==="action").length > 128)) {
            errors.push(`plugin.widgets must contain 1..${LIMITS.maxWidgets} widgets`);
        } else {
            if(plugin.widgets.every(w=>isPlainObject(w))) errors.push(...actionReferenceErrors(plugin.widgets));
            const ids = new Set();
            plugin.widgets.forEach((widget, index) => validateWidget(widget, index, errors, ids));
            for(const widget of plugin.widgets) if(widget?.type==='code' && isPlainObject(widget.code)) for(const [key,types] of [['inputs',['metric','table','chart','list','map','kanban','timeline']],['actions',['form']]]) {
              if(Array.isArray(widget.code[key])) for(const id of widget.code[key]) if(!plugin.widgets.some(w=>w?.id===id&&types.includes(w.type)))errors.push(`Code binding ${id} must reference a matching widget in this page`);
            }
        }
    }

    validateSource(raw.source, errors);

    let checksum;
    if (raw.checksum !== undefined) {
        if (typeof raw.checksum !== 'string' || !CHECKSUM_RE.test(raw.checksum)) {
            errors.push('checksum must be sha256:<64 lowercase hex>');
        } else {
            checksum = bundleChecksum(raw);
            if (checksum !== raw.checksum) {
                if (legacyFullPayloadChecksum(raw) === raw.checksum) {
                    errors.push('checksum uses the legacy full-payload algorithm; run `node scripts/plugin-bundle.mjs reseal`');
                } else {
                    errors.push('checksum does not match the plugin definition');
                }
            }
        }
    } else if (requireChecksum) {
        errors.push('checksum is required (--require-checksum)');
    } else {
        warnings.push('bundle has no checksum; run `node scripts/plugin-bundle.mjs reseal` to seal it');
    }

    return { ok: errors.length === 0, errors, warnings, checksum };
}

/**
 * Resolve the tracked file that will hold a DX export and normalize provenance
 * without touching the plugin definition.
 *
 * - target: `--out`, else `source.path`, else `plugins/<slug>.plugin.json`;
 * - `source.repository` must be this product's repository;
 * - a differing `source.path` is an error unless `remapSource` is set;
 * - a missing `source` is synthesized for a first export;
 * - a present checksum is verified before it is ever rewritten.
 *
 * @returns {{ target: string, relativePath: string, bundle: object, remapped: boolean }}
 */
export function planBundleTarget(bundle, options) {
    const { root, out, remapSource = false } = options || {};
    if (!isPlainObject(bundle)) throw new Error('bundle_must_be_object');
    if (!isPlainObject(bundle.plugin)) throw new Error('bundle_plugin_required');
    if (bundle.plugin.product !== PRODUCT) throw new Error(`bundle_product_mismatch: expected ${PRODUCT}`);

    const source = bundle.source;
    if (source !== undefined && !isPlainObject(source)) throw new Error('bundle_source_invalid');
    if (isPlainObject(source) && Object.keys(source).some((key) => !SOURCE_KEYS.has(key))) {
        throw new Error('bundle_source_unknown_keys');
    }
    const sourcePathSafe = isPlainObject(source) && isSafeBundlePath(source.path);
    let relative;
    if (out !== undefined) {
        relative = String(out).replace(/^(?:\.\/)+/, '');
    } else if (sourcePathSafe) {
        relative = source.path;
    } else if (typeof bundle.plugin.slug === 'string' && SLUG_RE.test(bundle.plugin.slug)) {
        relative = `plugins/${bundle.plugin.slug}.plugin.json`;
    } else {
        throw new Error('bundle_slug_invalid: cannot derive a target path');
    }

    const target = resolvePluginsPath(root, relative);
    const relativePath = path.relative(root, target).split(path.sep).join('/');

    if (isPlainObject(source)) {
        if (typeof source.repository !== 'string' || !GITHUB_RE.test(source.repository)) {
            throw new Error('bundle_source_repository_invalid');
        }
        if (!repositoryMatches(source.repository)) {
            throw new Error(`bundle_source_repository_mismatch: ${source.repository} is not ${PRODUCT_SPEC.repository}`);
        }
        if (sourcePathSafe) {
            if (source.path !== relativePath && !remapSource) {
                throw new Error(`bundle_source_path_mismatch: source.path is ${source.path} but the target is ${relativePath}; pass --remap-source or use the matching --out`);
            }
        } else if (!remapSource) {
            throw new Error(`bundle_source_path_invalid: ${String(source.path)}; pass --remap-source to set ${relativePath}`);
        }
    }

    const checksum = bundleChecksum(bundle);
    if (bundle.checksum !== undefined) {
        if (typeof bundle.checksum !== 'string' || !CHECKSUM_RE.test(bundle.checksum)) {
            throw new Error('bundle_checksum_invalid');
        }
        if (bundle.checksum !== checksum) throw new Error('bundle_checksum_mismatch');
    }

    const normalized = {
        ...bundle,
        source: {
            repository: isPlainObject(source) ? source.repository : PRODUCT_SPEC.repository,
            path: relativePath,
            ...(isPlainObject(source) && source.revision !== undefined ? { revision: source.revision } : {}),
        },
        checksum,
    };
    return {
        target,
        relativePath,
        bundle: normalized,
        remapped: isPlainObject(source) && source.path !== relativePath,
    };
}

/** Read and size-check a bundle file. */
export function readBundleFile(root, candidate, options = {}) {
    const file = resolvePluginsPath(root, candidate);
    if (!fs.existsSync(file)) throw new Error('path_not_found');
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('path_not_a_file');
    if (stat.size > LIMITS.maxFileBytes) throw new Error('file_too_large');
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`invalid_json: ${(error instanceof Error ? error.message : String(error))}`);
    }
    return { file, parsed, result: validateBundle(parsed, options) };
}

/** Serialize a validated bundle as a tracked artifact (2-space JSON + newline). */
export function serializeBundle(bundle) {
    return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Ensure a bundle's `source` points at the file that will hold it.
 * `path` is repository-relative and must stay inside `plugins/`.
 */
export function assertBundleSourcePath(bundle, repoRelativePath) {
    if (bundle?.source?.path !== repoRelativePath) {
        throw new Error(`source.path must equal the tracked path (${repoRelativePath})`);
    }
}
