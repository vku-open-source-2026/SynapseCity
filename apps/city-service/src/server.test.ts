import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server';

test('advertises the domain boundary and Tier-2 dependency', async () => {
  const server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/v1/city`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.tier, 3);
  assert.equal(body.dependency, 'https://synapsedx.sbs');
  server.close();
});

