import axios from "axios";
import { HTMLElement, parse } from "node-html-parser";
import { getAllPullRequests, addAssignees } from "../../helpers/issue";
import { Context } from "../../types/context";
import { IssueType } from "../../types/payload";

// Check for pull requests linked to their respective issues but not assigned to them
export async function checkPullRequests(context: Context) {
  const { logger, payload } = context;
  const pulls = await getAllPullRequests(context);

  if (pulls.length === 0) {
    return logger.debug(`No pull requests found at this time`);
  }

  // Loop through the pull requests and assign them to their respective issues if needed
  for (const pull of pulls) {
    if (!pull.user) {
      continue;
    }

    const connectedPull = await getPullByNumber(context, pull.number);

    // Newly created PULL (draft or direct) pull does have same `created_at` and `updated_at`.
    if (!connectedPull || connectedPull.created_at !== connectedPull.updated_at) {
      logger.debug("It's an updated Pull Request, reverting");
      continue;
    }

    const linkedIssue = await getLinkedIssues({
      owner: payload.repository.owner.login,
      repository: payload.repository.name,
      pull: pull.number,
    });

    if (linkedIssue == null || !linkedIssue) {
      await associatePullRequestWithAssignedIssue(context, pull, pulls, connectedPull.body);
      continue;
    }

    const linkedIssueNumber = linkedIssue.substring(linkedIssue.lastIndexOf("/") + 1);

    // Check if the pull request opener is assigned to the issue
    const opener = pull.user.login;

    const issue = await getIssueByNumber(context, +linkedIssueNumber);
    if (!issue?.assignees) continue;

    // if issue is already assigned, continue
    if (issue.assignees.length > 0) {
      logger.debug(`Issue already assigned, ignoring...`);
      continue;
    }

    const assignedUsernames = issue.assignees.map((assignee) => assignee.login);
    if (!assignedUsernames.includes(opener)) {
      await addAssignees(context, +linkedIssueNumber, [opener]);
      logger.debug("Assigned pull request opener to issue", {
        pullRequest: pull.number,
        issue: linkedIssueNumber,
        opener,
      });
    }
  }
  return logger.debug(`Checking pull requests done!`);
}

export async function getLinkedIssues({ owner, repository, pull }: GetLinkedParams) {
  const { data } = await axios.get(`https://github.com/${owner}/${repository}/pull/${pull}`);
  const dom = parse(data);
  const devForm = dom.querySelector("[data-target='create-branch.developmentForm']") as HTMLElement;
  if (!devForm) {
    return null;
  }
  const linkedIssues = devForm.querySelectorAll(".my-1");

  if (linkedIssues.length === 0) {
    return null;
  }

  const issueUrl = linkedIssues[0].querySelector("a")?.attrs?.href || null;
  return issueUrl;
}

export async function getPullByNumber(context: Context, pull: number) {
  const payload = context.payload;

  try {
    const response = await context.octokit.rest.pulls.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: pull,
    });
    return response.data;
  } catch (err: unknown) {
    context.logger.fatal("Fetching pull request failed!", err);
    return;
  }
}

async function associatePullRequestWithAssignedIssue(
  context: Context,
  pull: PullRequestSummary,
  pulls: PullRequestSummary[],
  body?: string | null
) {
  if (!pull.user) {
    return;
  }

  const assignedIssues = await getAssignedIssues(context, pull.user.login);

  if (assignedIssues.length === 0) {
    context.logger.debug("No assigned issue found for pull request opener", {
      pullRequest: pull.number,
      opener: pull.user.login,
    });
    return;
  }

  const candidateIssues = await removeAssignedIssuesWithOpenPullRequests(context, pull, pulls, assignedIssues);

  if (candidateIssues.length === 0) {
    context.logger.debug("Assigned issues already have open pull requests", {
      pullRequest: pull.number,
      opener: pull.user.login,
      assignedIssues: assignedIssues.map((issue) => issue.number),
    });
    return;
  }

  if (candidateIssues.length > 1) {
    await addAmbiguousAssignmentComment(context, pull.number, pull.user.login, candidateIssues);
    return;
  }

  await linkPullRequestToIssue(context, pull.number, candidateIssues[0].number, body);
}

