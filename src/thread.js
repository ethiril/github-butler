// Pure thread utilities (no Slack/GitHub I/O except fetchThreadMessages).

export async function fetchThreadMessages(client, channelId, threadTs) {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 100,
  }).catch(() => null);
  return result?.messages ?? [];
}

export function compileThread(messages) {
  if (messages.length === 0) return "";
  const lines = messages
    .map((msg) => (msg.text ?? "").replace(/\n/g, "\n> "))
    .filter(Boolean)
    .map((text) => `> ${text}`);
  return "**Full thread:**\n\n" + lines.join("\n>\n");
}

export function deriveTitle(messageText) {
  const firstLine = (messageText ?? "").split("\n")[0].trim();
  if (!firstLine) return "Issue from Slack";
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + "...";
}
