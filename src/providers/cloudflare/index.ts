/**
 * Cloudflare Provider module
 * Exports the Cloudflare DNS provider implementation
 */
import CloudflareProvider from './provider';
import { convertRecord, convertToCloudflareFormat } from './converter';
import { validateRecord } from './validator';

// Export the provider class as default
export default CloudflareProvider;

// Also export utility functions
export { convertRecord, convertToCloudflareFormat, validateRecord };