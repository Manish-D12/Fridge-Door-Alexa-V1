import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ObligationSchema, type Obligation } from '@fridge-door/shared';
import type { ObligationStore } from './types.js';

export interface DynamoStoreOptions {
  tableName: string;
  region: string;
  endpoint?: string | undefined;
}

export function createDynamoClient(opts: Omit<DynamoStoreOptions, 'tableName'>): DynamoDBClient {
  return new DynamoDBClient({ region: opts.region, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
}

/**
 * DynamoDB store. Table: PK `householdId` (S), SK `id` (S).
 * A household is a single partition, so listing is one paginated Query.
 */
export class DynamoObligationStore implements ObligationStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoStoreOptions, client: DynamoDBClient = createDynamoClient(opts)) {
    this.table = opts.tableName;
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  describe(): string {
    return `DynamoDB table ${this.table}`;
  }

  async list(householdId: string): Promise<Obligation[]> {
    const items: Obligation[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': householdId },
          ExclusiveStartKey,
        }),
      );
      for (const raw of res.Items ?? []) items.push(parseItem(raw));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async get(householdId: string, id: string): Promise<Obligation | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { householdId, id } }));
    return res.Item ? parseItem(res.Item) : null;
  }

  async put(obligation: Obligation): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: obligation }));
  }

  async markDone(householdId: string, id: string, doneBy: string, doneAt: string): Promise<Obligation | null> {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { householdId, id },
          UpdateExpression: 'SET #status = :done, doneBy = :by, doneAt = :at',
          ConditionExpression: 'attribute_exists(id) AND #status <> :done',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':done': 'done', ':by': doneBy, ':at': doneAt },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes ? parseItem(res.Attributes) : null;
    } catch (err) {
      // Either missing or already done: report the current state.
      if (err instanceof ConditionalCheckFailedException) return this.get(householdId, id);
      throw err;
    }
  }

  async clearHousehold(householdId: string): Promise<number> {
    const items = await this.list(householdId);
    for (let i = 0; i < items.length; i += 25) {
      let requests: Record<string, unknown[]> | undefined = {
        [this.table]: items.slice(i, i + 25).map((o) => ({ DeleteRequest: { Key: { householdId, id: o.id } } })),
      };
      for (let attempt = 0; requests && Object.keys(requests).length > 0; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** attempt)));
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: requests as never }));
        requests = res.UnprocessedItems as Record<string, unknown[]> | undefined;
      }
    }
    return items.length;
  }
}

function parseItem(raw: Record<string, unknown>): Obligation {
  const parsed = ObligationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Malformed obligation in DynamoDB (${String(raw.householdId)}/${String(raw.id)}): ${parsed.error.message}`);
  }
  return parsed.data;
}
