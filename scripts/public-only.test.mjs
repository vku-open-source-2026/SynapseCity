// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Public-only console guard rails.
 *
 * These tests do not replace a browser test; they catch the regressions that
 * matter for the 2026-11-14 workspace contract:
 * - the server and edge redirect every retired path to one fixed DX URL;
 * - the client root route redirects and never preserves a return target;
 * - no route module mounts a dashboard, login form, Sidebar or archived page;
 * - the public map / report / lookup routes stay mounted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = path.join(ROOT, 'apps', 'console');
const DX = 'https://synapsedx.sbs/workspace';
const MOVED = ['/login', '/register', '/admin', '/technician', '/workspace'];

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function routeFiles(dir = path.join(CONSOLE, 'src', 'routes')) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...routeFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(full);
    }
    return files;
}

test('console nginx redirects every retired path to the fixed DX URL', () => {
    const config = read('apps/console/nginx.conf');
    for (const location of ['= /login', '= /register', '= /workspace', '^~ /workspace/', '= /admin', '^~ /admin/', '= /technician', '^~ /technician/']) {
        const pattern = new RegExp(`location ${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ return 308 ${DX}; \\}`);
        assert.match(config, pattern, `missing redirect for ${location}`);
    }
    assert.match(config, /try_files \$uri \/index\.html;/, 'the public SPA fallback must stay');
    assert.ok(!/\?next=/.test(config), 'redirects must not preserve a return target');
});

test('public edge redirects before proxying the console', () => {
    const config = read('infra/nginx/synapsecity.conf');
    for (const location of ['= /login', '= /register', '= /workspace', '^~ /admin/', '^~ /technician/']) {
        const pattern = new RegExp(`location ${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ return 308 ${DX}; \\}`);
        assert.match(config, pattern, `edge missing redirect for ${location}`);
    }
});

test('client root redirects moved paths and keeps public paths mounted', () => {
    const root = fs.readFileSync(path.join(CONSOLE, 'src', 'routes', '__root.tsx'), 'utf8');
    assert.match(root, /workspaceRedirectHref\(location\.pathname\)/);
    assert.match(root, /throw redirect\(\{ href \}\)/);
    const helper = fs.readFileSync(path.join(CONSOLE, 'src', 'lib', 'workspace.ts'), 'utf8');
    assert.match(helper, /export const WORKSPACE_URL = `\$\{WORKSPACE_ORIGIN\}\$\{WORKSPACE_PATH\}`;/);
    assert.match(helper, /WORKSPACE_ORIGIN = "https:\/\/synapsedx\.sbs"/);
    assert.match(helper, /WORKSPACE_PATH = "\/workspace"/);
    assert.ok(!/\?next=|sanitizeReturnPath|redirect=/.test(helper), 'return-target hints are not allowed');

    for (const file of ['index.tsx', 'map.tsx', 'about.tsx', 'docs.tsx', 'asset.$id.tsx', 'public/report.tsx', 'public/incidents.$incidentId.tsx']) {
        const source = fs.readFileSync(path.join(CONSOLE, 'src', 'routes', file), 'utf8');
        assert.ok(!/WorkspaceMovedNotice/.test(source), `public route ${file} must stay mounted`);
    }
});

test('retired route modules are redirect/notice stubs with no dashboard imports', () => {
    const files = routeFiles();
    const privateRoutes = files.filter((file) => {
        const relative = path.relative(path.join(CONSOLE, 'src', 'routes'), file).split(path.sep).join('/');
        return /^(login|register|admin|technician)(\.tsx|\/)/.test(relative);
    });
    assert.ok(privateRoutes.length >= 30, 'expected the retired City route set');
    for (const file of privateRoutes) {
        const source = fs.readFileSync(file, 'utf8');
        const relative = path.relative(ROOT, file);
        assert.match(source, /WorkspaceMovedNotice/, `${relative} is not a stub`);
        assert.ok(!/from ["'].*pages\//.test(source), `${relative} still mounts a page`);
        assert.ok(!/Sidebar|AdminLayout|ProtectedRoute|authStore/.test(source), `${relative} still mounts work UI`);
    }
});

test('archived work UI is outside the build root', () => {
    const srcPages = path.join(CONSOLE, 'src', 'pages');
    const removed = ['admin', 'alerts', 'budgets', 'iot', 'reports', 'settings', 'Dashboard.tsx', 'LoginPage.tsx', 'RegisterPage.tsx', 'AdminLogin.tsx', 'AssetMapView.tsx'];
    for (const entry of removed) {
        assert.ok(!fs.existsSync(path.join(srcPages, entry)), `${entry} must not remain in the build root`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'source', 'apps', 'console', 'src', 'pages', 'admin')));
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'source', 'apps', 'console', 'src', 'routes', 'technician.tsx')));
});

test('public contribution intake and public map stay owned', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'apps', 'contribution-service')));
    assert.ok(fs.existsSync(path.join(ROOT, 'apps', 'contribution-console')));
    const mapRoute = fs.readFileSync(path.join(CONSOLE, 'src', 'routes', 'map.tsx'), 'utf8');
    assert.match(mapRoute, /PublicMap/);
    const reportRoute = fs.readFileSync(path.join(CONSOLE, 'src', 'routes', 'public', 'report.tsx'), 'utf8');
    assert.match(reportRoute, /PublicIncidentReport/);
});
