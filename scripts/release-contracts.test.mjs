// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Release/CI contracts that must stay true in a clean checkout. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const compose = read('docker-compose.yml');
const release = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml');
const EXPECTED_TESTS = 4;
let executedTests = 0;

function contractTest(name, fn) {
    test(name, () => {
        executedTests += 1;
        fn();
    });
}

after(() => assert.equal(executedTests, EXPECTED_TESTS));

function composeImages() {
    return [...compose.matchAll(/^\s+image:\s+ghcr\.io\/[^/\s]+\/(synapsecity-[^:\s]+):/gm)]
        .map((match) => match[1])
        .sort();
}

contractTest('release publishes every Compose-built City image, including both IoT images', () => {
    const expected = composeImages();
    assert.ok(expected.includes('synapsecity-iot-bridge'));
    assert.ok(expected.includes('synapsecity-iot-mock'));

    const pushList = release.match(/images="([^"]+)"/)?.[1].split(/\s+/).sort();
    assert.deepEqual(pushList, expected, 'tag/push list drifted from Compose');

    const publicList = [...release.matchAll(/for image in ([^;]+); do/g)]
        .map((match) => match[1].split(/\s+/).sort())
        .find((images) => images.includes('synapsecity-city-service'));
    assert.deepEqual(publicList, expected, 'GHCR visibility list drifted from Compose');

    const notes = [...release.matchAll(/^\s*- `ghcr\.io\/.*\/(synapsecity-[^:]+):/gm)]
        .map((match) => match[1])
        .sort();
    assert.deepEqual(notes, expected, 'release notes drifted from Compose');
});

contractTest('release and CI execute the non-skippable local workflow contract harness', () => {
    for (const [name, workflow] of [['release', release], ['CI', ci]]) {
        assert.match(workflow, /npm run test:workflow-artifacts/, `${name} must run executable workflow artifact contracts`);
        assert.doesNotMatch(
            workflow,
            /npm run test:workflow-engine/,
            `${name} must not use the skippable real-engine harness as its clean-checkout gate`,
        );
    }
});

contractTest('the stale root Dockerfile is absent and canonical service Dockerfiles remain', () => {
    assert.equal(
        fs.existsSync(path.join(ROOT, 'Dockerfile')),
        false,
        'the retired root TypeScript/vendor Dockerfile must not return; use apps/*/Dockerfile',
    );
    for (const relative of [
        'apps/city-service/Dockerfile',
        'apps/gateway/Dockerfile',
        'apps/console/Dockerfile',
        'apps/contribution-service/Dockerfile',
        'apps/contribution-console/Dockerfile',
        'apps/iot-bridge/Dockerfile',
        'apps/iot-mock/Dockerfile',
    ]) {
        assert.ok(fs.existsSync(path.join(ROOT, relative)), `${relative} is missing`);
        assert.doesNotMatch(read(relative), /SynapseCity\/vendor|dist\/src\/server\.js/, relative);
    }
});

contractTest('CI checks all locked Rust workspaces at the declared MSRV', () => {
    assert.match(ci, /dtolnay\/rust-toolchain@1\.89\.0/);
    for (const service of ['city-service', 'gateway', 'contribution-service']) {
        const manifest = read(`apps/${service}/Cargo.toml`);
        assert.match(manifest, /rust-version = "1\.89"/);
        assert.ok(
            ci.includes(`(cd apps/${service} && cargo check --locked --all-targets)`),
            `${service} is missing from the MSRV job`,
        );
    }
});
