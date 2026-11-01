// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const fs = require('node:fs');
const path = require('node:path');

const routeTreePath = path.join(__dirname, '..', 'src', 'routeTree.gen.ts');
const source = fs.readFileSync(routeTreePath, 'utf8');
const header = '// SPDX-License-Identifier: Apache-2.0\n// SPDX-FileCopyrightText: 2026 VKU.VIC\n';

if (!source.includes('SPDX-License-Identifier: Apache-2.0')) {
  fs.writeFileSync(routeTreePath, `${header}${source}`);
}
