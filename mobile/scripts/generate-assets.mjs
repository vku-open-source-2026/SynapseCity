// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const cityIcon = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#071726"/><stop offset="1" stop-color="#0B2B3D"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#67E8F9"/><stop offset="1" stop-color="#22C55E"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <circle cx="512" cy="470" r="250" fill="#22D3EE" opacity="0.08"/>
  <path d="M256 690h512" stroke="#67E8F9" stroke-width="24" stroke-linecap="round" opacity="0.55"/>
  <g fill="url(#accent)">
    <rect x="276" y="500" width="92" height="190" rx="18" opacity="0.75"/>
    <rect x="392" y="410" width="104" height="280" rx="20" opacity="0.9"/>
    <rect x="520" y="468" width="92" height="222" rx="18" opacity="0.8"/>
    <rect x="636" y="536" width="112" height="154" rx="18" opacity="0.7"/>
  </g>
  <g stroke="#071726" stroke-width="14" opacity="0.55">
    <path d="M416 450h56M416 500h56M416 550h56M416 600h56"/>
    <path d="M544 508h44M544 558h44M544 608h44"/>
  </g>
  <path d="M512 246c-68 0-122 54-122 122 0 92 122 202 122 202s122-110 122-202c0-68-54-122-122-122z" fill="#F8FAFC"/>
  <circle cx="512" cy="366" r="44" fill="#0EA5B7"/>
</svg>`;

const sosIcon = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#160A12"/><stop offset="1" stop-color="#3A0D1B"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FB7185"/><stop offset="1" stop-color="#F59E0B"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <circle cx="512" cy="480" r="270" fill="#F43F5E" opacity="0.12"/>
  <path d="M512 196l258 96v196c0 158-104 278-258 340-154-62-258-182-258-340V292z" fill="none" stroke="url(#accent)" stroke-width="42" stroke-linejoin="round"/>
  <path d="M512 322v196" stroke="#F8FAFC" stroke-width="52" stroke-linecap="round"/>
  <circle cx="512" cy="612" r="34" fill="#F8FAFC"/>
  <path d="M250 796c62-44 130-66 204-66M570 730c74 0 142 22 204 66" stroke="#FB7185" stroke-width="26" stroke-linecap="round" opacity="0.55"/>
</svg>`;

const splashCity = `
<svg width="1284" height="1284" viewBox="0 0 1284 1284" xmlns="http://www.w3.org/2000/svg">
  <rect width="1284" height="1284" fill="#F4FBFB"/>
  <g transform="translate(322 322) scale(0.625)">${cityIcon.trim().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>
  <text x="642" y="1040" text-anchor="middle" font-family="Segoe UI, Arial" font-size="64" font-weight="700" fill="#0F172A">SynapseCity</text>
  <text x="642" y="1104" text-anchor="middle" font-family="Segoe UI, Arial" font-size="32" fill="#0F766E">city infrastructure, in your pocket</text>
</svg>`;

const splashSos = `
<svg width="1284" height="1284" viewBox="0 0 1284 1284" xmlns="http://www.w3.org/2000/svg">
  <rect width="1284" height="1284" fill="#160A12"/>
  <g transform="translate(322 322) scale(0.625)">${sosIcon.trim().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>
  <text x="642" y="1040" text-anchor="middle" font-family="Segoe UI, Arial" font-size="64" font-weight="700" fill="#FFF1F2">SynapseSOS</text>
  <text x="642" y="1104" text-anchor="middle" font-family="Segoe UI, Arial" font-size="32" fill="#FDA4AF">emergency operations, when it matters</text>
</svg>`;

async function save(name, svg, size) {
  const path = resolve(root, name);
  await mkdir(dirname(path), { recursive: true });
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path);
  console.log(`${name} ${size}x${size}`);
}

const brand = process.argv[2] === 'sos' ? 'sos' : 'city';
const icon = brand === 'sos' ? sosIcon : cityIcon;
const splash = brand === 'sos' ? splashSos : splashCity;

await save('assets/icon.png', icon, 1024);
await save('assets/adaptive-icon.png', icon, 1024);
await save('assets/splash-icon.png', splash, 1284);
await save('assets/notification-icon.png', `
<svg width="96" height="96" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <path d="M48 8l30 12v22c0 20-13 34-30 42C31 76 18 62 18 42V20z" fill="#FFFFFF"/>
  <path d="M48 28v20" stroke="#000" stroke-width="6" stroke-linecap="round"/>
  <circle cx="48" cy="58" r="4" fill="#000"/>
</svg>`, 96);
