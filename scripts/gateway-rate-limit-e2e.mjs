#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Actual Rust gateway + City process regression test for H6.
 *
 * The public-report limit is one request per client per window. Two different
 * edge-supplied XFF identities must both reach City validation independently;
 * a repeat of the first identity must still be rate limited. No Tier-2 network
 * call is made because the malformed report is rejected before persistence.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = [
    { name: 'city', directory: 'apps/city-service', binary: 'synapsecity-city' },
    { name: 'gateway', directory: 'apps/gateway', binary: 'synapsecity-gateway' },
];
const children = [];

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

async function waitForPort(port, child) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`${child.spawnfile} exited early with code ${child.exitCode}`);
        }
        const connected = await new Promise((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => { socket.destroy(); resolve(false); });
        });
        if (connected) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for 127.0.0.1:${port}`);
}

function start(binary, args, env) {
    const child = spawn(binary, args, {
        cwd: ROOT,
        env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
    child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
    child.diagnostics = () => diagnostics;
    children.push(child);
    return child;
}

async function stop(child) {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

try {
    const binaries = new Map();
    for (const service of services) {
        const cwd = path.join(ROOT, service.directory);
        execFileSync('cargo', ['build', '--locked'], {
            cwd,
            env: process.env,
            stdio: 'pipe',
        });
        const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
            cwd,
            env: process.env,
            encoding: 'utf8',
        }));
        binaries.set(service.name, path.join(metadata.target_directory, 'debug', service.binary));
    }
    const cityPort = await freePort();
    const gatewayPort = await freePort();
    const city = start(
        binaries.get('city'),
        [],
        {
            PORT: String(cityPort),
            NODE_ENV: 'test',
            ALLOW_LOCAL_DEPENDENCIES: 'true',
            SYNAPSEDX_BASE_URL: 'http://127.0.0.1:9',
            AUTH_SECRET: 'gateway-e2e-test-secret',
            PUBLIC_RATE_LIMIT: '1',
            PUBLIC_RATE_WINDOW_MS: '60000',
        },
    );
    await waitForPort(cityPort, city);

    const gateway = start(
        binaries.get('gateway'),
        [],
        {
            PORT: String(gatewayPort),
            NODE_ENV: 'test',
            ALLOW_LOCAL_DEPENDENCIES: 'true',
            CITY_SERVICE_URL: `http://127.0.0.1:${cityPort}`,
            CONSOLE_URL: 'http://127.0.0.1:9',
        },
    );
    await waitForPort(gatewayPort, gateway);

    const report = async (forwardedFor) => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/public/incidents`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-forwarded-for': forwardedFor,
            },
            body: '{}',
        });
        return { status: response.status, body: await response.json() };
    };

    const first = await report('198.51.100.10');
    const second = await report('198.51.100.11');
    const repeated = await report('198.51.100.10');
    assert.equal(first.status, 400, JSON.stringify(first));
    assert.equal(second.status, 400, JSON.stringify(second));
    assert.equal(repeated.status, 429, JSON.stringify(repeated));
    assert.equal(repeated.body.code, 'rate_limited');
    console.log('[gateway-rate-limit-e2e] distinct XFF clients are independent; repeat is 429');
} catch (error) {
    for (const child of children) {
        if (child.exitCode === null) {
            console.error(child.diagnostics());
        }
    }
    throw error;
} finally {
    await Promise.all(children.map(stop));
}
