#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Dependency license inventory, policy gate, and Cargo CycloneDX output. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const npmLocks = [
  ['root', 'package-lock.json', 'node_modules'],
  ['console', 'apps/console/package-lock.json', 'apps/console/node_modules'],
  ['contribution-console', 'apps/contribution-console/package-lock.json', 'apps/contribution-console/node_modules'],
  ['mobile', 'mobile/package-lock.json', 'mobile/node_modules'],
];
const selectedNpmLock = option('npm-lock');
const activeNpmLocks = selectedNpmLock
  ? npmLocks.filter(([, lockPath]) => lockPath === selectedNpmLock)
  : npmLocks;
if (selectedNpmLock && activeNpmLocks.length === 0) throw new Error(`unknown npm lock: ${selectedNpmLock}`);
const cargoManifests = [
  ['city-service', 'apps/city-service/Cargo.toml'],
  ['gateway', 'apps/gateway/Cargo.toml'],
  ['contribution-service', 'apps/contribution-service/Cargo.toml'],
];
const licenseOverrides = {
  'arc@0.2.0': { license: 'BSD', source: 'https://github.com/springmeyer/arc.js' },
  'leaflet.heat@0.2.0': { license: 'BSD-2-Clause', source: 'https://github.com/Leaflet/Leaflet.heat' },
};
const forbidden = /hippocratic|sspl|busl|commons-clause|polyform|elastic|rsal|agpl/i;
const copyleft = /(?:^|\W)(?:gpl|lgpl)(?:-|$)/i;
const allowedBase = /^(?:0BSD|Apache-2\.0|MIT|MIT-0|ISC|BSD(?:-[23]-Clause)?|BDS-3-Clause|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|CC-BY-4\.0|MPL-2\.0|EDL-1\.0|EPL-1\.0|EPL-2\.0|Unicode-3\.0|CDLA-Permissive-2\.0|Zlib|BSL-1\.0|Python-2\.0|X11|curl|libpng-2\.0|JSON|WTFPL|Artistic-2\.0)(?:\s+WITH\s+LLVM-exception)?$/i;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const token = ` ${operator} `;
  const normalized = expression.replace(/\s*\/\s*/g, ' OR ');
  for (let index = 0; index <= normalized.length - token.length; index += 1) {
    const char = normalized[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && normalized.startsWith(token, index)) {
      parts.push(normalized.slice(start, index).trim());
      index += token.length - 1;
      start = index + 1;
    }
  }
  parts.push(normalized.slice(start).trim());
  return parts.filter(Boolean);
}

function unwrap(expression) {
  let value = expression.trim();
  while (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
  return value;
}

function acceptableExpression(expression, runtime) {
  let value = unwrap(expression);
  const orParts = splitTopLevel(value, 'OR');
  if (orParts.length > 1) return orParts.some((part) => acceptableExpression(part, runtime));
  const andParts = splitTopLevel(value, 'AND');
  if (andParts.length > 1) return andParts.every((part) => acceptableExpression(part, runtime));
  if (forbidden.test(value)) return false;
  if (copyleft.test(value)) return !runtime;
  return allowedBase.test(value) || value.includes('SEE LICENSE IN');
}

function npmComponents() {
  const components = new Map();
  for (const [workspace, lockPath, modulesPath] of activeNpmLocks) {
    const lock = readJson(lockPath);
    for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
      if (!packagePath.startsWith('node_modules/') || entry.link) continue;
      const name = packagePath.split('node_modules/').pop();
      const version = entry.version;
      if (!version) continue;
      const key = `npm:${name}@${version}`;
      const override = licenseOverrides[`${name}@${version}`];
      const license = entry.license || override?.license || null;
      let packageDir = resolve(root, modulesPath, packagePath.split('node_modules/')[1]);
      if (!existsSync(packageDir)) packageDir = resolve(root, 'node_modules', packagePath.split('node_modules/')[1]);
      const existing = components.get(key) || {
        ecosystem: 'npm',
        name,
        version,
        license,
        dev: true,
        runtime: false,
        sources: new Set(),
        workspaces: new Set(),
        packageDir,
      };
      existing.dev &&= Boolean(entry.dev);
      existing.runtime ||= !entry.dev;
      existing.sources.add(entry.resolved || override?.source || packageDir);
      existing.workspaces.add(workspace);
      components.set(key, existing);
    }
  }
  return components;
}

