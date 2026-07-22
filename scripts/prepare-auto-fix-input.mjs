#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function limitedText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function exactRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export async function prepareAutoFixInput({
  event,
  revision,
  githubRepository,
  apiBase = "https://api.github.com",
  token,
  fetchImpl = fetch,
}) {
  invariant(event?.action === "labeled", "Auto Fix requires an issues.labeled event");
  invariant(event?.sender?.login === "xiaotianfotos", "Only xiaotianfotos may activate Auto Fix");
  invariant(event?.label?.name === "auto-fix", "Auto Fix requires the exact auto-fix label");
  invariant(event?.issue && !event.issue.pull_request, "Auto Fix accepts issues, not pull requests");
  const repo = event?.repository?.full_name;
  invariant(exactRepository(repo) && repo === githubRepository, "Auto Fix repository does not match GITHUB_REPOSITORY");
  invariant(event?.repository?.owner?.login === "xiaotianfotos", "Auto Fix is restricted to the repository owner");
  invariant(Number.isInteger(event.issue.number) && event.issue.number > 0, "Auto Fix issue number is invalid");
  invariant(typeof revision === "string" && /^[0-9a-f]{40}$/i.test(revision), "Auto Fix revision must be an exact commit SHA");
  const cloneUrl = event?.repository?.clone_url;
  invariant(
    typeof cloneUrl === "string" && /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(cloneUrl),
    "Auto Fix repository clone URL is invalid",
  );
  const defaultBranch = event?.repository?.default_branch;
  invariant(typeof defaultBranch === "string" && defaultBranch.length > 0 && defaultBranch.length <= 255, "Auto Fix default branch is invalid");
  invariant(typeof token === "string" && token.length > 0, "A GitHub token is required to read issue discussion");
  const apiRoot = new URL(apiBase);
  invariant(apiRoot.protocol === "https:", "GitHub API base must use HTTPS");
  const commentCount = Number.isInteger(event.issue.comments) && event.issue.comments >= 0
    ? event.issue.comments
    : 0;
  const commentsPage = Math.max(1, Math.ceil(commentCount / 100));
  const commentsUrl = new URL(
    `/repos/${repo}/issues/${event.issue.number}/comments?per_page=100&page=${commentsPage}`,
    `${apiRoot.origin}/`,
  );
  const response = await fetchImpl(commentsUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  invariant(response.ok, `GitHub issue comments request failed with HTTP ${response.status}`);
  const comments = await response.json();
  invariant(Array.isArray(comments), "GitHub issue comments response is invalid");

  return {
    repo,
    issue: event.issue.number,
    title: limitedText(event.issue.title, 500) || `Issue #${event.issue.number}`,
    body: limitedText(event.issue.body, 50_000),
    repository_url: cloneUrl,
    revision: revision.toLowerCase(),
    branch: defaultBranch,
    labels: (Array.isArray(event.issue.labels) ? event.issue.labels : [])
      .map((label) => typeof label === "string" ? label : label?.name)
      .filter((label) => typeof label === "string")
      .slice(0, 100)
      .map((label) => label.slice(0, 200)),
    discussion: comments.slice(-32).map((comment) => ({
      author: limitedText(comment?.user?.login, 200) || "unknown",
      body: limitedText(comment?.body, 8192),
    })),
  };
}

async function main(argv) {
  invariant(argv.length === 1, "usage: prepare-auto-fix-input.mjs <output.json>");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  invariant(eventPath && fs.existsSync(eventPath), "GITHUB_EVENT_PATH is missing");
  const prepared = await prepareAutoFixInput({
    event: JSON.parse(fs.readFileSync(eventPath, "utf8")),
    revision: process.env.AUTO_FIX_REVISION,
    githubRepository: process.env.GITHUB_REPOSITORY,
    apiBase: process.env.GITHUB_API_URL,
    token: process.env.GITHUB_TOKEN,
  });
  fs.writeFileSync(argv[0], `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`Cannot prepare Auto Fix input: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
