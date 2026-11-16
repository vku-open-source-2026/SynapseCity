#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Legacy OpenInfra -> SynapseCity data migration.
 *
 * Reads the JSON export produced from the old MongoDB deployment and writes it
 * through the published Tier-2 capabilities API (`@synapsedx/capabilities`).
 * This script never opens a database connection, never calls SynapseOne and
 * never touches a Tier-2 private port: the City service remains the only owner
 * of its domain datasets and Tier 2 remains the only persistence boundary.
 *
 * The migration is intentionally conservative:
 *   - only City-owned collections are imported; SOS-owned collections are
 *     reported and skipped (they belong to SynapseCitySOS);
 *   - reporter PII and internal comments are written to the private
 *     `city-incident-internal` sidecar, never to the public `city-incidents`
 *     projection;
 *   - password hashes are never written to `city-users`;
 *   - `sensor_readings` / `alerts` are compacted for a demo-ready dataset while
 *     assets, sensors and every master record stay complete.
 *
 * Usage:
 *   node scripts/import-openinfra.mjs --dry-run
 *   node scripts/import-openinfra.mjs
 *   node scripts/import-openinfra.mjs --readings=all --readings-window-hours=168
 *
 * The state file makes the run resumable. Existing record ids are also
 * discovered from Tier 2 before each collection, so a rerun is idempotent even
 * without the state file.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { CapabilitiesClient } from '@synapsedx/capabilities';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_DATA_DIR = path.resolve(REPO_ROOT, '..', 'nhan_tmp_data', 'openinfra_data_2026-11-09');
const DEFAULT_STATE_FILE = path.resolve(REPO_ROOT, '.notes', 'import-openinfra.state.json');
const MAPPING_VERSION = 1;
const BATCH_LIMIT = 100;
const PAGE_SIZE = 500;

function cityPublicUrl() {
  return (process.env.CITY_PUBLIC_URL || 'https://synapsecity.sbs').replace(/\/$/, '');
}

const CITY_COLLECTIONS = {
  assets: 'openinfra_core/json/openinfra/assets.json',
  incidents: 'openinfra_core/json/openinfra/incidents.json',
  sensors: 'openinfra_core/json/openinfra/iot_sensors.json',
  readings: 'openinfra_core/json/openinfra/sensor_readings.json',
  alerts: 'openinfra_core/json/openinfra/alerts.json',
  maintenance: 'openinfra_core/json/openinfra/maintenance_records.json',
  budgets: 'openinfra_core/json/openinfra/budgets.json',
  budgetTransactions: 'openinfra_core/json/openinfra/budget_transactions.json',
  users: 'openinfra_core/json/openinfra/users.json',
  reports: 'openinfra_core/json/openinfra/reports.json',
  notifications: 'openinfra_core/json/openinfra/notifications.json',
  geofences: 'openinfra_core/json/openinfra/geofences.json',
};

/** Collections owned by SynapseCitySOS. They must never enter a city-* dataset. */
const SOS_COLLECTIONS = [
  'emergency_events',
  'eop_plans',
  'dispatch_orders',
  'resource_units',
  'sitreps',
  'after_action_reports',
  'hazard_layers',
  'emergency_sla_breaches',
  'geofence_alert_events',
  'vector_corpus',
];

/**
 * Dataset specifications mirror `apps/city-service/src/domain.ts`. Keeping the
 * same metadata here means the City service finds the datasets already in the
 * expected state and does not rewrite them on its next request.
 */
const DATASETS = {
  assets: {
    id: 'city-assets', name: 'SynapseCity infrastructure assets', entityType: 'CityAsset',
    license: 'PDDL-1.0', description: 'Public projection of city infrastructure assets', public: true,
  },
  incidents: {
    id: 'city-incidents', name: 'SynapseCity infrastructure incidents', entityType: 'CityIncident',
    license: 'PDDL-1.0', description: 'Public projection of generalized infrastructure incidents', public: true,
  },
  incidentInternal: {
    id: 'city-incident-internal', name: 'SynapseCity incident internal records', entityType: 'CityIncidentInternal',
    license: 'PDDL-1.0', description: 'Private reporter identity and internal incident notes', public: false,
  },
  maintenance: {
    id: 'city-maintenance', name: 'SynapseCity maintenance work orders', entityType: 'MaintenanceWorkOrder',
    license: 'PDDL-1.0', description: 'Infrastructure maintenance lifecycle records', public: false,
  },
  sensors: {
    id: 'city-iot-sensors', name: 'SynapseCity IoT sensors', entityType: 'IoTSensor',
    license: 'PDDL-1.0', description: 'Infrastructure sensor metadata and readings', public: false,
  },
  sensorData: {
    id: 'city-iot-readings', name: 'SynapseCity IoT readings', entityType: 'SensorReading',
    license: 'PDDL-1.0', description: 'Infrastructure sensor observations', public: false,
  },
  alerts: {
    id: 'city-alerts', name: 'SynapseCity alerts', entityType: 'InfrastructureAlert',
    license: 'PDDL-1.0', description: 'Operational alerts associated with city infrastructure', public: false,
  },
  budgets: {
    id: 'city-budgets', name: 'SynapseCity budgets', entityType: 'InfrastructureBudget',
    license: 'PDDL-1.0', description: 'Infrastructure budget records', public: false,
  },
  transactions: {
    id: 'city-budget-transactions', name: 'SynapseCity budget transactions', entityType: 'BudgetTransaction',
    license: 'PDDL-1.0', description: 'Infrastructure budget transactions', public: false,
  },
  reports: {
    id: 'city-reports', name: 'SynapseCity reports', entityType: 'InfrastructureReport',
    license: 'PDDL-1.0', description: 'Infrastructure operational reports', public: false,
  },
  files: {
    id: 'city-files', name: 'SynapseCity file metadata', entityType: 'CityFile',
    license: 'PDDL-1.0', description: 'Metadata for binary files stored through the Tier-2 files capability', public: false,
  },
  notifications: {
    id: 'city-notifications', name: 'SynapseCity notifications', entityType: 'InfrastructureNotification',
    license: 'PDDL-1.0', description: 'Infrastructure notification records', public: false,
  },
  users: {
    id: 'city-users', name: 'SynapseCity users', entityType: 'CityUser',
    license: 'PDDL-1.0', description: 'Domain operator profiles', public: false,
  },
  geofences: {
    id: 'city-geofences', name: 'SynapseCity geofences', entityType: 'CityGeofence',
    license: 'PDDL-1.0', description: 'Infrastructure geofence records', public: false,
  },
};

const FEATURE_TYPES = {
  'Cột điện': 'power_pole',
  'Đèn giao thông': 'traffic_signal',
  'Đèn đường': 'street_light',
  'Trụ chữa cháy': 'hydrant',
  'Trạm điện': 'power_station',
  'Cống thoát nước': 'drainage',
  'Đường ống điện': 'power_conduit',
  'Trạm sạc': 'charging_station',
  'Ống dẫn nước': 'water_pipe',
};

const ASSET_STATUS = {
  operational: 'active',
  maintenance: 'maintenance',
  damaged: 'maintenance',
  retired: 'decommissioned',
};

