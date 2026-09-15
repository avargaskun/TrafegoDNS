// @ts-nocheck
/**
 * DigitalOcean Provider module
 * Exports the DigitalOcean DNS provider implementation
 */
import DigitalOceanProvider from './provider';
import { convertRecord, convertToDigitalOceanFormat } from './converter';
import { validateRecord } from './validator';

// Export the provider class as default
export default DigitalOceanProvider;

// Also export utility functions
export { convertRecord, convertToDigitalOceanFormat, validateRecord };
