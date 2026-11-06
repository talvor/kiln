// A stand-in entry point that imports the pinned Claude Agent SDK, to build against.
import { query } from "@anthropic-ai/claude-agent-sdk";

console.log(typeof query === "function" ? "uses-sdk ok" : "uses-sdk broken");