const LIFECYCLE_STAGE = {
  planning: 'operational',
  construction: 'under_repair',
  operational: 'operational',
  decommissioned: 'decommissioned',
};

// ---------------------------------------------------------------------------
// CLI / logging
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: node scripts/import-openinfra.mjs [options]',
    '',
    'Options:',
    '  --data-dir <dir>              OpenInfra data pack (default: ../nhan_tmp_data/openinfra_data_2026-11-09)',
    '  --env-file <file>             Env file with SYNAPSEDX_* (default: .env)',
    '  --state <file>                Resumable state file (default: .notes/import-openinfra.state.json)',
    '  --readings <hourly|all|none>  Time-series import mode (default: hourly)',
    '  --readings-window-hours <n>   Window length, relative to the densest history (default: 168)',
    '  --readings-interval-hours <n> Hours between sampled readings (default: 2)',
    '  --alerts <meaningful|all|none> Alert import mode (default: meaningful)',
    '  --batch-size <n>              Records per Tier-2 bulk call, max 100 (default: 100)',
    '  --records-per-second <n>      Throttle writes to stay under the Tier-1 edge limit (default: 10)',
    '  --read-page-delay-ms <n>      Delay between existing-id pages to avoid IAM bursts (default: 1200)',
    '  --only <a,b>                  Import only the listed collections',
    '  --fresh                       Ignore a mismatched state file and start a new pass',
    '  --dry-run                     Count and map without writing anything',
    '  --help                        Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    envFile: path.join(REPO_ROOT, '.env'),
    stateFile: DEFAULT_STATE_FILE,
    readings: 'hourly',
    readingsWindowHours: 168,
    readingsIntervalHours: 2,
    alerts: 'meaningful',
    batchSize: BATCH_LIMIT,
    recordsPerSecond: 10,
    readPageDelayMs: 1200,
    only: null,
    fresh: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--data-dir') options.dataDir = path.resolve(next());
    else if (arg === '--env-file') options.envFile = path.resolve(next());
    else if (arg === '--state') options.stateFile = path.resolve(next());
    else if (arg === '--readings') options.readings = next();
    else if (arg.startsWith('--readings=')) options.readings = arg.slice('--readings='.length);
    else if (arg === '--readings-window-hours') options.readingsWindowHours = Number(next());
    else if (arg.startsWith('--readings-window-hours=')) options.readingsWindowHours = Number(arg.slice('--readings-window-hours='.length));
    else if (arg === '--readings-interval-hours') options.readingsIntervalHours = Number(next());
    else if (arg.startsWith('--readings-interval-hours=')) options.readingsIntervalHours = Number(arg.slice('--readings-interval-hours='.length));
    else if (arg === '--alerts') options.alerts = next();
    else if (arg.startsWith('--alerts=')) options.alerts = arg.slice('--alerts='.length);
    else if (arg === '--read-page-delay-ms') options.readPageDelayMs = Number(next());
    else if (arg.startsWith('--read-page-delay-ms=')) options.readPageDelayMs = Number(arg.slice('--read-page-delay-ms='.length));
    else if (arg === '--records-per-second') options.recordsPerSecond = Number(next());
    else if (arg.startsWith('--records-per-second=')) options.recordsPerSecond = Number(arg.slice('--records-per-second='.length));
    else if (arg === '--batch-size') options.batchSize = Number(next());
    else if (arg.startsWith('--batch-size=')) options.batchSize = Number(arg.slice('--batch-size='.length));
    else if (arg === '--only') options.only = next().split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length).split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (arg === '--fresh') options.fresh = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['hourly', 'all', 'none'].includes(options.readings)) throw new Error('--readings must be hourly, all or none');
  if (!['meaningful', 'all', 'none'].includes(options.alerts)) throw new Error('--alerts must be meaningful, all or none');
  if (!Number.isFinite(options.readingsWindowHours) || options.readingsWindowHours < 1) throw new Error('--readings-window-hours must be a positive number');
  if (!Number.isFinite(options.readingsIntervalHours) || options.readingsIntervalHours < 1 || options.readingsIntervalHours > 24) {
    throw new Error('--readings-interval-hours must be between 1 and 24');
  }
  if (!Number.isFinite(options.recordsPerSecond) || options.recordsPerSecond <= 0) throw new Error('--records-per-second must be a positive number');
  if (!Number.isFinite(options.readPageDelayMs) || options.readPageDelayMs < 0) throw new Error('--read-page-delay-ms must be zero or positive');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > BATCH_LIMIT) {
    throw new Error(`--batch-size must be an integer between 1 and ${BATCH_LIMIT}`);
  }
  return options;
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function log(message) {
  console.log(`[import ${stamp()}] ${message}`);
}

function warn(message) {
  console.warn(`[import ${stamp()}] WARN ${message}`);
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tier-2 fans every record write out to three Tier-1 calls (base write, event
 * queue and audit). The public edge allows 50 requests/second per source IP, so
 * an unthrottled importer self-inflicts 503s. This pacer spreads writes at a
 * configurable records/second, including the batch currently being written.
 */
class BulkPacer {
  constructor(recordsPerSecond) {
    this.interval = 1000 / recordsPerSecond;
    this.nextAt = 0;
  }

  async wait(count) {
    const now = Date.now();
    this.nextAt = Math.max(this.nextAt, now);
    const delay = this.nextAt - now;
    if (delay > 0) await sleep(delay);
    this.nextAt += count * this.interval;
  }
}

// ---------------------------------------------------------------------------
// Environment / SDK
// ---------------------------------------------------------------------------

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function createClient() {
  const baseUrl = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
  const token = process.env.SYNAPSEDX_TOKEN || '';
  const apiKey = process.env.SYNAPSEDX_API_KEY || '';
  if (!token && !apiKey) {
    throw new Error('SYNAPSEDX_TOKEN or SYNAPSEDX_API_KEY is required (put it in .env or export it)');
  }
  // Prefer the scoped service key. Tier-2 verifies bearer tokens through the
  // IAM credential endpoint, which is deliberately limited to 60 requests per
  // minute; a bulk migration would immediately trip that guard. The service
  // key uses the machine key-verification path and is the documented credential
  // for private record writes.
  if (apiKey) {
    log('credential: scoped Tier-2 service key');
    return new CapabilitiesClient({ baseUrl, apiKey });
  }
  log('credential: Tier-1 bearer token');
  return new CapabilitiesClient({ baseUrl, token });
}

// ---------------------------------------------------------------------------
// JSON stream
// ---------------------------------------------------------------------------

/**
 * Stream a top-level JSON array and yield each object. The legacy readings and
 * alerts files are hundreds of megabytes, so the importer must never call
 * `JSON.parse` on the whole file.
 */
async function* streamJsonArray(file) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let started = false;
  let finished = false;
  let elementCount = 0;

  const feed = bufferPart => {
    buffer += bufferPart;
  };

  const readStream = fs.createReadStream(file);
  for await (const chunk of readStream) {
    feed(decoder.write(chunk));
    while (true) {
      if (!started) {
        const open = buffer.indexOf('[');
        if (open < 0) {
          buffer = '';
          break;
        }
        buffer = buffer.slice(open + 1);
        started = true;
      }
      let start = 0;
      while (start < buffer.length && (buffer[start] === ',' || /\s/.test(buffer[start]))) start += 1;
      if (start > 0) buffer = buffer.slice(start);
      if (!buffer.length) break;
      if (buffer[0] === ']') {
        finished = true;
        buffer = '';
        break;
      }
      if (buffer[0] !== '{') {
        throw new Error(`${file}: expected a JSON object at element ${elementCount + 1}`);
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end < 0) break;
      const text = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      elementCount += 1;
      yield JSON.parse(text);
    }
    if (finished) break;
  }
  feed(decoder.end());
  if (!finished) {
    // A final chunk may have completed the last element without the closing
    // bracket; accept a well-formed array that simply ended.
    const trimmed = buffer.trim();
    if (trimmed && trimmed !== ']') {
      throw new Error(`${file}: unexpected end of JSON array (${elementCount} elements read)`);
    }
  }
}

