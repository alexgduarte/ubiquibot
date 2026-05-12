import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import axios from "axios";
import { getAllPullRequests } from "../../helpers/issue";
import { Context } from "../../types/context";
import { checkPullRequests } from "./check-pull-requests";

jest.mock("axios");
jest.mock("../../helpers/issue", () => ({
  getAllPullRequests: jest.fn(),
  addAssignees: jest.fn(),
}));

const htmlWithoutLinkedIssues = "<div data-target='create-branch.developmentForm'></div>";
const htmlWithLinkedIssue =
  "<div data-target='create-branch.developmentForm'><div class='my-1'><a href='/ubiquity/ubiquibot/issues/34'>#34</a></div></div>";

describe("checkPullRequests", () => {
  const mockedAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
  const mockedGetAllPullRequests = getAllPullRequests as jest.MockedFunction<typeof getAllPullRequests>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosGet.mockResolvedValue({ data: htmlWithoutLinkedIssues });
    mockedGetAllPullRequests.mockResolvedValue([{ number: 12, user: { login: "alice" } }] as never);
  });

  test("adds a resolving keyword when the opener has one assigned issue", async () => {
    const { context, pullsUpdate, issuesCreateComment } = createContext({
      assignedIssues: [createAssignedIssue(34, "alice")],
      pullBody: "Implementation notes",
    });

    await checkPullRequests(context);

    expect(pullsUpdate).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquibot",
      pull_number: 12,
      body: "Implementation notes\n\nResolves #34",
    });
    expect(issuesCreateComment).not.toHaveBeenCalled();
  });

  test("adds a warning comment when the opener has multiple assigned issues", async () => {
    const { context, pullsUpdate, issuesCreateComment } = createContext({
      assignedIssues: [createAssignedIssue(34, "alice"), createAssignedIssue(35, "alice")],
      pullBody: "Implementation notes",
    });

    await checkPullRequests(context);

    expect(pullsUpdate).not.toHaveBeenCalled();
    expect(issuesCreateComment).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquibot",
      issue_number: 12,
      body: expect.stringContaining("multiple open issues assigned to you (#34, #35)"),
    });
  });

  test("does nothing when the opener has no assigned issues", async () => {
    const { context, pullsUpdate, issuesCreateComment } = createContext({
      assignedIssues: [createAssignedIssue(34, "bob")],
      pullBody: "Implementation notes",
    });

    await checkPullRequests(context);

    expect(pullsUpdate).not.toHaveBeenCalled();
    expect(issuesCreateComment).not.toHaveBeenCalled();
  });

  test("uses the remaining assigned issue when another open pull request is already linked", async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({ data: htmlWithoutLinkedIssues })
      .mockResolvedValueOnce({ data: htmlWithLinkedIssue });
    mockedGetAllPullRequests.mockResolvedValue([
      { number: 12, user: { login: "alice" } },
      { number: 13, user: { login: "alice" } },
    ] as never);

    const { context, pullsGet, pullsUpdate, issuesCreateComment } = createContext({
      assignedIssues: [createAssignedIssue(34, "alice"), createAssignedIssue(35, "alice")],
      pullBody: "Implementation notes",
    });

    pullsGet
      .mockResolvedValueOnce({
        data: {
          created_at: "2026-05-12T08:00:00Z",
          updated_at: "2026-05-12T08:00:00Z",
          body: "Implementation notes",
        },
      })
      .mockResolvedValueOnce({
        data: {
          created_at: "2026-05-11T08:00:00Z",
          updated_at: "2026-05-12T08:00:00Z",
          body: "Other pull request",
        },
      });

    await checkPullRequests(context);

    expect(pullsUpdate).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquibot",
      pull_number: 12,
      body: "Implementation notes\n\nResolves #35",
    });
    expect(issuesCreateComment).not.toHaveBeenCalled();
  });
});

function createContext({ assignedIssues, pullBody }: CreateContextParams) {
  const pullsGet = jest.fn(async () => ({
    data: {
      created_at: "2026-05-12T08:00:00Z",
      updated_at: "2026-05-12T08:00:00Z",
      body: pullBody,
    },
  }));
  const pullsUpdate = jest.fn(async () => ({ data: {} }));
  const issuesCreateComment = jest.fn(async () => ({ data: {} }));
  const paginate = jest.fn(
    async (
      _method: unknown,
      _params: unknown,
      mapFn: (response: { data: ReturnType<typeof createAssignedIssue>[] }) => unknown
    ) => mapFn({ data: assignedIssues })
  );

  const context = {
    payload: {
      repository: {
        owner: { login: "ubiquity" },
        name: "ubiquibot",
      },
    },
    octokit: {
      paginate,
      rest: {
        pulls: {
          get: pullsGet,
          update: pullsUpdate,
        },
        issues: {
          listForRepo: jest.fn(),
          createComment: issuesCreateComment,
        },
      },
    },
    logger: {
      debug: jest.fn(),
      fatal: jest.fn(),
    },
  } as unknown as Context;

  return { context, pullsGet, pullsUpdate, issuesCreateComment };
}

function createAssignedIssue(number: number, assignee: string) {
  return {
    number,
    assignees: [{ login: assignee }],
  };
}

interface CreateContextParams {
  assignedIssues: ReturnType<typeof createAssignedIssue>[];
  pullBody: string;
}
