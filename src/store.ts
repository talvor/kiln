import { join } from "@std/path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import type { Budget } from "./limits.ts";
import type { Logger } from "./log.ts";

/**
 * Ordered schema migrations. The store's `user_version` is the number of migrations applied.
 * Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: key/value metadata and the append-only event log.
  `create table meta (key text primary key, value text not null) strict;
   create table events (
     id integer primary key,
     ts text not null,
     kind text not null,
     data text not null default '{}'
   ) strict;
   create trigger events_no_update before update on events
     begin select raise(abort, 'events are append-only'); end;
   create trigger events_no_delete before delete on events
     begin select raise(abort, 'events are append-only'); end;`,
  // 2: registered Projects.
  `create table projects (
     id integer primary key,
     name text not null unique,
     source text not null,
     remote_url text not null,
     clone_path text not null,
     default_branch text not null,
     head_commit text not null,
     setup_command text,
     test_command text,
     lint_command text,
     build_command text,
     baseline text,
     warnings text not null default '[]',
     registered_at text not null
   ) strict;`,
  // 3: managing Projects: pause, soft removal (history is kept; the name is freed for a new
  // registration), and Requests, so removal can tell whether work is still active.
  `create table projects_new (
     id integer primary key,
     name text not null,
     source text not null,
     remote_url text not null,
     clone_path text not null,
     default_branch text not null,
     head_commit text not null,
     setup_command text,
     test_command text,
     lint_command text,
     build_command text,
     baseline text,
     warnings text not null default '[]',
     registered_at text not null,
     paused integer not null default 0,
     removed_at text
   ) strict;
   insert into projects_new (id, name, source, remote_url, clone_path, default_branch, head_commit,
       setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at)
     select id, name, source, remote_url, clone_path, default_branch, head_commit,
       setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at
     from projects;
   drop table projects;
   alter table projects_new rename to projects;
   create unique index projects_active_name on projects (name) where removed_at is null;
   create table requests (
     id integer primary key,
     project_id integer not null references projects (id),
     status text not null default 'active' check (status in ('active', 'done')),
     created_at text not null
   ) strict;`,
  // 4: sessions (the addresses agents work under) and the Messages between them. Messages are
  // append-only; what happens to them afterwards (read, delivered, dead-lettered) lives in
  // message_status.
  `create table sessions (
     address text primary key,
     role text not null check (role in ('overseer', 'leader', 'worker')),
     department text,
     cwd text not null,
     opened_at text not null
   ) strict;
   create unique index sessions_one_overseer on sessions (role) where role = 'overseer';
   create unique index sessions_one_leader on sessions (department) where role = 'leader';
   create table messages (
     id integer primary key,
     sender text not null references sessions (address),
     recipient text not null references sessions (address),
     kind text not null check (kind in ('assignment', 'result', 'question', 'answer')),
     body text not null,
     in_reply_to integer references messages (id),
     assignment_id integer references messages (id),
     synthesised integer not null default 0,
     sent_at text not null
   ) strict;
   create trigger messages_no_update before update on messages
     begin select raise(abort, 'messages are append-only'); end;
   create trigger messages_no_delete before delete on messages
     begin select raise(abort, 'messages are append-only'); end;
   create table message_status (
     message_id integer primary key references messages (id),
     read_at text,
     deliveries integer not null default 0,
     last_delivery_at text,
     dead_lettered_at text
   ) strict;`,
  // 5: Worktrees (checkouts outside the Project's clone, each with its own ports), the branch of
  // each Request, and Assignments with their own branch and Worktree.
  `create table worktrees (
     id integer primary key,
     path text not null,
     branch text not null,
     port_base integer not null,
     created_at text not null,
     released_at text
   ) strict;
   create unique index worktrees_live_ports on worktrees (port_base) where released_at is null;
   alter table requests add column branch text;
   alter table requests add column worktree_id integer references worktrees (id);
   create table assignments (
     id integer primary key references messages (id),
     request_id integer not null references requests (id),
     branch text,
     worktree_id integer references worktrees (id),
     status text not null default 'active' check (status in ('active', 'merged')),
     pushed integer not null default 0,
     created_at text not null,
     merged_at text
   ) strict;`,
  // 6: the shared lifecycle states for Requests, Steps and Assignments; a Request's Playbook,
  // description, optional tracker item and published ticket; the Steps of a Playbook; and the
  // role a session plays. SQLite cannot widen a check constraint, so requests and assignments
  // are rebuilt (their rows are kept; an Assignment that was merged is done).
  `create table requests_new (
     id integer primary key,
     project_id integer not null references projects (id),
     status text not null default 'active'
       check (status in ('planned', 'active', 'done', 'failed')),
     created_at text not null,
     branch text,
     worktree_id integer references worktrees (id),
     playbook text,
     description text,
     tracker_item text,
     ticket_url text,
     failure text
   ) strict;
   insert into requests_new (id, project_id, status, created_at, branch, worktree_id)
     select id, project_id, status, created_at, branch, worktree_id from requests;
   drop table requests;
   alter table requests_new rename to requests;
   create table assignments_new (
     id integer primary key references messages (id),
     request_id integer not null references requests (id),
     branch text,
     worktree_id integer references worktrees (id),
     status text not null default 'active'
       check (status in ('planned', 'active', 'done', 'failed')),
     pushed integer not null default 0,
     created_at text not null,
     merged_at text
   ) strict;
   insert into assignments_new
     select id, request_id, branch, worktree_id,
       case status when 'merged' then 'done' else status end, pushed, created_at, merged_at
     from assignments;
   drop table assignments;
   alter table assignments_new rename to assignments;
   create table steps (
     id integer primary key,
     request_id integer not null references requests (id),
     position integer not null,
     spec text not null,
     status text not null default 'planned'
       check (status in ('planned', 'active', 'done', 'failed')),
     worker text,
     message_id integer references messages (id),
     failure text,
     unique (request_id, position)
   ) strict;
   alter table sessions add column role_name text;`,
  `alter table steps add column retries integer not null default 0;`,
  // 8: limits and queuing. An Assignment waits as planned until a concurrency slot and its files
  // are free; once active it runs under a budget, counts the turns and spend its worker used, and
  // records which limit stopped it.
  `alter table assignments add column owns text not null default '[]';
   alter table assignments add column budget text;
   alter table assignments add column turns_used integer not null default 0;
   alter table assignments add column spend_usd real not null default 0;
   alter table assignments add column started_at text;
   alter table assignments add column activity_at text;
   alter table assignments add column limit_reached text;`,
  // 9: Escalations the Overseer brings to the user. An Escalation stays open, however long, until
  // the user approves or rejects it; a decision is made once and never changed or removed.
  `create table escalations (
     id integer primary key,
     raised_by text not null references sessions (address),
     request_id integer references requests (id),
     summary text not null,
     detail text,
     status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
     reason text,
     created_at text not null,
     decided_at text
   ) strict;
   create trigger escalations_decided_once before update on escalations
     when old.status != 'open'
     begin select raise(abort, 'a decided escalation is never changed'); end;
   create trigger escalations_no_delete before delete on escalations
     begin select raise(abort, 'escalations are never removed'); end;`,
  // 10: Gates. An Escalation the conductor raises at a point in a Step names the Step, the kind of
  // Gate and the leader's report (a Step message) it was raised for.
  `alter table escalations add column step_id integer references steps (id);
   alter table escalations add column gate text check (gate in ('spec-approval', 'out-of-scope'));
   alter table escalations add column gate_message_id integer;`,
  // 11: work the user sent back is counted apart from verification retries.
  `alter table steps add column sent_back integer not null default 0;`,
  // 12: Lavish pages. Each Escalation gets one page with a one-time token that lets the page, and
  // only the page, carry the user's decision; text typed on the page is kept as notes for the
  // Overseer and never decides anything.
  `create table escalation_pages (
     escalation_id integer primary key references escalations (id),
     token text not null,
     created_at text not null,
     spent_at text
   ) strict;
   create table escalation_notes (
     id integer primary key,
     escalation_id integer not null references escalations (id),
     body text not null,
     sent_at text not null
   ) strict;`,
  // 13: the question relay. A Message may relay another (a leader passing a worker's question up,
  // or the answer coming back down); an Escalation may be raised over a question; and a session
  // remembers its Claude session so it can be resumed to read an answer.
  `alter table messages add column relay_of integer references messages (id);
   alter table escalations add column question_id integer references messages (id);
   alter table sessions add column claude_session_id text;`,
  // 14: implementing a ticket. A Request records the pull request Kiln opened for it; a Step
  // counts the times QA findings sent it round again; and two more kinds of Gate exist (SQLite
  // cannot widen a check constraint, so escalations is rebuilt, rows and triggers kept).
  `alter table requests add column pr_url text;
   alter table steps add column round integer not null default 0;
   create table escalations_new (
     id integer primary key,
     raised_by text not null references sessions (address),
     request_id integer references requests (id),
     summary text not null,
     detail text,
     status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
     reason text,
     created_at text not null,
     decided_at text,
     step_id integer references steps (id),
     gate text check (gate in ('spec-approval', 'out-of-scope', 'blocked-on-user', 'qa-passed')),
     gate_message_id integer,
     question_id integer references messages (id)
   ) strict;
   insert into escalations_new
     select id, raised_by, request_id, summary, detail, status, reason, created_at, decided_at,
       step_id, gate, gate_message_id, question_id from escalations;
   drop table escalations;
   alter table escalations_new rename to escalations;
   create trigger escalations_decided_once before update on escalations
     when old.status != 'open'
     begin select raise(abort, 'a decided escalation is never changed'); end;
   create trigger escalations_no_delete before delete on escalations
     begin select raise(abort, 'escalations are never removed'); end;`,
  // 15: the chat with the Overseer. Each Claude session of the Overseer chat is a chat session; what the
  // user and the Overseer said in them is kept, append-only, so a fresh session can be seeded.
  `create table chat_sessions (
     id integer primary key,
     started_at text not null,
     seen_at text not null,
     ended_at text,
     end_reason text check (end_reason in ('exit', 'rollover')),
     rollover_requested_at text,
     events_through integer not null default 0
   ) strict;
   create table chat_turns (
     id integer primary key,
     chat_session_id integer not null references chat_sessions (id),
     speaker text not null check (speaker in ('user', 'overseer')),
     text text not null,
     at text not null
   ) strict;
   create trigger chat_turns_no_update before update on chat_turns
     begin select raise(abort, 'chat history is append-only'); end;
   create trigger chat_turns_no_delete before delete on chat_turns
     begin select raise(abort, 'chat history is append-only'); end;`,
];

export class StoreTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `The store is at schema version ${found}, newer than this Kiln supports (${supported}). ` +
        `It was written by a newer Kiln; upgrade Kiln instead of opening it with this version.`,
    );
  }
}

/** A Project as registered: where it came from, Kiln's clone, its commands and test baseline. */
export interface ProjectRecord {
  id: number;
  name: string;
  /** What the user gave Kiln: a path or a URL. */
  source: string;
  remoteUrl: string;
  /** Kiln's own clone of the Project. */
  clonePath: string;
  defaultBranch: string;
  headCommit: string;
  setupCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  /** The result of the test command on the clean checkout; null when there is no test command. */
  baseline: Baseline | null;
  warnings: string[];
  registeredAt: string;
  /** A paused Project accepts no new Requests. */
  paused: boolean;
  /** Set when the Project was removed; its record and history stay. */
  removedAt: string | null;
}
export interface Baseline {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** The commit the baseline was recorded on. */
  commit: string;
  /** The end of the test command's output. */
  outputTail: string;
  recordedAt: string;
}
export type NewProject = Omit<ProjectRecord, "id" | "registeredAt" | "paused" | "removedAt">;
/** What can change on a registered Project. */
export type ProjectPatch = Partial<
  Pick<
    ProjectRecord,
    | "paused"
    | "defaultBranch"
    | "headCommit"
    | "setupCommand"
    | "testCommand"
    | "lintCommand"
    | "buildCommand"
    | "baseline"
    | "warnings"
  >
