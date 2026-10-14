# Parent guidance while Pi delegates run

## Question and short answer

What does the parent model get told to do while a background Pi subagent/delegate/worker runs, and how do extensions prevent a second retrieval path when results are pushed?

The clearest implementations explicitly teach the *replacement action*: do independent work, otherwise end the turn; completion wakes a new turn. They also name forbidden substitutes (polling, sleeping, reading session files, or a wait tool). A wait tool is not a universal solution: some extensions discourage it for normally pushed results; others make it the sole collector, return only lifecycle events rather than the report, or mark the report consumed so the pending push is suppressed. No model experiment here establishes that wording alone is sufficient for gpt-6-astra.

For pi-squire, strengthen the sentence from “there is no need” to an explicit prohibition naming `session_mail_ask`, and put that prohibition in the launch receipt too. Do not add a blocking wait tool merely to cure duplicate report collection. If exactly one arrival must be guaranteed despite model behavior, enforce a single report delivery owner; a prompt cannot supply that guarantee. A blanket ban on asking an owned delegate also bans legitimate clarification, so that is a product-policy decision, not something this survey proves necessary.

## Date, versions, and method

Checked **2026-10-14 UTC**, using public source snapshots pinned by full Git commit. This is a fresh parent-wording survey, not a repeat of `async-result-delivery.md`; the edxeth and nicobailon commits happen to match the earlier local snapshots. HEADs are source snapshots, not a claim that npm has published every change. Every code quote below links to its full pinned commit. Markdown/README-only assertions are not used to establish behavior.

Local first: `git rev-parse HEAD` initially returned `6dfedef1b210019dfe76a6d42b35c1371ad6b381`; while research ran, HEAD advanced to `529c3447ed1ecae9b9cabd58d9420433f3cc082f`. No code was edited by this researcher. The existing delivery note and the two existing `/tmp/async-result-research/*pi-subagents` snapshots were identified, but delivery research was not repeated.

Discovery evidence:

- `search_pi_packages({query:"subagent",limit:25})` returned “top 25 by downloads of 401 matches”; `worker` returned 25 of 54; `delegate` returned 25 of 67. These calls search the [pi.dev package catalog](https://pi.dev). The catalog is a discovery source, not the owner of implementation claims.
- `curl -s 'https://registry.npmjs.org/-/v1/search?text=keywords:pi-package%20subagent&size=100'` yielded 100 packages. Their repository links were unioned with relevant catalog entries. This is a **100-result cap**, not the entire npm ecosystem.
- `gh search repos 'pi-coding-agent subagent' --limit 50 --json fullName` returned `HashWarlock/nobody-plans-for-pi`, `catlain/pi-workflow`, `GonChen/codex-pi-agents`, `KatouMegumi-dar/pi-subagent-tool`, `KcAnom/pi-fairy-tales`; the analogous `worker` query returned `qaml-ai/pi-coding-agent-worker-package` and `qaml-ai/pi-coding-agent-worker`.
- Snapshots were downloaded with `git ls-remote https://github.com/<owner>/<repo>.git HEAD` followed by `https://codeload.github.com/<owner>/<repo>/tar.gz/<full-sha>`. The broad inventory at the end records every attempted repository and its pin. Source searches excluded tests when selecting runtime wording; tests were not executed.

The detailed profiles below verify actual tool descriptions, prompt snippets/guidelines, launch receipts, and relevant collector code. The broad inventory is a **triage inventory**, not 128 full architectural audits: undecided wait/push interactions and nonmatching wording are explicitly `unknown`. An unsuccessful textual search is not proof that a runtime guard does not exist. The open-ended “every extension” universe is unknown and cannot be established from capped search endpoints.

## Decision for pi-squire

Suggested parent-facing sentence (recommendation, not a quotation):

> While the delegate runs, do independent work or end your turn; its final report arrives automatically and starts your next turn. Do not use `session_mail_ask`, poll `delegation_status`, or read result/session files just to wait for or collect that report.

Use this in the tool description and a shorter version in the immediate receipt. Separately label `delegation_status` as diagnostics/recovery, not the way to wait. Keep the ability to inspect evidence after the report, and keep intentional steering/clarification distinct from asking for the same report.

Evidence for that recommendation is especially direct in edxeth's prompt, nicobailon's prohibition on `bg_wait` for native-notified work, deathbeam's immediate receipt, ByteTrue's description/guidelines/receipt, and prjct-app's receipt. They all tell the parent how to yield rather than merely saying a result will arrive. Evidence **against** adding a wait tool as a generic fix comes from nicobailon and hheei: they possess wait tools yet explicitly tell the parent not to use them for normal subagent reports. Evidence for structural exact-once handling is in gotgenes, bermudi, and mavam: their collectors participate in delivery ownership rather than independently requesting another report.

The observed `session_mail_ask` incident is supplied by the task, not independently reproduced. This survey found no verified source showing a `session_mail_ask`-specific parent-to-owned-delegate block. Whether an enforceable, provider-independent block is available through pi-squire's consumed `message:*` hooks is **unknown** here. Do not infer that another extension's internal collector deduplication would deduplicate two independent mail replies.

## Detailed parent-facing contracts


### edxeth/pi-subagents

The parent gets a full “After launch” prompt snippet, including end-turn, automatic wake, no polling, no session-file checks, and no duplication of assigned work. The launch receipt reiterates automatic steer delivery. There is no separately registered wait tool among the core launch/resume/kill registrations reviewed: synchronous waiting is selected by launch behavior and handled inside `getLaunchedSubagentResult`; this is different from an arbitrary mail ask. Collector-vs-push ownership is already covered by the earlier delivery note. A block on an external mail ask is **unknown**.

[src/tools/subagent-tools.ts:362–380](https://github.com/edxeth/pi-subagents/blob/cf6dbf41c17986f3882e6804a68e8fb8282d25e6/src/tools/subagent-tools.ts#L362-L380) (verbatim source string/template; concatenation and placeholders are retained):

```ts
	// argv-based one-shot check is available here. Background children are
	// `pi -p` processes, which is the case that matters.
	if (isOneShotPromptInvocation()) {
		return (
			"After launch:\n" +
			"- In this session every launch waits for the helper and returns its report as the tool result. Read the report and continue; do not redo delegated work.\n" +
			"- Ask the user only when there is a plausible next step but ownership is ambiguous.\n"
		);
	}
	return (
		"After launch:\n" +
		"- If a helper returns later, continue only with clearly independent work. Do not redo delegated work and do not claim the helper's findings before its later message appears.\n" +
		"- If no safe independent work is clear, stop your response and wait for the later helper message.\n" +
		"- Ask the user only when there is a plausible next step but ownership is ambiguous.\n" +
		"Results arrive automatically as a steer message that starts a new turn. " +
		"Do not poll, sleep-read, or check session files — the harness handles delivery.\n" +
		getCoordinatorOnlyTurnPrompt()
	);
}
```

[src/runtime/running-registry.ts:151–168](https://github.com/edxeth/pi-subagents/blob/cf6dbf41c17986f3882e6804a68e8fb8282d25e6/src/runtime/running-registry.ts#L151-L168) (verbatim source string/template; concatenation and placeholders are retained):

```ts
function getStartedSubagentResult(running: RunningSubagent) {
	const isAsync = running.async ?? !(running.blocking ?? false);
	if (isAsync) requestSubagentBatchStop();
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Sub-agent "${running.name}" launched ${isAsync ? "async" : "sync"} with id ${running.id}. ` +
					(isAsync
						? `Results will be delivered automatically as a steer message when it finishes. `
						: `The parent is waiting for this result before continuing. `) +
					`Use this exact id if you need to resume or stop this child.`,
			},
		],
		details: getStartedSubagentDetails(running),
		...getSubagentBatchStopMetadata(),
	};
```

[src/runtime/running-registry.ts:170–183](https://github.com/edxeth/pi-subagents/blob/cf6dbf41c17986f3882e6804a68e8fb8282d25e6/src/runtime/running-registry.ts#L170-L183) (verbatim source string/template; concatenation and placeholders are retained):

```ts

export async function getLaunchedSubagentResult(
	running: RunningSubagent,
	runtime: RunningRegistryRuntime,
	signal?: AbortSignal,
) {
	const parentShouldWait = shouldAwaitSubagentLaunch(running);
	if (!parentShouldWait) return getStartedSubagentResult(running);
	const result = await runtime.waitForSubagentResult({ id: running.id }, signal);
	// The parent waited, so the report is already in this tool result. The
	// coordinator-only turn stop exists for detached launches only; a stop mark
	// here would end the turn before the model reads the report.
	return runtime.asSubagentToolResult(result);
}
```

[src/tools/resume-tool.ts:63–71](https://github.com/edxeth/pi-subagents/blob/cf6dbf41c17986f3882e6804a68e8fb8282d25e6/src/tools/resume-tool.ts#L63-L71) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		description: "Continue a previous subagent session from its session file, optionally sending a follow-up task.",
		promptSnippet:
			"Use subagent_resume when an earlier helper session was cancelled, left open, or needs follow-up work with its existing context.\n" +
			"\n" +
			"Provide sessionFile from the earlier subagent output. If you include task, it is sent as the next instruction in that resumed session.\n" +
			"\n" +
			"The resumed helper may run in a visible terminal or hidden process depending on saved metadata or the mode argument. The tool usually returns after starting it; the helper's final report appears later in this chat when it finishes. Do not invent or assume resumed-session results before that later message appears. " +
			"Leave model/thinking unset unless the user named concrete values for this resume. Do not infer them from quality, depth, urgency, safety, or cost language. " +
			"The result arrives automatically as a steer message. Do not poll for it.",
```

### nicobailon/pi-subagents

The ordinary parent is explicitly told **not to use its wait tool** for native-notified async runs. `bg_wait` exists for provider/detached work without native notification when a same-turn result is needed; the child runtime has different guidance because it lacks that notifier. The receipt branches on native completion support. Status is available for a one-shot check. The wait result says completion/control events have been observed and to inspect status if a notification is not visible; do not assume waiting consumes/suppresses the ordinary push. The earlier delivery report owns the underlying timing/deduplication analysis; a third-party mail-ask block is **unknown**.

