/**
 * Route53 Provider module
 * Exports the Route53 DNS provider implementation
 */
import Route53Provider from './provider';
import { convertRecord, convertToRoute53Format, ensureTrailingDot } from './converter';
import { validateRecord } from './validator';
import { standardizeRecords, recordNeedsUpdate } from './recordUtils';
import { 
  fetchAllRecords,
  findRecordInCache,
  updateRecordInCache,
  removeRecordFromCache
} from './cacheUtils';
import {
  createRecord,
  updateRecord,
  deleteRecord,
  batchEnsureRecords
} from './operationUtils';

// Export the provider class as default
export default Route53Provider;

// Also export utility functions
export {
  convertRecord,
  convertToRoute53Format,
  ensureTrailingDot,
  validateRecord,
  standardizeRecords,
  recordNeedsUpdate,
  fetchAllRecords,
  findRecordInCache,
  updateRecordInCache,
  removeRecordFromCache,
  createRecord,
  updateRecord,
  deleteRecord,
  batchEnsureRecords
};