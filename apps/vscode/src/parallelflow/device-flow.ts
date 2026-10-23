// OAuth-style device sign-in (RFC 8628 shape): get a code, open the browser, poll until the person
// approves. Pure: the API, browser, clock and sleep are injected.
import type { DeviceCode, DeviceToken, DeviceTokenResult } from './api.js';

export interface DeviceFlowDeps {
  deviceCode(clientName: string): Promise<DeviceCode>;
  deviceToken(deviceCode: string): Promise<DeviceTokenResult>;
  /** Open verification_uri_complete and show the code to compare. */
  present(code: DeviceCode): void | Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  signal?: AbortSignal;
  clientName?: string;
}

export type DeviceFlowFailure = 'expired' | 'denied' | 'cancelled' | 'unreachable';

export class DeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    message: string,
  ) {
    super(message);
  }
}

const SLOW_DOWN_MS = 5000;
const MAX_NETWORK_FAILURES = 5;

export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceToken> {
  const code = await deps.deviceCode(deps.clientName ?? 'VS Code');
  await deps.present(code);
  let intervalMs = Math.max(1, code.interval || 5) * 1000;
  const deadline = deps.now() + code.expires_in * 1000;
  let failures = 0;

  for (;;) {
    if (deps.signal?.aborted) throw new DeviceFlowError('cancelled', 'Sign-in cancelled');
    await deps.sleep(intervalMs, deps.signal);
    if (deps.signal?.aborted) throw new DeviceFlowError('cancelled', 'Sign-in cancelled');
    if (deps.now() > deadline)
      throw new DeviceFlowError('expired', 'The sign-in code expired. Try again.');

    let result: DeviceTokenResult;
    try {
      result = await deps.deviceToken(code.device_code);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= MAX_NETWORK_FAILURES) {
        throw new DeviceFlowError('unreachable', `Sign-in failed: ${(err as Error).message}`);
      }
      intervalMs = Math.min(intervalMs * 2, 30_000);
      continue;
    }
    if (result.ok) return result.token;
    switch (result.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += SLOW_DOWN_MS;
        continue;
      case 'expired_token':
        throw new DeviceFlowError('expired', 'The sign-in code expired. Try again.');
      case 'access_denied':
        throw new DeviceFlowError('denied', 'Sign-in was declined in the browser.');
    }
  }
}
