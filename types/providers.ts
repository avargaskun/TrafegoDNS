export interface CloudflareRecordData {
  name?: string;
  priority?: number;
  weight?: number;
  port?: number;
  target?: string;
  flags?: number;
  tag?: string;
  value?: string;
}

export interface CloudflareRecordPayload {
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  priority?: number;
  data?: CloudflareRecordData;
}

export interface CloudflareApiRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  priority?: number;
  data?: CloudflareRecordData;
}

export interface CloudflareZone {
  id: string;
}

export interface CloudflareResponse<T> {
  result: T;
  result_info?: {
    total_pages?: number;
  };
}

export interface DigitalOceanRecordPayload {
  type: string;
  name: string;
  ttl: number;
  data?: string;
  priority?: number;
  weight?: number;
  port?: number;
  flags?: number;
  tag?: string;
}

export interface DigitalOceanApiRecord {
  id: number;
  type: string;
  name: string;
  data: string;
  ttl: number;
  priority: number | null;
  port: number | null;
  weight: number | null;
  flags: number | null;
  tag: string | null;
}

export interface DigitalOceanRecordsResponse {
  domain_records: DigitalOceanApiRecord[];
  links?: {
    pages?: {
      next?: string;
    };
  };
}

export interface DigitalOceanRecordResponse {
  domain_record: DigitalOceanApiRecord;
}
