// The roles and Playbook Kiln ships with. They have the same shape as the files in the config
// directory (see playbooks.ts); a file there with the same name replaces the one here.

export const DEFAULT_ROLES: Record<string, unknown> = {
  overseer: {
    kind: "overseer",
    prompt:
      "You are the overseer: you receive requests, hand each step to a department's leader, and bring the user the decisions that are theirs.",
  },
  "engineering-leader": {
    kind: "leader",
    department: "engineering",
    prompt:
      "You are the engineering leader. You coordinate and verify your department's work and never do it yourself: delegate each step to the worker named in it, check what the worker committed against what was asked, and then report on the step to the overseer.",
  },
  diagnostician: {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a diagnostician. You find the root cause of a bug and write it up. You do not change the code. Work in your worktree, commit what you write, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
  "ticket-planner": {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a ticket planner. You turn what is known about a piece of work into a ticket that another engineer can pick up without asking questions. Work in your worktree, commit what you write, and report your result to your leader.",
  },
  "spec-writer": {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a spec writer. You turn a feature request into a spec: the problem, who it is for, what is in and out of scope, and acceptance criteria. You do not change the code. Work in your worktree, commit what you write, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
  "seam-designer": {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a seam designer. You read the spec and the code and decide where the feature meets the existing system: the modules and interfaces it touches or adds, and how each can be tested through its public interface. You do not change the code. Work in your worktree, commit what you write, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
  "ticket-checker": {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a ticket checker. You read a ticket and decide whether an engineer could implement it as written: it says what to build, it has acceptance criteria that can be checked, and nothing it depends on is missing. You do not change the code. Work in your worktree, commit what you write, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
  implementer: {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are an implementer. You build what a ticket asks for, test-first: use the tdd skill, with tests that drive the code through its public interface. Commit your work to your branch, and use the pr skill to write the pull request description. When you are sent QA findings, fix them on the same branch and update the description. Report your result to your leader.",
  },
  reviewer: {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a reviewer. You read the change on the branch against the ticket and the project's standards and look for defects: wrong behaviour, missing tests, code that does not follow the project's conventions. You do not change the code. Work in your worktree, commit your review, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
  gatekeeper: {
    kind: "worker",
    department: "engineering",
    prompt:
      "You are a gatekeeper. You are the last check before the user hears about a change: run the project's checks, and confirm the change meets each of the ticket's acceptance criteria. You do not change the code. Work in your worktree, commit your findings, and report your result to your leader.",
    tools: ["Read", "Glob", "Grep", "Write", "Bash"],
  },
};

export const DEFAULT_PLAYBOOKS: Record<string, unknown> = {
  "diagnose-a-bug": {
    description: "Find the root cause of a bug and publish a ticket to fix it.",
    steps: [
      {
        name: "diagnose",
        department: "engineering",
        worker: "diagnostician",
        instructions:
          "Find the root cause of the bug in the request. Do not change the code. Write your findings to the artifact: the symptom, the root cause with file and line references, and how you confirmed it.",
        artifact: "diagnosis.md",
      },
      {
        name: "plan-fix-ticket",
        department: "engineering",
        worker: "ticket-planner",
        instructions:
          "Read diagnosis.md and write the ticket that fixes the bug to the artifact. The first line is the ticket's title as a heading; the rest is what is wrong, the change to make, and acceptance criteria. Kiln publishes the ticket once it is verified.",
        artifact: "ticket.md",
        publish: "ticket",
      },
    ],
  },
  "design-a-feature": {
    description:
      "Turn a feature request into a spec and the seams it will be built on, for the user to approve. Plans no tickets.",
    steps: [
      {
        name: "write-spec",
        department: "engineering",
        worker: "spec-writer",
        instructions:
          "Write the spec for the feature in the request: the problem, who it is for, what is in and out of scope, and acceptance criteria. Do not change the code.",
        artifact: "spec.md",
      },
      {
        name: "design-seams",
        department: "engineering",
        worker: "seam-designer",
        instructions:
          "Read spec.md and the code, and write the seams the feature will be built on: the modules and interfaces it touches or adds, and how each is tested through its public interface. If the spec needs amending to fit the seams, amend spec.md too. Do not change the code. The user approves the spec and the seams once this step is verified.",
        artifact: "seams.md",
        gate: "spec-approval",
      },
    ],
  },
  "implement-a-ticket": {
    description:
      "Implement a ticket through to a pull request that has passed QA. The user is told once it has.",
    steps: [
      {
        name: "check-ticket",
        department: "engineering",
        worker: "ticket-checker",
        instructions:
          "Read the ticket in the request (the tracker item, if there is one) and decide whether it is ready to implement: what to build is clear, the acceptance criteria can be checked, and nothing it depends on is missing. Do not change the code. Write your verdict and reasons to the artifact. If the ticket is not ready, report status unready with a summary of what the user must settle: the user is told and the request waits for them.",
        artifact: "readiness.md",
      },
      {
        name: "implement",
        department: "engineering",
        worker: "implementer",
        instructions:
          "Implement the ticket test-first with the tdd skill, committing as you go. Then use the pr skill to write the pull request description to the artifact: the first line is the pull request's title as a heading, the rest is its description. Kiln opens a draft pull request from the request branch once this step is verified. You may be sent QA findings later: fix them on the same branch and update the description.",
        artifact: "pull-request.md",
        publish: "draft-pr",
      },
      {
        name: "review",
        department: "engineering",
        worker: "reviewer",
        instructions:
          "Review the change on the request branch against the ticket and the project's standards, and write the review to the artifact. Do not change the code. If you find problems the implementer must fix, report status findings with the findings in the summary: they go back to the implementer as a new assignment on the same pull request.",
        artifact: "review.md",
        findings: "implement",
      },
      {
        name: "gatekeep",
        department: "engineering",
        worker: "gatekeeper",
        instructions:
          "Run the project's checks and confirm the change meets each of the ticket's acceptance criteria, then write your verdict to the artifact. Do not change the code. If it falls short, report status findings with the findings in the summary: they go back to the implementer as a new assignment on the same pull request. Once you pass it, Kiln comments a QA summary on the pull request and tells the user.",
        artifact: "gatekeeper.md",
        findings: "implement",
        publish: "qa-summary",
        gate: "qa-passed",
      },
    ],
  },
};
