import { getUserDefaults, setUserDefaults } from "./defaults.js";
import {
  buildModal,
  buildAddToIssueModal,
  buildProjectFieldMap,
  resolveDefaultProjectId,
  toSlackOption,
} from "./modal.js";
import { fetchThreadMessages, compileThread, deriveTitle } from "./thread.js";

// ── Shared quick-create logic ─────────────────────────────────────────────────
// Used by both the emoji reaction handler and the Quick Create button handler.
// Skips the form; uses the user's last-saved defaults. Thread is automatically
// compiled into the body when the message is part of a thread.

async function quickCreate({ client, github, userId, channelId, threadTs, messageText, permalink }) {
  const defaults = getUserDefaults(userId);
  if (!defaults.repo) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: "No default repo saved. Use *Create Issue* (form) once to set your preferences.",
    });
    return;
  }

  const title = deriveTitle(messageText);

  let body = messageText;
  if (threadTs) {
    const threadMsgs = await fetchThreadMessages(client, channelId, threadTs);
    if (threadMsgs.length > 1) {
      body = compileThread(threadMsgs);
    }
  }
  if (permalink) {
    body += `\n\n---\n_Created from Slack: ${permalink}_`;
  }

  try {
    const createdIssue = await github.createIssue({
      repo: defaults.repo,
      title,
      body,
      labels: defaults.labelValues,
      milestone: defaults.milestoneValue ? Number(defaults.milestoneValue) : undefined,
    });

    if (defaults.projectId) {
      await github.addIssueToProject(defaults.projectId, createdIssue.node_id)
        .catch((err) => console.error("Failed to add quick-create issue to project:", err.message));
    }

    await client.chat.postMessage({
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      text: `Issue created: <${createdIssue.html_url}|${defaults.repo}#${createdIssue.number} -- ${title}>`,
    });
  } catch (err) {
    console.error("Quick create failed:", err);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `Failed to create issue: ${err.message}`,
    });
  }
}

// ── Issue display helper ──────────────────────────────────────────────────────