>;

/** A checkout of a Project outside its clone, with the ports it may use. */
export interface WorktreeRecord {
  id: number;
  path: string;
  branch: string;
  /** First of the WORKTREE_PORTS consecutive ports reserved for this Worktree. */
  portBase: number;
  releasedAt: string | null;
}
export const WORKTREE_PORTS = 10;
export const FIRST_WORKTREE_PORT = 20_000;
const LAST_WORKTREE_PORT = 60_000;

/** The states a Request, a Step and an Assignment share. */
export const STATES = ["planned", "active", "done", "failed"] as const;
export type State = typeof STATES[number];

/** One department step of a Playbook, as it was when the Request began. */
export interface StepSpec {
  name: string;
  department: string;
  /** The worker role that does the step's work. */
  worker: string;
  instructions: string;
  /** The file the worker commits; the leader's verification looks for it. */
  artifact: string;
  /** What Kiln publishes from the artifact once the step is verified. */
  publish?: "ticket" | "draft-pr" | "qa-summary";
  /** A Gate the user must pass, once the step is verified and merged, before the step is done. */
  gate?: "spec-approval" | "qa-passed";
  /** The earlier step that findings reported on this step go back to, as a new Assignment. */
  findings?: string;
}
export interface RequestRecord {
  id: number;
  projectId: number;
  status: State;
  /** The branch the Request's merged Assignments accumulate on; null until it is created. */
  branch: string | null;
  worktreeId: number | null;
  /** The Playbook the Request follows; null for a Request that is just a branch. */
  playbook: string | null;
  description: string | null;
  /** Where the work came from in the Project's tracker, if anywhere. */
  trackerItem: string | null;
  /** The ticket Kiln published for the Request, if its Playbook publishes one. */
  ticketUrl: string | null;
  /** The pull request Kiln opened for the Request, if its Playbook opens one. */
  prUrl: string | null;
  failure: string | null;
}
export interface NewPlaybookRun {
  playbook: string;
  description: string;
  trackerItem: string | null;
  steps: StepSpec[];
}
/** A department step of a Request: handed to the department's leader as one assignment. */
export interface StepRecord {
  id: number;
  requestId: number;
  /** 1-based place in the Playbook. */
  position: number;
  spec: StepSpec;
  status: State;
  /** The address of the worker session the leader delegates to; set when the step begins. */
  worker: string | null;
  /** The assignment Message that handed the step to the leader. */
  messageId: number | null;
  /** How many times the Step went back to its leader with rejection feedback. */
  retries: number;
  /** How many times the user sent the Step's work back; these do not count as retries. */
  sentBack: number;
  /** How many times QA findings sent the work back to an earlier Step and this Step began again. */
  round: number;
  failure: string | null;
}
export interface AssignmentRecord {
  id: number;
  requestId: number;
  branch: string | null;
  worktreeId: number | null;
  status: State;
  /** When the Assignment was merged into the request branch; null until then. */
  mergedAt: string | null;
  /** Whether the merge has reached the remote. */
  pushed: boolean;
  /** The paths the Assignment declared it works on. */
  owns: string[];
  /** The limits it runs under; set when it is planned. */
  budget: Budget | null;
  /** What its worker has used so far. */
  turnsUsed: number;
  spendUsd: number;
  /** When it began running, and when its worker last showed a sign of life. */
  startedAt: string | null;
  activityAt: string | null;
  /** Which limit stopped it: turns, spend, time or inactivity. */
  limitReached: LimitKind | null;
}
export type LimitKind = "turns" | "spend" | "time" | "inactivity";