function decodeExtended(value) {
  if (Array.isArray(value)) return value.map(decodeExtended);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0];
    if (key === '$oid') return String(value.$oid);
    if (key === '$date') {
      const raw = value.$date;
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object' && raw.$numberLong !== undefined) {
        const parsed = new Date(Number(raw.$numberLong));
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(raw.$numberLong);
      }
      return String(raw);
    }
    if (key === '$numberLong') {
      const parsed = Number(value.$numberLong);
      return Number.isSafeInteger(parsed) ? parsed : String(value.$numberLong);
    }
    if (key === '$numberInt') return Number(value.$numberInt);
    if (key === '$numberDouble' || key === '$numberDecimal') {
      const parsed = Number(value[key]);
      return Number.isFinite(parsed) ? parsed : String(value[key]);
    }
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = decodeExtended(entry);
  return output;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

class ImportState {
  constructor(file, fingerprint) {
    this.file = file;
    this.fingerprint = fingerprint;
    this.data = { version: 1, fingerprint, startedAt: new Date().toISOString(), collections: {} };
  }

  async load({ fresh = false } = {}) {
    if (!fs.existsSync(this.file)) return this;
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (error) {
      if (!fresh) throw new Error(`Cannot read state file ${this.file}: ${error.message}; use --fresh to start over`);
      warn(`Ignoring unreadable state file ${this.file}`);
      return this;
    }
    if (parsed.fingerprint !== this.fingerprint) {
      if (!fresh) {
        throw new Error(
          `State file ${this.file} was created with different options.\n`
          + `  previous: ${parsed.fingerprint}\n  current:  ${this.fingerprint}\n`
          + 'Use --fresh to start a new pass (existing Tier-2 records are skipped by id).',
        );
      }
      warn('Starting a fresh pass because the state options changed');
      return this;
    }
    this.data = parsed;
    this.data.collections ||= {};
    return this;
  }

