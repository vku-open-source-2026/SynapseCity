#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const fs = require('fs');
const path = require('path');

const SPLASH_SIZES = [
  { name: 'splash-640x1136', width: 640, height: 1136 },
  { name: 'splash-750x1334', width: 750, height: 1334 },
  { name: 'splash-1242x2208', width: 1242, height: 2208 },
  { name: 'splash-1125x2436', width: 1125, height: 2436 },
  { name: 'splash-1170x2532', width: 1170, height: 2532 },
  { name: 'splash-1179x2556', width: 1179, height: 2556 },
  { name: 'splash-1284x2778', width: 1284, height: 2778 },
  { name: 'splash-1290x2796', width: 1290, height: 2796 },
];
const ICON_SIZES = [{ name: 'apple-touch-icon-180x180', size: 180 }];
const OUTPUT_DIR = path.join(__dirname, '../public/icons');
const PRODUCT_NAME = process.env.SYNAPSE_PRODUCT_NAME || 'SynapseCity';

function createSplashSVG(width, height) {
  const logoSize = Math.min(width, height) * 0.2;
  const centerX = width / 2;
  const centerY = height / 2 - 50;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">\n' +
    '  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#4FACFE"/><stop offset="100%" style="stop-color:#00F2FE"/></linearGradient></defs>\n' +
    '  <rect width="' + width + '" height="' + height + '" fill="url(#bg)"/>\n' +
    '  <g transform="translate(' + (centerX - logoSize / 2) + ', ' + (centerY - logoSize / 2) + ')"><rect width="' + logoSize + '" height="' + logoSize + '" rx="' + (logoSize * 0.2) + '" fill="white"/><path d="M12 2L2 7L12 12L22 7L12 2ZM2 17L12 22L22 17M2 12L12 17L22 12" transform="scale(' + (logoSize / 24) + ')" stroke="#4FACFE" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>\n' +
    '  <text x="' + centerX + '" y="' + (centerY + logoSize / 2 + 60) + '" font-family="system-ui, sans-serif" font-size="' + (logoSize * 0.25) + '" font-weight="700" fill="white" text-anchor="middle">' + PRODUCT_NAME + '</text>\n' +
    '</svg>\n';
}

function createIconSVG(size) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">\n' +
    '  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#4FACFE"/><stop offset="100%" style="stop-color:#00F2FE"/></linearGradient></defs>\n' +
    '  <rect width="' + size + '" height="' + size + '" fill="url(#bg)"/>\n' +
    '  <path d="M12 2L2 7L12 12L22 7L12 2ZM2 17L12 22L22 17M2 12L12 17L22 12" transform="scale(' + (size / 24) + ')" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>\n' +
    '</svg>\n';
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const item of SPLASH_SIZES) {
  fs.writeFileSync(path.join(OUTPUT_DIR, item.name + '.svg'), createSplashSVG(item.width, item.height));
}
for (const item of ICON_SIZES) {
  fs.writeFileSync(path.join(OUTPUT_DIR, item.name + '.svg'), createIconSVG(item.size));
}
console.log('Generated ' + (SPLASH_SIZES.length + ICON_SIZES.length) + ' SVG assets in ' + OUTPUT_DIR);
