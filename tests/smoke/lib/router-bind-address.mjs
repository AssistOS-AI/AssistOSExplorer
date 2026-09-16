import { isIPv4 } from 'node:net';
import os from 'node:os';

export const DEFAULT_ROUTER_BIND_ADDRESS = '127.0.0.1';
export const ROUTER_BIND_ADDRESS_LABEL = 'io.assistos.ploinky-box.router-bind-address';

export function validateRouterBindAddress(value = DEFAULT_ROUTER_BIND_ADDRESS) {
  if (typeof value !== 'string' || !isIPv4(value)) {
    throw new Error('SMOKE_BOX_ROUTER_BIND_ADDRESS must be one canonical IPv4 address without a port.');
  }
  if (value === DEFAULT_ROUTER_BIND_ADDRESS || value === '0.0.0.0') return value;
  const [first, second] = value.split('.').map(Number);
  if (first === 0 || first === 127 || first >= 224 || (first === 169 && second === 254)) {
    throw new Error('SMOKE_BOX_ROUTER_BIND_ADDRESS must be 127.0.0.1, 0.0.0.0, or an assigned host IPv4 address.');
  }
  return value;
}

export function readExpectedRouterBindAddress(env = process.env, { interfaces = os.networkInterfaces() } = {}) {
  const address = validateRouterBindAddress(env.SMOKE_BOX_ROUTER_BIND_ADDRESS);
  if (address !== DEFAULT_ROUTER_BIND_ADDRESS && address !== '0.0.0.0'
    && !Object.values(interfaces).flat().some((entry) => (
      (entry?.family === 'IPv4' || entry?.family === 4) && entry.address === address
    ))) {
    throw new Error('SMOKE_BOX_ROUTER_BIND_ADDRESS is not assigned to a network interface on this test host.');
  }
  return address;
}

export function assertRouterBindAddressLabel(labels, expectedAddress = DEFAULT_ROUTER_BIND_ADDRESS) {
  const address = validateRouterBindAddress(expectedAddress);
  const labelled = Object.hasOwn(labels || {}, ROUTER_BIND_ADDRESS_LABEL);
  if (address === DEFAULT_ROUTER_BIND_ADDRESS ? labelled : labels?.[ROUTER_BIND_ADDRESS_LABEL] !== address) {
    throw new Error('Box router-bind-address label does not match the explicitly expected Router binding.');
  }
  return address;
}
