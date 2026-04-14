// Local HTTP adapter for testing Lambda/HTTP mode without deploying to AWS.
//
// Usage:
//   node local-lambda.js [port]          (default port 3000)
//
// Then expose it to Slack with ngrok:
//   ngrok http 3000
//
// Point your Slack app's Request URL to:
//   https://<ngrok-id>.ngrok.io/slack/events
//
// Environment: set SLACK_SIGNING_SECRET (not SLACK_APP_TOKEN) so the app
// initialises in HTTP/Lambda mode. Do NOT set SLACK_APP_TOKEN.

import { createServer } from "node:http";
import { handler } from "./app.js";

const PORT = parseInt(process.argv[2] ?? "3000", 10);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  // Flatten multi-value headers into single strings (API Gateway v1 format)
  const headers = {};
  for (const [key, val] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(val) ? val.join(",") : val;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  const queryStringParameters = {};
  for (const [k, v] of url.searchParams) queryStringParameters[k] = v;

  // API Gateway v1 (REST API) event format — matches what AwsLambdaReceiver expects
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
    headers,
    body: rawBody || null,
    isBase64Encoded: false,
  };

  const context = {
    functionName: "slack-github-issues-local",
    awsRequestId: `local-${Date.now()}`,
    getRemainingTimeInMillis: () => 30000,
  };

  try {
    const result = await handler(event, context);
    const responseHeaders = result.headers ?? {};
    res.writeHead(result.statusCode ?? 200, responseHeaders);
    res.end(result.body ?? "");
  } catch (err) {
    console.error("[local-lambda] unhandled error:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`[local-lambda] listening on http://localhost:${PORT}`);
  console.log(`[local-lambda] Slack Request URL: https://<ngrok-id>.ngrok.io/slack/events`);
});
