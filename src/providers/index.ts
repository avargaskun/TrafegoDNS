// @ts-nocheck
/**
 * DNS Providers index
 * Exports all provider-related components
 */
import DNSProvider from './base';
import DNSProviderFactory from './factory';
import CloudflareProvider from './cloudflare';
import DigitalOceanProvider from './digitalocean';
import Route53Provider from './route53';

// Provider types enum for easier reference
const ProviderTypes = {
  CLOUDFLARE: 'cloudflare',
  DIGITALOCEAN: 'digitalocean',
  ROUTE53: 'route53'
};

// Export all providers and utilities
export {
  // Base classes
  DNSProvider,
  DNSProviderFactory,
  
  // Provider implementations
  CloudflareProvider,
  DigitalOceanProvider,
  Route53Provider,
  
  // Constants
  ProviderTypes
};