function cargoComponents() {
  const components = new Map();
  for (const [workspace, manifest] of cargoManifests) {
    const output = execFileSync(process.env.CARGO || 'cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const metadata = JSON.parse(output);
    for (const pkg of metadata.packages) {
      const key = `cargo:${pkg.name}@${pkg.version}`;
      const existing = components.get(key) || {
        ecosystem: 'cargo',
        name: pkg.name,
        version: pkg.version,
        license: pkg.license || null,
        dev: false,
        runtime: true,
        sources: new Set(),
        workspaces: new Set(),
        packageDir: dirname(pkg.manifest_path),
        checksum: pkg.checksum || null,
      };
      existing.sources.add(pkg.source || pkg.repository || pkg.manifest_path);
      existing.workspaces.add(workspace);
      components.set(key, existing);
    }
  }
  return components;
}

function serialise(components) {
  return [...components.values()]
    .map((component) => ({
      ...component,
      sources: [...component.sources].sort(),
      workspaces: [...component.workspaces].sort(),
    }))
    .sort((left, right) => left.ecosystem.localeCompare(right.ecosystem)
      || left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version));
}

function licenceFiles(packageDir) {
  if (!existsSync(packageDir)) return [];
  const files = [];
  const visit = (directory, depth) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = statSync(path);
      if (info.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name)) {
        if (info.size < 2 * 1024 * 1024) files.push(path);
      } else if (info.isDirectory() && depth < 2 && /^(?:licen[cs]es?|copying|notices?)$/i.test(name)) {
        visit(path, depth + 1);
      }
    }
  };
  visit(packageDir, 0);
  return files;
}

function currentSourceCommit() {
  if (process.env.SOURCE_COMMIT) return process.env.SOURCE_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'UNSET';
  }
}

function noticesText(components, sourceCommit) {
  const sections = [
    'SynapseCity complete dependency notice inventory',
    'Source commit: ' + sourceCommit,
    'Generated from all npm and Cargo locks. Upstream texts are unmodified.',
  ];
  const seenTexts = new Set();
  for (const component of components) {
    const header = [
      '',
      '='.repeat(78),
      `${component.ecosystem} ${component.name}@${component.version}`,
      `License expression: ${component.license || 'UNKNOWN'}`,
      `Scope: ${component.runtime ? 'runtime/production' : 'development-only'}`,
      `Workspaces: ${component.workspaces.join(', ')}`,
      `Source: ${component.sources.join(', ')}`,
    ].join('\n');
    const texts = licenceFiles(component.packageDir);
    if (texts.length === 0) {
      sections.push(`${header}\n[No separate license file found in the installed package; see registry expression and source URL.]`);
      continue;
    }
    for (const path of texts) {
      const text = readFileSync(path, 'utf8');
      const digest = createHash('sha256').update(text).digest('hex');
      if (seenTexts.has(digest)) {
        sections.push(`${header}\nLicense file: ${path.split('/').pop()} (same text as an earlier component)`);
      } else {
        seenTexts.add(digest);
        sections.push(`${header}\nLicense file: ${path.split('/').pop()}\n\n${text}`);
      }
    }
  }
  return `${sections.join('\n')}\n`;
}

