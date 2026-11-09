# Kiln

Kiln is a long-running AI coding factory. A person asks it for software work across the projects registered with it, and departments of AI agents carry that work out and check it.

## Language

**Kiln**:
The factory as a whole: the overseer, its departments, and the projects registered with it.
_Avoid_: platform, system, orchestrator

**Overseer**:
The single role the user talks to. It receives requests, delegates them to departments, and brings the user the decisions that are theirs.
_Avoid_: manager, coordinator, orchestrator, boss

**Department**:
A group of roles responsible for one kind of work, made up of one leader and its workers.
_Avoid_: team, squad, role group

**Leader**:
The role that heads a department. It coordinates and verifies the department's work and never does that work itself.
_Avoid_: lead, manager, supervisor

**Worker**:
A role that does the actual work of a department, one assignment at a time.
_Avoid_: agent, minion, drone

**Project**:
A code repository registered with Kiln, which Kiln can do work on.
_Avoid_: repo, codebase, target

**Request**:
A piece of work the user asks the overseer for on a project, such as implementing a ticket, researching a bug, or designing a feature.
_Avoid_: task, job, order

**Assignment**:
A unit of a request handed from a leader to a worker.
_Avoid_: task, job

**Playbook**:
The ordered list of department steps Kiln follows for one type of request.
_Avoid_: workflow, pipeline, recipe

**Step**:
One department's part of a request in its Playbook, handed to that department's leader as a single assignment from the overseer. A step is done when its leader reports it verified.
_Avoid_: stage, phase, task

**State**:
Where a request, a step or an assignment is in its life: planned, active, done or failed. All three share the same states.
_Avoid_: status, phase

**Tracker item**:
The ticket in a project's tracker that a request came from. A request may have none. A ticket Kiln publishes for a request is a new tracker item.
_Avoid_: issue link, ticket reference

**Rejection**:
A failed verification of a step's work. The work is not merged; the step goes back to its leader with the feedback for a fresh worker that starts from the rejected branch. A step is retried twice, then the rejection goes up to the Overseer.
_Avoid_: bounce, failure

**Limit**:
What one Assignment may use before Kiln stops its worker: turns, spend and wall-clock time, plus a watch for a worker that shows no sign of life. A Project's ceiling caps what a leader may ask for. When a Limit is reached the Assignment fails with a result written by Kiln, and its leader chooses what happens next.
_Avoid_: quota, timeout

**Cap**:
How many Assignments may be active at once, in all of Kiln and in one Project. An Assignment over a Cap, or whose declared files overlap another's, waits as planned and starts when it is free.
_Avoid_: rate limit, throttle

**Gate**:
A point in a request where the overseer must bring the user a decision before work can continue.
_Avoid_: approval step, checkpoint

**Escalation**:
A question or decision raised up the chain from worker to leader to overseer, and on to the user when it is theirs to make. The Overseer records each one it brings the user; it stays open, however long, until the user approves or rejects it. A rejection carries the user's reason, a decision is final, and an open one whose Request has ended is stale.
_Avoid_: alert, handoff up

**Question relay**:
How a question travels up the chain and its answer comes back down. It is answered at the first level that can; otherwise it is passed up with the chain recorded, ending at the user as an Escalation. The answer reaches the Worker that asked, and wakes the Worker's own Claude session again.
_Avoid_: forwarding, ticket routing

**Inbox**:
The place where messages addressed to one agent wait to be read. Assignments, results, questions and answers all travel as messages in inboxes.
_Avoid_: mailbox, queue, channel

**Nudge**:
A short prompt from Kiln that wakes an agent so it reads its inbox.
_Avoid_: ping, wake-up call, notification

**Message**:
One piece of mail between two agents: an assignment, a result, a question or an answer. Messages are never changed or removed once sent; what happens to them afterwards (read, nudged, dead-lettered) is recorded beside them.
_Avoid_: email, ticket, event

**Route**:
The one path a Message may take: assignments and answers go down to a direct report, results and questions go up to the sender's direct superior (worker to its department's leader, leader to the overseer). Any other path is refused.
_Avoid_: channel, permission

**Dead letter**:
A Message nobody read after three Nudges. Kiln stops waking anyone for it; a dead-lettered assignment is reported back to its sender as a failed result written by Kiln.
_Avoid_: lost message, expired message

**Merge watch**:
How Kiln follows a pull request that has passed QA, with no model involved: on a clock it asks the forge for the pull request's state. Kiln never merges. Merged is the user's go-ahead: the wrap-up step begins and, once the ticket is closed, Kiln cleans up the Request's worktrees and branches. Closed without merging blocks the Request on the user, and nothing is removed.
_Avoid_: PR poller, auto-merge

**Wrap-up**:
The last step of implementing a ticket, an Assignment to a Closer that begins once the pull request is merged. Its note is posted on the tracker item, and Kiln closes the tracker item.
_Avoid_: closing step, finalisation

**Breakdown**:
A spec split into tickets: each ticket says which of the spec's acceptance criteria it covers and which tickets it is blocked by. The Leader accepts it only when every criterion is covered and the dependencies have no cycle; once its tickets are in the tracker the Overseer approves it and tells the user afterwards.
_Avoid_: plan, decomposition

**Wayfinder**:
The worker that takes one ticket in a Request and either charts it (the route: the pieces of work in order) or resolves it (the answer). There is one Wayfinder session per Request. A ticket labelled `research` goes to the **Researcher** instead, who answers its question from primary sources.
_Avoid_: scout, navigator

**Halt**:
The user's model-free stop of all work (`kiln halt`): agents are stopped, nobody is woken and no Request advances until `kiln resume`. A halt survives a restart.
_Avoid_: pause, freeze

**Interruption**:
A crash of Kiln under an agent's launch. The work is resumed once; interrupted a second time it fails.
_Avoid_: restart failure

**Stuck**:
An agent Kiln stopped waking because its launches kept failing for infrastructure reasons past the retry budget (with backoff), or because its work was interrupted twice. The Overseer is told.
_Avoid_: dead, hung

**Cancel**:
Ending a Request at the user's word (`kiln request cancel`). Its workers stop and it fails; its branches and worktrees are kept.
_Avoid_: abort, delete

**Budget**:
What all the work of one Request may cost in dollars, summed over every agent that works for it, or what all of Kiln may spend in a day (the **daily cap**). At 80% of either the user is notified. A Request that uses its Budget is blocked on the user, who gives it another Budget's worth or ends it; at the daily cap nobody is woken until the cap is raised or the day ends. Not a Limit, which bounds one Assignment.
_Avoid_: quota, allowance

**Notification**:
A message from Kiln to the user outside the chat, handed to the command the user configured: a Budget warning, a Request blocked on a Budget, the daily cap reached, or the digest. A command that fails never stops the work.
_Avoid_: alert, push

**Digest**:
What happened since the user was last told, sent once a day as a Notification and given to the Overseer when the user attaches with `kiln chat`. When nothing happened there is no digest.
_Avoid_: summary, report
