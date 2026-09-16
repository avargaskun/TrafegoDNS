import type { DnsStats } from './dns';

declare global {
  var statsCounter: DnsStats | undefined;
  var proxiedStatusCache: Record<string, boolean | undefined> | undefined;
}

export {};
