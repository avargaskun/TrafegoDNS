/**
 * Cache utility functions for Route53 provider
 */
import { ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import logger from '../../utils/logger';
import type { ListResourceRecordSetsCommandInput, RRType } from '@aws-sdk/client-route-53';
import type Route53Provider from './provider';
import type { Route53Record, Route53RecordSet } from '../../../types/providers';

/**
 * Fetch all records from Route53, handling pagination
 */
async function fetchAllRecords(this: Route53Provider): Promise<Route53Record[]> {
  let allRecords: Route53Record[] = [];
  let isTruncated: boolean | undefined = true;
  let nextRecordName: string | null | undefined = null;
  let nextRecordType: RRType | null | undefined = null;
  let nextRecordIdentifier: string | null | undefined = null;
  
  while (isTruncated) {
    try {
      const params: ListResourceRecordSetsCommandInput = {
        HostedZoneId: this.zoneId
      };
      
      // Handle pagination
      if (nextRecordName) {
        params.StartRecordName = nextRecordName;
        params.StartRecordType = nextRecordType!;
        
        if (nextRecordIdentifier) {
          params.StartRecordIdentifier = nextRecordIdentifier;
        }
      }
      
      const command = new ListResourceRecordSetsCommand(params);
      const response = await this.route53.send(command);
      
      // Process and standardize records
      const standardizedRecords = this.standardizeRecords(response.ResourceRecordSets as Route53RecordSet[]);
      allRecords = allRecords.concat(standardizedRecords);
      
      // Check if there are more records to fetch
      isTruncated = response.IsTruncated;
      
      if (isTruncated) {
        nextRecordName = response.NextRecordName;
        nextRecordType = response.NextRecordType;
        nextRecordIdentifier = response.NextRecordIdentifier;
      }
    } catch (error) {
      logger.error(`Error fetching DNS records: ${error.message}`);
      throw error;
    }
  }
  
  return allRecords;
}

/**
 * Find a record in the cache
 * Override to handle Route53's trailing dots in names
 */
function findRecordInCache(this: Route53Provider, type: string, name: string): Route53Record | null {
  // Normalize the name (remove trailing dot if present)
  const normalizedName = name.endsWith('.') ? name.slice(0, -1) : name;
  
  logger.trace(`Route53Provider.findRecordInCache: Looking for ${type} record with name ${normalizedName}`);
  
  // Find in cache
  const record = this.recordCache.records.find(r => {
    // Normalize record name as well
    const recordName = r.name.endsWith('.') ? r.name.slice(0, -1) : r.name;
    return r.type === type && recordName === normalizedName;
  });
  
  if (record) {
    logger.trace(`Route53Provider.findRecordInCache: Found record with name ${record.name}`);
    return record;
  }
  
  logger.trace(`Route53Provider.findRecordInCache: No record found`);
  return null;
}

/**
 * Update a record in the cache
 */
function updateRecordInCache(this: Route53Provider, record: Route53Record): void {
  logger.trace(`Route53Provider.updateRecordInCache: Updating record in cache: name=${record.name}, type=${record.type}`);
  
  const index = this.recordCache.records.findIndex(
    r => r.name === record.name && r.type === record.type
  );
  
  if (index !== -1) {
    logger.trace(`Route53Provider.updateRecordInCache: Found existing record at index ${index}, replacing`);
    this.recordCache.records[index] = record;
  } else {
    logger.trace(`Route53Provider.updateRecordInCache: Record not found in cache, adding new record`);
    this.recordCache.records.push(record);
  }
}

/**
 * Remove a record from the cache
 */
function removeRecordFromCache(this: Route53Provider, name: string, type: string): void {
  logger.trace(`Route53Provider.removeRecordFromCache: Removing record name=${name}, type=${type} from cache`);
  
  const initialLength = this.recordCache.records.length;
  this.recordCache.records = this.recordCache.records.filter(
    record => !(record.name === name && record.type === type)
  );
  
  const removed = initialLength - this.recordCache.records.length;
  logger.trace(`Route53Provider.removeRecordFromCache: Removed ${removed} records from cache`);
}

export {
  fetchAllRecords,
  findRecordInCache,
  updateRecordInCache,
  removeRecordFromCache
};