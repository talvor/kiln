# Question relay

A Worker that is stuck asks its Leader a question (`raise_question`), and so does a Worker whose
tool call Kiln refused. The question is answered at the first level that can.

- The Leader answers it with `send` (kind `answer`).
- A Leader that cannot answer passes it up: `raise_question` with `relaysQuestion` set to the
  Worker's question id. The new question records the one it passes up (`relayOf`). When the
  Overseer answers, Kiln sends that answer on down to the Worker, from the Leader, recording the
  answer it came from (`relayOf`); the Leader does not have to wake.
- An Overseer that cannot answer raises an Escalation over the question (`raise_escalation` with
  `questionId`). The user's `kiln approve` or `kiln reject --reason` is then the answer, and it
  goes down the same chain.
- An answer wakes the very Claude session that asked: Kiln remembers each agent's Claude session
  and resumes it, so a Worker carries on with its context instead of starting over. If the session
  cannot be resumed, Kiln retries once with a fresh one, which reads the answer from its
  inbox. A grilling-style skill's questions are asked this way, so they work unattended.
