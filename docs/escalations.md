# Escalations

A decision that is the user's to make is an **Escalation**. The Overseer raises one with its
`raise_escalation` tool (`summary`, optional `detail`, optional `requestId` of an active Request);
`read_escalations` shows it which of its Escalations were decided, and why. Leaders and workers
cannot raise one: they ask their superior a question.

```
kiln escalations [--all] [--json]       # what waits for you; --all adds the decided ones
kiln approve <escalation-id>
kiln reject <escalation-id> --reason <text>
```

- An Escalation waits for as long as it takes. Nothing times it out or decides for you.
- Only the daemon records a decision, and only for you. A decision is final: deciding again is
  refused. A rejection needs a reason, which the Overseer reads.
- An open Escalation whose Request has since finished or failed is **stale**: it is listed as such
  and cannot be decided.
- Agents never decide. Kiln marks every command an agent runs (`KILN_AGENT`), and the daemon
  refuses `approve` and `reject` from it; the policing hook also refuses the commands in an
  agent's shell, and no tool decides.