function cyclonedx(components, workspace) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'SynapseCity license-gate', version: '1' }] },
      component: { type: 'application', name: `synapsecity-${workspace}`, version: '0.1.0' },
    },
    components: components.map((component) => ({
      type: 'library',
      'bom-ref': `${component.ecosystem}:${component.name}@${component.version}`,
      name: component.name,
      version: component.version,
      licenses: component.license ? [{ expression: component.license }] : [],
      externalReferences: component.sources.filter((source) => /^https?:/.test(source)).map((url) => ({ type: 'distribution', url })),
      properties: [
        { name: 'synapsecity:scope', value: component.runtime ? 'runtime' : 'development' },
        { name: 'synapsecity:workspaces', value: component.workspaces.join(',') },
        ...(component.checksum ? [{ name: 'synapsecity:cargo-checksum', value: component.checksum }] : []),
      ],
    })),
  };
}

const npm = npmComponents();
const cargo = args.includes('--npm-only') ? new Map() : cargoComponents();
const components = serialise(new Map([...npm, ...cargo]));
const errors = [];
for (const component of components) {
  if (!component.license) {
    if (component.runtime) errors.push(`${component.ecosystem} ${component.name}@${component.version}: missing runtime license metadata`);
    continue;
  }
  if (forbidden.test(component.license)) {
    errors.push(`${component.ecosystem} ${component.name}@${component.version}: forbidden license ${component.license}`);
  } else if (!acceptableExpression(component.license, component.runtime)) {
    errors.push(`${component.ecosystem} ${component.name}@${component.version}: disallowed ${component.runtime ? 'runtime' : 'development'} expression ${component.license}`);
  }
}
for (const required of ['LICENSE', 'NOTICE', 'THIRD-PARTY.md', 'licenses/MPL-2.0.txt', 'licenses/EDL-1.0.txt', 'licenses/SOURCE-OFFER.md', 'licenses/THIRD-PARTY-NOTICES.txt']) {
  if (!existsSync(join(root, required))) errors.push(`missing notice material: ${required}`);
}
const contributionLock = readJson('apps/contribution-console/package-lock.json');
if (Object.keys(contributionLock.packages).some((path) => /react-leaflet/i.test(path))) {
  errors.push('contribution lock still contains React Leaflet');
}
const footer = readFileSync(join(root, 'apps/console/src/components/Footer.tsx'), 'utf8');
if (!footer.includes('Font Awesome') || !footer.includes('/THIRD-PARTY-NOTICES.txt')) {
  errors.push('console footer is missing Font Awesome/third-party attribution');
}

const jsonOutput = option('output-json');
if (jsonOutput) {
  mkdirSync(dirname(jsonOutput), { recursive: true });
  writeFileSync(jsonOutput, `${JSON.stringify({ generatedAt: new Date().toISOString(), components }, null, 2)}\n`);
}
const textOutput = option('output-text');
if (textOutput) {
  mkdirSync(dirname(textOutput), { recursive: true });
  const lines = ['SynapseCity dependency license inventory', ''];
  for (const component of components) {
    lines.push(`${component.ecosystem}\t${component.name}@${component.version}\t${component.license || 'UNKNOWN'}\t${component.runtime ? 'runtime' : 'dev'}\t${component.workspaces.join(',')}`);
  }
  writeFileSync(textOutput, `${lines.join('\n')}\n`);
}
const noticesOutput = option('notices-output');
if (noticesOutput) {
  mkdirSync(dirname(noticesOutput), { recursive: true });
  writeFileSync(noticesOutput, noticesText(components, currentSourceCommit()));
}
const sbomDir = option('sbom-dir');
if (sbomDir) {
  mkdirSync(sbomDir, { recursive: true });
  for (const [workspace] of cargoManifests) {
    const scoped = components.filter((component) => component.ecosystem === 'cargo' && component.workspaces.includes(workspace));
    writeFileSync(join(sbomDir, `cargo-${workspace}.cdx.json`), `${JSON.stringify(cyclonedx(scoped, workspace), null, 2)}\n`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `license gate: ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  const runtime = components.filter((component) => component.runtime).length;
  const devOnly = components.length - runtime;
  console.log(`license gate: ${components.length} unique packages (${runtime} runtime/production, ${devOnly} development-only); no disallowed runtime licenses`);
}
