/**
 * Creates the DynamoDB table (PK householdId, SK id, on-demand billing).
 *   npm run create-table
 * Honours DYNAMODB_TABLE, AWS_REGION and DYNAMODB_ENDPOINT (for DynamoDB Local).
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { loadConfig } from '../src/config.js';
import { createDynamoClient } from '../src/store/dynamo.js';

const config = loadConfig();
const client = createDynamoClient({ region: config.AWS_REGION, endpoint: config.DYNAMODB_ENDPOINT });
const TableName = config.DYNAMODB_TABLE;

try {
  await client.send(
    new CreateTableCommand({
      TableName,
      AttributeDefinitions: [
        { AttributeName: 'householdId', AttributeType: 'S' },
        { AttributeName: 'id', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'householdId', KeyType: 'HASH' },
        { AttributeName: 'id', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      Tags: [{ Key: 'app', Value: 'fridge-door' }],
    }),
  );
  console.log(`Creating table ${TableName} in ${config.AWS_REGION}...`);
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName });
  console.log(`Table ${TableName} is ACTIVE.`);
} catch (err) {
  if (err instanceof ResourceInUseException) {
    const { Table } = await client.send(new DescribeTableCommand({ TableName }));
    console.log(`Table ${TableName} already exists (status ${Table?.TableStatus}).`);
  } else {
    console.error(`Failed to create table ${TableName}:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
