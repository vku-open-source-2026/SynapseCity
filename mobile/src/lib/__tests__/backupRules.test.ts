// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const androidRoot = fileURLToPath(
  new URL('../../../android/app/src/main/', import.meta.url),
);

function read(relativePath: string): string {
  return readFileSync(`${androidRoot}${relativePath}`, 'utf8');
}

function exclusions(xml: string): string[] {
  return [...xml.matchAll(/<exclude\s+domain="([^"]+)"\s+path="([^"]+)"\s*\/>/g)].map(
    (match) => `${match[1]}:${match[2]}`,
  );
}

describe('Android backup privacy rules', () => {
  it('wires both manifest attributes to existing XML resources', () => {
    const manifest = read('AndroidManifest.xml');
    expect(manifest).toContain('android:fullBackupContent="@xml/secure_store_backup_rules"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/secure_store_data_extraction_rules"');
    expect(read('res/xml/secure_store_backup_rules.xml')).toContain('<full-backup-content>');
    expect(read('res/xml/secure_store_data_extraction_rules.xml')).toContain('<data-extraction-rules>');
  });

  it('excludes SecureStore and legacy AsyncStorage sessions from Android 11 backup', () => {
    const xml = read('res/xml/secure_store_backup_rules.xml');
    const rules = exclusions(xml);
    expect(rules).toContain('sharedpref:SecureStore.xml');
    expect(rules).toContain('database:RKStorage');
  });

  it('excludes SecureStore and legacy AsyncStorage sessions from cloud and D2D transfers', () => {
    const xml = read('res/xml/secure_store_data_extraction_rules.xml');
    const cloud = xml.match(/<cloud-backup>([\s\S]*?)<\/cloud-backup>/)?.[1] ?? '';
    const device = xml.match(/<device-transfer>([\s\S]*?)<\/device-transfer>/)?.[1] ?? '';
    for (const section of [cloud, device]) {
      const rules = exclusions(section);
      expect(rules).toContain('sharedpref:SecureStore.xml');
      expect(rules).toContain('database:RKStorage');
    }
  });
});
