# The Dashboard is a separate client process with a memory-only token

The Dashboard is served by `kiln dashboard`, a separate foreground process that talks to the daemon over its existing unix socket like the CLI does, bound to 127.0.0.1 on a free port. The daemon gains no network surface. A per-launch secret token is held in the dashboard's memory only (never in argv, environment or files) and exchanged for an HttpOnly, SameSite=Strict cookie; Host and Origin are checked on every request, because the Dashboard can approve spend.

Considered and rejected: an HTTP server inside the daemon (always on, but puts a TCP listener in the long-running process that supervises agents), reach beyond the machine (LAN, tailnet, internet, which would need real authentication), and a token the daemon knows (which would allow a Notification link but weakens the secret). Reaching the Dashboard from another device means tunnelling to the loopback port yourself.

The residual risk is that a process running as the same user can read the dashboard's memory; agents are kept off it by extending the policing hook to refuse their shell commands aimed at the dashboard port.