export class UnknownRequestError extends Error {
  constructor(id: number) {
    super(`No request ${id} exists.`);
  }
}
export class UnknownAssignmentError extends Error {
  constructor(id: number) {
    super(`No assignment ${id} exists.`);
  }
}

/** A decision the Overseer brings to the user, and what the user decided. */
export interface EscalationRecord {
  id: number;
  /** The session that raised it: always the Overseer. */
  raisedBy: string;
  /** The Request it concerns, if any. */
  requestId: number | null;
  summary: string;
  detail: string | null;
  status: "open" | "approved" | "rejected";
  /** Why the user rejected it. */
  reason: string | null;
  /** For a Gate: the Step it holds, which kind it is, and the Step message it was raised on. */
  stepId: number | null;
  gate: GateKind | null;
  gateMessageId: number | null;
  /** The question that reached the Overseer and could only be settled by the user. */
  questionId: number | null;
  createdAt: string;
  decidedAt: string | null;
}
export type GateKind = "spec-approval" | "out-of-scope" | "blocked-on-user" | "qa-passed";
export interface NewEscalation {
  raisedBy: string;
  stepId?: number | null;
  gate?: GateKind | null;
  gateMessageId?: number | null;
  requestId?: number | null;
  summary: string;
  detail?: string | null;
  questionId?: number | null;
}

/** The page of an Escalation: the token is good for one decision. */
export interface EscalationPage {
  escalationId: number;
  token: string;
  spentAt: string | null;
}
/** Text the user typed on an Escalation's page, for the Overseer to read. */
export interface EscalationNote {
  id: number;
  escalationId: number;
  body: string;
  sentAt: string;
}

export class UnknownEscalationError extends Error {
  constructor(id: number) {
    super(`No escalation ${id} exists.`);
  }
}
/** The Escalation was decided before: a second decision is refused. */
export class EscalationDecidedError extends Error {
  constructor(readonly escalation: EscalationRecord) {
    super(
      `Escalation ${escalation.id} was already ${escalation.status}` +
        `${escalation.decidedAt ? ` at ${escalation.decidedAt}` : ""}; a decision is final.`,
    );
  }
}