async function getAssignedIssues(context: Context, username: string): Promise<AssignedIssue[]> {
  const payload = context.payload;

  try {
    const issues = (await context.octokit.paginate(
      context.octokit.rest.issues.listForRepo,
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        state: IssueType.OPEN,
        per_page: 100,
      },
      ({ data: issues }) =>
        issues.filter(
          (issue) => !issue.pull_request && issue.assignees?.some((assignee) => assignee && assignee.login === username)
        )
    )) as AssignedIssue[];
    return issues;
  } catch (err: unknown) {
    context.logger.fatal("Fetching assigned issues failed!", err);
    return [];
  }
}

async function linkPullRequestToIssue(context: Context, pullNumber: number, issueNumber: number, body?: string | null) {
  const payload = context.payload;
  const trimmedBody = body?.trim();
  const linkedBody = trimmedBody ? `${trimmedBody}\n\nResolves #${issueNumber}` : `Resolves #${issueNumber}`;

  try {
    await context.octokit.rest.pulls.update({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: pullNumber,
      body: linkedBody,
    });
    context.logger.debug("Linked pull request to assigned issue", {
      pullRequest: pullNumber,
      issue: issueNumber,
    });
  } catch (err: unknown) {
    context.logger.fatal("Linking pull request to issue failed!", err);
  }
}

async function removeAssignedIssuesWithOpenPullRequests(
  context: Context,
  pull: PullRequestSummary,
  pulls: PullRequestSummary[],
  assignedIssues: AssignedIssue[]
) {
  const pullOwner = pull.user?.login;
  if (!pullOwner || assignedIssues.length <= 1) {
    return assignedIssues;
  }

  const payload = context.payload;
  const linkedIssueNumbers = new Set<number>();

  for (const openPull of pulls) {
    if (openPull.number === pull.number || openPull.user?.login !== pullOwner) {
      continue;
    }

    const linkedIssue = await getLinkedIssues({
      owner: payload.repository.owner.login,
      repository: payload.repository.name,
      pull: openPull.number,
    });

    const linkedIssueNumber = linkedIssue ? Number(linkedIssue.substring(linkedIssue.lastIndexOf("/") + 1)) : null;
    if (linkedIssueNumber) {
      linkedIssueNumbers.add(linkedIssueNumber);
    }
  }

  return assignedIssues.filter((issue) => !linkedIssueNumbers.has(issue.number));
}

async function addAmbiguousAssignmentComment(
  context: Context,
  pullNumber: number,
  opener: string,
  assignedIssues: AssignedIssue[]
) {
  const payload = context.payload;
  const issueList = assignedIssues.map((issue) => `#${issue.number}`).join(", ");

  try {
    await context.octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: pullNumber,
      body: `@${opener} I found multiple open issues assigned to you (${issueList}), so I cannot safely associate this pull request automatically. Please add \`Resolves #...\` to the pull request body for the issue this change resolves.`,
    });
    context.logger.debug("Added ambiguous issue association warning", {
      pullRequest: pullNumber,
      opener,
      assignedIssues: assignedIssues.map((issue) => issue.number),
    });
  } catch (err: unknown) {
    context.logger.fatal("Adding ambiguous issue association warning failed!", err);
  }
}

// Get issues by issue number
export async function getIssueByNumber(context: Context, issueNumber: number) {
  const payload = context.payload;
  try {
    const { data: issue } = await context.octokit.rest.issues.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNumber,
    });
    return issue;
  } catch (e: unknown) {
    context.logger.fatal("Fetching issue failed!", e);
    return;
  }
}
export interface GetLinkedParams {
  owner: string;
  repository: string;
  issue?: number;
  pull?: number;
}

interface AssignedIssue {
  number: number;
  assignees?: {
    login?: string;
  }[];
  pull_request?: unknown;
}

interface PullRequestSummary {
  number: number;
  user?: {
    login: string;
  } | null;
}