[src/extension/tool-description.ts:15–20](https://github.com/nicobailon/pi-subagents/blob/a4c8ced69a8176cdf4179b127feddc8875e3418f/src/extension/tool-description.ts#L15-L20) (verbatim source string/template; concatenation and placeholders are retained):

```ts

// Part of every built-in description and appended to custom ones, so it is sent on every request.
export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
- Delegate only when the operator asked, directly or through applicable user/project instructions; size, complexity or risk alone is not authorization.
- Native async completion wakes this session: return control; do not sleep, poll or call bg_wait for it.
- One writer per cwd/worktree; isolate concurrent writers.
```

[src/extension/tool-description.ts:49](https://github.com/nicobailon/pi-subagents/blob/a4c8ced69a8176cdf4179b127feddc8875e3418f/src/extension/tool-description.ts#L49) (verbatim source string/template; concatenation and placeholders are retained):

```ts
• Async follows asyncByDefault (normally true); async:false only to block the parent, not for final reviews/gates. Consume results at dependency barriers. bg_wait is for provider/detached work without native notification that needs a same-turn result.
```

[src/runs/background/async-execution.ts:416–428](https://github.com/nicobailon/pi-subagents/blob/a4c8ced69a8176cdf4179b127feddc8875e3418f/src/runs/background/async-execution.ts#L416-L428) (verbatim source string/template; concatenation and placeholders are retained):

```ts
	}
	| { error: string };

export function formatAsyncStartedMessage(headline: string, interactive: boolean): string {
	const guidance = interactive
		? [
			"Detached. Return control now: native completion wakes you, so do not sleep, poll, or call bg_wait for it.",
			"One-shot check: subagent({ action: \"status\", id: \"...\" }).",
		]
		: [
			"Detached non-interactive run: Pi auto-drains current-session subagent work at agent_end. Do not run sleep timers or polling loops. Use bg_wait only for results this turn needs from work without native notification, and subagent({ action: \"status\", id: \"...\" }) for a one-shot check.",
		];
	return [headline, "", ...guidance].join("\n");
```

[src/runs/background/wait-tool.ts:18–24](https://github.com/nicobailon/pi-subagents/blob/a4c8ced69a8176cdf4179b127feddc8875e3418f/src/runs/background/wait-tool.ts#L18-L24) (verbatim source string/template; concatenation and placeholders are retained):

```ts
	const description = `Wait for background work, then return. ${child ? "This child runtime has no native completion notifier: use blocking bg_wait to collect your owned descendants this turn and read their result references; agent_end draining does not synthesize results." : "Ordinary async subagent runs already wake this session natively; use bg_wait only for provider, detached, or other background work without native notification, when a same-turn result is needed."}
{} — first active run or provider item to finish or need attention.
{all:true} — all work active at call time.
{id} — one run; a finished async run returns its result references.
{id,nonBlocking:true} — subscribe to that run's wake and return now.
Timeout or a user message ends the wait without error; work keeps running.${enabled ? "" : "\nDisabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED: returns immediately."}`;
	// Messages typed while the agent is busy (steer or follow-up) end open waits so they reach the model.
```

[src/runs/background/subagent-wait.ts:865–875](https://github.com/nicobailon/pi-subagents/blob/a4c8ced69a8176cdf4179b127feddc8875e3418f/src/runs/background/subagent-wait.ts#L865-L875) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			? `\n${foregroundResult.content.map((part) => part.type === "text" ? part.text : "").join("\n")}`
			: "";
		const scope = params.id
			? `run "${params.id}"`
			: initialProviderIds.size === 0
				? `${initialAsyncIds.size} async run(s)`
				: `${initialAsyncIds.size} async run(s) and ${initialProviderIds.size} provider item(s)`;
		const status = relevantAttention.length > 0 ? "attention required" : "done";
		return result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${recoveryNote}${resumeGuidance}${attentionNote}${foregroundNote} Completion/control events have been observed; inspect status if a notification is not visible yet.`,
			(deps.failOnFailedRuns === true && failedAsyncCount > 0) || (deps.failOnAttention === true && relevantAttention.length > 0),
```

### deathbeam/pi-packages

`@deathbeam/pi-delegate` repeats end-turn guidance both in prompt guidelines and in the actual launch receipt. It explicitly bans even no-op bash calls whose only purpose is waiting. Its named management tools are steer/cancel, not a result-collecting wait in this quoted contract. A guard against third-party ask is **unknown**.

[packages/pi-delegate/index.ts:334–341](https://github.com/deathbeam/pi-packages/blob/452a9062f845e7fafaf9c16f18db1e22a5aa0442/packages/pi-delegate/index.ts#L334-L341) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        return {
            content: [
                {
                    type: "text" as const,
                    text: `${prior ? "Revived" : "Started"} delegate "${job.agent}" in the background (job ${job.id}). Steer it with delegate_steer or stop it with delegate_cancel. Do not call tools solely to wait, even no-op bash commands; when its report is your next dependency, end your turn and it will arrive automatically unless cancelled.`,
                },
            ],
            details,
```

[packages/pi-delegate/index.ts:451–458](https://github.com/deathbeam/pi-packages/blob/452a9062f845e7fafaf9c16f18db1e22a5aa0442/packages/pi-delegate/index.ts#L451-L458) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        promptGuidelines: [
            "You are the orchestrator, and delegating is your default: plan, split the work, brief delegates, and integrate their reports. Delegation is authorized; do not wait for the user to ask. Your context is the scarce resource: everything you read stays in it, is re-sent with every later request, and brings compaction closer. A delegate works in a fresh context, often on a cheaper model, and returns only its report.",
            "Delegate exploration, research, implementation beyond a small edit, build/test/debug loops, and reviews. Work directly only for reading one known file or the lines you are about to edit, one targeted search, a small edit (about 30 lines in one file), a quick verification (one test run or one cited line), or a command the user asked you to run. Shell one-liners and scripts that search or read code count as exploration, not quick commands.",
            "Your failure mode is drifting into doing the work yourself, one quick search at a time. Decide what to delegate before your first exploratory call; if one targeted search does not settle it, delegate the rest.",
            "Start every independent delegate before waiting on any, ideally in one message. Trust reports instead of repeating their searches; check only what you act on. If a report falls short, delegate a follow-up that names the gap instead of redoing the work yourself.",
            "While delegates run, stay outside their scopes. When a report is the next dependency, end your turn with a brief waiting status. Completion will wake you.",
            "Read every required delegate report before claiming the task is done. Never sleep, poll, or call any tool solely to wait (including `bash` with `true`, `echo`, or `sleep 0`). Use delegate_list only for a one-time status check.",
        ],
```

### ByteTrue/pi-package-mono

`@bytetrue/pi-subagent` uses the same replacement action in all three surfaces: description, guidelines, and immediate receipt. Status is explicitly one-off and says not to poll, but exposes the child log for full behavioral history. That exposure is not itself a second *final report* request. A blocking collector or external-ask guard is **unknown**. Its adjacent shell background tool explains in a source comment why a bare no-poll rule was insufficient (implementation author's observation, not a benchmark of GPT).

[packages/pi-subagent/src/index.ts:2035–2044](https://github.com/ByteTrue/pi-package-mono/blob/4255e2fa2ae7613d019cc0542c7c3f3282130b0e/packages/pi-subagent/src/index.ts#L2035-L2044) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    description: `Delegate ONE self-contained task to an isolated child agent session. Omit 'agent' for a plain child: it inherits your model, thinking level, and pi's default tools (read, bash, edit, write), and no role prompt is added — any self-contained job you would otherwise do inline fits. Pass 'agent' when a role's trigger description below matches the job; roles from .pi/agents/ (project or user) are picked up automatically:\n\n${roster}\n\nThe call returns at once with a task id; the full result arrives later as a new message that starts your next turn — until then, continue with other work or end your turn. To run several tasks at once, make multiple subagent calls in the same message; use subagent_status to check one and subagent_stop to stop one. Supports session resumption.`,
    promptSnippet:
      "Delegate a self-contained job to a child agent — a plain child by default, or a roster role from the tool description when its trigger matches; the call returns at once and the result arrives later as a new message.",
    // Positive-first wording (decision 001): state the wait model instead of only forbidding polling.
    promptGuidelines: [
      "Delegate any self-contained job to subagent so you stay free to keep working or hand control back to the user",
      "Omit 'agent' for a plain child (inherits your model, thinking level, and default tools); pass 'agent' when a roster role's trigger description matches the job — e.g. 'reviewer' for an independent adversarial review",
      "After a subagent starts, continue with other work or end your turn; its complete output arrives as a new message that starts your next turn",
    ],
    parameters: {
```

[packages/pi-subagent/src/index.ts:2178–2183](https://github.com/ByteTrue/pi-package-mono/blob/4255e2fa2ae7613d019cc0542c7c3f3282130b0e/packages/pi-subagent/src/index.ts#L2178-L2183) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        content: [
          {
            type: "text",
            text: `Subagent started (ID: ${taskId}). Its full result will arrive as a new message — continue with other work or end your turn now.`,
          },
        ],
```

[packages/pi-subagent/src/index.ts:2210–2214](https://github.com/ByteTrue/pi-package-mono/blob/4255e2fa2ae7613d019cc0542c7c3f3282130b0e/packages/pi-subagent/src/index.ts#L2210-L2214) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "Check one subagent task by id: status, elapsed time, current activity (running tool, turns, token/cost, model), recent tool calls, and the child session log path — read that file for the full model behaviour history. The full result is reported automatically as a new message when the task completes, so don't poll.",
    promptSnippet: "Check one subagent task.",
```

[packages/pi-background-terminal/src/tools/background-run.ts:59–67](https://github.com/ByteTrue/pi-package-mono/blob/4255e2fa2ae7613d019cc0542c7c3f3282130b0e/packages/pi-background-terminal/src/tools/background-run.ts#L59-L67) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    description: `Starts a shell command in the background and returns immediately with a task id; the command keeps running on its own. Use it for work that should run hands-off — builds, test suites, dev servers, watch mode. When you need the output to decide your next step, use bash instead. After it starts, continue with other work or end your turn: its exit — natural, failed, or timed-out — arrives as a new message that starts your next turn. That notification is how you wait. The command is hard-killed after timeout seconds (default ${DEFAULT_LIFETIME_SECONDS}, hard cap ${HARD_CAP_LIFETIME_SECONDS} — larger values are clamped). A dev server that hits the cap is renewed by restarting it with background_run; the timeout notification tells you when. Full output streams to a file (path in the result); use read on that path.`,
    promptSnippet: `Start a command in the background; its exit arrives later as a new message. Use bash when you need the result now.`,
    // Positive-first wording (decision 001): each line says what to do; the wait model is stated
    // explicitly because a bare "do not poll" left a vacuum the model filled with `sleep`.
    promptGuidelines: [
      "Use background_run for work that should run hands-off — builds, test suites, dev servers, watch mode — anything you can leave running while you do other things",
      "When you need a command's output to decide your next step, use bash — it blocks and returns the output",
      "After background_run returns, the command is already running: continue with other work or end your turn. Its exit arrives as a new message that starts your next turn — that notification is how you wait. background_status is for a one-off look at partial output",
      `timeout is a hard lifetime cap (default ${DEFAULT_LIFETIME_SECONDS}s, hard cap ${HARD_CAP_LIFETIME_SECONDS}s — larger values are clamped); pass a larger value for dev servers and watch modes, and restart with background_run when the timeout notification arrives to renew them`,
```

### prjct-app/pi-subagents

The parent receipt says results wake an idle session and to continue or end the turn. Another launch path explicitly says not to ask again for the same work. Its status interface incorporates a bounded wait when there is nothing new, rather than requiring a polling loop. These are wording/shape restrictions, not verified interception of a separate mail provider.

[src/index.ts:621–626](https://github.com/prjct-app/pi-subagents/blob/9020f8e1dbe4ff1887b16d206a3b1c837527d09b/src/index.ts#L621-L626) (verbatim source string/template; concatenation and placeholders are retained):

```ts
          content: [{
            type: 'text' as const,
            text: `${job.name} (${job.agent ?? job.role}) is on "${job.subject}", using ${modelKey(job.provider, job.modelId)}, `
              + `${job.workspace ? `working in external snapshot ${job.cwd}; proposed changes will be written to ${job.patchFile}` : `reading ${job.cwd}`}. `
              + 'Its report arrives here when it ends. Carry on; do not wait for it, and do not ask again for the same work.',
          }],
```

[src/index.ts:681–685](https://github.com/prjct-app/pi-subagents/blob/9020f8e1dbe4ff1887b16d206a3b1c837527d09b/src/index.ts#L681-L685) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    label: 'Delegated jobs',
    description: 'The subagents this session started. A job that came back blocked is open work you own. '
      + 'result: full evidence. steer: guide a live job. resume: continue a retained one. resolve: mark its blockers handled. '
      + 'purge: forget finished jobs (jobId for one). Reports arrive by themselves: never poll status; '
      + `one with nothing new waits up to ${STATUS_WAIT_MS / 1000}s, then end your turn. Messages: plain, simple English.`,
```

[src/index.ts:743–748](https://github.com/prjct-app/pi-subagents/blob/9020f8e1dbe4ff1887b16d206a3b1c837527d09b/src/index.ts#L743-L748) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        return {
          content: [{
            type: 'text' as const,
            text: `No change since your last check; ${ledger.jobs.filter(job => !isTerminal(job.state)).length} still running after a ${Math.round(waitMs / 1000)}s wait. `
              + 'Their reports arrive here by themselves and wake this session when it is idle, so do not poll. '
              + 'Continue your own work, or end your turn if nothing else is left.',
```

### championswimmer/pi-subagent-manager

Offers `agent_wait`, foreground `agent_spawn`, and detached `wait:false` spawn. Its injected parent policy distinguishes orchestration mode (NEVER call wait; end turn) from opportunistic mode (wait only for needed same-turn results; do not immediately wait on long-running background children). The description tells detached callers not to poll but the wait description says “poll status or wait again” after cancellation/timeouts: this is conditional guidance, not a uniform anti-poll contract. `agent_output` is an explicitly authorized full-result retrieval path; a completion event is not necessarily the full report. Wait-versus-push suppression and a mail-ask block are **unknown**.

[src/orch/prompt.ts:15–25](https://github.com/championswimmer/pi-subagent-manager/blob/092627be6f3696b3897767d896ef7309c01e48ca/src/orch/prompt.ts#L15-L25) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  const waitingPolicy =
    settings.subagentMode === "orchestration"
      ? "As an orchestrator, you must NEVER be blocked waiting for subagents. ALWAYS start every subagent in async/background mode with wait:false, even for small or sequential tasks. NEVER call agent_wait or use a foreground spawn. End your turn after assigning work so you remain free to talk to the user while subagents work. Check agent_status and collect available results with agent_output without blocking; if results are not ready, report that and leave the conversation free."
      : "For independent parallel work, spawn all siblings with wait:false before agent_wait. Only await synchronous tasks whose results are needed in the current turn. For long-running tasks, create background agents with wait:false and do not immediately call agent_wait; end your turn so you remain free to talk to the user while they work. Await background results when the user asks you to collect them.";
  return [
    "## pi-subagent",
    "You are /root, the main conversation (L1).",
    policy,
    "Call agent_types before choosing a type. Use task-based kebab-case paths, not type names. Choose context via agent_spawn path: /root/task forks the lexical parent's conversation; /task starts fresh with no inherited history. Use fresh agents for adversarial review or clean-slate research; give them a self-contained task without the current thread's conclusions.",
    waitingPolicy,
    'Use agent_status to inspect and agent_output for full results. Completion, failure or stop of a wait:false agent is delivered to you as a message event that starts a new turn when you are idle (with Final Recap on, once after all outstanding async agents have finished). Pass timeoutMs to agent_spawn to get a status event if a child runs long; the child is not killed. Valid range 30000–300000 ms; omit for no timeout. To extend a running background agent\'s reporting timer, before or after a timeout event, call agent_steer({path: "/root/task", timeoutMs: 120000}) with message omitted entirely. This resets the timer from now (replacing any pending timer), without sending input, interrupting or resuming the agent; it requires the agent to still be running. After re-arming, end your turn to remain available while it works. For other timeout responses, follow the waiting policy above, send steering input or stop the agent.',
```

[src/orch/tools.ts:80–85](https://github.com/championswimmer/pi-subagent-manager/blob/092627be6f3696b3897767d896ef7309c01e48ca/src/orch/tools.ts#L80-L85) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      },
    ),
    make(
      "agent_spawn",
      "Spawn a named child. The lexical parent, NOT the caller, supplies a context snapshot. /root is the main thread; independent roots have no inherited context. Foreground waits by default; wait:false runs detached: when it completes, fails or is stopped, you receive a message event that wakes you, so do not poll. Optional timeoutMs (30000–300000; none if unset): if the child is still running after that many ms you receive an event with its status, elapsed time, tokens and recent output (the child is NOT stopped; you decide whether to wait, steer, stop it or re-arm with agent_steer timeoutMs). For parallel work, spawn every independent sibling with wait:false before calling agent_wait; child agents with delegation tools should do the same. Existing paths are retained and can be resumed with agent_steer. Use agent_types to discover current types.",
      Type.Object({
```

[src/orch/tools.ts:102–107](https://github.com/championswimmer/pi-subagent-manager/blob/092627be6f3696b3897767d896ef7309c01e48ca/src/orch/tools.ts#L102-L107) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      async (params, signal) => result(compact(await threads().spawn(params, signal))),
    ),
    make(
      "agent_wait",
      "Wait for a descendant to complete, fail, stop or pause. Paused means no final answer handback. Cancellation/timeouts do not stop the child; poll status or wait again.",
      Type.Object({
```

### tintinweb/pi-subagents

Parent guidelines prohibit polling/sleeping and say to continue other work. `get_subagent_result({wait:true})` is a real blocking collector. Crucially its tool description says the push carries **only a preview**, so fetching the full result is intended, not necessarily duplicate report delivery. A terminal collect sets `resultConsumed` and cancels the outbox entry; cancellation of a wait leaves the child running/unconsumed so it can still notify. This is internal delivery ownership, not a ban on arbitrary asks.

[src/index.ts:1755–1760](https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L1755-L1760) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
```

[src/index.ts:2962–2978](https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L2962-L2978) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  // ---- get_subagent_result tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
```

[src/index.ts:2991–3004](https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L2991-L3004) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }
```

[src/index.ts:3033–3038](https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L3033-L3038) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        outbox.cancel(record.id);
      }

```

### gotgenes/pi-packages

The friendly fork offers `get_subagent_result({wait:true,timeout})`. Its description permits blocking collection and discourages simply re-waiting if no progress changed. The collector claims delivery before awaiting, marks a settled result consumed, and releases the claim if interrupted. The push notifier skips claimed/consumed records. Thus it stops its own **second transport delivery** structurally, while still allowing status/history retrieval; this is not an external mail-ask filter.

[packages/pi-subagents/src/tools/get-result-tool.ts:193–204](https://github.com/gotgenes/pi-packages/blob/806a5a73afeb50142c3963e185ac6101bc1aa18a/packages/pi-subagents/src/tools/get-result-tool.ts#L193-L204) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			modelName: modelLabel(record.model),
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"Check status and retrieve results from a background agent.",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background. " +
```

[packages/pi-subagents/src/tools/get-result-tool.ts:211–228](https://github.com/gotgenes/pi-packages/blob/806a5a73afeb50142c3963e185ac6101bc1aa18a/packages/pi-subagents/src/tools/get-result-tool.ts#L211-L228) (verbatim source string/template; concatenation and placeholders are retained):

```ts
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
				timeout: Type.Optional(
					Type.Number({
						description:
							"Seconds to wait when wait is true (optional, no default: wait until the agent finishes). " +
							"An expired wait does not stop the agent; if its progress is unchanged since your last check, do not simply wait again.",
					}),
```

[packages/pi-subagents/src/tools/get-result-tool.ts:112–132](https://github.com/gotgenes/pi-packages/blob/806a5a73afeb50142c3963e185ac6101bc1aa18a/packages/pi-subagents/src/tools/get-result-tool.ts#L112-L132) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		// this call's claim. So the report carries that outcome, not the live run's.
		// Consumption is record-wide and now belongs to the resumed run, so it is
		// not marked here; doing so would silence a background resume's nudge.
		if (params.wait === true) {
			// Waiting commits this call to delivering the outcome, so claim it before
			// the agent can settle and be announced by the nudge instead.
			const claim = record.claim();
			const bound = params.timeout === undefined ? undefined : new WaitBound(signal, params.timeout);
			try {
				const wait = await record.waitUntilSettled(bound?.signal ?? signal);
				if (wait.kind === "settled") record.markConsumed();
				else claim.release();
				if (wait.kind === "superseded") return { superseded: wait.outcome };
				if (wait.kind === "unsettled" && bound?.expired) return { waitExpiredAfter: params.timeout };
			} finally {
				bound?.dispose();
			}
		} else if (!record.isActive()) {
			record.markConsumed();
		}
		return {};
```

[packages/pi-subagents/src/observation/notification.ts:244–259](https://github.com/gotgenes/pi-packages/blob/806a5a73afeb50142c3963e185ac6101bc1aa18a/packages/pi-subagents/src/observation/notification.ts#L244-L259) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    // The session is gone. It is the aborts fired during shutdown that reach
    // here, and with no parent run active a nudge would go straight out as an
    // unrecallable followUp.
    if (this.disposed) return;
    // A carrier has committed to delivering this outcome, so announcing it would
    // duplicate a delivery the parent is already getting. Structural and decided
    // at the parent's request, so unlike the consumption check below it cannot
    // race the turn.
    if (record.claimed) return;
    // Consumption is domain state on the record; the nudge is a pure
    // announcement. Skip if the parent already pulled the result (enqueue-time
    // guard); emitIndividualNudge re-reads record.consumed when the nudge is
    // actually emitted, which is what makes the flush a fresh re-check.
    if (record.consumed) return;
    if (this.parentRunActive) {
      this.withholdCompletion(record);
```

### bermudi/pi-delegate

Offers `delegate_ticket` poll/wait and synchronous `async:false`. Prompt guidelines say results arrive themselves and to wait only if blocked. The terminal view returned by poll/wait is fingerprinted as consumed, and the delivery flush drops a wake that would repeat that same view. It does not prohibit every inspection; it deduplicates its own push and pull paths. An external ask block is **unknown**.

[delegate.ts:1576–1579](https://github.com/bermudi/pi-delegate/blob/9474efa5a8e15e1808995ddc466de27c19e7d87e/delegate.ts#L1576-L1579) (verbatim source string/template; concatenation and placeholders are retained):

```ts
          "Subagents cannot delegate further — plan the full fan-out yourself; ask_parent is a worker's only escalation.",
          "Only a subagent's final message comes back: name the answer shape you need (file list, yes/no, short verdict) so reports stay short.",
          "Async results arrive on their own at your next step — do not poll in a loop; wait only when blocked on a ticket's result.",
          'Parallelize reads freely — read-only tasks (explore) admit concurrently beside anything. Before dispatching 2+ write-capable tasks to one repo in a call, pick the shape: independent edits → workspace "isolated" (private worktrees, parallel, merged in task order); dependent edits → dependsOn chain on shared. Same-phase unordered writers reject; overlapping writers in separate calls reject.',
```

[delegate.ts:1791–1796](https://github.com/bermudi/pi-delegate/blob/9474efa5a8e15e1808995ddc466de27c19e7d87e/delegate.ts#L1791-L1796) (verbatim source string/template; concatenation and placeholders are retained):

```ts
                      (briefNote(call.brief) !== undefined
                        ? `${briefNote(call.brief)}\n`
                        : "") +
                      `Results arrive on their own at your next step; wait only when blocked on them. ` +
                      `delegate_ticket can wait on or cancel it if needed (action "wait" / "cancel").` +
                      (ticket.notices.length > 0
```

[delegate.ts:1906–1912](https://github.com/bermudi/pi-delegate/blob/9474efa5a8e15e1808995ddc466de27c19e7d87e/delegate.ts#L1906-L1912) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        name: "delegate_ticket",
        label: "Delegate Tickets",
        description:
          "Inspect or control background delegate work. poll returns status immediately; wait returns on settlement or a new worker question/interruption. cancel previews unless force:true. answer replies to a worker question; steer sends instructions at turn boundaries; interrupt stops a turn while retaining its transcript. Results arrive at your next step on their own — wait only when blocked on one.",
        parameters: Type.Unsafe<TicketToolArguments>(ticketSchema),
        promptSnippet:
          "Inspect, wait, cancel, answer, steer or interrupt background delegate work",
```

[delegate.ts:1939–1953](https://github.com/bermudi/pi-delegate/blob/9474efa5a8e15e1808995ddc466de27c19e7d87e/delegate.ts#L1939-L1953) (verbatim source string/template; concatenation and placeholders are retained):

```ts
          // SPEC v3 "Wake delivery": a wait/poll that returned the
          // ticket's terminal view has already shown the model its
          // content — record the fingerprint so the flush drops a wake
          // that would only repeat it.
          if (
            (call.action === "poll" || call.action === "wait") &&
            result.consumedView !== undefined &&
            result.ticket !== undefined
          ) {
            delivery.noteConsumed(
              result.ticket.id,
              call.action === "poll" ? "poll" : "wait",
              result.consumedView,
            );
          }
```

### mavam/pi-agents

Offers `agent_wait` but interactive parent guidance says end the turn unless this turn must combine results. Its headless prompt explicitly says to wait before answering because agents pause when the run ends. The service wait **takes results instead of their delivery**, recording them delivered when the parent holds the tool result; an interrupted wait leaves agents running and says results arrive as messages. This solves its own dual collector/push path, not arbitrary separate child conversations.

[src/pi/prompt.ts:14–20](https://github.com/mavam/pi-agents/blob/a99f4ed8f1b07ee8ad43c564b9ce82e85064ec00/src/pi/prompt.ts#L14-L20) (verbatim source string/template; concatenation and placeholders are retained):

```ts
/** When results arrive, in a session that goes on after your turn. */
const ONGOING =
  "Agents work in the background, and their results arrive on their own as messages that start a new turn. After starting agents, tell the user what you started and end your turn, also when nothing else is left to do, or continue with work that doesn't need the results. Call agent_wait only when this turn must combine results, as a codemode script that aggregates them does.";

/** When results arrive, in a run that ends with your answer. */
const SINGLE_SHOT =
  "This run ends with your answer, and agents still working then pause, so call agent_wait for the results you need before you answer.";
```

[src/agents/service.ts:498–509](https://github.com/mavam/pi-agents/blob/a99f4ed8f1b07ee8ad43c564b9ce82e85064ec00/src/agents/service.ts#L498-L509) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  /**
   * Wait until the agents are idle and the graphs finished, and return
   * them. The wait takes their results instead of their delivery: when a
   * parent call waits (`carrier`), its result carries them, so they count
   * as delivered once the parent holds that result; otherwise the caller
   * takes them, and they count at once. Successful answers with no parent
   * request have no delivery; the wait consumes them at once. Aborting
   * `signal` ends only the wait, and so does the parent's attention:
   * either throws `WaitInterrupted`.
   */
  async wait(names: string[], options: WaitOptions = {}): Promise<WaitOutcome> {
    return this.waitFor(
```

[src/pi/tools.ts:342–346](https://github.com/mavam/pi-agents/blob/a99f4ed8f1b07ee8ad43c564b9ce82e85064ec00/src/pi/tools.ts#L342-L346) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        },
        content: steered
          ? "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages."
          : "Stopped waiting. The agents keep working.",
        details: {
```

### KristjanPikhof/pi-agents-team

Different shape: the injected default orchestrator notes demand `wait_for_agents` after `delegate_task`, forbid ping/sleep polling, and explicitly say completion toasts are UI-only. It discourages repeating `agent_result` once the summary has been received. This is not evidence that a blocking wait is required for an extension that already pushes a model-visible final report.

[src/config.ts:287–294](https://github.com/KristjanPikhof/pi-agents-team/blob/6285b63485f1c536e1b30eea42b23eb8e20d7c91/src/config.ts#L287-L294) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		systemPromptNotes: [
			"The visible Pi session is the orchestrator and owns all user-facing dialogue; workers are subordinate RPC peers that report compact summaries.",
			"Answer directly only for trivial, already-known, or tiny bounded asks; delegate investigation, review, mapping, and multi-file work.",
			"When the user asks for N workers or parallel analysis, spawn them immediately in one batch — do not pre-explore the repo yourself first.",
			"After delegate_task, call wait_for_agents until workers finish; do not poll with ping_agents or sleep in bash.",
			"Worker completion toasts (✓ ...) are UI-only; ignore them and do not re-call agent_result after you already have the summary.",
			"agent_result is authoritative: synthesize from its <final_answer>; if empty, re-delegate smaller slices or steer the worker, not your own tools.",
			"Before non-trivial reuse, inspect worker usage: reuse normally below 50%, cautiously from 50-70%, prefer fresh above 70%, and spawn fresh at/above 80% context or at/below 32768 remaining tokens.",
```

### hheei/hepi-mono

The subagents prompt tells the parent to do independent work or end the turn and prohibits get/list polling, sleeping, waits, and tailing logs for completion. Despite a generic `wait_jobs` tool, it says **do not use it to wait for subagent reports**. Healthy subagents already report and close. Direct result reading remains possible when explicitly needed; wait/push suppression is **unknown**.

[packages/pi-subagents/src/tool-activation.ts:22–29](https://github.com/hheei/hepi-mono/blob/c6d2318688bd0132b70598d2ebc3edb4cfde45eb/packages/pi-subagents/src/tool-activation.ts#L22-L29) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export const USAGE_GUIDE = [
	"Reuse an existing subagent via send_agent for related work. Inspect available definitions and owned children with list_agents before creating a new child; use get_agent for current identity or state.",
	"Spawn a new agent only when a distinct role or fresh context is needed. Idle children consume no compute and do not need to be frozen, paused, or stopped before other work starts.",
	"send_agent can resume done, blocked, errored, or stopped children with their session context. After an error, retry send_agent or create a new child with spawn_agent; neither guarantees recovery. A previous runtime must be confirmed stopped before starting a replacement.",
	"Child results arrive automatically as subagent-report messages, including while you work on other tasks. After spawn or send, do independent work or end your turn. Do not poll get_agent or list_agents, sleep, wait, or tail session/log files to detect completion. Do not fabricate or summarize results before a report arrives.",
	"Background job controls may become available when a task starts. Subagent task ids use the same agent-X format returned by spawn_agent, for example agent-1. Do not use wait_jobs to wait for subagent reports: healthy subagents report automatically and close themselves. wait_jobs is optional and only for directly reading a result when needed; stop_jobs is optional and only for explicitly terminating a job that should not continue. Use stop_agent to end a child runtime intentionally.",
].join("\n");

```

[packages/pi-ext-tools/src/task-tools.ts:181–186](https://github.com/hheei/hepi-mono/blob/c6d2318688bd0132b70598d2ebc3edb4cfde45eb/packages/pi-ext-tools/src/task-tools.ts#L181-L186) (verbatim source string/template; concatenation and placeholders are retained):

```ts
	const waitTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "wait_jobs",
		label: "wait_jobs",
		description:
			"Wait until every listed background job finishes (timeout: 1800s) and return their results directly. Do not poll background jobs. Use this only when the next step needs their results.",
		parameters: IdsParams,
```

### fitchmultz/pi-subagents

Explicit guidance appears in the primary tool's prompt, detached launch receipt, and running status result: end turn rather than poll; foreground chosen only explicitly. Status remains for diagnosis/blocked or stale runs. A foreground continuation released for incoming Intercom says completion will arrive automatically. It even advertises blocking Intercom `ask` for a genuinely blocked child, which is evidence that a blanket “never ask your child anything” rule would be broader than this design. Third-party mail-ask interception is **unknown**.

[src/extension/primary-tool.ts:20–22](https://github.com/fitchmultz/pi-subagents/blob/d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e/src/extension/primary-tool.ts#L20-L22) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export const SUBAGENT_GUIDELINES = [
  "Use subagent for materially parallelizable scouting, review, or implementation work where another focused agent adds value.",
  "Top-level subagent execution uses the stock async default unless configuration opts out. Launch a small bounded fanout of independent agents as separate single-agent runs so each completion wakes the parent, with at most one writer. Use one tasks call for non-review fanout when all child results are required together, when shared concurrency/task limits are needed, or when multiple writers require worktree isolation; the parent receives one aggregate completion. If no useful parent work remains, end the turn and wait instead of polling; completion wakes the parent. This also applies when an incomplete active Pi goal needs child evidence: yield, then continue the goal after automatic completion delivery. Set async:false only for explicitly chosen foreground execution.",
```

[src/runs/background/async-launch.ts:39–46](https://github.com/fitchmultz/pi-subagents/blob/d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e/src/runs/background/async-launch.ts#L39-L46) (verbatim source string/template; concatenation and placeholders are retained):

```ts
): string {
  return [
    headline,
    "",
    "The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
    "If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
    `Use ${formatRunAction("status", "...", {}, childSafe)} when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.`,
  ].join("\n");
```

[src/runs/background/run-status-contracts.ts:14–15](https://github.com/fitchmultz/pi-subagents/blob/d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e/src/runs/background/run-status-contracts.ts#L14-L15) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export const ASYNC_COMPLETION_REMINDER =
  "Completion will be delivered automatically. If you are only waiting, end your turn instead of polling status again.";
```

[src/runs/foreground/wait-run.ts:278–281](https://github.com/fitchmultz/pi-subagents/blob/d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e/src/runs/foreground/wait-run.ts#L278-L281) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    this.finish({
      status: "yielded",
      text: `Released the wait for an incoming Intercom message. Run ${this.target.runId} is unchanged. Continue useful work or end the turn; completion will arrive automatically.`,
    });
```

[src/runs/shared/subagent-control.ts:297–301](https://github.com/fitchmultz/pi-subagents/blob/d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e/src/runs/shared/subagent-control.ts#L297-L301) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  );
  const ask =
    childIntercomTarget !== undefined && childIntercomTarget !== ""
      ? `Ask (blocking wait only; parent must remain alive): intercom({ action: "ask", to: "${childIntercomTarget}", delivery: "steer", message: "What are you blocked on? Reply with the smallest next step, or state the exact decision you need." })`
      : "Ask (blocking wait only): no child message route registered";
```

### jjuraszek/pi-cohort

The immediate detached receipt has the same clear independent-work/end-turn/no-poll pattern. Status remains an authorized diagnosis path. A separately exposed wait tool and push-consumption interaction are **unknown** in this profile; the quoted receipt does not require one.

[src/runs/background/async-execution.ts:132–137](https://github.com/jjuraszek/pi-cohort/blob/d038341409e8832c67269b34b8a34749b989cef1/src/runs/background/async-execution.ts#L132-L137) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		headline,
		"",
		"The async run is running in the background. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.",
	].join("\n");
```

### heyhuynhgiabuu/pi-task

Background is default; `background:false` waits inline. Both the tool-description builder and receipt constants say results arrive automatically and prohibit polling tasks/session files. A separate post-launch wait tool or external ask block is **unknown**. The package-owned task skill further spells out independent work/end reply, but runtime strings are sufficient evidence here.

[src/helpers.ts:218–221](https://github.com/heyhuynhgiabuu/pi-task/blob/7eb559a5f82138760e1ff676b3d6f7f7e042f919/src/helpers.ts#L218-L221) (verbatim source string/template; concatenation and placeholders are retained):

```ts

Not for: file/symbol lookups, 2-3 file edits, or no matching agent.

Summarize the child result for the user; verify writer changes. Parallelize independent tasks; don't duplicate work. Background by default; background false waits inline. Results arrive automatically: do not poll tasks or session files. Read the task skill for detailed handoffs and examples when available.`;
```

[src/constants.ts:5–9](https://github.com/heyhuynhgiabuu/pi-task/blob/7eb559a5f82138760e1ff676b3d6f7f7e042f919/src/constants.ts#L5-L9) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export const MAX_POLL_ERRORS = 3; // consecutive poll failures before giving up on a task
export const TASK_BACKGROUND_RECEIPT_GUIDANCE =
  "The result is delivered automatically when ready; do not poll this task or its session file.";
export const COMPARISON_BACKGROUND_RECEIPT_GUIDANCE =
  "Results are delivered automatically when both tasks finish; do not poll either task or their session files.";
```

[src/lifecycle/durable-execution.ts:93–99](https://github.com/heyhuynhgiabuu/pi-task/blob/7eb559a5f82138760e1ff676b3d6f7f7e042f919/src/lifecycle/durable-execution.ts#L93-L99) (verbatim source string/template; concatenation and placeholders are retained):

```ts

export function formatDurableBackgroundReceipt(id: string): string {
  return [
    `Task ${id} is running on the durable backend.`,
    "Its work is committed to durable storage: if this Pi process dies, the next one resumes and delivers the result.",
    "Results are delivered automatically; do not poll.",
  ].join("\n");
```

### zachwill/pi-orchestrate

`orchestrate` returns acceptance, then a separate result. Its status guideline says completion polling is unnecessary and reserves status for diagnostics/recovery. The injected parent contract groups same-response dispatch calls and resumes once the group finishes, allowing other tools alongside. No wait tool appears in the orchestration tool registration reviewed (`orchestrate`, status, interactive send/interrupt/close); an external mail block is **unknown**.

[extension/pi/tools.ts:105–113](https://github.com/zachwill/pi-orchestrate/blob/2800564bdee2785b694c857af09e5bd780955250/extension/pi/tools.ts#L105-L113) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Start a background assignment. Choose a catalog name with worker, name the assignment with title, and give the complete brief in instructions. Returns a worker_id for follow-up and controls; the result arrives separately.",
    promptSnippet: "Start a background worker with a complete assignment brief",
    promptGuidelines: [
      "Workers receive your instructions, not your conversation. Include the goal, relevant context, owned paths, and expected result.",
    ],
    executionMode: "parallel",
```

[extension/pi/tools.ts:129–145](https://github.com/zachwill/pi-orchestrate/blob/2800564bdee2785b694c857af09e5bd780955250/extension/pi/tools.ts#L129-L145) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      const readable = acceptedRunSummary(acceptedRun);
      return readableToolResult(
        `Accepted ${JSON.stringify(params.title)} as ${readable.worker_id}. Results will arrive automatically.`,
        readable,
      );
    },
  });

  pi.registerTool({
    name: "worker_status",
    label: "Worker Status",
    description:
      "Inspect the worker catalog and this session's workers for diagnostics or recovery. Includes worker IDs, configuration, current state, latest outcomes, and available transcript paths.",
    promptSnippet: "Recover worker IDs and inspect configuration, state, and outcomes",
    promptGuidelines: [
      "Use worker_status to investigate unexpected state or recover missing information. Results arrive automatically, so completion polling is unnecessary.",
    ],
```

[extension/parent/contract.ts:114–119](https://github.com/zachwill/pi-orchestrate/blob/2800564bdee2785b694c857af09e5bd780955250/extension/parent/contract.ts#L114-L119) (verbatim source string/template; concatenation and placeholders are retained):

```ts
### Dispatch and dependencies

- \`orchestrate\` and \`interactive_send\` return acceptance while work continues in the background. The worker’s result arrives separately. Calls to these tools in the same response form one result group, which resumes you once the group has finished. Other tool calls can run alongside dispatches without joining the result group.
- After dispatch, continue useful independent work. When you need worker results and have no useful independent work left, send a brief pending response without tool calls. This lets automatic result delivery resume you.
- Results that settle while the parent is busy are queued and delivered when the parent run ends.
- Compaction does not stop workers. Pick up existing assignments from the live worker context, which shows current activity and ready interactive sessions. Use \`worker_status\` to recover missing IDs or diagnose unexpected state. Completion arrives automatically, so polling is unnecessary.
```

### boadij/pi-herdsman

The parent Agent-controller guidance explicitly prohibits status requests, sleep and other waiting mechanisms, says results/attention resume automatically, and distinguishes a bounded diagnostic read for stale-health attention from polling. A blocking collector and its push interaction are **unknown** here; this wording is stronger than merely announcing a later message.

[extension/agent-controller.ts:701–705](https://github.com/boadij/pi-herdsman/blob/0dc62d39b63afe2d273d687b9e49e7114f2fcfa3/extension/agent-controller.ts#L701-L705) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  "Use list_agents when fresh Agent state or ownership is materially needed for a control or recovery decision, or to refresh the definition roster; do not use it for progress polling. " +
  "Follow current available_tools and revalidation: steer_agent queues a cooperative correction for Pi to deliver after the current assistant turn and its tool calls reach a steering boundary; it does not preempt the current operation. interrupt_agent cancels the current operation and replaces its direction. " +
  "Use reply_agent only to answer that Agent's exact pending ask_owner question. close_agent destructively closes an eligible Agent generation. inspect_agent provides bounded live terminal/process evidence; read_agent_transcript provides bounded persisted conversation/tool evidence. " +
  "When Agent work is unresolved, handle required control, then continue only necessary work you still own or end the turn without concluding; results or attention resume the session automatically. Do not poll with status requests, sleep, or other waiting mechanisms. " +
  "Stale health attention is diagnosis, not progress polling: use attached evidence first and, when absent or insufficient, perform at most one bounded diagnostic read before passive waiting. A repeated reminder for the same stale episode is additional recovery evidence: unchanged qualifying activity means the Agent has not crossed an execution boundary since the previous reminder. A steer queued during that unchanged episode cannot have taken effect yet. Do not repeat diagnostic reads solely because a reminder fired. Continue waiting only while existing evidence still positively supports a legitimate long-running operation; otherwise use interrupt_agent to stop the current operation and continue the same assignment. " +
```

### ismailsaleekh/pi-background-tasks

`bg_delegate` intentionally pushes a **terminal notification**, then requires `bg_result` to retrieve the answer. That second fetch is part of the contract, unlike pi-squire's full-report push. If the result is not ready it tells the parent to end the turn and wait for the notification. A no-poll rule does not imply never reading result artifacts after notification. Dedicated delegate wait/push suppression is **unknown**.

[src/delegate-extension.ts:508–514](https://github.com/ismailsaleekh/pi-background-tasks/blob/799182ff65d7040732aea23b2001ea860b688531/src/delegate-extension.ts#L508-L514) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      'Use bg_delegate when work should continue in the background and the worker needs what you already know: it is seeded with a projection of this conversation.',
      'The prompt is authoritative. State exactly what you want investigated and what the answer should contain.',
      'The delegate is inspect-only at the model-visible tool boundary: it can read, search, and list files, but cannot run shell commands, edit or write files, use the network, or delegate further.',
      'Extension discovery is isolated by default. Use extensionMode:"ambient" only when the pinned provider is registered by an ambient user/project extension.',
      'Ambient mode executes arbitrary discovered extension code in the child process. Tool allowlists do not sandbox extension code, so ambient mode weakens inspect-only process isolation.',
      'Facts that exist only inside omitted tool output are not available to the delegate. Restate such findings in the prompt.',
      'bg_delegate returns immediately. Do not poll; retrieve the answer with bg_result after the terminal notification arrives.',
```

[src/delegate-extension.ts:761–766](https://github.com/ismailsaleekh/pi-background-tasks/blob/799182ff65d7040732aea23b2001ea860b688531/src/delegate-extension.ts#L761-L766) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      'Retrieve a hash-verified result from a bg_delegate or background Fusion task. Never blocks: a running task returns a typed not-ready result. Oversized answers are never truncated.',
    promptSnippet: 'Retrieve the verified answer from a completed delegate or Fusion task',
    promptGuidelines: [
      'Call bg_result once the delegate or Fusion terminal notification has arrived. It never blocks and must not be polled.',
      'A not-ready result means the task is still running; end the turn and wait for the notification.',
    ],
```

[src/core/common.ts:389–394](https://github.com/ismailsaleekh/pi-background-tasks/blob/799182ff65d7040732aea23b2001ea860b688531/src/core/common.ts#L389-L394) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      automaticWakeEnabled: true,
      text: [
        'Terminal notification: enabled.',
        'Automatic follow-up turn: enabled.',
        'Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.',
      ].join('\n'),
```

### kvidzibo/pi-delegate

A unified `delegate` tool supports launch, background receipt, same-tool jobId wait, timeout:0 peek, wrap and cancel. Its guideline explicitly says use delegate as the only parent-child tool. Quiet/progress-based supervision guidance repeatedly permits waiting; it only says interactive mode *may* inject a completion notice, not that every wait receives a full report twice. Collector/push suppression is **unknown**.

[delegate/index.ts:421–427](https://github.com/kvidzibo/pi-delegate/blob/b196978922e34b0dac77896138699f2ea75a25f5/delegate/index.ts#L421-L427) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		description:
			"Child agent. recon/implement/review/oracle. Model from config. background returns jobId. jobId waits/peeks/wraps/cancels. timeoutMs is wait budget, never kills. Interactive mode may inject a completion notice. Local models share maxLocalConcurrent. No nesting.",
		promptSnippet: "Route isolated work to a named delegate agent. Model comes from config or the model argument.",
		promptGuidelines: [
			"Before each substantial task, assess delegate; use it for isolated child work only when expected speed or quality gain exceeds coordination and validation cost.",
			"Use delegate as the only parent-child tool. One child per call. No nesting.",
			"With delegate, the parent owns decomposition, architecture and security judgment, ambiguity resolution, main implementation, destructive or external actions, integration, final validation and the final answer.",
```

[delegate/index.ts:436–441](https://github.com/kvidzibo/pi-delegate/blob/b196978922e34b0dac77896138699f2ea75a25f5/delegate/index.ts#L436-L441) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			"For 'review loop <model>', call delegate with kind review and the requested model; address findings and review again until none important remain. If blocked, report it rather than substituting a model or claiming a clean review.",
			"delegate background:true returns jobId immediately; the child keeps running.",
			"delegate timeoutMs is a wait budget, never a kill. Foreground expiry auto-backgrounds and returns a short check-in.",
			"With delegate jobId, omit timeoutMs to wait until done or 60s quiet; timeoutMs:0 peeks.",
			"On a nonterminal delegate check-in, inspect current/recent tools and quietForMs. Wait while useful progress continues; silence or wait expiry alone does not prove a stall.",
			"For a suspected delegate stall, request wrap:true once, then wait again in a separate call; allow the current turn/tools and final report time to finish.",
```

### arhen/pi-extensions

Offers `await_subagent`/`autoAwait`, but says use only for same-turn consumption; otherwise end turn. Its receipt unusually asks for **one startup status check**, then says not to wait. Await can wake for child messages. This is a conditional coordination tool, not a universal recommendation to wait on every pushed result. Collector/push suppression is **unknown**.

[packages/core/pi-core-subagent/src/index.ts:244–247](https://github.com/arhen/pi-extensions/blob/267bbdbc142942f9741ffd21287b94d77a52bb1f/packages/core/pi-core-subagent/src/index.ts#L244-L247) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			"Write agents work in an isolated git worktree; review the branch diff and merge with `git merge --no-ff <branch>` when done.",
			"After spawning, call subagent_status({ runId }) ONCE to confirm the tasks started; fix or respawn a task that died on spawn.",
			"End each task with a runnable check, e.g. 'Verify: bun test'. A subagent's claim of success is not evidence.",
			"When you have no work left, end your turn — completion notifies you. await_subagent/autoAwait only when this turn must consume the result immediately.",
```

[packages/core/pi-core-subagent/src/index.ts:290–295](https://github.com/arhen/pi-extensions/blob/267bbdbc142942f9741ffd21287b94d77a52bb1f/packages/core/pi-core-subagent/src/index.ts#L290-L295) (verbatim source string/template; concatenation and placeholders are retained):

```ts
				content: [
					{
						type: "text",
						text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nNext: call subagent_status({ runId: "${details.run.id}" }) now to confirm the tasks actually started before doing anything else.\nAfter that, completion will notify you — if you have no other work, end your turn instead of waiting.\nOther tools: subagent_result / reply_subagent / steer_subagent / resume_subagent / subagent_cancel.`,
					},
				],
```

[packages/core/pi-core-subagent/src/index.ts:405–409](https://github.com/arhen/pi-extensions/blob/267bbdbc142942f9741ffd21287b94d77a52bb1f/packages/core/pi-core-subagent/src/index.ts#L405-L409) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		name: "await_subagent",
		label: "Await Subagent",
		description:
			"Block until a run finishes (or timeoutMs elapses). Only when you have your own work to sync; otherwise end your turn. Child messages that arrive while parked wake the wait and are returned.",
		parameters: AwaitParam,
```

### nlbwqmz/wj-pi-subagents

A particularly useful shape: `wait_agent` returns **lifecycle state and revision, never report text**, while independent reply/final-report events are separate. The wait can be released by parent input and then explicitly says not to call wait again this turn. Avoiding a second report-bearing path is structural at the API-result shape, rather than asking the model not to use an available report collector. How third-party mail integrates is **unknown**.

[src/agent-tools.ts:91–95](https://github.com/nlbwqmz/wj-pi-subagents/blob/6569131b88ffa38353a951753d9d5b6f0983b28a/src/agent-tools.ts#L91-L95) (verbatim source string/template; concatenation and placeholders are retained):

```ts
 */
export const WAIT_PARENT_INPUT_WOKEN_NOTICE =
  "Released by an incoming message from the parent agent, not by any target event: "
  + "the agents you are waiting for have not finished. The pending message will be delivered "
  + "after this turn's tool calls finish; do not call wait_agent again in this turn.";
```

[src/agent-tools.ts:197–205](https://github.com/nlbwqmz/wj-pi-subagents/blob/6569131b88ffa38353a951753d9d5b6f0983b28a/src/agent-tools.ts#L197-L205) (verbatim source string/template; concatenation and placeholders are retained):

```ts
const descriptions: Readonly<Record<AgentToolName, string>> = Object.freeze({
  get_agent_templates: "List currently discovered and valid subagent templates as a JSON array. Each item includes template_id, optional description, declared business tools, and declared excluded tools. Do not call spawn_agent when the result is [].",
  spawn_agent: "Create a direct child subagent with a valid template_id and complete the startup handshake. Call get_agent_templates first; copy template_id exactly and preserve case. Do not guess, rewrite, or substitute description. Do not call spawn_agent when get_agent_templates returns []. After creation, use send_message to send the first task.",
  send_message: "Send a message or steering to a direct child subagent. accepted: true means only that the receiving accepted this message; it does not mean the model read it, started work, or completed processing. A delivery failure affects only this call and does not change lifecycle state. After receiving accepted: true, the parent agent must treat the task as delivered, must not resend the same task, and must cease any direct work on that scope.",
  wait_agent: "Wait for the next independent reply, final_report, idle, or terminal event from one or more direct child subagents. If a target is already idle, failed, or terminated with no newer event, return its current stable state immediately. The result includes independent lifecycle state and revision, never task results or report text. batch_released is only a tool-call wrapper; timeout ends only this wait. woken with wake_reason parent_input means this wait was released by an incoming message from the parent agent, not by any target event: the targets are still unfinished, and wait_agent must not be called again in that turn.",
  interrupt_agent: "Cooperatively interrupt the active Pi turn of a direct child subagent while preserving its node and context.",
  terminate_agent: "Permanently terminate a direct child subagent and its registered subtree, then confirm resource reclamation. Use only when you are sure the branch will not be reused.",
  get_agent_status: "Read the most recently confirmed safe status snapshot for a direct child subagent.",
  get_agent_tree: "Read the read-only agent tree visible to the current caller.",
```

### pifydev/subagent

Pending tool results directly tell interactive parents not to poll: carry on or finish the turn and be picked back up. It deliberately reverses the advice for headless runs, where no post-turn recipient remains: collect again in the same turn. It offers a bounded collect/wait parameter. This context-sensitive instruction guards against a false automatic-wake promise; external-ask interception and collector/push suppression are **unknown**.

[src/pending.ts:69–96](https://github.com/pifydev/subagent/blob/788513828564d72df3dde07560df60ca4e8cd3a5/src/pending.ts#L69-L96) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export function pendingResult(input: PendingInput): PendingResult {
  const ms = Math.max(0, input.now - input.startedAt);
  const state = input.kind === "queued" ? "queued behind the concurrency cap" : "still running";
  // A headless run has no session to deliver into — it ends when this turn
  // does. Telling the model "do not poll, it will be delivered" there strands
  // it awaiting a message that never comes; it must collect within the turn.
  const headless = input.interactive === false;
  const text = headless
    ? [
        `${input.id} is ${state} (${elapsed(ms)}).`,
        "",
        "This is a headless run: nothing is delivered after your turn ends. Call",
        `${input.collectWith} again in this same turn until it returns the result — do not end`,
        "your turn expecting to be picked back up.",
      ].join("\n")
    : [
        `${input.id} is ${state} (${elapsed(ms)}).`,
        "",
        "Do not poll for it. The result is delivered to you automatically the moment it lands,",
        `so there is nothing to wait for here — carry on with other work, or finish your turn and`,
        `you will be picked back up. ${input.collectWith} is only needed if you want it early.`,
      ].join("\n");
  return {
    text,
    details: { id: input.id, status: input.kind, retryable: true, elapsedMs: ms, pollRequired: headless },
  };
}

```

[extensions/subagent.ts:890–895](https://github.com/pifydev/subagent/blob/788513828564d72df3dde07560df60ca4e8cd3a5/extensions/subagent.ts#L890-L895) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      "for it before answering — useful headless, where nothing is delivered after your turn ends.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id, e.g. reviewer-1" }),
      wait: Type.Optional(
        Type.Number({ description: "Seconds to wait for the run to finish before answering, 0-120 (default 0)" }),
      ),
```

### smithyyang/pi-subagent-lite

Description says not to duplicate delegated work, continue nonoverlapping tasks, receive an automatic follow-up, then **read each output file for the full result**. `async:false` waits inline. Here artifact reading is intentional, not prohibited; the pushed event is insufficient by design. Separate wait/ask controls and collector/push suppression are **unknown**.

[src/index.ts:934–938](https://github.com/smithyyang/pi-subagent-lite/blob/f8459f8ed6cce2a2cb8efc3dc9018c53d0da5a5f/src/index.ts#L934-L938) (verbatim source string/template; concatenation and placeholders are retained):

```ts
USAGE NOTES:
1. Always delegate via tasks[]. Launch multiple subagents concurrently whenever possible by putting multiple items in one tasks[] array.
2. Once you have delegated work to a subagent, do not duplicate that work yourself. Continue with non-overlapping tasks while the subagent runs.
3. When an async batch completes, you will be automatically notified via a follow-up message. Read each output file to get the full result.
4. Each subagent invocation starts with a fresh context. Your prompt should contain a highly detailed task description for the subagent to perform autonomously. Specify exactly what information the agent should write to the output file.
```

[src/index.ts:953–955](https://github.com/smithyyang/pi-subagent-lite/blob/f8459f8ed6cce2a2cb8efc3dc9018c53d0da5a5f/src/index.ts#L953-L955) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			async: Type.Optional(Type.Boolean({
				description: "Run in background (default: true). If false, waits for all subagents to finish before returning.",
			})),
```

### xynogen/pix-mono

`pix-subagent` launch receipt explicitly prohibits polling, sleep-wait and calling `agent_control` just to fetch a normally automatic result. A retrieval tool remains, explicitly for previous results, not waiting/polling; it can return verbose history. Launch also supports `background:false` for inline execution. Collector/push suppression and an external ask guard are **unknown**.

[packages/pix-subagent/src/tools.ts:688–695](https://github.com/xynogen/pix-mono/blob/4aa52bd260d41eab43ac65f7e364928250ee7ab3/packages/pix-subagent/src/tools.ts#L688-L695) (verbatim source string/template; concatenation and placeholders are retained):

```ts
				if (bgRecord) bgRecord.isBackground = true;

				return textResult(
					`Launched ${bgId}. To steer or stop it while it runs: agent_control action:"steer"/"stop". ` +
						`Its result is delivered automatically when it finishes — do NOT poll, sleep-wait, or call agent_control just to fetch it. ` +
						`Stop is gentle by default: the agent summarizes its progress first, so partial work is never lost. Continue with other work or respond to the user.`,
					{
						...detailBase,
```

[packages/pix-subagent/src/tools.ts:835–839](https://github.com/xynogen/pix-mono/blob/4aa52bd260d41eab43ac65f7e364928250ee7ab3/packages/pix-subagent/src/tools.ts#L835-L839) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		label: "Agent Result",
		renderShell: "self",
		description:
			"Retrieve a previous agent result by ID. Results are delivered automatically; do not use this to wait or poll. verbose=true returns full conversation history. turns=N returns only the last N turns — also works for agents stopped or aborted mid-task.",
		parameters: Type.Object({
```

### signalridge/pi-extensions

Parent guideline prohibits polling/sleep and says continue work. It offers `get_subagent_result({wait:true})`; nested agents have a corresponding check/wait tool. The quote does not establish external-ask prohibition or exact-once between pulls/pushes; those are **unknown**.

[packages/pi-subagents/src/index.ts:2594–2599](https://github.com/signalridge/pi-extensions/blob/3ebe4317de18de0a724d88ea7a59e3360d04539b/packages/pi-subagents/src/index.ts#L2594-L2599) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
```

[packages/pi-subagents/src/index.ts:3466–3472](https://github.com/signalridge/pi-extensions/blob/3ebe4317de18de0a724d88ea7a59e3360d04539b/packages/pi-subagents/src/index.ts#L3466-L3472) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        }),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "If true, wait for the agent to complete before returning. Default: false.",
          }),
        ),
```

[packages/pi-subagents/src/nested-tools.ts:383–389](https://github.com/signalridge/pi-extensions/blob/3ebe4317de18de0a724d88ea7a59e3360d04539b/packages/pi-subagents/src/nested-tools.ts#L383-L389) (verbatim source string/template; concatenation and placeholders are retained):

```ts

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
```

### ESSO0428/pi-subagents

Its description says every Agent call is detached and `run_in_background` is compatibility-only; parent should continue other work. It therefore does not expose the ordinary foreground/background choice through that field. Full collector/push interaction and other fetching restrictions are **unknown**.

[src/index.ts:999–1004](https://github.com/ESSO0428/pi-subagents/blob/a9e4c555c4a63ecb6be6bbf02fdd96cd24f4f581/src/index.ts#L999-L1004) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "Every Agent call is detached and returns an agent ID immediately. run_in_background is accepted for compatibility but has no effect; continue with other work instead of waiting.",
      "Use wait: true to receive one grouped completion notification; create/update/seal explicit groups with subagent_wait_group.",
      "Results arrive via the completion notification. Then call get_subagent_result once per completed task ID with wait omitted or false before summarizing if the user needs the outputs; this preserves native expandable result UI without blocking.",
```

### ZiChuanLan/pi-subagents-lite

Same explicit notified/no-poll/no-sleep/continue-work guidance, plus `get_subagent_result` with optional wait. Its own collector/push deduplication and external ask control are **unknown**.

[src/index.ts:629–634](https://github.com/ZiChuanLan/pi-subagents-lite/blob/04e28e7c1e5d792dd53786425c98d4dc6a74c16a/src/index.ts#L629-L634) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    promptGuidelines: [
      "Use subagent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn subagent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
```

[src/index.ts:1091–1097](https://github.com/ZiChuanLan/pi-subagents-lite/blob/04e28e7c1e5d792dd53786425c98d4dc6a74c16a/src/index.ts#L1091-L1097) (verbatim source string/template; concatenation and placeholders are retained):

```ts
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
```

### casualjim/pi-mimir

`pi-herdr-agents` prompt and description say immediately end turn or work independently, and the harness wakes the parent with the result. Resume says the same and bans invented results. Separate wait/collector behavior and hard external-ask restrictions are **unknown**.

[packages/pi-herdr-agents/pi-extension/subagents/index.ts:3364–3369](https://github.com/casualjim/pi-mimir/blob/9e68ca8f868210b50449d60d3136d25ac253de48/packages/pi-herdr-agents/pi-extension/subagents/index.ts#L3364-L3369) (verbatim source string/template; concatenation and placeholders are retained):

```ts
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate, assume, or summarize results after calling this tool. " +
				"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
			promptSnippet:
```

[packages/pi-herdr-agents/pi-extension/subagents/index.ts:3970–3975](https://github.com/casualjim/pi-mimir/blob/9e68ca8f868210b50449d60d3136d25ac253de48/packages/pi-herdr-agents/pi-extension/subagents/index.ts#L3970-L3975) (verbatim source string/template; concatenation and placeholders are retained):

```ts
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			promptSnippet:
```

### j0k3r-dev-rgl/pi-subagents-j0k3r

Tool description distinguishes task (wait inline) from background, where the parent should respond and wait for automatic notification rather than sleeping, polling status, or fetching results just to wait. Collector/push ownership and an external ask guard are **unknown**.

[src/tools/subagent-run.ts:39–45](https://github.com/j0k3r-dev-rgl/pi-subagents-j0k3r/blob/66f562ef7e15bc3fc1f9136d1b31faf4c20fb214/src/tools/subagent-run.ts#L39-L45) (verbatim source string/template; concatenation and placeholders are retained):

```ts
export function createSubagentRunTool(manager: SubagentManager, pi: any) {
  return {
    name: 'subagent_run',
    label: 'Subagent Run',
    description: 'Delegate a task to exactly one markdown-defined subagent. Always omit mode unless the user explicitly requested task or background; the manager will choose automatically. Use mode=task to wait. Use mode=background only when the user explicitly asked for background; after launch, respond to the user and wait for the automatic completion notification instead of sleeping, polling status, or fetching results just to wait.',
    promptSnippet: 'Delegate analysis/review/test/design tasks to one subagent. Always omit mode unless the user explicitly requested task or background. If launched in background, respond immediately and wait for the automatic completion notification; do not sleep or poll status just to wait.',
    parameters: Type.Object({
```

### awoaCrim/pi-smart-subagents

Offers a dedicated `subagent_wait`, explicitly “Collect a background run once”; timeout/abort leaves it alive. The dedicated tool delegates to the same `action:"wait"` executor so delivery semantics share one implementation. This is positive evidence for a shared collector, not for an independent child ask. Full race behavior was not audited here and is **unknown**.

[src/extension.ts:2321–2336](https://github.com/awoaCrim/pi-smart-subagents/blob/33c7736f69792b3df5ddf8a73a7240f85b7f1437/src/extension.ts#L2321-L2336) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  // Dedicated blocking-collect tool. Thin front-end: it rewrites its args into
  // the equivalent `action:"wait"` request and reuses the main tool's execute,
  // so delivery/markDelivered/cap semantics cannot drift between the two.
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent wait",
    description:
      "Collect a background run once. Wait timeout/abort leaves it alive; action:cancel stops it. Shares subagent action:wait delivery.",
    parameters: ProviderSubagentWaitParamsSchema,
    async execute(id, params: SubagentWaitParams, signal, onUpdate, ctx) {
      if (!Value.Check(SubagentWaitParamsSchema, params)) {
        const errors = [...Value.Errors(SubagentWaitParamsSchema, params)].slice(0, 5).map((error: any) => error.message).join("; ");
        fail(`Invalid wait parameters: ${errors}`);
      }
      return executeSubagent(id, { action: "wait", id: params.id }, signal, onUpdate, ctx, params.timeout_ms);
    },
```

### narumiruna/pi-extensions

Offers `subagent_wait` for a terminal job or incoming child communication; requests/responses interrupt without canceling the job. Parent `subagent_send` may make a new request to an active job or answer a child request. Thus communication is explicitly part of this API; whether ordinary result pushes and waits duplicate or consume one another is **unknown**.

[packages/pi-subagents/src/tools.ts:274–284](https://github.com/narumiruna/pi-extensions/blob/45779b3c6d68ba57709b2de81f67faefe7bfe45e/packages/pi-subagents/src/tools.ts#L274-L284) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent · Wait",
    description:
      "Use subagent_wait to wait for one job to become terminal. An incoming child request or response interrupts the wait without cancelling the job. A timeout or caller cancellation stops only this wait.",
    promptSnippet: "Use subagent_wait to wait for one subagent job or incoming message",
    parameters: WaitParameters,
    prepareArguments: prepareWaitArguments,
    async execute(_toolCallId, params, signal) {
      const timeoutMs = resolveTimeoutMs(params.timeout);
      return toolResult(await runtime.wait(requiredIdentifier(params.jobId, "jobId"), timeoutMs, signal));
```

[packages/pi-subagents/src/tools.ts:288–292](https://github.com/narumiruna/pi-extensions/blob/45779b3c6d68ba57709b2de81f67faefe7bfe45e/packages/pi-subagents/src/tools.ts#L288-L292) (verbatim source string/template; concatenation and placeholders are retained):

```ts
  pi.registerTool({
    name: "subagent_send",
    label: "Subagent · Send",
    description:
      "Use subagent_send to send one request to an active job or answer one pending child request. For a new request, provide recipient and omit requestId. To answer a request, provide requestId and omit recipient. Provide exactly one of recipient or requestId. An accepted new request interrupts any active child response wait so delivery can proceed without consuming the child's original request.",
```

### d3ara1n/pi-extensions

Its `subagent_wait` waits for selected/all background runs and returns **status and usage**, explicitly requiring `subagent_check` for actual results; cancellation leaves children running. It separately warns against asking a child to wrap up merely to avoid waiting. Thus the wait is not a second report-bearing path itself. Push-versus-check ownership is **unknown**.

[packages/pi-subagent/src/index.ts:713–719](https://github.com/d3ara1n/pi-extensions/blob/bd6d2577e0f783c9a29074cc7a4f11fcd3038cb9/packages/pi-subagent/src/index.ts#L713-L719) (verbatim source string/template; concatenation and placeholders are retained):

```ts
    pi.registerTool({
      name: "subagent_wait",
      label: "Wait for background subagents",
      description:
        "Wait until all specified background subagent runs end. Omit ids to wait for all current background runs. Returns status and usage for each run; use subagent_check to retrieve results. Cancelling the wait leaves the runs running. Direct tool call only — not callable from codemode scripts: it is absent from the script's `tools` object.",
      promptSnippet: "Wait for background subagents to finish",
      exposure: "model-only",
```

[packages/pi-subagent/src/index.ts:404–409](https://github.com/d3ara1n/pi-extensions/blob/bd6d2577e0f783c9a29074cc7a4f11fcd3038cb9/packages/pi-subagent/src/index.ts#L404-L409) (verbatim source string/template; concatenation and placeholders are retained):

```ts
      "BACKGROUND DELEGATION:",
      "",
      "- Use it only when you have your own work this turn (including an ongoing discussion with the user) while the run executes; otherwise let the call block and return the result directly.",
      "- While a background run is queued or running, continue independent work. When its result is needed and no independent work remains, use subagent_wait, then subagent_check to collect it; if it has already ended, collect it directly. Do not use repeated subagent_check calls as a substitute for waiting.",
      "- Use subagent_steer for a concrete deviation from the delegated task or new information that changes its requirements. A running status or several checks without a result is not evidence of a wrong direction or a stall. Do not ask the child to wrap up or return early merely to avoid waiting.",
      "- Cancel a run you no longer need with subagent_cancel(id) — the child stops and its partial output remains available for subagent_check to collect.",
```

### azmeenafandi/brl-subagent

Parent description says background fanout wakes once per child, prohibits polling except when `completionNotify:"off"`, and permits a one-shot stall check. That last exception makes the intended diagnostic/polling distinction explicit. Blocking collector interaction and external ask blocking are **unknown**.

[src/index.ts:2825–2827](https://github.com/azmeenafandi/brl-subagent/blob/7fa210c684666dca9ab2ed797430d74937d73c7b/src/index.ts#L2825-L2827) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			"Set retryOnTimeout: true to automatically retry a FOREGROUND subagent that times out. Only retries once — the second timeout is treated as a final failure. Background runs are not auto-retried; re-dispatch with retryRunId.",
			"Set background: true to run the subagent in the background without blocking. The tool returns immediately with an agent ID. With tasks, background fans out: every task starts as its own background agent, the call returns one ID per task in task order, and the conductor is woken once per agent as each finishes; chain and graph cannot be combined with background (rejected). Background runs wake the conductor with a structured completion message when they finish — do not poll: polling is only correct when completion notifications are disabled (completionNotify \"off\"); one status check as a stall check is legitimate.",
			"",
```

### noguerol/trimegisto

Launch receipt says not to block/sleep: the harness delivers **one batch reconciliation** even for timeout/killed agents. `trimegisto_harvest` is an authorized on-demand snapshot, not a requirement to poll for completion. Harvest/automatic reconciliation deduplication and third-party asks are **unknown**.

[src/index.ts:1659–1664](https://github.com/noguerol/trimegisto/blob/75d5d51ef5cfb8e9ed7854f9dff9af458e2f6705/src/index.ts#L1659-L1664) (verbatim source string/template; concatenation and placeholders are retained):

```ts
            `\n\n🚀 **Wave 1/${waves.length} running: ${taskDetails.length}/${plan.launch.length} planned.**` +
            `\nThe list below is wave 1 only — later waves start when their dependencies settle:\n${taskList}` +
            (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : "") +
            `\n\nA wave only starts when the previous one is terminal, so a declared \`needs\` edge really carries the upstream verdict. ` +
            `Do not block or sleep waiting: Trimegisto delivers ONE reconciliation with every agent's conclusion when the whole batch settles — even if an agent is killed or times out. For an on-demand snapshot, call trimegisto_harvest.`,
        }],
```

[src/index.ts:1831–1834](https://github.com/noguerol/trimegisto/blob/75d5d51ef5cfb8e9ed7854f9dff9af458e2f6705/src/index.ts#L1831-L1834) (verbatim source string/template; concatenation and placeholders are retained):

```ts
          const err = a.stderr.trim();
          if (out) lines.push("", "```", out.slice(0, maxOutputChars), "```");
          else if (err) lines.push("", `Error/partial stderr: ${err.slice(0, Math.min(1000, maxOutputChars))}`);
          else lines.push("", "_(no output yet — do not wait idly; continue other work)_");
```

### wangjq4214/pi-delegate

A deliberate **no-push** comparison: description says background completion does not automatically message or wake the parent. Therefore a status/result read here is not a competing route to a pushed final report. The full description owns that distinction.

[packages/pi-delegate/src/delegate.ts:187–193](https://github.com/wangjq4214/pi-delegate/blob/f79a4137c21125818a2359ce2cccec3ff8b291bf/packages/pi-delegate/src/delegate.ts#L187-L193) (verbatim source string/template; concatenation and placeholders are retained):

```ts
			name: DELEGATE_TOOL,
			label: "Delegate",
			description:
				"Run a self-contained task in a fresh subagent with inherited tools except delegation. The parent conversation is not copied; supply necessary context. By default the subagent shares the parent working directory; optional cwd selects another existing directory, not a sandbox. Coordinate file edits. By default, wait for the result. With background:true, return a taskId without waiting; completion does not send an automatic message or wake the parent; use delegate_list to discover tasks and delegate_status for details. delegate_steer/delegate_cancel manage background tasks only. Large results include a full-output file path.",
			parameters,
			prepareArguments(args) {
				return prepareDelegationArguments(args) as Static<typeof parameters>;
```

### HenryQW/pi-harness

Direct requests return a Herdr handle and one follow-up result; the description does not itself supply the clear independent-work/end-turn/no-poll instruction found in the stronger examples. Durable isolated mode exposes status inspection. A wait tool, pushed-result deduplication, and external ask restriction are **unknown** in this profile.

[extensions/pi-subagent/extensions/subagent.ts:599–603](https://github.com/HenryQW/pi-harness/blob/0ca291709a8cc95e5d7439d22c7454e894aa512e/extensions/pi-subagent/extensions/subagent.ts#L599-L603) (verbatim source string/template; concatenation and placeholders are retained):

```ts
		promptGuidelines: [
			"Keep trivial mechanically verifiable work in Main. Use mode direct for bounded, explicitly authorized work with the Role's declared resources in the shared checkout, including writes or commits. Specify allowed scope and exclusions; preserve unrelated changes. Direct work has no isolated checks, rollback, or integration guarantees. Use mode isolated for checked changesets; explicit mode never falls back.",
			"Direct requests use one compact role/name/task/access packet, tasks for independent packets, or chain with {previous}. Direct work returns a Herdr handle after launch; results arrive as one follow-up message.",
			"Classify each direct task's access honestly: write when it may change files, Git state, or external resources; read otherwise. Read tasks run concurrently without checkout admission, and nothing enforces read (no sandbox). Any write task makes the request serial, reserves the checkout until workers are proved stopped, and requires a JSON completion object. Use mode isolated for checked writes.",
			"To build on a finished direct worker's context (follow-up questions, corrections, next steps on the same evidence), set continueFrom to its reference such as D7.1 with the same role; the worker resumes its saved Pi session in a new tab. Start a fresh task for unrelated work, a different Role, or when the old context is stale or large.",
```

### pi-squire: local contract before and during this research

[src/index.ts:315 at 6dfedef1b210019dfe76a6d42b35c1371ad6b381](https://github.com/gvanderclay/pi-squire/blob/6dfedef1b210019dfe76a6d42b35c1371ad6b381/src/index.ts#L315) (verbatim):

```ts
		"Hand a self-contained task to a delegate Pi session in a background tmux window, so it works while you do not. Each call starts the delegation at once; the delegate runs in this session's working directory and agent root and reports back later as one message. Use it when the work is self-contained and you would rather keep your own context for it.";
```

[src/index.ts:584 at 6dfedef1b210019dfe76a6d42b35c1371ad6b381](https://github.com/gvanderclay/pi-squire/blob/6dfedef1b210019dfe76a6d42b35c1371ad6b381/src/index.ts#L584) (verbatim):

```ts
				`Started delegation ${launched.id}: ${start.agent.name} (${start.model}, thinking ${start.thinking}) in window ${launched.windowName}. It runs in the background and its result arrives as a message; delegation_status reports it and delegation_close ends it.${start.skipped.length > 0 ? ` ${fallbackNote(start)}` : ""}${start.notices.map((line) => ` ${line}`).join("")}`,
```

[src/index.ts:315 at 529c3447ed1ecae9b9cabd58d9420433f3cc082f](https://github.com/gvanderclay/pi-squire/blob/529c3447ed1ecae9b9cabd58d9420433f3cc082f/src/index.ts#L315) (verbatim):

```ts
		"Hand a self-contained task to a delegate Pi session in a background tmux window, so it works while you do not. Each call starts the delegation at once; the delegate runs in this session's working directory and agent root and reports back later as one message. While it runs, keep working or end your turn: its result starts your next turn on its own, so there is no need to ask the delegate for it or poll delegation_status. Use it when the work is self-contained and you would rather keep your own context for it.";
```

[src/index.ts:584 at 529c3447ed1ecae9b9cabd58d9420433f3cc082f](https://github.com/gvanderclay/pi-squire/blob/529c3447ed1ecae9b9cabd58d9420433f3cc082f/src/index.ts#L584) (verbatim):

```ts
				`Started delegation ${launched.id}: ${start.agent.name} (${start.model}, thinking ${start.thinking}) in window ${launched.windowName}. It runs in the background, and its result arrives as a message that starts your next turn on its own; delegation_close ends it.${start.skipped.length > 0 ? ` ${fallbackNote(start)}` : ""}${start.notices.map((line) => ` ${line}`).join("")}`,
```

The new sentence is aligned with the replacement-action guidance above, but ‘there is no need’ is weaker than the explicit prohibitions in edxeth, nicobailon and deathbeam. Whether strengthening it is necessary or sufficient for GPT is unknown; this is a recommendation based on the published contracts, not measured model compliance.

## What is and is not prevented

**Prompt discouragement:** naming an automatic result does not by itself prescribe what to do instead. The strongest quoted strings add “end your turn,” “starts a new turn,” and explicit alternatives not to call. These are instructions, not hard runtime restrictions; the effect on GPT remains unknown without an experiment.

**API shape:** event-only waits (wj), status/usage-only waits (d3ara1n), automatic full reports with no separately advertised collector (deathbeam), and preview/notification-plus-explicit-collector designs (tintinweb, background-tasks, smithyyang) are different contracts. A second tool call is not inherently a duplicate; it becomes a duplicate when both paths carry the same full final report.

**Delivery ownership:** gotgenes claims a report before waiting and skips its push; bermudi fingerprints a terminal poll/wait view and suppresses its duplicate wake; mavam consumes the outstanding delivery through the wait result. Those source paths demonstrate why adding a wait tool requires shared state with the push mechanism. None demonstrates that an unrelated `session_mail_ask` automatically participates in that state.

**No verified blanket external-ask guard:** `rg` over the fetched runtime TypeScript/JavaScript did not reveal a `session_mail_ask`-specific guard. This is a bounded search observation, not proof that no extension can do it. Most compared extensions own their launch/communication/collector tools, unlike pi-squire's dependency on an independently registered message provider. The precise enforceable boundary is unknown and should be researched against that provider before deciding to block asks.

## Unsettled questions

- **Unknown:** whether the new pi-squire sentence changes gpt-6-astra behavior across representative prompts, especially dependent work and idle turns. No model calls or behavioral reproduction were performed.
- **Unknown:** whether “one final result message” is a desired hard guarantee or merely the normal transport contract. That decision determines whether runtime interception is warranted after clearer wording.
- **Unknown:** whether blocking all `session_mail_ask` calls to owned delegates is acceptable when clarification or a genuinely blocking decision is needed. Other implementations explicitly allow such communication.
- **Unknown:** full collector/push race handling for every entry below; only gotgenes, bermudi, mavam, and tintinweb received the concrete collector inspection reported above.
- **Unknown:** a complete worldwide inventory. Catalog and npm searches are capped; forks, unpublished local packages and removed repositories exist.

## Broad discovery inventory and source triage

All snapshots below were checked for runtime wording and tool registrations. This appendix is deliberately labeled **triage**: candidate string matches are quoted verbatim and pinned, but an apparent wait-related registration is not automatically a verified model-callable collector. If a repository has no quoted parent guidance, wording/wait/push interaction remains **unknown**, not “none.” The detailed sections above provide the verified comparisons; the inventory makes discovery limits visible rather than silently dropping unrelated, synchronous, stale or complicated hits.


### Inventory: 1aboveio/pi-better-harness

Snapshot: `64aeeaeca7f526431b2cd695962d3fa56d7054c0` ([source tree](https://github.com/1aboveio/pi-better-harness/tree/64aeeaeca7f526431b2cd695962d3fa56d7054c0)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/pi-better-subagents/delegation.ts:20](https://github.com/1aboveio/pi-better-harness/blob/64aeeaeca7f526431b2cd695962d3fa56d7054c0/packages/pi-better-subagents/delegation.ts#L20) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return "Delegation mode: coordinator. The foreground coordinates, integrates, and verifies. Call agents_catalog to discover current available roles and inspect their descriptions. Pass a role to subagent_spawn by its short name, as listed (role: \"developer\"). Delegate every nontrivial task covered by an available role according to its current description; do not assume bundled roles are unchanged. Keep orchestration, cross-role decisions, unowned or ambiguous work, integration, and final verification in the foreground. Inspect results and failures before concluding; do not poll for running children.";
```

[packages/pi-better-subagents/delegation.ts:22](https://github.com/1aboveio/pi-better-harness/blob/64aeeaeca7f526431b2cd695962d3fa56d7054c0/packages/pi-better-subagents/delegation.ts#L22) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return "Delegation mode: adaptive. Delegate bounded, substantial independent work when a suitable subagent is available and useful; continue unblocked foreground work. Keep small, tightly coupled, or interactive work in the foreground. Inspect and integrate delegated results before final verification; do not poll.";
```

[packages/pi-better-subagents/completion.mjs:120](https://github.com/1aboveio/pi-better-harness/blob/64aeeaeca7f526431b2cd695962d3fa56d7054c0/packages/pi-better-subagents/completion.mjs#L120) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
`You may wait, stop (subagent_stop id="${p.id}"), or retry from the original task.`;
```

### Inventory: AgiFlow/doompi

Snapshot: `e5658c87246384406b1efb7230d3885c58e18c95` ([source tree](https://github.com/AgiFlow/doompi/tree/e5658c87246384406b1efb7230d3885c58e18c95)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/minor/doompi-workflow/src/tui/workflowRuntime.ts:2464](https://github.com/AgiFlow/doompi/blob/e5658c87246384406b1efb7230d3885c58e18c95/packages/minor/doompi-workflow/src/tui/workflowRuntime.ts#L2464) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
if (provider) await runCleanup('unregister the background-work provider', () => provider.dispose());
```

[packages/minor/doompi-help/src/services/helpActivation/index.ts:160](https://github.com/AgiFlow/doompi/blob/e5658c87246384406b1efb7230d3885c58e18c95/packages/minor/doompi-help/src/services/helpActivation/index.ts#L160) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(Array.from({ length: count }, () => worker()));
```

[packages/foundations/doompi-skill/src/services/deferredSkills/index.ts:26](https://github.com/AgiFlow/doompi/blob/e5658c87246384406b1efb7230d3885c58e18c95/packages/foundations/doompi-skill/src/services/deferredSkills/index.ts#L26) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const { loadSkills } = await import(workerData.piModuleUrl);
```

### Inventory: AgwaB/pi-subagent

Snapshot: `5330c223d853115a6812ffbbc3b2175b288b1cbe` ([source tree](https://github.com/AgwaB/pi-subagent/tree/5330c223d853115a6812ffbbc3b2175b288b1cbe)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/index.ts:452](https://github.com/AgwaB/pi-subagent/blob/5330c223d853115a6812ffbbc3b2175b288b1cbe/src/index.ts#L452) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
'action must be one of "run", "status", "logs", "wait", "interrupt", "mark-background", "reconcile", or "prune" when provided.',
```

[src/index.ts:524](https://github.com/AgwaB/pi-subagent/blob/5330c223d853115a6812ffbbc3b2175b288b1cbe/src/index.ts#L524) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const record = await setRunDependency(ref, "background");
```

[src/index.ts:1088](https://github.com/AgwaB/pi-subagent/blob/5330c223d853115a6812ffbbc3b2175b288b1cbe/src/index.ts#L1088) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
'What to do. Default "run" starts a new subagent. status/logs/wait/interrupt/mark-background/reconcile operate on an existing runId. prune deletes old terminal runs under cwd (dry run unless yes is true).',
```

### Inventory: AllenYolk/pi-extensions

Snapshot: `c29b3ae98856cc443452986c3dad9bd72667d116` ([source tree](https://github.com/AllenYolk/pi-extensions/tree/c29b3ae98856cc443452986c3dad9bd72667d116)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: AlvaroRausell/pi-image-subagent

Snapshot: `4f3d63df040f959a3b9db7d0a708b3805543ad90` ([source tree](https://github.com/AlvaroRausell/pi-image-subagent/tree/4f3d63df040f959a3b9db7d0a708b3805543ad90)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: BlackBeltTechnology/pi-dashboard-subagents

Snapshot: `cfcf1964a2656c093668a78351df581a743eccdc` ([source tree](https://github.com/BlackBeltTechnology/pi-dashboard-subagents/tree/cfcf1964a2656c093668a78351df581a743eccdc)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **ByteTrue/pi-package-mono** — `4255e2fa2ae7613d019cc0542c7c3f3282130b0e`; detailed contract above.

- **ESSO0428/pi-subagents** — `a9e4c555c4a63ecb6be6bbf02fdd96cd24f4f581`; detailed contract above.

### Inventory: EricMoin/rolebox

Snapshot: `f4280157ccf356c25d49c9785f314497a0258cd3` ([source tree](https://github.com/EricMoin/rolebox/tree/f4280157ccf356c25d49c9785f314497a0258cd3)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/prompt/builder.ts:211](https://github.com/EricMoin/rolebox/blob/f4280157ccf356c25d49c9785f314497a0258cd3/src/prompt/builder.ts#L211) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"credential it settles with, so end your turn after graph_declare. A worker settles\n" +
```

[src/prompt/builder.ts:241](https://github.com/EricMoin/rolebox/blob/f4280157ccf356c25d49c9785f314497a0258cd3/src/prompt/builder.ts#L241) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"settles with, so end your turn after graph_declare. A worker settles its node with\n" +
```

[src/loader/subagents.ts:245](https://github.com/EricMoin/rolebox/blob/f4280157ccf356c25d49c9785f314497a0258cd3/src/loader/subagents.ts#L245) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
matches = await fglob(`subagents/*/${ROLE_YAML}`, {
```

### Inventory: Fornace/pi-subagent-extension

Snapshot: `1016b93b4509a30daffba7620d203f26528a8fae` ([source tree](https://github.com/Fornace/pi-subagent-extension/tree/1016b93b4509a30daffba7620d203f26528a8fae)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[managed-wait-tool.ts:21](https://github.com/Fornace/pi-subagent-extension/blob/1016b93b4509a30daffba7620d203f26528a8fae/managed-wait-tool.ts#L21) — wait/await registration **candidate**:

```ts
name: "agent_wait",
```

### Inventory: Gentleman-Programming/gentle-shell

Snapshot: `f69cf2b80d42fa642410fb4b1a7a4b858945d167` ([source tree](https://github.com/Gentleman-Programming/gentle-shell/tree/f69cf2b80d42fa642410fb4b1a7a4b858945d167)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/gentle-ai.ts:1325](https://github.com/Gentleman-Programming/gentle-shell/blob/f69cf2b80d42fa642410fb4b1a7a4b858945d167/extensions/gentle-ai.ts#L1325) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
For background work, launch the bounded action and end the turn when no independent in-scope work remains. Retain its identity and resume the already-authorized continuation automatically on its completion event; do not ask the human to say "continue", poll, or claim completion while checks remain pending.
```

[extensions/gentle-ai.ts:10553](https://github.com/Gentleman-Programming/gentle-shell/blob/f69cf2b80d42fa642410fb4b1a7a4b858945d167/extensions/gentle-ai.ts#L10553) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const selected = await ctx.ui.select("Background subagents policy", ["status", "enable", "disable"]);
```

[extensions/gentle-agents.ts:824](https://github.com/Gentleman-Programming/gentle-shell/blob/f69cf2b80d42fa642410fb4b1a7a4b858945d167/extensions/gentle-agents.ts#L824) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
reason: `Standalone sleep is blocked while background work is active (${tasks} task(s), ${running} job(s)). End the turn now; each completion arrives automatically as a session message and starts a new turn.`,
```

### Inventory: GeorgeDong32/pi-review

Snapshot: `358129569e89c2fb7178c63364c35f81d269e1e8` ([source tree](https://github.com/GeorgeDong32/pi-review/tree/358129569e89c2fb7178c63364c35f81d269e1e8)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: GodTamIt/pi-mono

Snapshot: `d899567f01a420e37d509ec97e1e558defd2b3f8` ([source tree](https://github.com/GodTamIt/pi-mono/tree/d899567f01a420e37d509ec97e1e558defd2b3f8)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/pi-agent-roster/src/index.ts:330](https://github.com/GodTamIt/pi-mono/blob/d899567f01a420e37d509ec97e1e558defd2b3f8/packages/pi-agent-roster/src/index.ts#L330) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await subagentsSettings.handle({ ui: ctx.ui });
```

[packages/pi-agent-roster/src/tools/foreground-runner.ts:86](https://github.com/GodTamIt/pi-mono/blob/d899567f01a420e37d509ec97e1e558defd2b3f8/packages/pi-agent-roster/src/tools/foreground-runner.ts#L86) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
record = await manager.spawnAndWait(params.baseline, identity.subagentType, execution.task, {
```

[packages/pi-agent-roster/src/lifecycle/create-subagent-session.ts:309](https://github.com/GodTamIt/pi-mono/blob/d899567f01a420e37d509ec97e1e558defd2b3f8/packages/pi-agent-roster/src/lifecycle/create-subagent-session.ts#L309) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await subagentSession.dispose();
```

### Inventory: GonChen/codex-pi-agents

Snapshot: `bf834a81be9acde5241936654c9de75fb0b2486f` ([source tree](https://github.com/GonChen/codex-pi-agents/tree/bf834a81be9acde5241936654c9de75fb0b2486f)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[dev/src/lib/send-thread.ts:39](https://github.com/GonChen/codex-pi-agents/blob/bf834a81be9acde5241936654c9de75fb0b2486f/dev/src/lib/send-thread.ts#L39) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
`Wait for the current run to finish (see \`pi-subagent status --thread ${thread.thread_id}\` or use \`wait\`).`
```

### Inventory: HashWarlock/nobody-plans-for-pi

Snapshot: `fc2edc0f6d90dcdeb8c1d9e10a4bca9d7c20c0e4` ([source tree](https://github.com/HashWarlock/nobody-plans-for-pi/tree/fc2edc0f6d90dcdeb8c1d9e10a4bca9d7c20c0e4)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/subagent/index.ts:206](https://github.com/HashWarlock/nobody-plans-for-pi/blob/fc2edc0f6d90dcdeb8c1d9e10a4bca9d7c20c0e4/extensions/subagent/index.ts#L206) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

- **HenryQW/pi-harness** — `0ca291709a8cc95e5d7439d22c7454e894aa512e`; detailed contract above.

### Inventory: IgorWarzocha/howaboua-pi-stuff

Snapshot: `100893459f3e8237c414bd56aaaa9657cbec625c` ([source tree](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/100893459f3e8237c414bd56aaaa9657cbec625c)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/pi-codex-imagegen/index.ts:39](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/100893459f3e8237c414bd56aaaa9657cbec625c/packages/pi-codex-imagegen/index.ts#L39) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"generatedImage(await tools.image_gen__imagegen({prompt:string,transparent_background?:boolean,referenced_image_paths?:string[],num_last_images_to_include?:number})) // prompt: include target aspect ratio and quality; transparency for cutouts, preserve existing transparency in edits; no selectors=generate; paths/recent count=edit; never text/serialize base64 result",
```

[packages/pi-browser/remote-worker.ts:26](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/100893459f3e8237c414bd56aaaa9657cbec625c/packages/pi-browser/remote-worker.ts#L26) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await serveBrowserWorker(workerId);
```

[packages/pi-codex-conversion/src/ui/tool-rendering/codex-rendering.ts:28](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/100893459f3e8237c414bd56aaaa9657cbec625c/packages/pi-codex-conversion/src/ui/tool-rendering/codex-rendering.ts#L28) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const title = interacted ? "Interacted with background terminal" : "Waited for background terminal";
```

[packages/pi-codex-conversion/src/tools/code-mode/public-tools.ts:146](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/100893459f3e8237c414bd56aaaa9657cbec625c/packages/pi-codex-conversion/src/tools/code-mode/public-tools.ts#L146) — wait/await registration **candidate**:

```ts
name: "wait",
```

[packages/pi-dynamic-tools/src/tools.ts:137](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/100893459f3e8237c414bd56aaaa9657cbec625c/packages/pi-dynamic-tools/src/tools.ts#L137) — wait/await registration **candidate**:

```ts
name: "wait",
```

### Inventory: JerryAZR/pi-subagent-lite

Snapshot: `8b6ce6a7d1fd50d5b09b97bb1b799a8d121577dd` ([source tree](https://github.com/JerryAZR/pi-subagent-lite/tree/8b6ce6a7d1fd50d5b09b97bb1b799a8d121577dd)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[index.ts:59](https://github.com/JerryAZR/pi-subagent-lite/blob/8b6ce6a7d1fd50d5b09b97bb1b799a8d121577dd/index.ts#L59) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

### Inventory: JerryAZR/pi-subagent-tools

Snapshot: `2061e0109c066df75c7957e462d38b978a1de177` ([source tree](https://github.com/JerryAZR/pi-subagent-tools/tree/2061e0109c066df75c7957e462d38b978a1de177)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: JetBrains/ytdb-slate

Snapshot: `58e2cdcde8c802c0bf4d55da8d523aaab75d115e` ([source tree](https://github.com/JetBrains/ytdb-slate/tree/58e2cdcde8c802c0bf4d55da8d523aaab75d115e)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extension/mode.ts:370](https://github.com/JetBrains/ytdb-slate/blob/58e2cdcde8c802c0bf4d55da8d523aaab75d115e/extension/mode.ts#L370) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
Wait for that worker result and verify that it reports success before writing the
```

[extension/handoff.ts:347](https://github.com/JetBrains/ytdb-slate/blob/58e2cdcde8c802c0bf4d55da8d523aaab75d115e/extension/handoff.ts#L347) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"Wait for that worker result and verify that it reports success before writing the final HANDOFF BRIEF.",
```

[extension/worker.ts:693](https://github.com/JetBrains/ytdb-slate/blob/58e2cdcde8c802c0bf4d55da8d523aaab75d115e/extension/worker.ts#L693) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await workerSession.settleManagedOperations();
```

### Inventory: JetCrab/pi-desk

Snapshot: `253553f86503aee021a1909857f6bb855fabe92f` ([source tree](https://github.com/JetCrab/pi-desk/tree/253553f86503aee021a1909857f6bb855fabe92f)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/server/l4_foundation/terminal/l4-terminal-pty.ts:305](https://github.com/JetCrab/pi-desk/blob/253553f86503aee021a1909857f6bb855fabe92f/src/server/l4_foundation/terminal/l4-terminal-pty.ts#L305) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await this.workerExit
```

[plugins/pi-desk-usage/src/usage-runtime.ts:440](https://github.com/JetCrab/pi-desk/blob/253553f86503aee021a1909857f6bb855fabe92f/plugins/pi-desk-usage/src/usage-runtime.ts#L440) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
if (worker) await worker.terminate()
```

[plugins/pi-desk-usage/src/l4-usage-files.ts:122](https://github.com/JetCrab/pi-desk/blob/253553f86503aee021a1909857f6bb855fabe92f/plugins/pi-desk-usage/src/l4-usage-files.ts#L122) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
? await nestedSessionFiles(join(directory, subagentDirectory.name))
```

### Inventory: Jonghakseo/pi-extension

Snapshot: `95a4babe442a19a98f5b5a7274c51fa5c8681a97` ([source tree](https://github.com/Jonghakseo/pi-extension/tree/95a4babe442a19a98f5b5a7274c51fa5c8681a97)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/bash-async/tool-schema.ts:13](https://github.com/Jonghakseo/pi-extension/blob/95a4babe442a19a98f5b5a7274c51fa5c8681a97/packages/bash-async/tool-schema.ts#L13) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const TOOL_DESCRIPTION_REST = `Do not call sleep or poll status, output, or list to wait. Continue only with work that does not depend on the job; otherwise end the turn. Results arrive automatically once your current response and its tool calls finish, whether the job succeeded, failed, or timed out. Jobs you kill are not reported. Query output only when early output is needed or the user asks; repeated queries that return no new information are rate limited and fail. TUI, REPL, and commands requiring stdin are unsupported.`;
```

[packages/bash-async/tool-schema.ts:25](https://github.com/Jonghakseo/pi-extension/blob/95a4babe442a19a98f5b5a7274c51fa5c8681a97/packages/bash-async/tool-schema.ts#L25) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return `Run a finite, non-interactive shell command, in the background if it takes long. start waits up to ${formatSyncWindow(syncWindowMs)}: a command that finishes within it returns its final status and output inline and is not reported again; a longer command keeps running in the background. ${TOOL_DESCRIPTION_REST}`;
```

[packages/bash-async/render.ts:7](https://github.com/Jonghakseo/pi-extension/blob/95a4babe442a19a98f5b5a7274c51fa5c8681a97/packages/bash-async/render.ts#L7) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return `Started background job ${details.jobId} (${details.status})${still}: ${details.title}\nDo not call sleep or poll status, output, or list to wait. Continue only with work that does not depend on this job; otherwise end the turn. Results arrive automatically once your current response and its tool calls finish, whether the job succeeded, failed, or timed out. Jobs you kill are not reported.`;
```

### Inventory: KatouMegumi-dar/pi-subagent-tool

Snapshot: `306e603190ee15a4e18a2756039300396171dcc1` ([source tree](https://github.com/KatouMegumi-dar/pi-subagent-tool/tree/306e603190ee15a4e18a2756039300396171dcc1)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[index.ts:417](https://github.com/KatouMegumi-dar/pi-subagent-tool/blob/306e603190ee15a4e18a2756039300396171dcc1/index.ts#L417) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

[index.ts:523](https://github.com/KatouMegumi-dar/pi-subagent-tool/blob/306e603190ee15a4e18a2756039300396171dcc1/index.ts#L523) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

[index.ts:899](https://github.com/KatouMegumi-dar/pi-subagent-tool/blob/306e603190ee15a4e18a2756039300396171dcc1/index.ts#L899) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"Use {wait: 0} or {background: true} for pure background dispatch; use {wait: -1} to block until done.",
```

### Inventory: KcAnom/pi-fairy-tales

Snapshot: `2e0e73327e188a2f60d3762c9aaa95015224f9ef` ([source tree](https://github.com/KcAnom/pi-fairy-tales/tree/2e0e73327e188a2f60d3762c9aaa95015224f9ef)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/fairy-tales-agents.ts:294](https://github.com/KcAnom/pi-fairy-tales/blob/2e0e73327e188a2f60d3762c9aaa95015224f9ef/extensions/fairy-tales-agents.ts#L294) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
`Delegate a task to a specialized subagent running in its own context. Roles: ${roleDescriptions}. The subagent cannot ask questions — give it a complete, self-contained task. Set background:true to keep working while it runs; its result is delivered to you when it finishes. Overflow beyond the concurrency limit is queued, not rejected.`,
```

[extensions/fairy-tales-agents.ts:306](https://github.com/KcAnom/pi-fairy-tales/blob/2e0e73327e188a2f60d3762c9aaa95015224f9ef/extensions/fairy-tales-agents.ts#L306) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
background: Type.Optional(Type.Boolean({ description: "Run in background; result is delivered on completion" })),
```

[extensions/fairy-tales-agents.ts:489](https://github.com/KcAnom/pi-fairy-tales/blob/2e0e73327e188a2f60d3762c9aaa95015224f9ef/extensions/fairy-tales-agents.ts#L489) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const outcome = await runClaimedQuest(claimed, ctx, background, _signal);
```

### Inventory: KrisGray/pi-agent-stack

Snapshot: `aaaa16a8905836d5ded967826ac67686546e4ab8` ([source tree](https://github.com/KrisGray/pi-agent-stack/tree/aaaa16a8905836d5ded967826ac67686546e4ab8)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **KristjanPikhof/pi-agents-team** — `6285b63485f1c536e1b30eea42b23eb8e20d7c91`; detailed contract above.

### Inventory: Labiey/expert-council-router

Snapshot: `16ecc076479a2db35b7ff72417bb0763937b287b` ([source tree](https://github.com/Labiey/expert-council-router/tree/16ecc076479a2db35b7ff72417bb0763937b287b)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/pi-runtime/src/pi-runtime.ts:1416](https://github.com/Labiey/expert-council-router/blob/16ecc076479a2db35b7ff72417bb0763937b287b/packages/pi-runtime/src/pi-runtime.ts#L1416) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"After the tool confirms, end your turn with a one-paragraph summary; do not continue the task.",
```

[packages/pi-runtime/src/pi-runtime.ts:1470](https://github.com/Labiey/expert-council-router/blob/16ecc076479a2db35b7ff72417bb0763937b287b/packages/pi-runtime/src/pi-runtime.ts#L1470) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
text: "Stop report recorded. End your turn now with a one-paragraph summary of what you did and learned. Do not continue the task.",
```

[packages/mcp-server/src/index.ts:352](https://github.com/Labiey/expert-council-router/blob/16ecc076479a2db35b7ff72417bb0763937b287b/packages/mcp-server/src/index.ts#L352) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
description: "After all other useful host work is finished, wait without polling for any or all background expert executions. Choose a finite timeoutMs from expected remaining task difficulty, then use expert_result for feedback.",
```

### Inventory: MDGChamomile/pi-subagent

Snapshot: `78aeb53fb9ed365b3be273680aa46b153c1c1d90` ([source tree](https://github.com/MDGChamomile/pi-subagent/tree/78aeb53fb9ed365b3be273680aa46b153c1c1d90)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/pi-subagent/settings-command.ts:128](https://github.com/MDGChamomile/pi-subagent/blob/78aeb53fb9ed365b3be273680aa46b153c1c1d90/extensions/pi-subagent/settings-command.ts#L128) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
if (!await ctx.ui.confirm("Save subagent defaults? · 5/5", [
```

[extensions/pi-subagent/index.ts:98](https://github.com/MDGChamomile/pi-subagent/blob/78aeb53fb9ed365b3be273680aa46b153c1c1d90/extensions/pi-subagent/index.ts#L98) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
tempDir = await makeCanonicalTempDirectory(join(tmpdir(), "pi-subagent-"));
```

[packaging/pi-subagent/check.mjs:77](https://github.com/MDGChamomile/pi-subagent/blob/78aeb53fb9ed365b3be273680aa46b153c1c1d90/packaging/pi-subagent/check.mjs#L77) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
assert.equal((await stat(join(sourceRoot, "extensions/pi-subagent/assets", asset))).isFile(), true,
```

### Inventory: MikkelKappelPersson/pi-shepherd

Snapshot: `225e2e286734b269093ad615af88da54b6b79e08` ([source tree](https://github.com/MikkelKappelPersson/pi-shepherd/tree/225e2e286734b269093ad615af88da54b6b79e08)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **QuintinShaw/pi-dynamic-workflows** — **unknown**: snapshot retrieval failed (`git ls-remote` could not retrieve HEAD).

### Inventory: Ryu-CZ/pi-herdr-flock

Snapshot: `a42f37fb9d78954190ec9de338bc8217c0a02052` ([source tree](https://github.com/Ryu-CZ/pi-herdr-flock/tree/a42f37fb9d78954190ec9de338bc8217c0a02052)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **SelesaiInTech/selesai-code** — **unknown**: snapshot retrieval failed (`git ls-remote` could not retrieve HEAD).

### Inventory: UninspiredStudio/pi-subagent-pipeline

Snapshot: `a277b33bdbf18e331844576bb2357a2363629b64` ([source tree](https://github.com/UninspiredStudio/pi-subagent-pipeline/tree/a277b33bdbf18e331844576bb2357a2363629b64)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: Wolido/subagent-isolation

Snapshot: `8f9170e13c5391493cf80a7c76954cd797a516ca` ([source tree](https://github.com/Wolido/subagent-isolation/tree/8f9170e13c5391493cf80a7c76954cd797a516ca)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/index.ts:508](https://github.com/Wolido/subagent-isolation/blob/8f9170e13c5391493cf80a7c76954cd797a516ca/src/index.ts#L508) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

### Inventory: Yivas/pi-delegation-policy

Snapshot: `980e34df826b1e32c6a26ea30dfbff13964298d1` ([source tree](https://github.com/Yivas/pi-delegation-policy/tree/980e34df826b1e32c6a26ea30dfbff13964298d1)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/context-shunt-adapter.ts:70](https://github.com/Yivas/pi-delegation-policy/blob/980e34df826b1e32c6a26ea30dfbff13964298d1/src/context-shunt-adapter.ts#L70) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
reason: `${decision.reason} Use a bounded range. The temporary exception queue is full; wait for an existing request to expire. No worker was launched automatically.`,
```

- **ZiChuanLan/pi-subagents-lite** — `04e28e7c1e5d792dd53786425c98d4dc6a74c16a`; detailed contract above.

### Inventory: a-t-h-i/bot-lobby

Snapshot: `537257745362d707d1a855d142884416dea52422` ([source tree](https://github.com/a-t-h-i/bot-lobby/tree/537257745362d707d1a855d142884416dea52422)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/desk/session.ts:160](https://github.com/a-t-h-i/bot-lobby/blob/537257745362d707d1a855d142884416dea52422/src/desk/session.ts#L160) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return this.wait(worker, Math.min(MAX_WAIT_MS, Math.max(1000, request.timeoutMs ?? MAX_WAIT_MS)));
```

[src/desk/session.ts:203](https://github.com/a-t-h-i/bot-lobby/blob/537257745362d707d1a855d142884416dea52422/src/desk/session.ts#L203) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const waiting = this.desk.waitingFor(worker).map((entry) => `You are #${entry.position} for \`${entry.path}\` (held by ${label(entry.holder.worker)}: ${entry.holder.intent}).`);
```

[src/desk/session.ts:207](https://github.com/a-t-h-i/bot-lobby/blob/537257745362d707d1a855d142884416dea52422/src/desk/session.ts#L207) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
private async wait(worker: WorkerId, timeoutMs: number): Promise<Omit<DeskResponse, "id">> {
```

[src/desk/client-extension.ts:89](https://github.com/a-t-h-i/bot-lobby/blob/537257745362d707d1a855d142884416dea52422/src/desk/client-extension.ts#L89) — wait/await registration **candidate**:

```ts
name: "wait_for_files",
```

### Inventory: a1121611810/pi-ptc-subagents

Snapshot: `f76496d16dadea41fd1c15bbf4a4fdfe4491a385` ([source tree](https://github.com/a1121611810/pi-ptc-subagents/tree/f76496d16dadea41fd1c15bbf4a4fdfe4491a385)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/index.ts:352](https://github.com/a1121611810/pi-ptc-subagents/blob/f76496d16dadea41fd1c15bbf4a4fdfe4491a385/src/index.ts#L352) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const { items, acks } = await background.drainNotifications(subscriberId);
```

[src/index.ts:366](https://github.com/a1121611810/pi-ptc-subagents/blob/f76496d16dadea41fd1c15bbf4a4fdfe4491a385/src/index.ts#L366) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await background.acknowledgeNotifications(acks);
```

[src/index.ts:371](https://github.com/a1121611810/pi-ptc-subagents/blob/f76496d16dadea41fd1c15bbf4a4fdfe4491a385/src/index.ts#L371) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const records = await background.registry.query({ limit: Number.MAX_SAFE_INTEGER });
```

### Inventory: adamcjm/pi-subagent

Snapshot: `73f0db9dddd4cadd6ab032715520fe918b1ddb7d` ([source tree](https://github.com/adamcjm/pi-subagent/tree/73f0db9dddd4cadd6ab032715520fe918b1ddb7d)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/subagent/index.ts:237](https://github.com/adamcjm/pi-subagent/blob/73f0db9dddd4cadd6ab032715520fe918b1ddb7d/extensions/subagent/index.ts#L237) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

[extensions/subagent/index.ts:242](https://github.com/adamcjm/pi-subagent/blob/73f0db9dddd4cadd6ab032715520fe918b1ddb7d/extensions/subagent/index.ts#L242) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

### Inventory: adamjen/pi-one-subagent-at-a-time

Snapshot: `a536077b6dde0970ecc8b2365d15b07b34541bee` ([source tree](https://github.com/adamjen/pi-one-subagent-at-a-time/tree/a536077b6dde0970ecc8b2365d15b07b34541bee)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: aefreedman/pi-subagents

Snapshot: `35ffe9e39e9b13fa628ad28e032f4606bbea4d64` ([source tree](https://github.com/aefreedman/pi-subagents/tree/35ffe9e39e9b13fa628ad28e032f4606bbea4d64)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/index.ts:453](https://github.com/aefreedman/pi-subagents/blob/35ffe9e39e9b13fa628ad28e032f4606bbea4d64/extensions/index.ts#L453) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

[extensions/index.ts:458](https://github.com/aefreedman/pi-subagents/blob/35ffe9e39e9b13fa628ad28e032f4606bbea4d64/extensions/index.ts#L458) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

### Inventory: andrea-tomassi/pi-open-agents

Snapshot: `9273b556726a5b86cce9159891094f8c4b3ecc8b` ([source tree](https://github.com/andrea-tomassi/pi-open-agents/tree/9273b556726a5b86cce9159891094f8c4b3ecc8b)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: anthod0/pi-lab

Snapshot: `dcdcb3c1773b7a658ad4c2a48a14adaeca8082c3` ([source tree](https://github.com/anthod0/pi-lab/tree/dcdcb3c1773b7a658ad4c2a48a14adaeca8082c3)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **arhen/pi-extensions** — `267bbdbc142942f9741ffd21287b94d77a52bb1f`; detailed contract above.

### Inventory: asermax/herdr-subagents

Snapshot: `94b8ac12db7b8184706372c96c199b4fb2a2f6bc` ([source tree](https://github.com/asermax/herdr-subagents/tree/94b8ac12db7b8184706372c96c199b4fb2a2f6bc)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/core/subagent.ts:258](https://github.com/asermax/herdr-subagents/blob/94b8ac12db7b8184706372c96c199b4fb2a2f6bc/src/core/subagent.ts#L258) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return `Timed out waiting for subagent ${name} — nothing new; re-arm the wait`;
```

- **astrofoundry/pi-astro** — **unknown**: snapshot retrieval failed (`git ls-remote` could not retrieve HEAD).

### Inventory: avtc/avtc-pi

Snapshot: `e6aa704467b33c0c195f703b6602b348dffaf253` ([source tree](https://github.com/avtc/avtc-pi/tree/e6aa704467b33c0c195f703b6602b348dffaf253)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: avtc/avtc-pi-ask-user-question

Snapshot: `da1df191b7db4e50696294e360ea6f7f86bb5603` ([source tree](https://github.com/avtc/avtc-pi-ask-user-question/tree/da1df191b7db4e50696294e360ea6f7f86bb5603)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: avtc/avtc-pi-subagent

Snapshot: `b8ba4497bd99034ebeb397ca22f66f1b489e5869` ([source tree](https://github.com/avtc/avtc-pi-subagent/tree/b8ba4497bd99034ebeb397ca22f66f1b489e5869)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/process-runner.ts:146](https://github.com/avtc/avtc-pi-subagent/blob/b8ba4497bd99034ebeb397ca22f66f1b489e5869/src/process-runner.ts#L146) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

- **awoaCrim/pi-smart-subagents** — `33c7736f69792b3df5ddf8a73a7240f85b7f1437`; detailed contract above.

- **azmeenafandi/brl-subagent** — `7fa210c684666dca9ab2ed797430d74937d73c7b`; detailed contract above.

### Inventory: bacnh85/pi-extensions

Snapshot: `85233b0ea14aa62104593140f9788bcb083e10e4` ([source tree](https://github.com/bacnh85/pi-extensions/tree/85233b0ea14aa62104593140f9788bcb083e10e4)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[pi-a2a/extensions/lib/client.ts:941](https://github.com/bacnh85/pi-extensions/blob/85233b0ea14aa62104593140f9788bcb083e10e4/pi-a2a/extensions/lib/client.ts#L941) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

[pi-cron/extensions/index.ts:398](https://github.com/bacnh85/pi-extensions/blob/85233b0ea14aa62104593140f9788bcb083e10e4/pi-cron/extensions/index.ts#L398) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const pin = isPinned(job) ? ` Runs headless (${[job.model, job.thinking].filter(Boolean).join(", thinking ")}) — result arrives as a follow-up.` : "";
```

[pi-cron/extensions/index.ts:435](https://github.com/bacnh85/pi-extensions/blob/85233b0ea14aa62104593140f9788bcb083e10e4/pi-cron/extensions/index.ts#L435) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
content: [{ type: "text" as const, text: `Job '${job.name}' fired manually — result arrives as a follow-up turn.` }],
```

- **bermudi/pi-delegate** — `9474efa5a8e15e1808995ddc466de27c19e7d87e`; detailed contract above.

- **boadij/pi-herdsman** — `0dc62d39b63afe2d273d687b9e49e7114f2fcfa3`; detailed contract above.

### Inventory: btnalit/pi-claude-supervisor

Snapshot: `b4bb837f882374987c033812959eee794050d1d2` ([source tree](https://github.com/btnalit/pi-claude-supervisor/tree/b4bb837f882374987c033812959eee794050d1d2)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/verifier.ts:293](https://github.com/btnalit/pi-claude-supervisor/blob/b4bb837f882374987c033812959eee794050d1d2/src/verifier.ts#L293) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const result = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 4096, signal, env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }) });
```

[src/decision-worker.ts:496](https://github.com/btnalit/pi-claude-supervisor/blob/b4bb837f882374987c033812959eee794050d1d2/src/decision-worker.ts#L496) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
verify. Choose wait when the Worker's result says it is waiting for its own background agents,
```

[src/decision-worker.ts:526](https://github.com/btnalit/pi-claude-supervisor/blob/b4bb837f882374987c033812959eee794050d1d2/src/decision-worker.ts#L526) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
length of one build-and-test cycle), stop waiting on long background work: use continue or
```

- **casualjim/pi-mimir** — `9e68ca8f868210b50449d60d3136d25ac253de48`; detailed contract above.

### Inventory: catlain/pi-workflow

Snapshot: `2c9f516ea8bb7c089caba11f4ea42c17c7a58177` ([source tree](https://github.com/catlain/pi-workflow/tree/2c9f516ea8bb7c089caba11f4ea42c17c7a58177)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **championswimmer/pi-subagent-manager** — `092627be6f3696b3897767d896ef7309c01e48ca`; detailed contract above.

### Inventory: chankov/agent-fleet

Snapshot: `0af843fa2c92413ea16c50e50bd8a9e24f1d1995` ([source tree](https://github.com/chankov/agent-fleet/tree/0af843fa2c92413ea16c50e50bd8a9e24f1d1995)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[.pi/harnesses/lib/context-budget-child-prompt.ts:32](https://github.com/chankov/agent-fleet/blob/0af843fa2c92413ea16c50e50bd8a9e24f1d1995/.pi/harnesses/lib/context-budget-child-prompt.ts#L32) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
ask the user. Pause for research instead: end your turn with one or more lines of the
```

[.versions/2.0.3/.pi/harnesses/lib/context-budget-child-prompt.ts:31](https://github.com/chankov/agent-fleet/blob/0af843fa2c92413ea16c50e50bd8a9e24f1d1995/.versions/2.0.3/.pi/harnesses/lib/context-budget-child-prompt.ts#L31) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
ask the user. Pause for research instead: end your turn with one or more lines of the
```

[.versions/2.0.4/.pi/harnesses/lib/context-budget-child-prompt.ts:31](https://github.com/chankov/agent-fleet/blob/0af843fa2c92413ea16c50e50bd8a9e24f1d1995/.versions/2.0.4/.pi/harnesses/lib/context-budget-child-prompt.ts#L31) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
ask the user. Pause for research instead: end your turn with one or more lines of the
```

[.pi/harnesses/coms/index.ts:228](https://github.com/chankov/agent-fleet/blob/0af843fa2c92413ea16c50e50bd8a9e24f1d1995/.pi/harnesses/coms/index.ts#L228) — wait/await registration **candidate**:

```ts
name: "coms_await",
```

[.pi/harnesses/agent-hub/tools/coms-tools.ts:115](https://github.com/chankov/agent-fleet/blob/0af843fa2c92413ea16c50e50bd8a9e24f1d1995/.pi/harnesses/agent-hub/tools/coms-tools.ts#L115) — wait/await registration **candidate**:

```ts
name: "coms_await",
```

### Inventory: chaochaoxiaochao/pi-toolkit

Snapshot: `77eea9181b4bfda08a924db5fec3aa653feb4e62` ([source tree](https://github.com/chaochaoxiaochao/pi-toolkit/tree/77eea9181b4bfda08a924db5fec3aa653feb4e62)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/herdr-subagents/src/history.ts:85](https://github.com/chaochaoxiaochao/pi-toolkit/blob/77eea9181b4bfda08a924db5fec3aa653feb4e62/packages/herdr-subagents/src/history.ts#L85) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const runDirectory = await findRunDirectory(join(cwd, ".pi", "herdr-subagents", "runs"), runId);
```

[packages/herdr-subagents/src/queued-runs.ts:15](https://github.com/chaochaoxiaochao/pi-toolkit/blob/77eea9181b4bfda08a924db5fec3aa653feb4e62/packages/herdr-subagents/src/queued-runs.ts#L15) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await writeJsonAtomic(join(directory, `${runId}.json`), { runId, cwd, ...ownerRecord(owner), params: { ...params, background: true }, queuedAt: new Date().toISOString() });
```

[packages/herdr-subagents/src/queued-runs.ts:65](https://github.com/chaochaoxiaochao/pi-toolkit/blob/77eea9181b4bfda08a924db5fec3aa653feb4e62/packages/herdr-subagents/src/queued-runs.ts#L65) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await writeJsonAtomic(join(directory, "task.json"), { id, runId: queued.runId, order: index + 1, name: task.name, prompt: task.prompt, agent: task.agent ?? "worker", model: task.model, status: "cancelled", error: reason, sessionFile: join(directory, "session.jsonl"), startedAt: queued.queuedAt, completedAt: now });
```

### Inventory: comput-sh/pi-intercom

Snapshot: `ca508706f3e6ad5ef5d6a3c105dcfd4423939cff` ([source tree](https://github.com/comput-sh/pi-intercom/tree/ca508706f3e6ad5ef5d6a3c105dcfd4423939cff)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/runtime.ts:450](https://github.com/comput-sh/pi-intercom/blob/ca508706f3e6ad5ef5d6a3c105dcfd4423939cff/src/runtime.ts#L450) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await this.transmit(target.name, operation === 'reload_worker' ? 'reload' : 'request_status');
```

[src/runtime.ts:455](https://github.com/comput-sh/pi-intercom/blob/ca508706f3e6ad5ef5d6a3c105dcfd4423939cff/src/runtime.ts#L455) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
if (this.resumeFences.has(target.sessionId)) fail('Resume already in flight or awaiting worker status; outcome may be uncertain. Inspect the worker before any retry; no automatic relaunch.');
```

[src/handoff.ts:276](https://github.com/comput-sh/pi-intercom/blob/ca508706f3e6ad5ef5d6a3c105dcfd4423939cff/src/handoff.ts#L276) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await this.finish(p, result.paneClosed && result.workerExited ? 'closed' : 'uncertain', result.paneClosed && result.workerExited ? undefined : 'close_unverified');
```

- **d3ara1n/pi-extensions** — `bd6d2577e0f783c9a29074cc7a4f11fcd3038cb9`; detailed contract above.

### Inventory: damupi/pi-subagents-compatible

Snapshot: `f6f969ba260bef1a305f6d1ac4cf26bfbdd79d82` ([source tree](https://github.com/damupi/pi-subagents-compatible/tree/f6f969ba260bef1a305f6d1ac4cf26bfbdd79d82)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: danielcherubini/pi-archimedes

Snapshot: `b8a531ffae2e84aebb61b0d763a2d44e20682e24` ([source tree](https://github.com/danielcherubini/pi-archimedes/tree/b8a531ffae2e84aebb61b0d763a2d44e20682e24)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **deathbeam/pi-packages** — `452a9062f845e7fafaf9c16f18db1e22a5aa0442`; detailed contract above.

### Inventory: default-anton/pi-finder

Snapshot: `be44e311a0d35f57b44058f45a5e824fc48a05fe` ([source tree](https://github.com/default-anton/pi-finder/tree/be44e311a0d35f57b44058f45a5e824fc48a05fe)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: default-anton/pi-librarian

Snapshot: `021057b5d50d0593b9e245076ae646c4c9e29146` ([source tree](https://github.com/default-anton/pi-librarian/tree/021057b5d50d0593b9e245076ae646c4c9e29146)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: diegopetrucci/pi-extensions

Snapshot: `c5f13811cdccb9970e052ae003f7bb5975023029` ([source tree](https://github.com/diegopetrucci/pi-extensions/tree/c5f13811cdccb9970e052ae003f7bb5975023029)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: eachann1024/pi-jev-route

Snapshot: `f2f75f051edba9229c09ef7a1c94b26bea7f03f3` ([source tree](https://github.com/eachann1024/pi-jev-route/tree/f2f75f051edba9229c09ef7a1c94b26bea7f03f3)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **edxeth/pi-subagents** — `cf6dbf41c17986f3882e6804a68e8fb8282d25e6`; detailed contract above.

### Inventory: eggmasonvalue/pi-subagent

Snapshot: `f0f3094a9d0abf13c5235ef82009238bce9474e4` ([source tree](https://github.com/eggmasonvalue/pi-subagent/tree/f0f3094a9d0abf13c5235ef82009238bce9474e4)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: evo-hq/evo

Snapshot: `c70c04b4d2da2f2deb95d1d185b07d88d24f2ea7` ([source tree](https://github.com/evo-hq/evo/tree/c70c04b4d2da2f2deb95d1d185b07d88d24f2ea7)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[plugins/evo/npm/extensions/evo/index.js:298](https://github.com/evo-hq/evo/blob/c70c04b4d2da2f2deb95d1d185b07d88d24f2ea7/plugins/evo/npm/extensions/evo/index.js#L298) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
` + "If you need to wait for subagents to finish, use `evo wait` — it blocks\n" + `until any experiment concludes, max 1h.
```

### Inventory: evoclock/pi-agentic-driver

Snapshot: `9fc05b8a73745c694ec81d2da3b8aac1a8542042` ([source tree](https://github.com/evoclock/pi-agentic-driver/tree/9fc05b8a73745c694ec81d2da3b8aac1a8542042)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: fallanic/pi-streamline

Snapshot: `28b2fc496bef4e44add39bcf8d5119a50edbe38d` ([source tree](https://github.com/fallanic/pi-streamline/tree/28b2fc496bef4e44add39bcf8d5119a50edbe38d)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **ferdousbhai/pi-muse-bridge** — **unknown**: snapshot retrieval failed (`git ls-remote` could not retrieve HEAD).

- **fitchmultz/pi-subagents** — `d6a614c194bdbc14f49d5e0f52e2e4329a01ae0e`; detailed contract above.

### Inventory: gee666/pi-subagent

Snapshot: `68b529e729f8786cd227f69cb2f4b71019e31234` ([source tree](https://github.com/gee666/pi-subagent/tree/68b529e729f8786cd227f69cb2f4b71019e31234)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[shared.ts:95](https://github.com/gee666/pi-subagent/blob/68b529e729f8786cd227f69cb2f4b71019e31234/shared.ts#L95) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(Array.from({ length: limit }, () => worker()));
```

[extension/broadcast.ts:189](https://github.com/gee666/pi-subagent/blob/68b529e729f8786cd227f69cb2f4b71019e31234/extension/broadcast.ts#L189) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const choice = await ctx.ui.select("Broadcast this steering message to subagents?", [
```

[runner/single.ts:261](https://github.com/gee666/pi-subagent/blob/68b529e729f8786cd227f69cb2f4b71019e31234/runner/single.ts#L261) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await updateNameRecord(opts.namesFile, opts.subagentName, {
```

### Inventory: georgeharker/pi-acp

Snapshot: `03fe96c064137fa141334baee3fc07ebc3c5097e` ([source tree](https://github.com/georgeharker/pi-acp/tree/03fe96c064137fa141334baee3fc07ebc3c5097e)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: glacayo/tps-gentle-pi

Snapshot: `fdee948b3e1fab44eb60b2e4afcc40c827c14077` ([source tree](https://github.com/glacayo/tps-gentle-pi/tree/fdee948b3e1fab44eb60b2e4afcc40c827c14077)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **gotgenes/pi-packages** — `806a5a73afeb50142c3963e185ac6101bc1aa18a`; detailed contract above.

### Inventory: gszj2018/pi-subagent-permission-compat

Snapshot: `3dcde4a4331cd23371da5e81a45b5adfda166aa3` ([source tree](https://github.com/gszj2018/pi-subagent-permission-compat/tree/3dcde4a4331cd23371da5e81a45b5adfda166aa3)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: guygrigsby/pi-extensions

Snapshot: `00959f0cd147d1ae2f2379475498c990c0874756` ([source tree](https://github.com/guygrigsby/pi-extensions/tree/00959f0cd147d1ae2f2379475498c990c0874756)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **heyhuynhgiabuu/pi-task** — `7eb559a5f82138760e1ff676b3d6f7f7e042f919`; detailed contract above.

- **hheei/hepi-mono** — `c6d2318688bd0132b70598d2ebc3edb4cfde45eb`; detailed contract above.

### Inventory: hu3rror/pi-matt-subagent

Snapshot: `92a73bad8d35b942e5473864c40d1501d09f5dfd` ([source tree](https://github.com/hu3rror/pi-matt-subagent/tree/92a73bad8d35b942e5473864c40d1501d09f5dfd)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/subagent.ts:370](https://github.com/hu3rror/pi-matt-subagent/blob/92a73bad8d35b942e5473864c40d1501d09f5dfd/extensions/subagent.ts#L370) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
```

[extensions/subagent.ts:872](https://github.com/hu3rror/pi-matt-subagent/blob/92a73bad8d35b942e5473864c40d1501d09f5dfd/extensions/subagent.ts#L872) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const ok = await ctx.ui.confirm("Stop subagent run?", `Stop ${runRef(run)}? Partial findings stay on disk.`);
```

[extensions/subagent.ts:1105](https://github.com/hu3rror/pi-matt-subagent/blob/92a73bad8d35b942e5473864c40d1501d09f5dfd/extensions/subagent.ts#L1105) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const id = await pickRun(ctx, "Show log for which run?", subagentRuns.snapshot().filter((r) => r.logPath != null));
```

### Inventory: ilovepixelart/pi-code

Snapshot: `e10b3ef3bc14883e89a172e309f35c8281bef874` ([source tree](https://github.com/ilovepixelart/pi-code/tree/e10b3ef3bc14883e89a172e309f35c8281bef874)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/skills.ts:200](https://github.com/ilovepixelart/pi-code/blob/e10b3ef3bc14883e89a172e309f35c8281bef874/extensions/skills.ts#L200) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
ctx.ui.notify(`Skill ${fork.name} is running in a forked subagent in the background; its result arrives here when it completes.`, 'info')
```

[extensions/subagent/concurrency.ts:18](https://github.com/ilovepixelart/pi-code/blob/e10b3ef3bc14883e89a172e309f35c8281bef874/extensions/subagent/concurrency.ts#L18) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
results[current] = await fn(items[current], current) // NOSONAR typescript:S9382 - each worker of the pool runs its items one at a time
```

[extensions/subagent/concurrency.ts:21](https://github.com/ilovepixelart/pi-code/blob/e10b3ef3bc14883e89a172e309f35c8281bef874/extensions/subagent/concurrency.ts#L21) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers)
```

- **ismailsaleekh/pi-background-tasks** — `799182ff65d7040732aea23b2001ea860b688531`; detailed contract above.

### Inventory: itc-steve/pi-herdr

Snapshot: `e0a9d700fcdf161391c6db9b12a6b58f6502f59f` ([source tree](https://github.com/itc-steve/pi-herdr/tree/e0a9d700fcdf161391c6db9b12a6b58f6502f59f)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/handoff.ts:135](https://github.com/itc-steve/pi-herdr/blob/e0a9d700fcdf161391c6db9b12a6b58f6502f59f/src/handoff.ts#L135) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"Messages arrive after a model/tool turn, not while a tool is running. Do not wait indefinitely or poll for answers. Continue independent work or report the blocker to the parent. Finished workers cannot restart. Budget: 20 outgoing notes, 4096 UTF-8 bytes each.");
```

- **j0k3r-dev-rgl/pi-subagents-j0k3r** — `66f562ef7e15bc3fc1f9136d1b31faf4c20fb214`; detailed contract above.

- **jjuraszek/pi-cohort** — `d038341409e8832c67269b34b8a34749b989cef1`; detailed contract above.

### Inventory: jjuraszek/pi-gauntlet

Snapshot: `b928becaedd25742bf447488bc15561187f3b6f2` ([source tree](https://github.com/jjuraszek/pi-gauntlet/tree/b928becaedd25742bf447488bc15561187f3b6f2)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: jmcombs/pi-extensions

Snapshot: `4e4880481b5c8ce47b6cffc084efe98f8d055c3d` ([source tree](https://github.com/jmcombs/pi-extensions/tree/4e4880481b5c8ce47b6cffc084efe98f8d055c3d)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/prompt-enhancer/acceptance/run-matrix.ts:1097](https://github.com/jmcombs/pi-extensions/blob/4e4880481b5c8ce47b6cffc084efe98f8d055c3d/packages/prompt-enhancer/acceptance/run-matrix.ts#L1097) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

### Inventory: k3dom/pi-plugins

Snapshot: `07d57cb26f5af4be936450ecc763c12cf296ab58` ([source tree](https://github.com/k3dom/pi-plugins/tree/07d57cb26f5af4be936450ecc763c12cf296ab58)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: kalindudc/pi-minions

Snapshot: `497f2f791496397ef0a96ec24d34247c7a23ec12` ([source tree](https://github.com/kalindudc/pi-minions/tree/497f2f791496397ef0a96ec24d34247c7a23ec12)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **kvidzibo/pi-delegate** — `b196978922e34b0dac77896138699f2ea75a25f5`; detailed contract above.

### Inventory: leo-alvarenga/pi-mono

Snapshot: `2d2aa30a37ced022c5d9b612d7f0c5a8d6c81901` ([source tree](https://github.com/leo-alvarenga/pi-mono/tree/2d2aa30a37ced022c5d9b612d7f0c5a8d6c81901)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[libs/pi-ext-core/src/utils/concurrency.ts:22](https://github.com/leo-alvarenga/pi-mono/blob/2d2aa30a37ced022c5d9b612d7f0c5a8d6c81901/libs/pi-ext-core/src/utils/concurrency.ts#L22) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(workers);
```

- **mavam/pi-agents** — `a99f4ed8f1b07ee8ad43c564b9ce82e85064ec00`; detailed contract above.

### Inventory: milanglacier/pi-dynamic-workflow

Snapshot: `b4d6492a9bf3ac7dade7bd24b352e87e30c40252` ([source tree](https://github.com/milanglacier/pi-dynamic-workflow/tree/b4d6492a9bf3ac7dade7bd24b352e87e30c40252)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: mjakl/pi-subagent

Snapshot: `77cc8be9a4257c00643f328d461a7ab2c1490686` ([source tree](https://github.com/mjakl/pi-subagent/tree/77cc8be9a4257c00643f328d461a7ab2c1490686)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[runner.ts:929](https://github.com/mjakl/pi-subagent/blob/77cc8be9a4257c00643f328d461a7ab2c1490686/runner.ts#L929) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
await Promise.all(Array.from({ length: limit }, () => worker()));
```

### Inventory: mjasnikovs/pi-task

Snapshot: `6c17b74977d6feaa3dc95ed335535a709d871363` ([source tree](https://github.com/mjasnikovs/pi-task/tree/6c17b74977d6feaa3dc95ed335535a709d871363)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/task/phases.ts:906](https://github.com/mjasnikovs/pi-task/blob/6c17b74977d6feaa3dc95ed335535a709d871363/src/task/phases.ts#L906) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const sections = await runResearchStage(workerSpecs, drive, getConfig().researchConcurrency)
```

### Inventory: mojomanyana/pi-daddy

Snapshot: `cb49ed9189110ee237cf31a06f3d03a1c3b3dceb` ([source tree](https://github.com/mojomanyana/pi-daddy/tree/cb49ed9189110ee237cf31a06f3d03a1c3b3dceb)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/pi-daddy/src/governance/workspace-lease.ts:253](https://github.com/mojomanyana/pi-daddy/blob/cb49ed9189110ee237cf31a06f3d03a1c3b3dceb/packages/pi-daddy/src/governance/workspace-lease.ts#L253) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
(!(await matchesWorkerWorkspace(previous.captured_worker, input.workspace.root)) ||
```

[packages/pi-daddy/src/governance/workspace-lease.ts:254](https://github.com/mojomanyana/pi-daddy/blob/cb49ed9189110ee237cf31a06f3d03a1c3b3dceb/packages/pi-daddy/src/governance/workspace-lease.ts#L254) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
!(await readCapturedWorkerReceipt(previous.captured_worker)))) ||
```

[packages/pi-daddy/src/governance/workspace-lease.ts:434](https://github.com/mojomanyana/pi-daddy/blob/cb49ed9189110ee237cf31a06f3d03a1c3b3dceb/packages/pi-daddy/src/governance/workspace-lease.ts#L434) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const receipt = await readCapturedWorkerReceipt(metadata.captured_worker);
```

### Inventory: mystilleef/pi-subagent

Snapshot: `952e16464401ceaff9084206ebf92343937ed0c3` ([source tree](https://github.com/mystilleef/pi-subagent/tree/952e16464401ceaff9084206ebf92343937ed0c3)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/orchestration/cancel-command.ts:23](https://github.com/mystilleef/pi-subagent/blob/952e16464401ceaff9084206ebf92343937ed0c3/src/orchestration/cancel-command.ts#L23) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const selection = await ctx.ui.select("Cancel subagent", options);
```

- **narumiruna/pi-extensions** — `45779b3c6d68ba57709b2de81f67faefe7bfe45e`; detailed contract above.

### Inventory: nicknisi/pi-extensions

Snapshot: `1e338d3d42fe06f275d72864d9aceac678e97799` ([source tree](https://github.com/nicknisi/pi-extensions/tree/1e338d3d42fe06f275d72864d9aceac678e97799)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/llm-council/index.ts:359](https://github.com/nicknisi/pi-extensions/blob/1e338d3d42fe06f275d72864d9aceac678e97799/packages/llm-council/index.ts#L359) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const result = await subagents.spawn({
```

[packages/llm-council/index.ts:424](https://github.com/nicknisi/pi-extensions/blob/1e338d3d42fe06f275d72864d9aceac678e97799/packages/llm-council/index.ts#L424) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const chairmanResult = await subagents.spawn({
```

- **nicobailon/pi-subagents** — `a4c8ced69a8176cdf4179b127feddc8875e3418f`; detailed contract above.

### Inventory: nilskluewer/pi-subagent

Snapshot: `1e60fb3dd68e6e695f461d795399d2692b018c47` ([source tree](https://github.com/nilskluewer/pi-subagent/tree/1e60fb3dd68e6e695f461d795399d2692b018c47)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[extensions/subagent/index.ts:100](https://github.com/nilskluewer/pi-subagent/blob/1e60fb3dd68e6e695f461d795399d2692b018c47/extensions/subagent/index.ts#L100) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"For fan-out, chaining, or merging many subagent results, write one `codemode` script: `await Promise.all(items.map(i => tools.subagent({ task: ... })))` and return only the merged summary. Each result has `text`, `cost`, `status`, `sessionId`.",
```

- **nlbwqmz/wj-pi-subagents** — `6569131b88ffa38353a951753d9d5b6f0983b28a`; detailed contract above.

- **noguerol/trimegisto** — `75d5d51ef5cfb8e9ed7854f9dff9af458e2f6705`; detailed contract above.

- **pifydev/subagent** — `788513828564d72df3dde07560df60ca4e8cd3a5`; detailed contract above.

- **prjct-app/pi-subagents** — `9020f8e1dbe4ff1887b16d206a3b1c837527d09b`; detailed contract above.

### Inventory: qaml-ai/pi-coding-agent-worker

Snapshot: `d6c8a19c7dfe61f675501216472a1063e94fc938` ([source tree](https://github.com/qaml-ai/pi-coding-agent-worker/tree/d6c8a19c7dfe61f675501216472a1063e94fc938)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: qaml-ai/pi-coding-agent-worker-package

Snapshot: `6c85f037de7e4d387311aeb9acf28928ae45c07b` ([source tree](https://github.com/qaml-ai/pi-coding-agent-worker-package/tree/6c85f037de7e4d387311aeb9acf28928ae45c07b)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: rfxlamia/pocketto

Snapshot: `cc48675a35c7760b921a1c05b699cca002d92e05` ([source tree](https://github.com/rfxlamia/pocketto/tree/cc48675a35c7760b921a1c05b699cca002d92e05)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[test-support/lifecycle-dispatch/concurrent-mutations.js:152](https://github.com/rfxlamia/pocketto/blob/cc48675a35c7760b921a1c05b699cca002d92e05/test-support/lifecycle-dispatch/concurrent-mutations.js#L152) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
assert.equal(await waitForFile(fixture.deliveryReadPath, 5000), true, 'delivery worker must pause after reading lifecycle.json');
```

[test-support/lifecycle-dispatch/concurrent-mutations.js:154](https://github.com/rfxlamia/pocketto/blob/cc48675a35c7760b921a1c05b699cca002d92e05/test-support/lifecycle-dispatch/concurrent-mutations.js#L154) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
assert.equal(await waitForFile(fixture.transitionStartedPath, 5000), true, 'transition worker must start');
```

[test-support/lifecycle-dispatch/concurrent-mutations.js:158](https://github.com/rfxlamia/pocketto/blob/cc48675a35c7760b921a1c05b699cca002d92e05/test-support/lifecycle-dispatch/concurrent-mutations.js#L158) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const transitionResult = await workers[1].done;
```

### Inventory: rhinos0608/Pi-Subagents

Snapshot: `31030d936b49c9b72207f7bed2f04759c9e69e68` ([source tree](https://github.com/rhinos0608/Pi-Subagents/tree/31030d936b49c9b72207f7bed2f04759c9e69e68)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[install.mjs:90](https://github.com/rhinos0608/Pi-Subagents/blob/31030d936b49c9b72207f7bed2f04759c9e69e68/install.mjs#L90) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
• bg_wait - Wait for background/provider/detached work without native completion notifications
```

[src/extension/tool-description.ts:10](https://github.com/rhinos0608/Pi-Subagents/blob/31030d936b49c9b72207f7bed2f04759c9e69e68/src/extension/tool-description.ts#L10) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
Scripts are JavaScript statement bodies with explicit return and top-level await. Await runs.run(key,{agent,task}) before .output; await runs.all([{key,agent,task},...]) for an ordered array, not a key map. Pass worktree:true on a workflow child for its own managed worktree (needs a clean git tree). Observe every stored run promise with direct await, Promise.race, or Promise.all. Each subagent starts with fresh context: put the files, constraints, and success criteria it needs in its task. Do not hand one subagent a monolithic task; stage work sequentially or fan out across independent seams/files. Children sharing a cwd share its working tree. If writers may touch overlapping files and git status is clean, pass worktree:true on each workflow writer child; for single {agent,task} launches (no worktree field) create a worktree and pass it as the child's cwd; otherwise give each writer disjoint file ownership in the shared checkout, unless restricted to a single writer per cwd. Inspect owned runs with {action:"status",id}; control them with interrupt/resume/steer; check scripts offline with {action:"validate",workflowScript}. Read {action:"guide",topic:"tool-reference"} for controls and evidence gates, {action:"guide",topic:"workflows"} before advanced orchestration. On workflow, launch, or tooling failure: stop, report the exact failure plus run/status and repo/cwd/worktree evidence, and never silently switch execution modes without owner approval. Never include secrets in tasks or scripts.`;
```

[src/extension/index.ts:68](https://github.com/rhinos0608/Pi-Subagents/blob/31030d936b49c9b72207f7bed2f04759c9e69e68/src/extension/index.ts#L68) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
import { createWaitSubscriptionManager } from "../runs/background/wait-subscriptions.ts";
```

### Inventory: ross-jill-ws/pi-subagent-in-memory

Snapshot: `de649363a5e6726d981ff595e59cb594d16659d0` ([source tree](https://github.com/ross-jill-ws/pi-subagent-in-memory/tree/de649363a5e6726d981ff595e59cb594d16659d0)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

- **signalridge/pi-extensions** — `3ebe4317de18de0a724d88ea7a59e3360d04539b`; detailed contract above.

- **smithyyang/pi-subagent-lite** — `f8459f8ed6cce2a2cb8efc3dc9018c53d0da5a5f`; detailed contract above.

### Inventory: soringfs/pi-task-dispatcher

Snapshot: `6b30b511e5e1999ead4dacaef374d45ba91b6617` ([source tree](https://github.com/soringfs/pi-task-dispatcher/tree/6b30b511e5e1999ead4dacaef374d45ba91b6617)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

No targeted runtime wording/registration match was selected. This is not proof of absence; this candidate may be synchronous, human-command-only, unrelated to delegation, or use a differently named interface.

### Inventory: soyunninja/kankaku

Snapshot: `34c5d24f096fdfc385f5aedb192ecbbc70afb34e` ([source tree](https://github.com/soyunninja/kankaku/tree/34c5d24f096fdfc385f5aedb192ecbbc70afb34e)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/cli/src/domain/today-model.ts:52](https://github.com/soyunninja/kankaku/blob/34c5d24f096fdfc385f5aedb192ecbbc70afb34e/packages/cli/src/domain/today-model.ts#L52) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const waitingMs = summary.orchestrator.waitingMs + summary.subagent.waitingMs;
```

### Inventory: thestuntcoder/pi-long-task

Snapshot: `4a16d88b7ef96c569ca12ac596422088cb1248f9` ([source tree](https://github.com/thestuntcoder/pi-long-task/tree/4a16d88b7ef96c569ca12ac596422088cb1248f9)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/coordinator.ts:640](https://github.com/thestuntcoder/pi-long-task/blob/4a16d88b7ef96c569ca12ac596422088cb1248f9/src/coordinator.ts#L640) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
this.retained.contextUsagePercent = await workerSessionContextUsagePercent(this.retained.resource.session);
```

[src/coordinator.ts:939](https://github.com/thestuntcoder/pi-long-task/blob/4a16d88b7ef96c569ca12ac596422088cb1248f9/src/coordinator.ts#L939) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
return await options.run(workerOptions);
```

[src/coordinator.ts:952](https://github.com/thestuntcoder/pi-long-task/blob/4a16d88b7ef96c569ca12ac596422088cb1248f9/src/coordinator.ts#L952) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const initial = await execute(options.workerOptions);
```

### Inventory: tinoy1336/pi-extensions

Snapshot: `9c8aac98d4aae53e1214f190d955f720cafcd97b` ([source tree](https://github.com/tinoy1336/pi-extensions/tree/9c8aac98d4aae53e1214f190d955f720cafcd97b)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[packages/io-guard/index.ts:309](https://github.com/tinoy1336/pi-extensions/blob/9c8aac98d4aae53e1214f190d955f720cafcd97b/packages/io-guard/index.ts#L309) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const got = await tryAcquire(IO_ROOT, path, { worker: me.worker, pid: process.pid });
```

[packages/io-guard/index.ts:412](https://github.com/tinoy1336/pi-extensions/blob/9c8aac98d4aae53e1214f190d955f720cafcd97b/packages/io-guard/index.ts#L412) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const acquired = await tryAcquireWithGrace(IO_ROOT, path, { worker, pid: process.pid });
```

[packages/io-guard/index.ts:414](https://github.com/tinoy1336/pi-extensions/blob/9c8aac98d4aae53e1214f190d955f720cafcd97b/packages/io-guard/index.ts#L414) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
hookLog("io-guard", "park-waiting", { worker, path, id: entry.id, writer: entry.worker });
```

- **tintinweb/pi-subagents** — `ca93a5247e72e7053fcd10bea7125d6c4205f949`; detailed contract above.

### Inventory: trvon/pi-loop

Snapshot: `a6d7772a8f5a220d31f6d87224b02bcade4da1bd` ([source tree](https://github.com/trvon/pi-loop/tree/a6d7772a8f5a220d31f6d87224b02bcade4da1bd)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/tools/monitor-tools.ts:86](https://github.com/trvon/pi-loop/blob/a6d7772a8f5a220d31f6d87224b02bcade4da1bd/src/tools/monitor-tools.ts#L86) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
renderResult: renderToolResult, description: `Run a long command in the background while the agent continues. Use MonitorList for status/output; do not poll with shell sleep loops.\n\nThe timeout measures inactivity, not total runtime: output or structured progress renews it. Stale-monitor wakes require an unexpired callback. Pass onDone for a completion wake, or workflowId to pause a workflow until terminal. Commands may emit JSONL progress as {"progress":{...}}; otherwise use MonitorUpdate.`, promptGuidelines: ["Use MonitorCreate for builds, CI checks, experiments, and other commands that need not block the turn.", "Use onDone for terminal wakes; timeout alerts require an unexpired callback.", "For an active workflow, use workflowId instead of onDone and await its completion wake."], parameters: Type.Object({
```

[src/tools/monitor-tools.ts:142](https://github.com/trvon/pi-loop/blob/a6d7772a8f5a220d31f6d87224b02bcade4da1bd/src/tools/monitor-tools.ts#L142) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
workflowMsg = `\nWorkflow #${attached.id} is waiting on monitor #${entry.id} — no polling needed`;
```

[src/tools/monitor-tools.ts:152](https://github.com/trvon/pi-loop/blob/a6d7772a8f5a220d31f6d87224b02bcade4da1bd/src/tools/monitor-tools.ts#L152) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
onDoneMsg = `\nCompletion wake loop #${doneLoop.id}: fires when the monitor completes — no polling needed`;
```

### Inventory: tuansondinh/pi-fast-subagent

Snapshot: `559cc175447b25d1a162cf436875f0c60ac569be` ([source tree](https://github.com/tuansondinh/pi-fast-subagent/tree/559cc175447b25d1a162cf436875f0c60ac569be)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[index.ts:248](https://github.com/tuansondinh/pi-fast-subagent/blob/559cc175447b25d1a162cf436875f0c60ac569be/index.ts#L248) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const selected = await ctx.ui.select("Active background subagents", options);
```

[index.ts:280](https://github.com/tuansondinh/pi-fast-subagent/blob/559cc175447b25d1a162cf436875f0c60ac569be/index.ts#L280) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
const selected = await ctx.ui.select("Cancel background subagent", options);
```

- **wangjq4214/pi-delegate** — `f79a4137c21125818a2359ce2cccec3ff8b291bf`; detailed contract above.

### Inventory: xvzc/pi-subagents-minimal

Snapshot: `d65b5bc9aebbe77e0dbf042924e635c79b1927f7` ([source tree](https://github.com/xvzc/pi-subagents-minimal/tree/d65b5bc9aebbe77e0dbf042924e635c79b1927f7)). Parent wording, wait/push ownership, and fetching guard: **unknown unless the specific evidence below establishes a narrower fact**.

[src/guidelines.ts:75](https://github.com/xvzc/pi-subagents-minimal/blob/d65b5bc9aebbe77e0dbf042924e635c79b1927f7/src/guidelines.ts#L75) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
stop issuing tool calls and end the turn.
```

[src/schemas.ts:90](https://github.com/xvzc/pi-subagents-minimal/blob/d65b5bc9aebbe77e0dbf042924e635c79b1927f7/src/schemas.ts#L90) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"Do not wait or repeatedly poll after new or resume; retrieve the full result with subagent_output when completion is signaled or the result is needed. Start dependent work only after prerequisite output is collected and found sufficient; assess failed or inadequate prerequisites before replanning. Independent work may run in parallel, but keep one writer per workspace unless workspaces are genuinely isolated. Completion delivery is best-effort.",
```

[src/index.ts:650](https://github.com/xvzc/pi-subagents-minimal/blob/d65b5bc9aebbe77e0dbf042924e635c79b1927f7/src/index.ts#L650) — runtime **candidate** (not independently verified as parent-injected in this triage entry):

```ts
"Read the observed output of a subagent session after its completion notification has been received. Do not use this tool to wait for or poll a running subagent.",
```

- **xynogen/pix-mono** — `4aa52bd260d41eab43ac65f7e364928250ee7ab3`; detailed contract above.

- **zachwill/pi-orchestrate** — `2800564bdee2785b694c857af09e5bd780955250`; detailed contract above.

### Additional discovery limits

The five repositories returned by the GitHub “subagent” repository-description search were fetched and source-triaged in the inventory; their unverified parent contracts remain **unknown**. Packages with no usable repository link in the npm result (including `@zhushanwen/pi-subagent-workflow`, `pi-subagent-feather`, `@melihmucuk/pi-crew`, `@fyeeme/pi-subagents`, `@kivlor/pi-subagents`, `@wangxiang0605/subagent`, and `henyo-pi-subagent`) are also **unknown**; a published npm tarball could be inspected in a follow-up. Package source checks did not cover every catalog result whose advertised purpose was not launching Pi child work (for example model-storage packages and vision-only bridges).

This report does not claim model compliance, does not rerun delivery tests, does not implement a tool blocker, and does not change extension code. The research note is left uncommitted.