/** One Claude session of `kiln chat`; a rollover ends one and begins the next. */
export interface ChatRecord {
  id: number;
  startedAt: string;
  /** The last sign of life from `kiln chat`. */
  seenAt: string;
  endedAt: string | null;
  endReason: "exit" | "rollover" | null;
  /** Set once the session's context has grown too large and it should be replaced. */
  rolloverRequestedAt: string | null;
  /** The newest event the user's chat had caught up with, as of the last sign of life. */
  eventsThrough: number;
}
export interface ChatTurn {
  id: number;
  chatId: number;
  speaker: "user" | "overseer";
  text: string;
  at: string;
}
export interface EventRecord {
  id: number;
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

export type Role = "overseer" | "leader" | "worker";
export type MessageKind = "assignment" | "result" | "question" | "answer";

/** The address an agent works under, and where it sits in the chain of command. */
export interface SessionRecord {
  address: string;
  role: Role;
  /** Set for leaders and workers; the overseer belongs to no department. */
  department: string | null;
  /** Directory Kiln wakes the agent in. */
  cwd: string;
  /** The configured role the session plays, whose prompt Kiln wakes it with. */
  roleName: string | null;
  /** The Claude session of its last launch, resumed to deliver an answer to its own question. */
  claudeSessionId: string | null;
  openedAt: string;
}
export type NewSession = Omit<SessionRecord, "openedAt" | "roleName" | "claudeSessionId"> & {
  roleName?: string | null;
};

/** A Message and what has happened to it since it was sent. */
export interface MessageRecord {
  id: number;
  from: string;
  to: string;
  kind: MessageKind;
  body: Record<string, unknown>;
  /** The assignment a result answers, or the question an answer answers. */
  inReplyTo: number | null;
  /** The assignment a question asks about, if any. */
  assignmentId: number | null;
  /** The question this one passes up, or the answer this one passes down: the relay chain. */
  relayOf: number | null;
  /** Written by Kiln itself rather than by the sender. */
  synthesised: boolean;
  sentAt: string;
  readAt: string | null;
  /** How many Nudges have been sent for it. */
  deliveries: number;
  lastDeliveryAt: string | null;
  deadLetteredAt: string | null;
}
export type NewMessage = Pick<MessageRecord, "from" | "to" | "kind" | "body"> & {
  inReplyTo?: number | null;
  assignmentId?: number | null;
  relayOf?: number | null;
  synthesised?: boolean;
};
export interface MessageFilter {
  to?: string;
  from?: string;
  kind?: MessageKind;
  inReplyTo?: number;
  /** Not yet read, dead-lettered, or completed: what an agent still has to pick up. */
  waiting?: boolean;
}

export class UnknownSessionError extends Error {
  constructor(address: string) {
    super(`No session is open at "${address}".`);
  }
}
export class DuplicateSessionError extends Error {}

export class UnknownProjectError extends Error {
  constructor(name: string) {
    super(`No project named "${name}" is registered.`);
  }
}

/** Removal refused: the Project still has active Requests. */
export class ActiveRequestsError extends Error {
  constructor(name: string, readonly count: number) {
    super(
      `"${name}" has ${count} active request${count === 1 ? "" : "s"}; ` +
        `finish them or remove the project with --force.`,
    );
  }
}

export class DuplicateProjectError extends Error {
  constructor(name: string) {
    super(`A project named "${name}" is already registered.`);
  }
}

export interface StoreInfo {
  schemaVersion: number;
  sqliteVersion: string;
  journalMode: string;
}

export interface Store {
  info(): StoreInfo;
  /** Write a consistent copy of the store into the backups directory; returns its path. */
  backup(label?: string): Promise<string>;
  appendEvent(kind: string, data?: Record<string, unknown>): void;
  /** Record a Project; throws DuplicateProjectError if the name is taken. */
  addProject(project: NewProject): ProjectRecord;
  /** Registered Projects; removed ones only when asked for. */
  listProjects(opts?: { includeRemoved?: boolean }): ProjectRecord[];
  /** The registered (not removed) Project with this name; throws UnknownProjectError. */
  getProject(name: string): ProjectRecord;
  /** Change a Project; throws UnknownProjectError. */
  updateProject(name: string, patch: ProjectPatch): ProjectRecord;
  /** Remove a Project, keeping its record and history; refuse active Requests unless forced. */
  removeProject(name: string, opts?: { force?: boolean }): ProjectRecord;
  /** Begin a Request on a Project (no branch or Worktree yet). */
  addRequest(projectId: number): RequestRecord;
  /** Throws UnknownRequestError. */
  getRequest(id: number): RequestRecord;
  /** Requests in this state, oldest first. */
  listRequests(status: State): RequestRecord[];
  /** Make a Request follow a Playbook: record its description and a planned Step for each. */
  setPlaybook(requestId: number, run: NewPlaybookRun): void;
  /** Move a Request to a state; `failure` says why when it failed. */
  setRequestState(id: number, status: State, failure?: string): void;
  setTicketUrl(id: number, url: string): void;
  setPrUrl(id: number, url: string): void;
  /** The Steps of a Request, in Playbook order. */
  listSteps(requestId: number): StepRecord[];
  /** Begin a Step: it is active, handed to its leader in `messageId`, and delegated to `worker`. */
  beginStep(id: number, messageId: number, worker: string): void;
  /** Hand a rejected Step back to its leader in `messageId`, to be delegated to a fresh `worker`. */
  retryStep(id: number, messageId: number, worker: string, byUser?: boolean): void;
  setStepState(id: number, status: State, failure?: string): void;
  /** Take a Step back to planned for another round: nothing of its earlier tries carries over. */
  restartStep(id: number): void;
  /** Begin an Assignment for a router assignment Message; a planned one becomes active. */
  addAssignment(requestId: number, messageId: number): AssignmentRecord;
  /** Queue an Assignment as planned, with the paths it owns and the budget it will run under. */
  planAssignment(
    requestId: number,
    messageId: number,
    plan: { owns: string[]; budget: Budget },
  ): AssignmentRecord;
  /** Throws UnknownAssignmentError. */
  getAssignment(id: number): AssignmentRecord;
  /** How many Assignments are active, in all of Kiln or in one Project. */
  countActiveAssignments(projectId?: number): number;
  /** The active Assignments of Requests that are active, oldest first. */
  listActiveAssignments(): AssignmentRecord[];
  /** Add what a launch of the Assignment's worker used, and note the worker is alive. */
  addUsage(id: number, usage: { turns: number; spendUsd: number }): void;
  /** Note a sign of life from the Assignment's worker. */
  touchAssignment(id: number): void;
  /** The Assignment ran into a limit: it has failed. */
  markLimitReached(id: number, kind: LimitKind): void;
  listAssignments(requestId: number): AssignmentRecord[];
  setAssignmentState(id: number, status: State): void;
  /** Reserve a free port block for a new Worktree; throws if none is left. */
  addWorktree(wt: { path: string; branch: string }): WorktreeRecord;
  getWorktree(id: number): WorktreeRecord;
  findLiveWorktree(path: string): WorktreeRecord | undefined;
  /** Give back a Worktree's ports. */
  releaseWorktree(id: number): void;
  /** Record the branch and Worktree a Request or Assignment works on. */
  attachRequest(id: number, branch: string, worktreeId: number): void;
  attachAssignment(id: number, branch: string, worktreeId: number): void;
  /** Forget a Request or Assignment whose branch could not be created. */
  discardRequest(id: number): void;
  discardAssignment(id: number): void;
  /** Record that an Assignment was merged into its Request's branch. */
  markMerged(assignmentId: number): void;
  markPushed(assignmentId: number): void;
  /** Open a session; throws DuplicateSessionError if its address, or its seat, is taken. */
  addSession(session: NewSession): SessionRecord;
  listSessions(): SessionRecord[];
  /** Throws UnknownSessionError. */
  getSession(address: string): SessionRecord;
  /** Point a session at another directory, e.g. its worker's Assignment Worktree. */
  setSessionCwd(address: string, cwd: string): void;
  /** Remember the Claude session an agent was last launched in. */
  setClaudeSession(address: string, id: string): void;
  /** Append a Message. Messages are never changed or removed afterwards. */
  appendMessage(message: NewMessage): MessageRecord;
  getMessage(id: number): MessageRecord | undefined;
  listMessages(filter?: MessageFilter): MessageRecord[];
  markRead(ids: number[]): void;
  /** Count one more Nudge for each of these Messages. */
  recordDelivery(ids: number[]): void;
  deadLetter(id: number): void;
  /** Record an Escalation as open. */
  addEscalation(escalation: NewEscalation): EscalationRecord;
  /** Throws UnknownEscalationError. */
  getEscalation(id: number): EscalationRecord;
  /** Every Escalation, oldest first; only the open ones when asked. */
  listEscalations(opts?: { openOnly?: boolean }): EscalationRecord[];
  /**
   * Record the decision on an open Escalation. Throws UnknownEscalationError, or
   * EscalationDecidedError when it was decided before.
   */
  decideEscalation(id: number, decision: { approved: boolean; reason?: string }): EscalationRecord;
  /** The page of an Escalation and its one-time token, if it has one. */
  getEscalationPage(id: number): EscalationPage | undefined;
  /** Give the Escalation a page with this token. */
  addEscalationPage(id: number, token: string): EscalationPage;
  /** Spend the token: it carries a decision once. */
  spendEscalationPage(id: number): void;
  /** Keep text the user typed on the page for the Overseer. */
  addEscalationNote(id: number, body: string): EscalationNote;
  listEscalationNotes(id?: number): EscalationNote[];
  /** Begin a chat session. */
  startChat(): ChatRecord;
  /** Throws if there is no such chat session. */
  getChat(id: number): ChatRecord;
  /** The newest chat session, if any. */
  latestChat(): ChatRecord | undefined;
  /** Note a sign of life, and the newest event the chat has caught up with. */
  touchChat(id: number): void;
  endChat(id: number, reason: "exit" | "rollover"): void;
  requestRollover(id: number): void;
  addChatTurn(chatId: number, speaker: ChatTurn["speaker"], text: string): ChatTurn;
  /** The last `limit` turns of the chat, across sessions, oldest first. */
  listChatTurns(limit: number): ChatTurn[];
  /** Events after `afterId`, oldest first, of these kinds (all kinds if none given). */
  listEvents(afterId: number, kinds?: string[]): EventRecord[];
  close(): void;
}

export interface StoreOptions {
  file: string;
  backupsDir: string;
  log: Logger;
  migrations?: string[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function openStore(opts: StoreOptions): Promise<Store> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const existed = (() => {
    try {
      Deno.statSync(opts.file);
      return true;
    } catch {
      return false;
    }
  })();

  const db = new DatabaseSync(opts.file);
  try {
    const mode = db.prepare("pragma journal_mode = wal").get()!.journal_mode;
    if (mode !== "wal") {
      throw new Error(
        `Could not enable WAL mode on ${opts.file} (got "${mode}"). The store must be on a local filesystem.`,
      );
    }
    db.exec("pragma foreign_keys = on; pragma busy_timeout = 5000;");
    const version = () => db.prepare("pragma user_version").get()!.user_version as number;

    const found = version();
    if (found > migrations.length) throw new StoreTooNewError(found, migrations.length);

    let backupSeq = 0;
    // Uses SQLite's online backup API (VACUUM INTO fails to open its target under Deno on macOS).
    const backup = async (label = "manual"): Promise<string> => {
      Deno.mkdirSync(opts.backupsDir, { recursive: true, mode: 0o700 });
      const dest = join(opts.backupsDir, `kiln-${label}-${stamp()}-${backupSeq++}.db`);
      await sqliteBackup(db, dest);
      Deno.chmodSync(dest, 0o600);
      return dest;
    };

    if (found < migrations.length) {
      if (existed) {
        const dest = await backup(`pre-migrate-v${found}`);
        opts.log.info("store backed up before migration", {
          from: found,
          to: migrations.length,
          backup: dest,
        });
      }
      for (let v = found; v < migrations.length; v++) {
        // Rebuilding a table means dropping it, which foreign keys forbid while rows refer to
        // it: so they are off while a migration runs and checked before it commits.
        db.exec("pragma foreign_keys = off");
        db.exec("begin");
        try {
          db.exec(migrations[v]);
          const broken = db.prepare("pragma foreign_key_check").all();
          if (broken.length) {
            throw new Error(`migration ${v + 1} broke ${broken.length} reference(s)`);
          }
          db.exec(`pragma user_version = ${v + 1}`);
          db.exec("commit");
        } catch (err) {
          db.exec("rollback");
          throw err;
        } finally {
          db.exec("pragma foreign_keys = on");
        }
        opts.log.info("store migrated", { version: v + 1 });
      }
    }

    const insertEvent = db.prepare("insert into events (ts, kind, data) values (?, ?, ?)");
    const insertProject = db.prepare(
      `insert into projects (name, source, remote_url, clone_path, default_branch, head_commit,
         setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const toRecord = (row: Record<string, unknown>): ProjectRecord => ({
      id: row.id as number,
      name: row.name as string,
      source: row.source as string,
      remoteUrl: row.remote_url as string,
      clonePath: row.clone_path as string,
      defaultBranch: row.default_branch as string,
      headCommit: row.head_commit as string,
      setupCommand: row.setup_command as string | null,
      testCommand: row.test_command as string | null,
      lintCommand: row.lint_command as string | null,
      buildCommand: row.build_command as string | null,
      baseline: row.baseline ? JSON.parse(row.baseline as string) : null,
      warnings: JSON.parse(row.warnings as string),
      registeredAt: row.registered_at as string,
      paused: row.paused === 1,
      removedAt: row.removed_at as string | null,
    });
    const selectActive = db.prepare("select * from projects where name = ? and removed_at is null");
    const getProject = (name: string): ProjectRecord => {
      const row = selectActive.get(name);
      if (!row) throw new UnknownProjectError(name);
      return toRecord(row);
    };
    const countActive = db.prepare(
      "select count(*) n from requests where project_id = ? and status in ('planned', 'active')",
    );
    const toSession = (row: Record<string, unknown>): SessionRecord => ({
      address: row.address as string,
      role: row.role as Role,
      department: row.department as string | null,
      cwd: row.cwd as string,
      roleName: row.role_name as string | null,
      claudeSessionId: row.claude_session_id as string | null,
      openedAt: row.opened_at as string,
    });
    const toMessage = (row: Record<string, unknown>): MessageRecord => ({
      id: row.id as number,
      from: row.sender as string,
      to: row.recipient as string,
      kind: row.kind as MessageKind,
      body: JSON.parse(row.body as string),
      inReplyTo: row.in_reply_to as number | null,
      assignmentId: row.assignment_id as number | null,
      relayOf: row.relay_of as number | null,
      synthesised: row.synthesised === 1,
      sentAt: row.sent_at as string,
      readAt: row.read_at as string | null,
      deliveries: row.deliveries as number,
      lastDeliveryAt: row.last_delivery_at as string | null,
      deadLetteredAt: row.dead_lettered_at as string | null,
    });
    const messageSelect =
      `select m.*, s.read_at, s.deliveries, s.last_delivery_at, s.dead_lettered_at
       from messages m join message_status s on s.message_id = m.id`;
    const inTransaction = <T>(work: () => T): T => {
      db.exec("begin");
      try {
        const result = work();
        db.exec("commit");
        return result;
      } catch (err) {
        db.exec("rollback");
        throw err;
      }
    };
    const getMessage = (id: number): MessageRecord | undefined => {
      const row = db.prepare(`${messageSelect} where m.id = ?`).get(id);
      return row ? toMessage(row) : undefined;
    };
    const toEscalation = (row: Record<string, unknown>): EscalationRecord => ({
      id: row.id as number,
      raisedBy: row.raised_by as string,
      requestId: row.request_id as number | null,
      summary: row.summary as string,
      detail: row.detail as string | null,
      status: row.status as EscalationRecord["status"],
      reason: row.reason as string | null,
      stepId: row.step_id as number | null,
      gate: row.gate as GateKind | null,
      gateMessageId: row.gate_message_id as number | null,
      questionId: row.question_id as number | null,
      createdAt: row.created_at as string,
      decidedAt: row.decided_at as string | null,
    });
    const getEscalation = (id: number): EscalationRecord => {
      const row = db.prepare("select * from escalations where id = ?").get(id);
      if (!row) throw new UnknownEscalationError(id);
      return toEscalation(row);
    };
    const lastEventId = (): number =>
      (db.prepare("select coalesce(max(id), 0) as id from events").get() as { id: number }).id;
    const toChat = (row: Record<string, unknown>): ChatRecord => ({
      id: row.id as number,
      startedAt: row.started_at as string,
      seenAt: row.seen_at as string,
      endedAt: row.ended_at as string | null,
      endReason: row.end_reason as ChatRecord["endReason"],
      rolloverRequestedAt: row.rollover_requested_at as string | null,
      eventsThrough: row.events_through as number,
    });
    const getChat = (id: number): ChatRecord => {
      const row = db.prepare("select * from chat_sessions where id = ?").get(id);
      if (!row) throw new Error(`No chat session ${id} exists.`);
      return toChat(row);
    };
    const toRequest = (row: Record<string, unknown>): RequestRecord => ({
      id: row.id as number,
      projectId: row.project_id as number,
      status: row.status as State,
      branch: row.branch as string | null,
      worktreeId: row.worktree_id as number | null,
      playbook: row.playbook as string | null,
      description: row.description as string | null,
      trackerItem: row.tracker_item as string | null,
      ticketUrl: row.ticket_url as string | null,
      prUrl: row.pr_url as string | null,
      failure: row.failure as string | null,
    });
    const toStep = (row: Record<string, unknown>): StepRecord => ({
      id: row.id as number,
      requestId: row.request_id as number,
      position: row.position as number,
      spec: JSON.parse(row.spec as string),
      status: row.status as State,
      worker: row.worker as string | null,
      messageId: row.message_id as number | null,
      retries: row.retries as number,
      sentBack: row.sent_back as number,
      round: row.round as number,
      failure: row.failure as string | null,
    });
    const toAssignment = (row: Record<string, unknown>): AssignmentRecord => ({
      id: row.id as number,
      requestId: row.request_id as number,
      branch: row.branch as string | null,
      worktreeId: row.worktree_id as number | null,
      status: row.status as State,
      mergedAt: row.merged_at as string | null,
      pushed: row.pushed === 1,
      owns: JSON.parse(row.owns as string),
      budget: row.budget ? JSON.parse(row.budget as string) : null,
      turnsUsed: row.turns_used as number,
      spendUsd: row.spend_usd as number,
      startedAt: row.started_at as string | null,
      activityAt: row.activity_at as string | null,
      limitReached: row.limit_reached as LimitKind | null,
    });
    const toWorktree = (row: Record<string, unknown>): WorktreeRecord => ({
      id: row.id as number,
      path: row.path as string,
      branch: row.branch as string,
      portBase: row.port_base as number,
      releasedAt: row.released_at as string | null,
    });
    const getRequest = (id: number): RequestRecord => {
      const row = db.prepare("select * from requests where id = ?").get(id);
      if (!row) throw new UnknownRequestError(id);
      return toRequest(row);
    };
    const getAssignment = (id: number): AssignmentRecord => {
      const row = db.prepare("select * from assignments where id = ?").get(id);
      if (!row) throw new UnknownAssignmentError(id);
      return toAssignment(row);
    };
    return {
      addRequest: (projectId) => {
        const { lastInsertRowid } = db.prepare(
          "insert into requests (project_id, created_at) values (?, ?)",
        ).run(projectId, new Date().toISOString());
        return getRequest(Number(lastInsertRowid));
      },
      getRequest,
      listRequests: (status) =>
        db.prepare("select * from requests where status = ? order by id").all(status)
          .map(toRequest),
      setPlaybook: (requestId, run) =>
        inTransaction(() => {
          db.prepare(
            "update requests set playbook = ?, description = ?, tracker_item = ? where id = ?",
          ).run(run.playbook, run.description, run.trackerItem, requestId);
          run.steps.forEach((spec, i) => {
            db.prepare("insert into steps (request_id, position, spec) values (?, ?, ?)")
              .run(requestId, i + 1, JSON.stringify(spec));
          });
        }),
      setRequestState: (id, status, failure) => {
        db.prepare("update requests set status = ?, failure = ? where id = ?")
          .run(status, failure ?? null, id);
      },
      setTicketUrl: (id, url) => {
        db.prepare("update requests set ticket_url = ? where id = ?").run(url, id);
      },
      setPrUrl: (id, url) => {
        db.prepare("update requests set pr_url = ? where id = ?").run(url, id);
      },
      restartStep: (id) => {
        db.prepare(
          `update steps set status = 'planned', message_id = null, worker = null, failure = null,
             retries = 0, sent_back = 0, round = round + 1 where id = ?`,
        ).run(id);
      },
      listSteps: (requestId) =>
        db.prepare("select * from steps where request_id = ? order by position").all(requestId)
          .map(toStep),
      beginStep: (id, messageId, worker) => {
        db.prepare("update steps set status = 'active', message_id = ?, worker = ? where id = ?")
          .run(messageId, worker, id);
      },
      retryStep: (id, messageId, worker, byUser) => {
        db.prepare(
          byUser
            ? "update steps set message_id = ?, worker = ?, sent_back = sent_back + 1 where id = ?"
            : "update steps set message_id = ?, worker = ?, retries = retries + 1 where id = ?",
        ).run(messageId, worker, id);
      },
      setStepState: (id, status, failure) => {
        db.prepare("update steps set status = ?, failure = ? where id = ?")
          .run(status, failure ?? null, id);
      },
      addAssignment: (requestId, messageId) =>
        inTransaction(() => {
          getRequest(requestId);
          const message = getMessage(messageId);
          if (!message || message.kind !== "assignment") {
            throw new UnknownAssignmentError(messageId);
          }
          const now = new Date().toISOString();
          const planned = db.prepare(
            "select 1 from assignments where id = ? and status = 'planned'",
          ).get(messageId);
          if (planned) {
            db.prepare(
              "update assignments set status = 'active', started_at = ?, activity_at = ? where id = ?",
            ).run(now, now, messageId);
          } else {
            db.prepare(
              `insert into assignments (id, request_id, created_at, started_at, activity_at)
               values (?, ?, ?, ?, ?)`,
            ).run(messageId, requestId, now, now, now);
          }
          return getAssignment(messageId);
        }),
      getAssignment,
      planAssignment: (requestId, messageId, plan) =>
        inTransaction(() => {
          getRequest(requestId);
          const message = getMessage(messageId);
          if (!message || message.kind !== "assignment") {
            throw new UnknownAssignmentError(messageId);
          }
          db.prepare(
            `insert into assignments (id, request_id, status, created_at, owns, budget)
             values (?, ?, 'planned', ?, ?, ?)`,
          ).run(
            messageId,
            requestId,
            new Date().toISOString(),
            JSON.stringify(plan.owns),
            JSON.stringify(plan.budget),
          );
          return getAssignment(messageId);
        }),
      countActiveAssignments: (projectId) =>
        Number(
          db.prepare(
            `select count(*) as n from assignments a join requests r on r.id = a.request_id
             where a.status = 'active' ${projectId === undefined ? "" : "and r.project_id = ?"}`,
          ).get(...(projectId === undefined ? [] : [projectId]))!.n,
        ),
      listActiveAssignments: () =>
        db.prepare(
          `select a.* from assignments a join requests r on r.id = a.request_id
           where a.status = 'active' and r.status = 'active' order by a.id`,
        ).all().map(toAssignment),
      addUsage: (id, usage) => {
        db.prepare(
          `update assignments set turns_used = turns_used + ?, spend_usd = spend_usd + ?,
             activity_at = ? where id = ?`,
        ).run(usage.turns, usage.spendUsd, new Date().toISOString(), id);
      },
      touchAssignment: (id) => {
        db.prepare("update assignments set activity_at = ? where id = ?")
          .run(new Date().toISOString(), id);
      },
      markLimitReached: (id, kind) => {
        db.prepare(
          "update assignments set limit_reached = ?, status = 'failed' where id = ? and status = 'active'",
        ).run(kind, id);
      },
      listAssignments: (requestId) =>
        db.prepare("select * from assignments where request_id = ? order by id").all(requestId)
          .map(toAssignment),
      setAssignmentState: (id, status) => {
        db.prepare("update assignments set status = ? where id = ?").run(status, id);
      },
      addWorktree: (wt) =>
        inTransaction(() => {
          const used = new Set(
            db.prepare("select port_base from worktrees where released_at is null").all()
              .map((r) => r.port_base as number),
          );
          let base = FIRST_WORKTREE_PORT;
          while (used.has(base)) base += WORKTREE_PORTS;
          if (base + WORKTREE_PORTS > LAST_WORKTREE_PORT) {
            throw new Error("No free port block is left for a new worktree.");
          }
          const { lastInsertRowid } = db.prepare(
            "insert into worktrees (path, branch, port_base, created_at) values (?, ?, ?, ?)",
          ).run(wt.path, wt.branch, base, new Date().toISOString());
          return toWorktree(
            db.prepare("select * from worktrees where id = ?").get(Number(lastInsertRowid))!,
          );
        }),
      getWorktree: (id) => toWorktree(db.prepare("select * from worktrees where id = ?").get(id)!),
      findLiveWorktree: (path) => {
        const row = db.prepare("select * from worktrees where path = ? and released_at is null")
          .get(path);
        return row ? toWorktree(row) : undefined;
      },
      releaseWorktree: (id) => {
        db.prepare("update worktrees set released_at = ? where id = ? and released_at is null")
          .run(new Date().toISOString(), id);
      },
      attachRequest: (id, branch, worktreeId) => {
        db.prepare("update requests set branch = ?, worktree_id = ? where id = ?")
          .run(branch, worktreeId, id);
      },
      attachAssignment: (id, branch, worktreeId) => {
        db.prepare("update assignments set branch = ?, worktree_id = ? where id = ?")
          .run(branch, worktreeId, id);
      },
      discardRequest: (id) => {
        db.prepare("delete from requests where id = ? and branch is null").run(id);
      },
      discardAssignment: (id) => {
        db.prepare("delete from assignments where id = ? and branch is null").run(id);
      },
      markMerged: (id) => {
        db.prepare(
          `update assignments set merged_at = ?,
             status = case status when 'active' then 'done' else status end where id = ?`,
        ).run(new Date().toISOString(), id);
      },
      markPushed: (id) => {
        db.prepare("update assignments set pushed = 1 where id = ?").run(id);
      },
      addSession: (s) => {
        const openedAt = new Date().toISOString();
        try {
          db.prepare(
            `insert into sessions (address, role, department, cwd, role_name, opened_at)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(s.address, s.role, s.department, s.cwd, s.roleName ?? null, openedAt);
        } catch (err) {
          if (/UNIQUE constraint failed/.test((err as Error).message)) {
            throw new DuplicateSessionError(
              s.role === "overseer"
                ? "There is already an overseer."
                : s.role === "leader" && s.department
                ? `Department "${s.department}" already has a leader, or "${s.address}" is open.`
                : `A session is already open at "${s.address}".`,
            );
          }
          throw err;
        }
        return { ...s, roleName: s.roleName ?? null, claudeSessionId: null, openedAt };
      },
      setSessionCwd: (address, cwd) => {
        db.prepare("update sessions set cwd = ? where address = ?").run(cwd, address);
      },
      setClaudeSession: (address, id) => {
        db.prepare("update sessions set claude_session_id = ? where address = ?").run(id, address);
      },
      listSessions: () =>
        db.prepare("select * from sessions order by opened_at, address").all().map(toSession),
      getSession: (address) => {
        const row = db.prepare("select * from sessions where address = ?").get(address);
        if (!row) throw new UnknownSessionError(address);
        return toSession(row);
      },
      appendMessage: (m) =>
        inTransaction(() => {
          const { lastInsertRowid } = db.prepare(
            `insert into messages (sender, recipient, kind, body, in_reply_to, assignment_id, relay_of, synthesised, sent_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            m.from,
            m.to,
            m.kind,
            JSON.stringify(m.body),
            m.inReplyTo ?? null,
            m.assignmentId ?? null,
            m.relayOf ?? null,
            m.synthesised ? 1 : 0,
            new Date().toISOString(),
          );
          db.prepare("insert into message_status (message_id) values (?)").run(lastInsertRowid);
          return getMessage(Number(lastInsertRowid))!;
        }),
      getMessage,
      listMessages: (f = {}) => {
        const where: string[] = [];
        const values: (string | number)[] = [];
        if (f.to !== undefined) (where.push("m.recipient = ?"), values.push(f.to));
        if (f.from !== undefined) (where.push("m.sender = ?"), values.push(f.from));
        if (f.kind !== undefined) (where.push("m.kind = ?"), values.push(f.kind));
        if (f.inReplyTo !== undefined) (where.push("m.in_reply_to = ?"), values.push(f.inReplyTo));
        if (f.waiting) {
          where.push(
            `s.read_at is null and s.dead_lettered_at is null and
             (m.kind != 'assignment' or not exists (
               select 1 from messages r where r.kind = 'result' and r.in_reply_to = m.id
             ))`,
          );
        }
        return db.prepare(
          `${messageSelect} ${where.length ? `where ${where.join(" and ")}` : ""} order by m.id`,
        ).all(...values).map(toMessage);
      },
      markRead: (ids) =>
        inTransaction(() => {
          const stmt = db.prepare(
            "update message_status set read_at = ? where message_id = ? and read_at is null",
          );
          const now = new Date().toISOString();
          for (const id of ids) stmt.run(now, id);
        }),
      recordDelivery: (ids) =>
        inTransaction(() => {
          const stmt = db.prepare(
            "update message_status set deliveries = deliveries + 1, last_delivery_at = ? where message_id = ?",
          );
          const now = new Date().toISOString();
          for (const id of ids) stmt.run(now, id);
        }),
      deadLetter: (id) => {
        db.prepare("update message_status set dead_lettered_at = ? where message_id = ?")
          .run(new Date().toISOString(), id);
      },
      addProject: (p) => {
        const registeredAt = new Date().toISOString();
        try {
          const { lastInsertRowid } = insertProject.run(
            p.name,
            p.source,
            p.remoteUrl,
            p.clonePath,
            p.defaultBranch,
            p.headCommit,
            p.setupCommand,
            p.testCommand,
            p.lintCommand,
            p.buildCommand,
            p.baseline ? JSON.stringify(p.baseline) : null,
            JSON.stringify(p.warnings),
            registeredAt,
          );
          return {
            ...p,
            id: Number(lastInsertRowid),
            registeredAt,
            paused: false,
            removedAt: null,
          };
        } catch (err) {
          if (/UNIQUE constraint failed/.test((err as Error).message)) {
            throw new DuplicateProjectError(p.name);
          }
          throw err;
        }
      },
      listProjects: (o) =>
        db.prepare(
          `select * from projects ${
            o?.includeRemoved ? "" : "where removed_at is null "
          }order by id`,
        ).all().map(toRecord),
      getProject,
      updateProject: (name, patch) => {
        const project = getProject(name);
        const columns: Record<keyof ProjectPatch, string> = {
          paused: "paused",
          defaultBranch: "default_branch",
          headCommit: "head_commit",
          setupCommand: "setup_command",
          testCommand: "test_command",
          lintCommand: "lint_command",
          buildCommand: "build_command",
          baseline: "baseline",
          warnings: "warnings",
        };
        const sets: string[] = [];
        const values: (string | number | null)[] = [];
        for (const key of Object.keys(patch) as (keyof ProjectPatch)[]) {
          if (!(key in columns) || patch[key] === undefined) continue;
          const value = patch[key];
          sets.push(`${columns[key]} = ?`);
          values.push(
            key === "paused"
              ? (value ? 1 : 0)
              : key === "baseline" || key === "warnings"
              ? (value === null ? null : JSON.stringify(value))
              : value as string | null,
          );
        }
        if (sets.length) {
          db.prepare(`update projects set ${sets.join(", ")} where id = ?`).run(
            ...values,
            project.id,
          );
        }
        return getProject(name);
      },
      removeProject: (name, o) => {
        const project = getProject(name);
        const active = Number(countActive.get(project.id)!.n);
        if (active > 0 && !o?.force) throw new ActiveRequestsError(name, active);
        const removedAt = new Date().toISOString();
        db.exec("begin");
        try {
          db.prepare("update projects set removed_at = ? where id = ?").run(removedAt, project.id);
          insertEvent.run(
            removedAt,
            "project.removed",
            JSON.stringify({ id: project.id, name, forced: !!o?.force }),
          );
          db.exec("commit");
        } catch (err) {
          db.exec("rollback");
          throw err;
        }
        return { ...project, removedAt };
      },
      addEscalation: (e) => {
        const { lastInsertRowid } = db.prepare(
          `insert into escalations
             (raised_by, request_id, summary, detail, step_id, gate, gate_message_id, question_id, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.raisedBy,
          e.requestId ?? null,
          e.summary,
          e.detail ?? null,
          e.stepId ?? null,
          e.gate ?? null,
          e.gateMessageId ?? null,
          e.questionId ?? null,
          new Date().toISOString(),
        );
        return getEscalation(Number(lastInsertRowid));
      },
      getEscalation,
      listEscalations: (o = {}) =>
        db.prepare(
          `select * from escalations ${o.openOnly ? "where status = 'open'" : ""} order by id`,
        ).all().map(toEscalation),
      decideEscalation: (id, d) =>
        inTransaction(() => {
          const before = getEscalation(id);
          if (before.status !== "open") throw new EscalationDecidedError(before);
          db.prepare(
            "update escalations set status = ?, reason = ?, decided_at = ? where id = ?",
          ).run(
            d.approved ? "approved" : "rejected",
            d.reason ?? null,
            new Date().toISOString(),
            id,
          );
          return getEscalation(id);
        }),
      getEscalationPage: (id) => {
        const row = db.prepare("select * from escalation_pages where escalation_id = ?").get(id);
        return row
          ? {
            escalationId: Number(row.escalation_id),
            token: String(row.token),
            spentAt: (row.spent_at as string | null) ?? null,
          }
          : undefined;
      },
      addEscalationPage: (id, token) => {
        db.prepare(
          "insert into escalation_pages (escalation_id, token, created_at) values (?, ?, ?)",
        ).run(id, token, new Date().toISOString());
        return { escalationId: id, token, spentAt: null };
      },
      spendEscalationPage: (id) => {
        db.prepare("update escalation_pages set spent_at = ? where escalation_id = ?").run(
          new Date().toISOString(),
          id,
        );
      },
      addEscalationNote: (id, body) => {
        const sentAt = new Date().toISOString();
        const { lastInsertRowid } = db.prepare(
          "insert into escalation_notes (escalation_id, body, sent_at) values (?, ?, ?)",
        ).run(id, body, sentAt);
        return { id: Number(lastInsertRowid), escalationId: id, body, sentAt };
      },
      listEscalationNotes: (id) =>
        db.prepare(
          `select * from escalation_notes ${id === undefined ? "" : "where escalation_id = ?"}
           order by id`,
        ).all(...(id === undefined ? [] : [id])).map((row) => ({
          id: Number(row.id),
          escalationId: Number(row.escalation_id),
          body: String(row.body),
          sentAt: String(row.sent_at),
        })),
      info: () => ({
        schemaVersion: version(),
        sqliteVersion: db.prepare("select sqlite_version() v").get()!.v as string,
        journalMode: db.prepare("pragma journal_mode").get()!.journal_mode as string,
      }),
      backup,
      appendEvent: (kind, data = {}) => {
        insertEvent.run(new Date().toISOString(), kind, JSON.stringify(data));
      },
      startChat: () => {
        const now = new Date().toISOString();
        const { lastInsertRowid } = db.prepare(
          "insert into chat_sessions (started_at, seen_at, events_through) values (?, ?, ?)",
        ).run(now, now, lastEventId());
        return getChat(Number(lastInsertRowid));
      },
      getChat,
      latestChat: () => {
        const row = db.prepare("select * from chat_sessions order by id desc limit 1").get();
        return row ? toChat(row) : undefined;
      },
      touchChat: (id) => {
        db.prepare("update chat_sessions set seen_at = ?, events_through = ? where id = ?")
          .run(new Date().toISOString(), lastEventId(), id);
      },
      endChat: (id, reason) => {
        db.prepare(
          "update chat_sessions set ended_at = ?, end_reason = ? where id = ? and ended_at is null",
        ).run(new Date().toISOString(), reason, id);
      },
      requestRollover: (id) => {
        db.prepare(
          "update chat_sessions set rollover_requested_at = ? where id = ? " +
            "and rollover_requested_at is null",
        ).run(new Date().toISOString(), id);
      },
      addChatTurn: (chatId, speaker, text) => {
        const at = new Date().toISOString();
        const { lastInsertRowid } = db.prepare(
          "insert into chat_turns (chat_session_id, speaker, text, at) values (?, ?, ?, ?)",
        ).run(chatId, speaker, text, at);
        return { id: Number(lastInsertRowid), chatId, speaker, text, at };
      },
      listChatTurns: (limit) =>
        db.prepare("select * from chat_turns order by id desc limit ?").all(limit).reverse()
          .map((row) => ({
            id: row.id as number,
            chatId: row.chat_session_id as number,
            speaker: row.speaker as ChatTurn["speaker"],
            text: row.text as string,
            at: row.at as string,
          })),
      listEvents: (afterId, kinds) =>
        db.prepare("select * from events where id > ? order by id").all(afterId)
          .filter((row) => !kinds || kinds.includes(row.kind as string))
          .map((row) => ({
            id: row.id as number,
            ts: row.ts as string,
            kind: row.kind as string,
            data: JSON.parse(row.data as string),
          })),
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
