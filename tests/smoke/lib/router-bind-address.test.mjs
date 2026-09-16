import assert from 'node:assert/strict';
import test from 'node:test';

import { readExpectedRouterBindAddress, validateRouterBindAddress } from './router-bind-address.mjs';

test('Router binding expectations retain loopback by default and accept only canonical IPv4 literals', () => {
  assert.equal(readExpectedRouterBindAddress({}), '127.0.0.1');
  assert.equal(readExpectedRouterBindAddress({ SMOKE_BOX_ROUTER_BIND_ADDRESS: '0.0.0.0' }), '0.0.0.0');
  assert.equal(validateRouterBindAddress('192.168.1.50'), '192.168.1.50');
  for (const value of ['', '*', '0', 'localhost', '::', '::1', '[::1]', '192.168.1.50:8080',
    'http://192.168.1.50', '192.168.*.*', '192.168.001.50', ' 0.0.0.0', '127.1',
    '127.0.0.2', '0.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '256.0.0.1', null]) {
    assert.throws(() => validateRouterBindAddress(value), /SMOKE_BOX_ROUTER_BIND_ADDRESS/, String(value));
  }
});

test('an explicitly selected host address must be assigned to this test host', () => {
  const env = { SMOKE_BOX_ROUTER_BIND_ADDRESS: '192.168.1.50' };
  assert.equal(readExpectedRouterBindAddress(env, {
    interfaces: { eth0: [{ family: 'IPv4', address: '192.168.1.50' }] },
  }), '192.168.1.50');
  assert.throws(() => readExpectedRouterBindAddress(env, {
    interfaces: { eth0: [{ family: 'IPv4', address: '192.168.1.51' }] },
  }), /not assigned/);
});
