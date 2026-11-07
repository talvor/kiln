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
};