  collection(key) {
    this.data.collections[key] ||= {
      outputOffset: 0, created: 0, skipped: 0, failed: 0, errors: [], updatedAt: null,
    };
    return this.data.collections[key];
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`);
    await fsp.rename(temporary, this.file);
  }
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

async function ensureDataset(client, spec) {
  let existing;
  try {
    existing = await client.datasets.get(spec.id);
  } catch (error) {
    if (error.status !== 404) throw error;
    const created = await client.datasets.create({
      slug: spec.id,
      name: spec.name,
      entityType: spec.entityType,
      license: spec.license,
      description: spec.description,
      public: spec.public === true,
      schemaVersion: '1.0.0',
    });
    return spec.public === true ? client.datasets.publish(created.id) : created;
  }
  const desiredPublic = spec.public === true;
  const needsReconcile = existing.license !== spec.license
    || existing.public !== desiredPublic
    || existing.name !== spec.name
    || existing.entityType !== spec.entityType
    || (existing.description || '') !== (spec.description || '');
  if (!needsReconcile) return existing;
  if (existing.public === true && !desiredPublic && existing.status === 'published') {
    await client.datasets.revoke(existing.id);
  }
  return client.datasets.update(existing.id, {
    name: spec.name,
    entityType: spec.entityType,
    license: spec.license,
    description: spec.description,
    public: desiredPublic,
    schemaVersion: existing.schemaVersion || '1.0.0',
  });
}

// ---------------------------------------------------------------------------
// Record IO
// ---------------------------------------------------------------------------

async function loadExistingIds(client, datasetId, pageDelayMs = 0) {
  const ids = new Set();
  let offset = 0;
  for (;;) {
    const page = await client.records.list(datasetId, { limit: PAGE_SIZE, offset });
    for (const item of page.items) ids.add(String(item.id));
    if (page.items.length < PAGE_SIZE) break;
    offset += page.items.length;
    if (offset % 5000 === 0 && Number.isFinite(page.total)) {
      log(`${datasetId}: listed ${offset}/${page.total} existing ids`);
    }
    if (Number.isFinite(page.total) && offset >= page.total) break;
    // IAM allows 60 credential verifications per minute per edge address and
    // every Tier-2 request verifies the caller. Paging a 60k-record dataset in
    // a tight loop exhausts that bucket for every other product on the host.
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }
  return ids;
}

function isRetryable(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  const message = String(error.message || '');
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(message);
}

async function recordExists(client, datasetId, id) {
  try {
    await client.records.get(datasetId, id);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/**
 * Resolve a failed bulk entry without guessing: a duplicate id is a skipped
 * record, a missing record is retried once individually so one bad payload
 * cannot hide the rest of the batch.
 */
async function resolveFailedEntry(client, datasetId, entry, failure, progress) {
  try {
    if (await recordExists(client, datasetId, entry.id)) {
      progress.skipped += 1;
      return;
    }
    await client.records.create(datasetId, entry.data, { id: entry.id, publish: entry.publish === true });
    progress.created += 1;
  } catch (error) {
    progress.failed += 1;
    if (progress.errors.length < 20) {
      progress.errors.push({
        id: entry.id,
        code: failure?.code || 'create_failed',
        message: failure?.message || error.message,
      });
    }
  }
}

async function bulkWrite(client, datasetId, entries, progress) {
  let pending = entries.slice();
  for (let attempt = 0; attempt <= 3 && pending.length; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt));
    let result;
    try {
      result = await client.records.bulkCreate(datasetId, pending);
    } catch (error) {
      const body = error.body && typeof error.body === 'object' ? error.body : {};
      const failures = Array.isArray(body.errors) ? body.errors : [];
      if (failures.length) {
        // Tier-2 returns HTTP 400 when every entry failed; some of those may be
        // duplicates from an interrupted run. Resolve them individually.
        for (const failure of failures) {
          const entry = pending[failure.index];
          if (!entry) continue;
          await resolveFailedEntry(client, datasetId, entry, failure, progress);
        }
        return;
      }
      if (isRetryable(error) && attempt < 3) {
        warn(`${datasetId}: transient bulk failure (${error.status || 'network'}); retrying ${pending.length} records`);
        continue;
      }
      progress.failed += pending.length;
      if (progress.errors.length < 20) {
        progress.errors.push({ code: error.status || 'transport', message: error.message });
      }
      return;
    }

    progress.created += result.created.length;
    const failed = [];
    for (const failure of result.errors || []) {
      const entry = pending[failure.index];
      if (entry) failed.push({ entry, failure });
    }
    for (const { entry, failure } of failed) {
      await resolveFailedEntry(client, datasetId, entry, failure, progress);
    }
    return;
  }
  if (pending.length) {
    progress.failed += pending.length;
    if (progress.errors.length < 20) progress.errors.push({ code: 'retry_exhausted', message: `${pending.length} records` });
  }
}

function newProgress() {
  return { created: 0, skipped: 0, failed: 0, errors: [] };
}

function absorbProgress(target, source) {
  target.created += source.created;
  target.skipped += source.skipped;
  target.failed += source.failed;
  for (const error of source.errors) {
    if (target.errors.length >= 20) break;
    target.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function asIso(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeFeatureType(value) {
  return FEATURE_TYPES[String(value || '')] || String(value || 'infrastructure');
}

function normalizeAssetStatus(status, lifecycle) {
  const mapped = ASSET_STATUS[String(status || '').toLowerCase()];
  if (mapped) return mapped;
  if (String(lifecycle || '').toLowerCase() === 'decommissioned') return 'decommissioned';
  return 'active';
}

function normalizeLifecycle(stage, status) {
  if (status === 'decommissioned') return 'decommissioned';
  return LIFECYCLE_STAGE[String(stage || '').toLowerCase()] || 'operational';
}

function assetIsPublic(asset) {
  if (asset.public_visible === false) return false;
  if (asset.deleted_at) return false;
  if (['decommissioned', 'retired', 'deleted', 'purged'].includes(String(asset.status || '').toLowerCase())) return false;
  if (['decommissioned', 'retired', 'deleted'].includes(String(asset.lifecycle_stage || '').toLowerCase())) return false;
  return true;
}

function geometryCoordinates(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return undefined;
  const longitude = Number(geometry.coordinates[0]);
  const latitude = Number(geometry.coordinates[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return undefined;
  return { longitude, latitude };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapAsset(record, context) {
  const id = String(record._id || '');
  if (!id) return null;
  const geometry = record.geometry && typeof record.geometry === 'object' ? record.geometry : undefined;
  const coordinates = geometryCoordinates(geometry);
  const location = {
    ...(record.location && typeof record.location === 'object' ? record.location : {}),
    ...(coordinates ? { coordinates } : {}),
    ...(geometry ? { geometry } : {}),
  };
  const status = normalizeAssetStatus(record.status, record.lifecycle_stage);
  const asset = {
    id,
    assetId: id,
    asset_code: String(record.asset_code || id),
    name: String(record.name || record.asset_code || id),
    feature_type: normalizeFeatureType(record.feature_type),
    feature_code: String(record.feature_code || id),
    category: record.category,
    condition: record.condition,
    status,
    lifecycle_stage: normalizeLifecycle(record.lifecycle_stage, status),
    geometry,
    location,
    // Missing legacy flags default to the City asset default (public); only an
    // explicit false keeps the asset out of the public projection.
    public_visible: record.public_info_visible !== false,
    iot_enabled: record.iot_enabled === true,
    installation_date: asIso(record.installation_date),
    created_by: record.created_by,
    created_at: asIso(record.created_at),
    updated_at: asIso(record.updated_at),
    source: 'openinfra',
    sourceVersion: '1.0.0',
    legacy: {
      status: record.status,
      lifecycle_stage: record.lifecycle_stage,
      public_info_visible: record.public_info_visible,
      contrib_id: record._contrib_id,
    },
  };
  context.assets.set(id, asset);
  return { id, data: asset, publish: assetIsPublic(asset) };
}

function publicComment(comment, index) {
  if (!comment || typeof comment !== 'object' || comment.is_internal === true) return null;
  return {
    id: String(comment.id || `comment-${index + 1}`),
    comment: String(comment.comment || ''),
    posted_at: asIso(comment.posted_at || comment.created_at),
    created_at: asIso(comment.created_at || comment.posted_at),
    is_internal: false,
  };
}

function mapIncident(record, context) {
  const id = String(record._id || '');
  if (!id) return null;
  const geometry = record.location?.geometry;
  const coordinates = geometryCoordinates(geometry);
  const location = {
    ...(record.location && typeof record.location === 'object' ? record.location : {}),
    ...(coordinates ? { coordinates } : {}),
  };
  const photos = (Array.isArray(record.photos) ? record.photos : [])
    .map((value) => {
      const raw = String(value || '');
      const basename = path.basename(raw);
      return context.photoUrls.get(basename) || raw;
    })
    .filter(Boolean);
  const publicVisible = record.public_visible !== false;
  const reportedAt = asIso(record.reported_at || record.created_at);
  const published = {
    id,
    incidentId: id,
    incident_number: record.incident_number,
    incident_code: record.incident_number,
    title: String(record.title || ''),
    description: String(record.description || ''),
    category: String(record.category || 'other'),
    severity: String(record.severity || 'medium'),
    status: String(record.status || 'reported'),
    asset_id: record.asset_id,
    location,
    occurredAt: reportedAt,
    reported_at: reportedAt,
    created_at: asIso(record.created_at),
    updated_at: asIso(record.updated_at),
    acknowledged_at: asIso(record.acknowledged_at),
    resolved_at: asIso(record.resolved_at),
    closed_at: asIso(record.closed_at),
    resolution_type: record.resolution_type,
    upvotes: Number(record.upvotes) || 0,
    comments: (Array.isArray(record.comments) ? record.comments : [])
      .map(publicComment)
      .filter(Boolean),
    ...(photos.length ? { photos } : {}),
    public_visible: publicVisible,
    reporter_type: String(record.reporter_type || 'citizen'),
    ...(record.ai_verified !== undefined ? { ai_verified: record.ai_verified } : {}),
    ...(record.confidence_score !== undefined ? { confidence_score: record.confidence_score } : {}),
    source: 'openinfra',
    sourceVersion: '1.0.0',
  };
  const internalComments = (Array.isArray(record.comments) ? record.comments : [])
    .filter((comment) => comment && typeof comment === 'object' && comment.is_internal === true);
  const contact = record.reporter_contact && typeof record.reporter_contact === 'object' ? record.reporter_contact : {};
  const internalId = `internal-${id}`;
  const internal = {
    id: internalId,
    incident_id: id,
    reported_by: record.reported_by,
    reported_via: record.reported_via,
    contact_info: record.reporter_contact,
    reporter_name: contact.name,
    reporter_phone: contact.phone,
    reporter_email: contact.email,
    reporter_id_card: contact.id_card_number,
    assigned_to: record.assigned_to,
    assigned_at: asIso(record.assigned_at),
    resolution_notes: record.resolution_notes,
    maintenance_record_id: record.maintenance_record_id,
    ...(internalComments.length ? { internal_comments: internalComments } : {}),
    updated_at: asIso(record.updated_at),
  };
  return { id, internalId, published, internal, publish: publicVisible };
}

function mapSensor(record, context) {
  const id = String(record._id || '');
  if (!id) return null;
  const assetId = String(record.asset_id || '');
  const asset = context.assets.get(assetId);
  const lastReading = record.last_reading && typeof record.last_reading === 'object' ? record.last_reading : undefined;
  const sensor = {
    id,
    sensor_code: String(record.sensor_code || id),
    asset_id: assetId,
    sensor_type: String(record.sensor_type || 'unknown'),
    manufacturer: record.manufacturer,
    model: record.model,
    firmware_version: record.firmware_version,
    measurement_unit: record.measurement_unit,
    sample_rate: record.sample_rate,
    thresholds: record.thresholds,
    connection_type: record.connection_type,
    ip_address: record.ip_address,
    mac_address: record.mac_address,
    gateway_id: record.gateway_id,
    status: String(record.status || 'offline'),
    last_seen: asIso(record.last_seen),
    last_reading: lastReading ? asNumber(lastReading.value) : asNumber(record.last_reading),
    last_reading_at: lastReading ? asIso(lastReading.timestamp) : undefined,
    last_reading_unit: lastReading ? lastReading.unit : undefined,
    last_reading_status: lastReading ? lastReading.status : undefined,
    last_reading_detail: lastReading,
    calibration_date: asIso(record.calibration_date),
    calibration_due: asIso(record.calibration_due),
    calibration_factor: record.calibration_factor,
    installed_at: asIso(record.installed_at),
    installed_by: record.installed_by,
    location_description: record.location_description,
    maintenance_schedule: record.maintenance_schedule,
    last_maintenance: asIso(record.last_maintenance),
    next_maintenance: asIso(record.next_maintenance),
    created_at: asIso(record.created_at),
    updated_at: asIso(record.updated_at),
    created_by: record.created_by,
    tags: record.tags,
    ...(asset?.geometry ? { geometry: asset.geometry } : {}),
    ...(asset?.location?.coordinates ? { location: { coordinates: asset.location.coordinates, address: asset.location.address } } : {}),
    ...(asset?.feature_type ? { feature_type: asset.feature_type } : {}),
    ...(asset?.feature_code ? { feature_code: asset.feature_code } : {}),
    source: 'openinfra',
    sourceVersion: '1.0.0',
  };
  return { id, data: sensor, publish: false };
}

function mapAlert(record) {
  const id = String(record._id || '');
  if (!id) return null;
  const status = String(record.status || 'active');
  return {
    id,
    data: {
      id,
      alert_code: record.alert_code,
      source_type: record.source_type,
      sensor_id: record.sensor_id,
      asset_id: record.asset_id,
      alert_type: String(record.type || 'custom'),
      type: String(record.type || 'custom'),
      severity: String(record.severity || 'warning'),
      title: record.title,
      message: String(record.message || ''),
      description: String(record.message || ''),
      trigger_value: record.trigger_value,
      threshold_value: record.threshold_value,
      condition: record.condition,
      status,
      acknowledged: status === 'acknowledged',
      acknowledged_at: status === 'acknowledged' ? asIso(record.updated_at) : undefined,
      triggered_at: asIso(record.triggered_at || record.created_at),
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      auto_created: record.auto_created,
      metadata: record.metadata,
      notifications_sent: record.notifications_sent,
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapMaintenance(record) {
  const id = String(record._id || '');
  if (!id) return null;
  const parts = Array.isArray(record.parts_used) ? record.parts_used : [];
  return {
    id,
    data: {
      id,
      work_order_number: String(record.work_order_number || id),
      asset_id: record.asset_id,
      type: String(record.type || 'corrective'),
      priority: String(record.priority || 'medium'),
      title: String(record.title || ''),
      description: String(record.description || ''),
      status: String(record.status || 'scheduled'),
      scheduled_date: asIso(record.scheduled_date),
      estimated_duration: record.estimated_duration,
      assigned_to: record.assigned_to,
      technician: record.assigned_to,
      parts_used: parts,
      parts_replaced: parts.map((part) => part?.part_name).filter(Boolean),
      approval_status: record.status === 'waiting_approval' ? 'pending' : undefined,
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      created_by: record.created_by,
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapBudget(record) {
  const id = String(record._id || '');
  if (!id) return null;
  return {
    id,
    data: {
      id,
      budget_code: String(record.budget_code || id),
      fiscal_year: record.fiscal_year,
      period_type: record.period_type,
      start_date: asIso(record.start_date),
      end_date: asIso(record.end_date),
      name: record.name,
      description: record.description,
      category: record.category,
      total_allocated: record.total_allocated,
      total_spent: record.total_spent,
      total_remaining: record.total_remaining,
      utilization_rate: record.utilization_rate,
      currency: record.currency || 'VND',
      status: String(record.status || 'draft'),
      departments: record.departments,
      breakdown: record.breakdown,
      created_by: record.created_by,
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      approved_by: record.approved_by,
      approved_at: asIso(record.approved_at),
      // Console projection aliases.
      total_amount: record.total_allocated,
      allocated_amount: record.total_allocated,
      spent_amount: record.total_spent,
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapBudgetTransaction(record) {
  const id = String(record._id || '');
  if (!id) return null;
  const status = String(record.status || 'pending');
  return {
    id,
    data: {
      id,
      transaction_number: String(record.transaction_number || id),
      budget_id: record.budget_id,
      amount: record.amount,
      currency: record.currency || 'VND',
      transaction_date: asIso(record.transaction_date),
      description: record.description,
      category: record.category,
      asset_id: record.asset_id,
      vendor: record.vendor,
      status,
      transaction_type: 'expense',
      approved_at: ['approved', 'paid'].includes(status) ? asIso(record.updated_at) : undefined,
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapUser(record) {
  const id = String(record._id || '');
  if (!id) return null;
  const role = ['admin', 'manager', 'technician', 'volunteer', 'citizen'].includes(String(record.role || '').toLowerCase())
    ? String(record.role).toLowerCase()
    : 'citizen';
  return {
    id,
    data: {
      id,
      username: String(record.username || id),
      email: record.email,
      full_name: record.full_name,
      phone: record.phone,
      role,
      permissions: record.permissions,
      department: record.department,
      avatar_url: record.avatar_url,
      status: String(record.status || 'active'),
      language: record.language,
      notification_preferences: record.notification_preferences,
      last_login: asIso(record.last_login),
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      created_by: record.created_by,
      metadata: record.metadata,
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapReport(record) {
  const id = String(record._id || '');
  if (!id) return null;
  return {
    id,
    data: {
      id,
      report_code: String(record.report_code || id),
      type: String(record.type || 'custom'),
      name: record.name,
      description: record.description,
      parameters: record.parameters,
      format: record.format,
      status: String(record.status || 'pending'),
      created_at: asIso(record.created_at),
      created_by: record.created_by,
      metadata: record.metadata,
      error_message: record.error_message,
      scheduled: record.scheduled,
      schedule_pattern: record.schedule_pattern,
      next_run: asIso(record.next_run),
      source: 'openinfra',
    },
    publish: false,
  };
}

function mapNotification(record) {
  const id = String(record._id || '');
  if (!id) return null;
  const priority = String(record.priority || 'normal');
  return {
    id,
    data: {
      id,
      user_id: record.user_id,
      type: String(record.type || 'system'),
      title: record.title,
      message: record.message,
      entity_type: record.resource_type,
      entity_id: record.resource_id,
      resource_type: record.resource_type,
      resource_id: record.resource_id,
      channels: record.channels,
      read: record.read === true,
      read_at: asIso(record.read_at),
      priority,
      severity: priority === 'high' ? 'warning' : 'info',
      created_at: asIso(record.created_at),
      updated_at: asIso(record.updated_at),
      source: 'openinfra',
    },
    publish: false,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

async function* genericEntries(file, mapper, context) {
  for await (const raw of streamJsonArray(file)) {
    const decoded = decodeExtended(raw);
    const entry = mapper(decoded, context);
    if (entry) yield entry;
  }
}

/**
 * Pick the densest contiguous window of `hours`, anchored on an hour boundary.
 * The legacy readings have a full week of dense history followed by a handful
 * of stale rows months later, so "now - 7 days" would select almost nothing.
 */
async function densestWindow(file, hours) {
  const dayCounts = new Map();
  for await (const raw of streamJsonArray(file)) {
    const record = decodeExtended(raw);
    const timestamp = asIso(record.timestamp);
    if (!timestamp) continue;
    const day = timestamp.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  if (dayCounts.size === 0) return null;
  const days = [...dayCounts.keys()].sort();
  const windowMs = hours * 3_600_000;
  let best = null;
  for (const day of days) {
    const end = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    const start = end - windowMs;
    let count = 0;
    for (const [candidate, value] of dayCounts) {
      const at = Date.parse(`${candidate}T00:00:00Z`);
      if (at >= start && at < end) count += value;
    }
    if (!best || count > best.count) best = { start, end, count, day };
  }
  return best;
}

function readingEntry(id, record) {
  return {
    id,
    data: {
      id,
      sensor_id: String(record.sensor_id || ''),
      asset_id: record.asset_id,
      timestamp: asIso(record.timestamp),
      value: record.value,
      unit: record.unit,
      quality: record.quality,
      status: record.status,
      threshold_exceeded: record.threshold_exceeded,
      metadata: record.metadata,
      source: 'openinfra',
    },
    publish: false,
  };
}

/**
 * Compact time-series selection: one reading per sensor per hour inside the
 * densest window, plus the latest reading per sensor so a sensor card always
 * has a current value. Reading files are grouped by sensor, so this stays
 * memory-bounded and deterministic across resumes.
 */
async function* readingEntries(file, options) {
  if (options.readings === 'none') return;
  let window = null;
  if (options.readings === 'hourly') {
    window = await densestWindow(file, options.readingsWindowHours);
    if (!window) {
      warn('No readings found; skipping the readings collection');
      return;
    }
    log(`readings window: ${new Date(window.start).toISOString()} -> ${new Date(window.end).toISOString()} (${window.count} source rows)`);
  }
  const seenHours = new Set();
  const yielded = new Set();
  const latestBySensor = new Map();
  for await (const raw of streamJsonArray(file)) {
    const record = decodeExtended(raw);
    const id = String(record._id || '');
    const sensorId = String(record.sensor_id || '');
    const timestamp = asIso(record.timestamp);
    if (!id || !sensorId || !timestamp) continue;
    const at = Date.parse(timestamp);
    if (Number.isFinite(at)) {
      const previous = latestBySensor.get(sensorId);
      if (!previous || at > previous.at) latestBySensor.set(sensorId, { at, id, record });
    }
    if (options.readings === 'hourly') {
      if (!window || !Number.isFinite(at) || at < window.start || at >= window.end) continue;
      const hour = Number(timestamp.slice(11, 13));
      const bucket = Number.isFinite(hour)
        ? Math.floor(hour / options.readingsIntervalHours) * options.readingsIntervalHours
        : 0;
      const hourKey = `${sensorId}|${timestamp.slice(0, 10)}|${bucket}`;
      if (seenHours.has(hourKey)) continue;
      seenHours.add(hourKey);
      yielded.add(id);
      yield readingEntry(id, record);
    } else {
      yielded.add(id);
      yield readingEntry(id, record);
    }
  }
  if (options.readings === 'hourly') {
    for (const sensorId of [...latestBySensor.keys()].sort()) {
      const latest = latestBySensor.get(sensorId);
      if (!latest || yielded.has(latest.id)) continue;
      yielded.add(latest.id);
      yield readingEntry(latest.id, latest.record);
    }
  }
}

async function* alertEntries(file, options) {
  if (options.alerts === 'none') return;
  if (options.alerts === 'all') {
    for await (const raw of streamJsonArray(file)) {
      const entry = mapAlert(decodeExtended(raw));
      if (entry) yield entry;
    }
    return;
  }
  // Meaningful alerts: every non-noise alert plus the latest offline alert per
  // sensor. The legacy export contains ~594k repeated "sensor_offline" rows.
  const latestOffline = new Map();
  const yielded = new Set();
  for await (const raw of streamJsonArray(file)) {
    const record = decodeExtended(raw);
    const id = String(record._id || '');
    if (!id) continue;
    if (String(record.type || '') === 'sensor_offline') {
      const sensorId = String(record.sensor_id || '');
      const at = Date.parse(asIso(record.triggered_at || record.created_at) || '');
      const previous = latestOffline.get(sensorId);
      if (!previous || (Number.isFinite(at) && at > previous.at)) {
        latestOffline.set(sensorId, { at: Number.isFinite(at) ? at : 0, id, record });
      }
      continue;
    }
    yielded.add(id);
    yield mapAlert(record);
  }
  for (const sensorId of [...latestOffline.keys()].sort()) {
    const latest = latestOffline.get(sensorId);
    if (!latest || yielded.has(latest.id)) continue;
    yielded.add(latest.id);
    yield mapAlert(latest.record);
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

const PHOTO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileIdForPhoto(filename) {
  return `legacy-${createHash('sha1').update(filename).digest('hex').slice(0, 32)}`;
}

async function importPhotos(client, options) {
  const urls = new Map();
  const archive = path.join(options.dataDir, 'openinfra_core', 'backend_uploads.tar.gz');
  if (!fs.existsSync(archive)) {
    warn(`photo archive not found: ${archive}`);
    return urls;
  }
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'openinfra-photos-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'ignore' });
    const directory = path.join(temporary, 'incidents');
    if (!fs.existsSync(directory)) return urls;
    for (const filename of await fsp.readdir(directory)) {
      const extension = path.extname(filename).toLowerCase();
      const contentType = PHOTO_MIME[extension];
      if (!contentType) continue;
      const bytes = await fsp.readFile(path.join(directory, filename));
      const id = fileIdForPhoto(filename);
      let exists = false;
      try {
        await client.files.get(id);
        exists = true;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (!exists) {
        await client.files.upload({
          id,
          filename,
          contentType,
          size: bytes.length,
          checksumSha256: sha256(bytes),
          datasetId: DATASETS.files.id,
          recordId: id,
          content: bytes,
        });
        log(`uploaded photo ${filename} -> ${id}`);
      }
      const now = new Date().toISOString();
      const metadata = {
        id,
        filename,
        contentType,
        size: bytes.length,
        checksumSha256: sha256(bytes),
        owner: 'openinfra-import',
        public: true,
        entity_type: 'incident',
        created_at: now,
        updated_at: now,
        source: 'openinfra',
        storage: 'tier2-files',
      };
      try {
        await client.records.create(DATASETS.files.id, metadata, { id, publish: false });
      } catch (error) {
        if (error.status !== 400 && error.status !== 409) throw error;
        await client.records.update(DATASETS.files.id, id, metadata);
      }
      urls.set(filename, `${cityPublicUrl()}/v1/public/files/${encodeURIComponent(id)}/content`);
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

async function runCollection({ client, state, key, datasetId, generator, batchSize, dryRun, pacer, readPageDelayMs }) {
  const collectionState = state.collection(key);
  const started = Date.now();
  const existing = dryRun ? new Set() : await loadExistingIds(client, datasetId, readPageDelayMs);
  if (existing.size) log(`${key}: ${existing.size} existing records in ${datasetId}`);
  const progress = newProgress();
  let seen = 0;
  let committed = collectionState.outputOffset || 0;
  let skippedPending = 0;
  let batch = [];
  let frozen = false;
  let lastSaved = Date.now();
  let lastLogged = Date.now();

  /**
   * Commit only in order: a skipped row may not advance the checkpoint past an
   * unwritten record in the same batch, otherwise a crash would lose records.
   * If any record fails, the checkpoint stays behind so the next run retries it;
   * already-written ids are discovered and skipped by id.
   */
  const commit = async (flushBatch) => {
    if (flushBatch) {
      const before = committed;
      if (batch.length && !dryRun) {
        if (pacer) await pacer.wait(batch.length);
        await bulkWrite(client, datasetId, batch, progress);
      }
      if (!frozen && progress.failed > 0) {
        frozen = true;
        warn(`${key}: ${progress.failed} failures; checkpoint stays at ${committed} so the next run retries them`);
      }
      if (!frozen) committed += batch.length + skippedPending;
      else committed = before;
      batch = [];
      skippedPending = 0;
    } else {
      if (batch.length) {
        lastSaved = Date.now();
        return;
      }
      if (!frozen) committed += skippedPending;
      skippedPending = 0;
    }
    collectionState.outputOffset = committed;
    collectionState.created = (collectionState.created || 0) + progress.created;
    collectionState.skipped = (collectionState.skipped || 0) + progress.skipped;
    collectionState.failed = (collectionState.failed || 0) + progress.failed;
    collectionState.errors = progress.errors;
    collectionState.updatedAt = new Date().toISOString();
    progress.created = 0;
    progress.skipped = 0;
    progress.failed = 0;
    if (!dryRun) await state.save();
    lastSaved = Date.now();
  };

  for await (const entry of generator) {
    if (!entry) continue;
    seen += 1;
    if (seen <= committed) continue;
    if (!dryRun && existing.has(entry.id)) {
      skippedPending += 1;
      progress.skipped += 1;
    } else {
      batch.push(entry);
    }
    if (batch.length >= batchSize) {
      await commit(true);
    } else if (Date.now() - lastSaved > 5000) {
      await commit(false);
    }
    if (Date.now() - lastLogged > 30_000) {
      log(`${key}: ${seen} processed (created=${collectionState.created + progress.created} skipped=${collectionState.skipped + progress.skipped + skippedPending} failed=${collectionState.failed + progress.failed})`);
      lastLogged = Date.now();
    }
  }
  await commit(true);
  return {
    key,
    datasetId,
    total: seen,
    created: collectionState.created || 0,
    skipped: collectionState.skipped || 0,
    failed: collectionState.failed || 0,
    errors: collectionState.errors || [],
    durationMs: Date.now() - started,
    dryRun,
  };
}

async function runIncidents({ client, state, file, batchSize, dryRun, photoUrls, pacer, readPageDelayMs }) {
  const key = 'incidents';
  const collectionState = state.collection(key);
  const started = Date.now();
  const publicExisting = dryRun ? new Set() : await loadExistingIds(client, DATASETS.incidents.id, readPageDelayMs);
  const internalExisting = dryRun ? new Set() : await loadExistingIds(client, DATASETS.incidentInternal.id, readPageDelayMs);
  const progress = newProgress();
  let seen = 0;
  let committed = collectionState.outputOffset || 0;
  let publicBatch = [];
  let internalBatch = [];
  let mappedInBatch = 0;
  let frozen = false;

  const flush = async () => {
    if (mappedInBatch === 0) return;
    const before = committed;
    if (!dryRun) {
      if (pacer) await pacer.wait(publicBatch.length + internalBatch.length);
      if (publicBatch.length) await bulkWrite(client, DATASETS.incidents.id, publicBatch, progress);
      if (internalBatch.length) await bulkWrite(client, DATASETS.incidentInternal.id, internalBatch, progress);
    }
    if (!frozen && progress.failed > 0) {
      frozen = true;
      warn(`incidents: ${progress.failed} failures; checkpoint stays at ${committed} so the next run retries them`);
    }
    if (!frozen) committed += mappedInBatch;
    else committed = before;
    collectionState.outputOffset = committed;
    collectionState.created = (collectionState.created || 0) + progress.created;
    collectionState.skipped = (collectionState.skipped || 0) + progress.skipped;
    collectionState.failed = (collectionState.failed || 0) + progress.failed;
    collectionState.errors = progress.errors;
    collectionState.updatedAt = new Date().toISOString();
    progress.created = 0;
    progress.skipped = 0;
    progress.failed = 0;
    publicBatch = [];
    internalBatch = [];
    mappedInBatch = 0;
    if (!dryRun) await state.save();
  };

  for await (const raw of streamJsonArray(file)) {
    const record = decodeExtended(raw);
    const mapped = mapIncident(record, { photoUrls });
    if (!mapped) continue;
    seen += 1;
    if (seen <= committed) continue;
    mappedInBatch += 1;
    if (dryRun) {
      publicBatch.push(mapped);
    } else {
      if (publicExisting.has(mapped.id)) progress.skipped += 1;
      else publicBatch.push({ id: mapped.id, data: mapped.published, publish: mapped.publish });
      if (internalExisting.has(mapped.internalId)) progress.skipped += 1;
      else internalBatch.push({ id: mapped.internalId, data: mapped.internal, publish: false });
    }
    if (publicBatch.length >= batchSize || internalBatch.length >= batchSize) await flush();
  }
  await flush();
  collectionState.updatedAt = new Date().toISOString();
  if (!dryRun) await state.save();
  return {
    key,
    datasetId: DATASETS.incidents.id,
    total: seen,
    created: collectionState.created || 0,
    skipped: collectionState.skipped || 0,
    failed: collectionState.failed || 0,
    errors: collectionState.errors || [],
    durationMs: Date.now() - started,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function selected(options, key) {
  if (!options.only) return true;
  return options.only.includes(key);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  loadEnvFile(options.envFile);
  const client = createClient();
  const health = await client.health();
  if (health?.status !== 'ok') {
    throw new Error(`Tier-2 is not healthy at ${process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs'}: ${JSON.stringify(health)}`);
  }
  log(`Tier-2 connected: ${process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs'}`);
  log(`data pack: ${options.dataDir}`);
  log(`mode: ${options.dryRun ? 'dry-run' : 'write'} | readings=${options.readings} (${options.readingsWindowHours}h/${options.readingsIntervalHours}h) | alerts=${options.alerts} | batch=${options.batchSize} | ${options.recordsPerSecond} rec/s`);
  log(`SOS-owned collections are not imported into City: ${SOS_COLLECTIONS.join(', ')}`);

  const fingerprint = JSON.stringify({
    mappingVersion: MAPPING_VERSION,
    dataDir: path.resolve(options.dataDir),
    readings: options.readings,
    readingsWindowHours: options.readingsWindowHours,
    readingsIntervalHours: options.readingsIntervalHours,
    alerts: options.alerts,
  });
  const state = new ImportState(options.stateFile, fingerprint);
  if (!options.dryRun) {
    await state.load({ fresh: options.fresh });
    log(`state: ${options.stateFile}`);
  }

  if (!options.dryRun) {
    for (const spec of Object.values(DATASETS)) {
      await ensureDataset(client, spec);
    }
    log('datasets ready');
  }

  const pacer = new BulkPacer(options.recordsPerSecond);
  const context = { assets: new Map(), photoUrls: new Map() };
  const results = [];
  const started = Date.now();

  if (selected(options, 'assets')) {
    const result = await runCollection({
      client, state, key: 'assets',
      datasetId: DATASETS.assets.id,
      generator: genericEntries(path.join(options.dataDir, CITY_COLLECTIONS.assets), mapAsset, context),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`assets: ${result.total} mapped`);
  }

  // Sensors need the asset geometry/feature metadata from the pass above.
  if (context.assets.size === 0) {
    for await (const raw of streamJsonArray(path.join(options.dataDir, CITY_COLLECTIONS.assets))) {
      mapAsset(decodeExtended(raw), context);
    }
  }

  if (selected(options, 'photos') || selected(options, 'incidents')) {
    if (!options.dryRun) {
      try {
        context.photoUrls = await importPhotos(client, options);
        log(`photos ready: ${context.photoUrls.size}`);
      } catch (error) {
        warn(`photo import failed (incidents keep their legacy paths): ${error.message}`);
      }
    }
  }

  if (selected(options, 'users')) {
    const file = path.join(options.dataDir, CITY_COLLECTIONS.users);
    const result = await runCollection({
      client, state, key: 'users', datasetId: DATASETS.users.id,
      generator: genericEntries(file, mapUser, context),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`users: ${result.total} mapped (password hashes are never written)`);
  }

  if (selected(options, 'incidents')) {
    const result = await runIncidents({
      client, state, file: path.join(options.dataDir, CITY_COLLECTIONS.incidents),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs, photoUrls: context.photoUrls,
    });
    results.push(result);
    log(`incidents: ${result.total} public + private sidecar records mapped`);
  }

  if (selected(options, 'sensors')) {
    const file = path.join(options.dataDir, CITY_COLLECTIONS.sensors);
    const result = await runCollection({
      client, state, key: 'sensors', datasetId: DATASETS.sensors.id,
      generator: genericEntries(file, mapSensor, context),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`sensors: ${result.total} mapped`);
  }

  if (selected(options, 'alerts')) {
    const file = path.join(options.dataDir, CITY_COLLECTIONS.alerts);
    const result = await runCollection({
      client, state, key: 'alerts', datasetId: DATASETS.alerts.id,
      generator: alertEntries(file, options),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`alerts: ${result.total} selected (${options.alerts})`);
  }

  for (const [key, datasetId, mapper, label] of [
    ['maintenance', DATASETS.maintenance.id, mapMaintenance, 'maintenance'],
    ['budgets', DATASETS.budgets.id, mapBudget, 'budgets'],
    ['budgetTransactions', DATASETS.transactions.id, mapBudgetTransaction, 'budget transactions'],
    ['reports', DATASETS.reports.id, mapReport, 'reports'],
    ['notifications', DATASETS.notifications.id, mapNotification, 'notifications'],
  ]) {
    if (!selected(options, key)) continue;
    const file = path.join(options.dataDir, CITY_COLLECTIONS[key]);
    if (!fs.existsSync(file)) {
      warn(`${label}: source file not found (${file})`);
      continue;
    }
    const result = await runCollection({
      client, state, key, datasetId,
      generator: genericEntries(file, mapper, context),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`${label}: ${result.total} mapped`);
  }

  if (selected(options, 'readings')) {
    const file = path.join(options.dataDir, CITY_COLLECTIONS.readings);
    const result = await runCollection({
      client, state, key: 'readings', datasetId: DATASETS.sensorData.id,
      generator: readingEntries(file, options),
      batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
    });
    results.push(result);
    log(`readings: ${result.total} selected (${options.readings})`);
  }

  if (selected(options, 'geofences')) {
    const file = path.join(options.dataDir, CITY_COLLECTIONS.geofences);
    if (fs.existsSync(file)) {
      const result = await runCollection({
        client, state, key: 'geofences', datasetId: DATASETS.geofences.id,
        generator: genericEntries(file, (record) => {
          const id = String(record._id || '');
          if (!id) return null;
          return { id, data: { ...record, id, source: 'openinfra' }, publish: false };
        }, context),
        batchSize: options.batchSize, dryRun: options.dryRun, pacer, readPageDelayMs: options.readPageDelayMs,
      });
      results.push(result);
      log(`geofences: ${result.total} mapped`);
    }
  }

  if (!options.dryRun) await state.save();

  console.log('');
  console.log('Migration summary');
  console.log('-----------------');
  for (const result of results) {
    console.log(
      `${result.key.padEnd(20)} total=${String(result.total).padStart(7)} `
      + `created=${String(result.created).padStart(7)} skipped=${String(result.skipped).padStart(6)} `
      + `failed=${String(result.failed).padStart(4)} ${formatDuration(result.durationMs)}`,
    );
    for (const error of result.errors.slice(0, 3)) {
      console.log(`  ! ${error.id || ''} ${error.code}: ${error.message}`);
    }
  }
  console.log(`elapsed: ${formatDuration(Date.now() - started)}`);

  if (!options.dryRun) {
    console.log('');
    console.log('Tier-2 dataset totals');
    console.log('---------------------');
    for (const spec of Object.values(DATASETS)) {
      await sleep(250);
      let total = null;
      for (let attempt = 0; attempt < 3 && total === null; attempt += 1) {
        try {
          const page = await client.records.list(spec.id, { limit: 1, offset: 0 });
          total = page.total;
        } catch (error) {
          if (attempt < 2) await sleep(1000 * (attempt + 1));
          else total = `unavailable (${error.status || 'error'})`;
        }
      }
      console.log(`${spec.id.padEnd(26)} ${total}`);
    }
  }

  const failed = results.reduce((total, result) => total + result.failed, 0);
  if (failed > 0) {
    process.exitCode = 1;
    warn(`${failed} records failed; rerun the same command to retry them (existing ids are skipped)`);
  }
}

main().catch((error) => {
  console.error(`[import] FAILED: ${error.stack || error.message}`);
  process.exit(1);
});
