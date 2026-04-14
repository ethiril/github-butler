// Thread → GitHub issue mapping store.
// Enables "tag update": when a thread already has an issue, a new butler emoji
// reaction appends only the new messages as a comment instead of creating a
// duplicate.
//
// Backend: DynamoDB when DYNAMODB_TABLE is set, in-memory Map otherwise.
// All exports are async.

const TABLE = process.env.DYNAMODB_TABLE;

// In-memory fallback
const memoryMap = new Map();

// DynamoDB client — created lazily only if TABLE is set, to avoid loading the
// AWS SDK in local Socket Mode where DynamoDB is not used.
let dynamo = null;

async function getDynamo() {
  if (dynamo) return dynamo;
  const { DynamoDBClient, CreateTableCommand } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const clientConfig = {
    region: process.env.AWS_REGION ?? "eu-west-2",
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  };
  const raw = new DynamoDBClient(clientConfig);
  try {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [{ AttributeName: "threadTs", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "threadTs", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }));
    console.log(`[thread-store] created DynamoDB table: ${TABLE}`);
  } catch (err) {
    if (err.name !== "ResourceInUseException") throw err;
  }
  dynamo = DynamoDBDocumentClient.from(raw);
  return dynamo;
}

export async function registerThreadIssue(threadTs, repo, issueNumber, lastSyncedTs) {
  if (!TABLE) {
    memoryMap.set(threadTs, { repo, issueNumber, lastSyncedTs });
    return;
  }

  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { threadTs, repo, issueNumber, lastSyncedTs },
  }));
}

export async function getThreadIssue(threadTs) {
  if (!TABLE) {
    return memoryMap.get(threadTs) ?? null;
  }

  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  const result = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { threadTs },
  }));
  return result.Item ?? null;
}

export async function updateThreadIssueSyncTs(threadTs, lastSyncedTs) {
  if (!TABLE) {
    const entry = memoryMap.get(threadTs);
    if (entry) entry.lastSyncedTs = lastSyncedTs;
    return;
  }

  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { threadTs },
    UpdateExpression: "SET lastSyncedTs = :ts",
    ExpressionAttributeValues: { ":ts": lastSyncedTs },
  }));
}

// For testing only
export function clearThreadIssueMap() {
  memoryMap.clear();
}
