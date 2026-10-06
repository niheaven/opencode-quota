import { isTrackedUpstreamPluginInSync } from "./upstream-plugin-identity.mjs";
import { getUpstreamPluginIssueTitle } from "./upstream-plugin-specs.mjs";

export const UPSTREAM_PLUGIN_ISSUE_STATE = Object.freeze({
  SYNCED_PENDING_REVIEW: "synced_pending_review",
  UPDATE_AVAILABLE: "update_available",
});

function buildMarker(name, value) {
  return `<!-- opencode-quota:${name}=${value} -->`;
}

function parseIssueMarkers(body) {
  const markers = {};
  const pattern = /<!--\s*opencode-quota:([a-z0-9-]+)=([^\n]*?)\s*-->/g;

  for (const match of body?.matchAll?.(pattern) ?? []) {
    markers[match[1]] = match[2];
  }

  return markers;
}

function buildNewReleaseComment(pluginId, previousVersion, latestVersion) {
  return `Newer upstream npm release detected for ${pluginId}: ${previousVersion} -> ${latestVersion}.`;
}

function buildDuplicateIssueComment({
  canonicalIssueNumber,
  issueState,
  latestVersion,
  referenceDir,
}) {
  if (issueState === UPSTREAM_PLUGIN_ISSUE_STATE.SYNCED_PENDING_REVIEW) {
    return `Closing as duplicate of #${canonicalIssueNumber}. ${referenceDir} now matches ${latestVersion}, but the maintainer review issue remains open.`;
  }

  return `Closing as duplicate of #${canonicalIssueNumber}. The tracked reference is still behind npm ${latestVersion}.`;
}

function getDesiredIssueState(tracked, latest) {
  return isTrackedUpstreamPluginInSync(tracked, latest)
    ? UPSTREAM_PLUGIN_ISSUE_STATE.SYNCED_PENDING_REVIEW
    : UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE;
}

export function buildUpstreamPluginIssueBody({ spec, tracked, latest, issueState }) {
  const reviewCommand = "pnpm run upstream:prepare-review";
  const intro =
    issueState === UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE
      ? "An upstream companion plugin has a newer npm release than the copy tracked in this repository."
      : "The tracked copy now matches the latest npm release, but review, compatibility checking, and release work are still pending.";

  return [
    intro,
    "",
    `- Plugin: \`${spec.pluginId}\``,
    `- Package: \`${latest.packageName}\``,
    `- Repository: \`${latest.repo}\``,
    `- Tracked version: \`${tracked.version}\``,
    `- Latest npm version: \`${latest.version}\``,
    `- Issue state: \`${issueState}\``,
    `- Published at: \`${latest.publishedAt}\``,
    `- Reference path: \`${spec.referenceDir}\``,
    `- Review-prep command: \`${reviewCommand}\``,
    `- npm release: ${latest.npmUrl}`,
    `- Upstream repo: ${latest.repoUrl}`,
    "",
    buildMarker("plugin", spec.pluginId),
    buildMarker("issue-state", issueState),
    buildMarker("tracked-version", tracked.version),
    buildMarker("latest-version", latest.version),
    buildMarker("reference-dir", spec.referenceDir),
  ].join("\n");
}

export function planUpstreamPluginIssueAction({
  spec,
  tracked,
  latest,
  existingIssues,
  closedIssues = [],
}) {
  const title = getUpstreamPluginIssueTitle(spec.pluginId);
  const issueState = getDesiredIssueState(tracked, latest);
  const body = buildUpstreamPluginIssueBody({ issueState, latest, spec, tracked });
  const matchingIssues = [...existingIssues]
    .map((issue) => ({
      issue,
      markers: parseIssueMarkers(issue.body ?? ""),
    }))
    .filter(({ markers }) => markers.plugin === spec.pluginId)
    .sort((left, right) => left.issue.number - right.issue.number);

  if (matchingIssues.length === 0) {
    if (issueState === UPSTREAM_PLUGIN_ISSUE_STATE.SYNCED_PENDING_REVIEW) {
      return {
        title,
        body,
        close: [],
        comments: [],
        create: null,
        update: null,
      };
    }

    // The maintainer closed this plugin's issue for this same npm version (checked, no
    // effect on us, nothing synced). Stay quiet until npm publishes a newer version.
    const closedForThisVersion = closedIssues.some((issue) => {
      const markers = parseIssueMarkers(issue.body ?? "");
      return markers.plugin === spec.pluginId && markers["latest-version"] === latest.version;
    });
    if (closedForThisVersion) {
      return {
        title,
        body,
        close: [],
        comments: [],
        create: null,
        update: null,
      };
    }

    return {
      title,
      body,
      close: [],
      comments: [],
      create: { body, title },
      update: null,
    };
  }

  const [{ issue: canonicalIssue, markers: currentMarkers }, ...duplicateIssues] = matchingIssues;
  const previousLatestVersion = currentMarkers["latest-version"];
  const comments = [];

  if (
    issueState === UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE &&
    previousLatestVersion &&
    previousLatestVersion !== latest.version
  ) {
    comments.push({
      body: buildNewReleaseComment(spec.pluginId, previousLatestVersion, latest.version),
      issueNumber: canonicalIssue.number,
    });
  }

  return {
    title,
    body,
    close: duplicateIssues.map((issue) => ({
      commentBody: buildDuplicateIssueComment({
        canonicalIssueNumber: canonicalIssue.number,
        issueState,
        latestVersion: latest.version,
        referenceDir: spec.referenceDir,
      }),
      issueNumber: issue.issue.number,
    })),
    comments,
    create: null,
    update:
      canonicalIssue.body === body
        ? null
        : {
            body,
            issueNumber: canonicalIssue.number,
          },
  };
}
