import type { Config } from '../config.js';
import { DynamoObligationStore } from './dynamo.js';
import { LocalJsonStore } from './local.js';
import type { ObligationStore } from './types.js';

export type { ObligationStore } from './types.js';

export function createStore(config: Config): ObligationStore {
  if (config.STORAGE === 'local') return new LocalJsonStore(config.LOCAL_DATA_FILE);
  return new DynamoObligationStore({
    tableName: config.DYNAMODB_TABLE,
    region: config.AWS_REGION,
    endpoint: config.DYNAMODB_ENDPOINT,
  });
}
