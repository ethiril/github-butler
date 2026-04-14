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

// Formats a Slack ts (Unix float string) as "Apr 14 at 3:45 PM" (server local time)
function formatTs(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()} at ${h12}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

function inlineDisplayName(msg) {
  return (
    msg?.user_profile?.display_name ||
    msg?.user_profile?.display_name_normalized ||
    msg?.user_profile?.real_name ||
    msg?.profile?.display_name ||
    msg?.profile?.display_name_normalized ||
    msg?.profile?.real_name ||
    msg?.bot_profile?.name ||
    msg?.username ||
    null
  );
}

function bestUserName(user, fallbackUserId) {
  return (
    user?.profile?.display_name ||
    user?.profile?.display_name_normalized ||
    user?.profile?.real_name ||
    user?.real_name ||
    user?.name ||
    fallbackUserId
  );
}

// Resolves the display name for a single message. Caches users.info API calls
// so concurrent lookups for the same user share a single in-flight request.
async function resolveMessageDisplayName(client, userCache, msg) {
  const inlineName = inlineDisplayName(msg);
  if (inlineName) return inlineName;

  const userId = msg?.user;
  if (!userId) return "Unknown";
  if (userCache.has(userId)) return userCache.get(userId);

  const promise = client.users.info({ user: userId })
    .then((result) => {
      const resolved = bestUserName(result?.user, userId);
      console.log("[thread] resolved Slack user", { userId, resolved });
      return resolved;
    })
    .catch((err) => {
      console.warn("[thread] users.info failed", {
        userId,
        message: err?.data?.error || err?.message || String(err),
      });
      return userId;
    });

  userCache.set(userId, promise);
  return promise;
}

// Decodes Slack's mrkdwn special sequences to readable plain text / Markdown.
// Resolves <@U123> user mentions via the shared userCache (avoids duplicate API calls).
async function decodeSlackText(text, userCache, client) {
  // Resolve all user mentions to actual display name strings up front.
  // resolveMessageDisplayName returns a (possibly cached) promise — we await it
  // here so the .replace() below works synchronously with plain strings.
  const names = new Map();
  for (const [, userId, inlineName] of text.matchAll(/<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g)) {
    if (inlineName) {
      names.set(userId, inlineName);
    } else if (!names.has(userId)) {
      names.set(userId, await resolveMessageDisplayName(client, userCache, { user: userId }));
    }
  }

  return text
    // User mentions: <@U123|name> → @name, <@U123> → @resolved-name
    .replace(/<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, userId, inlineName) =>
      `@${inlineName ?? names.get(userId) ?? userId}`
    )
    // Channel mentions: <#C123|name> → #name
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    // Special broadcasts
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone")
    // Links with display text: <https://x.com|label> → label
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1")
    // Plain links: <https://x.com> → https://x.com
    .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}

// Enriches each message with the author's display name, timestamp, decoded text,
// and any image attachments.
//
// Options:
//   sinceTs      — only include messages newer than this Slack ts (tag update flow)
//   imageUploader — async fn(slackFile) => url | null; called for each image attachment.
//                   When provided, images are included as Markdown image references.
export async function compileThreadWithMeta(client, messages, { sinceTs, imageUploader } = {}) {
  const filtered = sinceTs
    ? messages.filter((msg) => parseFloat(msg.ts) > parseFloat(sinceTs))
    : messages;

  if (filtered.length === 0) return "";

  const userCache = new Map();

  const parts = await Promise.all(
    filtered.map(async (msg) => {
      // file_share messages carry the filename as msg.text — suppress it since
      // we render the actual file as an image or link below.
      const rawText = msg.subtype === "file_share" ? "" : (msg.text ?? "").trim();
      const text = rawText ? await decodeSlackText(rawText, userCache, client) : "";

      // Slack stores file attachments in msg.files (plural, newer) or msg.file
      // (singular, older / file_share subtype). Normalise to a single array.
      const allFiles = [
        ...(Array.isArray(msg.files) ? msg.files : []),
        ...(msg.file ? [msg.file] : []),
      ];

      // Collect image lines from file attachments
      const imageLines = [];
      if (imageUploader && allFiles.length > 0) {
        for (const file of allFiles) {
          if (!file.mimetype?.startsWith("image/")) continue;
          const url = await imageUploader(file);
          const label = file.name ?? "image";
          imageLines.push(url ? `![${label}](${url})` : `[${label}](${file.permalink ?? ""})`);
        }
      }

      if (!text && imageLines.length === 0) return null;

      const author = await resolveMessageDisplayName(client, userCache, msg);
      const timestamp = formatTs(msg.ts);

      const quotedLines = [];
      if (text) quotedLines.push(`> ${text.replace(/\n/g, "\n> ")}`);
      imageLines.forEach((img) => quotedLines.push(`> ${img}`));

      return `**${author}** · ${timestamp}\n${quotedLines.join("\n")}`;
    })
  );

  const body = parts.filter(Boolean).join("\n\n");
  return body ? `**Full thread:**\n\n${body}` : "";
}

export function deriveTitle(messageText) {
  const firstLine = (messageText ?? "").split("\n")[0].trim();
  if (!firstLine) return "Issue from Slack";
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + "...";
}