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
