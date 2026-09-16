import type ConfigManager from '../src/config/ConfigManager';

export type LabelPrefixes = Pick<ConfigManager, 'genericLabelPrefix' | 'dnsLabelPrefix' | 'traefikLabelPrefix'>;

export interface RecordTypeDefaults {
  content: string;
  proxied?: boolean;
  ttl: number;
  priority?: number;
  weight?: number;
  port?: number;
  flags?: number;
  tag?: string;
}

export interface IpCache {
  ipv4: string | null | undefined;
  ipv6: string | null | undefined;
  lastCheck: number;
}
