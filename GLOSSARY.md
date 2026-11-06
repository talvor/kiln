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

**Gate**:
A point in a request where the overseer must bring the user a decision before work can continue.
_Avoid_: approval step, checkpoint

**Escalation**:
A question or decision raised up the chain from worker to leader to overseer, and on to the user when it is theirs to make.
_Avoid_: alert, handoff up

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