async function showIssue(client, channelId, userId, repo, issueNumber, github) {
  const issue = await github.getIssue(repo, issueNumber).catch(() => null);
  if (!issue) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Could not find ${repo}#${issueNumber}.`,
    });
    return;
  }
  const labels = issue.labels.map((l) => l.name).join(", ") || "none";
  const assignees = issue.assignees.map((a) => a.login).join(", ") || "unassigned";
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: `${repo}#${issueNumber}: ${issue.title}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${issue.html_url}|${repo}#${issueNumber}: ${issue.title}>*\nState: ${issue.state} | Labels: ${labels} | Assignees: ${assignees}`,
      },
    }],
  });
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerHandlers(app, github) {
  // 1. Message shortcut → open the modal
  app.shortcut("create_github_issue", async ({ shortcut, ack, client }) => {
    await ack();

    const messageText = shortcut.message?.text ?? "";
    const channelId = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts ?? shortcut.message?.ts;
    const messageTs = shortcut.message?.ts;
    const userId = shortcut.user?.id;

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    }).catch(() => null);

    const slackMessageContext = {
      channelId,
      threadTs,
      messageTs,
      userId,
      permalink: permalinkResult?.permalink ?? "",
      projectFieldMap: {},
    };

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildModal({ messageText, metadata: slackMessageContext }),
    });
  });

  // 2. /issue slash command
  //    /issue           → open form
  //    /issue 123       → look up issue #123 in last-used repo
  //    /issue repo#123  → look up issue in a specific repo
  //    /issue search q  → search open issues
  //    /issue <text>    → open form with title pre-filled
  app.command("/issue", async ({ command, ack, client }) => {
    await ack();

    const text = (command.text ?? "").trim();
    const userId = command.user_id;

    const plainNumMatch = /^(\d+)$/.exec(text);
    if (plainNumMatch) {
      const defaults = getUserDefaults(userId);
      if (!defaults.repo) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: "No default repo saved. Create an issue first, or use `/issue repo-name#123`.",
        });
        return;
      }
      await showIssue(client, command.channel_id, userId, defaults.repo, parseInt(plainNumMatch[1], 10), github);
      return;
    }

    const repoNumMatch = /^([^#\s]+)#(\d+)$/.exec(text);
    if (repoNumMatch) {
      await showIssue(client, command.channel_id, userId, repoNumMatch[1], parseInt(repoNumMatch[2], 10), github);
      return;
    }

    if (text.toLowerCase().startsWith("search ")) {
      const query = text.slice(7).trim();
      if (!query) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: "Usage: `/issue search <query>`",
        });
        return;
      }
      const items = await github.searchIssues(query).catch(() => []);
      if (items.length === 0) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: `No issues found for "${query}".`,
        });
        return;
      }
      const lines = items
        .map((item) => {
          const repoName = item.repository_url.split("/").pop();
          return `• <${item.html_url}|${repoName}#${item.number}: ${item.title}> — ${item.state}`;
        })
        .join("\n");
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: `Search results for "${query}"`,
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: `*Search results for "${query}":*\n\n${lines}` },
        }],
      });
      return;
    }

    // Default: open form (text becomes pre-filled title)
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal({
        currentTitle: text,
        metadata: {
          channelId: command.channel_id,
          threadTs: null,
          messageTs: null,
          userId,
          permalink: "",
          projectFieldMap: {},
        },
      }),
    });
  });

  // 3. @mention in a thread → ephemeral message with Create Issue + Quick Create buttons
  // Workaround: Slack does not provide a trigger_id on message events,
  // so a modal cannot be opened directly. The button click provides one.
  // Usage: @GitHub Butler [optional title]
  app.event("app_mention", async ({ event, client }) => {
    const issueTitle = event.text.replace(/<@[^>]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;

    const slackMessageContext = {
      channelId: event.channel,
      threadTs,
      messageTs: event.ts,
      userId: event.user,
      permalink: "",
      projectFieldMap: {},
    };

    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: threadTs,
      text: issueTitle ? `Create issue: ${issueTitle}` : "Create a GitHub issue from this thread?",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: issueTitle
              ? `Create issue: *${issueTitle}*`
              : "Create a GitHub issue from this thread?",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Create Issue" },
              action_id: "open_modal_from_mention",
              value: JSON.stringify({ ...slackMessageContext, issueTitle }),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Quick Create" },
              action_id: "quick_create_from_mention",
              value: JSON.stringify({ ...slackMessageContext, issueTitle }),
            },
          ],
        },
      ],
    });
  });

  // 4. "Create Issue" button from @mention → open the modal
  app.action("open_modal_from_mention", async ({ ack, action, body, client }) => {
    await ack();

    const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({ currentTitle: issueTitle ?? "", metadata: slackMessageContext }),
    });
  });

  // 5. "Quick Create" button from @mention → create issue immediately using saved defaults
  app.action("quick_create_from_mention", async ({ ack, action, body, client }) => {
    await ack();

    const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);

    await quickCreate({
      client,
      github,
      userId: body.user?.id,
      channelId: slackMessageContext.channelId,
      threadTs: slackMessageContext.threadTs,
      messageText: issueTitle ?? "",
      permalink: slackMessageContext.permalink,
    });
  });

  // 6. Emoji reaction → quick-create issue from the reacted-to message
  // Enabled when QUICK_CREATE_EMOJI is set (e.g. QUICK_CREATE_EMOJI=github_butler).
  // Uses the reactor's saved defaults. Full thread is automatically included
  // when the reacted message is part of a thread.
  app.event("reaction_added", async ({ event, client }) => {
    const configuredEmoji = process.env.QUICK_CREATE_EMOJI;
    if (!configuredEmoji || event.reaction !== configuredEmoji) return;
    if (event.item.type !== "message") return;

    const historyResult = await client.conversations.history({
      channel: event.item.channel,
      latest: event.item.ts,
      inclusive: true,
      limit: 1,
    }).catch(() => null);

    const message = historyResult?.messages?.[0];
    if (!message) return;

    const permalinkResult = await client.chat.getPermalink({
      channel: event.item.channel,
      message_ts: event.item.ts,
    }).catch(() => null);

    await quickCreate({
      client,
      github,
      userId: event.user,
      channelId: event.item.channel,
      threadTs: message.thread_ts ?? null,
      messageText: message.text ?? "",
      permalink: permalinkResult?.permalink ?? "",
    });
  });

  // 7. External data source for the repo selector (used by both modals)
  app.options("repo_select", async ({ ack }) => {
    try {
      const repos = await github.getRepos();
      await ack({ options: repos.map((repoName) => toSlackOption(repoName, repoName)) });
    } catch (err) {
      await ack({ options: [toSlackOption(`Error: ${err.message}`, "__error__")] });
    }
  });

  // 8. Repo selected → load labels/milestones/projects/templates and apply user defaults
  app.action("repo_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedRepo = action.selected_option?.value;
    if (!selectedRepo || selectedRepo === "__error__") return;

    // The add_to_issue_modal repo selector doesn't use dispatch_action so this
    // handler only fires for the create_issue_modal.
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
    const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";
    const defaults = getUserDefaults(body.user?.id);

    const [labels, milestones, projects, templates] = await Promise.all([
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
    ]);

    const initialProjectId = resolveDefaultProjectId(
      projects,
      defaults.projectId,
      process.env.DEFAULT_GITHUB_PROJECT
    );
    const projectFields = initialProjectId
      ? await github.getProjectFields(initialProjectId).catch(() => [])
      : [];
    const projectFieldMap = buildProjectFieldMap(projectFields);

    const initialMilestoneValue = milestones.some((m) => m.value === defaults.milestoneValue)
      ? defaults.milestoneValue
      : null;
    const initialLabelValues = defaults.labelValues.filter((labelValue) =>
      labels.some((label) => label.value === labelValue)
    );

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap },
        currentTitle,
        currentBody,
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialProjectId,
        initialMilestoneValue,
        initialLabelValues,
      }),
    });
  });

  // 9. Template selected → pre-fill title, body, and labels from the template
  app.action("template_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedTemplateName = action.selected_option?.value;
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const selectedRepo = modalView.state.values.repo_block?.repo_select?.selected_option?.value;
    if (!selectedRepo) return;

    const defaults = getUserDefaults(body.user?.id);
    const currentProjectId = modalView.state.values.project_block?.project_select?.selected_option?.value ?? null;

    const [labels, milestones, projects, templates, projectFields] = await Promise.all([
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
      currentProjectId ? github.getProjectFields(currentProjectId).catch(() => []) : Promise.resolve([]),
    ]);

    const selectedTemplate = templates.find((t) => t.name === selectedTemplateName);
    const resolvedProjectId =
      resolveDefaultProjectId(projects, defaults.projectId, process.env.DEFAULT_GITHUB_PROJECT)
      ?? currentProjectId;
    const initialMilestoneValue = milestones.some((m) => m.value === defaults.milestoneValue)
      ? defaults.milestoneValue
      : null;

    const templateLabelValues = selectedTemplate?.labels.filter((lv) =>
      labels.some((l) => l.value === lv)
    ) ?? [];
    const initialLabelValues = templateLabelValues.length > 0
      ? templateLabelValues
      : defaults.labelValues.filter((lv) => labels.some((l) => l.value === lv));

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap: buildProjectFieldMap(projectFields) },
        currentTitle: selectedTemplate?.title ?? modalView.state.values.title_block?.title_input?.value ?? "",
        currentBody: selectedTemplate?.body ?? modalView.state.values.body_block?.body_input?.value ?? "",
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: resolvedProjectId,
        initialMilestoneValue,
        initialLabelValues,
      }),
    });
  });

  // 10. Project selected → load and display the project's custom fields
  app.action("project_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedProjectId = action.selected_option?.value;
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const selectedRepo = modalView.state.values.repo_block?.repo_select?.selected_option?.value;
    if (!selectedRepo) return;

    const selectedTemplateName = modalView.state.values.template_block?.template_select?.selected_option?.value ?? null;
    const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
    const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";
    const currentLabelValues = modalView.state.values.labels_block?.labels_select?.selected_options?.map((o) => o.value) ?? [];
    const currentMilestoneValue = modalView.state.values.milestone_block?.milestone_select?.selected_option?.value ?? null;

    const [labels, milestones, projects, templates, projectFields] = await Promise.all([
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
      selectedProjectId ? github.getProjectFields(selectedProjectId).catch(() => []) : Promise.resolve([]),
    ]);

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap: buildProjectFieldMap(projectFields) },
        currentTitle,
        currentBody,
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: selectedProjectId,
        initialMilestoneValue: currentMilestoneValue,
        initialLabelValues: currentLabelValues,
      }),
    });
  });

  // 11. "Add to GitHub Issue" message shortcut → open the add-to-issue modal
  app.shortcut("add_to_github_issue", async ({ shortcut, ack, client }) => {
    await ack();

    const messageText = shortcut.message?.text ?? "";
    const channelId = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts ?? shortcut.message?.ts;
    const messageTs = shortcut.message?.ts;

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    }).catch(() => null);

    const slackMessageContext = {
      channelId,
      threadTs,
      messageTs,
      userId: shortcut.user?.id,
      permalink: permalinkResult?.permalink ?? "",
    };

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildAddToIssueModal({ messageText, metadata: slackMessageContext }),
    });
  });

  // 12. Create issue modal submitted → create the GitHub issue and save user defaults
  app.view("create_issue_modal", async ({ ack, view, client }) => {
    const formValues = view.state.values;
    const slackMessageContext = JSON.parse(view.private_metadata);

    const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
    const issueTitle = formValues.title_block?.title_input?.value ?? "";
    const selectedLabels = formValues.labels_block?.labels_select?.selected_options?.map((opt) => opt.value) ?? [];
    const milestoneValue = formValues.milestone_block?.milestone_select?.selected_option?.value ?? null;
    const selectedProjectId = formValues.project_block?.project_select?.selected_option?.value ?? null;
    const parentIssueInput = formValues.parent_issue_block?.parent_issue_input?.value?.trim() ?? null;
    const includeThread = formValues.thread_block?.include_thread?.selected_options?.some(
      (opt) => opt.value === "include_thread"
    ) ?? false;

    setUserDefaults(slackMessageContext.userId, {
      repo: selectedRepo,
      projectId: selectedProjectId,
      milestoneValue,
      labelValues: selectedLabels,
    });

    await ack();

    const slackThreadLink = slackMessageContext.permalink
      ? `\n\n---\n_Created from Slack: ${slackMessageContext.permalink}_`
      : "";

    let issueBody = formValues.body_block?.body_input?.value ?? "";

    if (includeThread && slackMessageContext.threadTs) {
      const threadMsgs = await fetchThreadMessages(
        client,
        slackMessageContext.channelId,
        slackMessageContext.threadTs
      );
      const threadContent = compileThread(threadMsgs);
      if (threadContent) {
        issueBody = issueBody ? `${issueBody}\n\n${threadContent}` : threadContent;
      }
    }

    issueBody += slackThreadLink;

    try {
      const createdIssue = await github.createIssue({
        repo: selectedRepo,
        title: issueTitle,
        body: issueBody,
        labels: selectedLabels,
        milestone: milestoneValue ? Number(milestoneValue) : undefined,
      });

      if (selectedProjectId) {
        const projectItemId = await github.addIssueToProject(selectedProjectId, createdIssue.node_id)
          .catch((err) => { console.error("Failed to add issue to project:", err.message); return null; });

        if (projectItemId && slackMessageContext.projectFieldMap) {
          await github.setProjectItemFields(
            selectedProjectId,
            projectItemId,
            slackMessageContext.projectFieldMap,
            formValues
          );
        }
      }

      if (parentIssueInput) {
        await github.linkParentIssue(selectedRepo, parentIssueInput, createdIssue.node_id);
      }

      await client.chat.postMessage({
        channel: slackMessageContext.channelId,
        ...(slackMessageContext.threadTs ? { thread_ts: slackMessageContext.threadTs } : {}),
        unfurl_links: false,
        text: `Issue created: <${createdIssue.html_url}|${selectedRepo}#${createdIssue.number} -- ${issueTitle}>`,
      });
    } catch (err) {
      console.error("Failed to create issue:", err);
      await client.chat.postMessage({
        channel: slackMessageContext.userId,
        text: `Failed to create GitHub issue in *${selectedRepo}*: ${err.message}`,
      });
    }
  });

  // 13. Add-to-issue modal submitted → add a comment to the specified GitHub issue
  app.view("add_to_issue_modal", async ({ ack, view, client }) => {
    const formValues = view.state.values;
    const slackMessageContext = JSON.parse(view.private_metadata);

    const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
    const issueNumberRaw = (formValues.issue_number_block?.issue_number_input?.value ?? "").trim();
    const issueNumber = parseInt(issueNumberRaw.replace(/^#/, ""), 10);

    if (!selectedRepo || isNaN(issueNumber)) {
      await ack({
        response_action: "errors",
        errors: {
          ...(!selectedRepo ? { repo_block: "Please select a repository." } : {}),
          ...(isNaN(issueNumber) ? { issue_number_block: "Please enter a valid issue number." } : {}),
        },
      });
      return;
    }

    await ack();

    const includeThread = formValues.thread_block?.include_thread?.selected_options?.some(
      (opt) => opt.value === "include_thread"
    ) ?? false;

    const slackLink = slackMessageContext.permalink
      ? `\n\n---\n_Added from Slack: ${slackMessageContext.permalink}_`
      : "";

    let commentBody = formValues.body_block?.body_input?.value ?? "";

    if (includeThread && slackMessageContext.threadTs) {
      const threadMsgs = await fetchThreadMessages(
        client,
        slackMessageContext.channelId,
        slackMessageContext.threadTs
      );
      const threadContent = compileThread(threadMsgs);
      if (threadContent) {
        commentBody = commentBody ? `${commentBody}\n\n${threadContent}` : threadContent;
      }
    }

    commentBody += slackLink;

    try {
      const comment = await github.addIssueComment(selectedRepo, issueNumber, commentBody);
      await client.chat.postMessage({
        channel: slackMessageContext.channelId,
        ...(slackMessageContext.threadTs ? { thread_ts: slackMessageContext.threadTs } : {}),
        unfurl_links: false,
        text: `Comment added to <${comment.html_url}|${selectedRepo}#${issueNumber}>`,
      });
    } catch (err) {
      console.error("Failed to add comment:", err);
      await client.chat.postMessage({
        channel: slackMessageContext.userId,
        text: `Failed to add comment to *${selectedRepo}#${issueNumber}*: ${err.message}`,
      });
    }
  });
}
