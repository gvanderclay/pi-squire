# Role task routing

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Role task routing (experimental)](#role-task-routing-experimental)
  - [Policy](#policy)
  - [Request metadata and selection](#request-metadata-and-selection)
  - [Launch hooks, evidence and limits](#launch-hooks-evidence-and-limits)
  - [Routed quota observations](#routed-quota-observations)

<a id="role-task-routing"></a>

## Role task routing (experimental)

This opt-in is shipped and experimental, not production-validated. It requires
a compatible pi-squire runtime; older versions do not provide it. It adds a
policy for agents that declare
`routing_profile` in frontmatter. The agent parser rejects a malformed
binding instead of ignoring it. An agent without that field keeps the legacy
selection and fallback behavior. A bound agent never silently inherits the
parent model: a missing or invalid required policy or request metadata
refuses the routed call before dispatch. Do not send routing metadata to an unbound agent.

### Policy

The strict v1 policy lives at `<agent dir>/squire/routing.json` (not in
`settings.json`). Its top-level shape is `version: 1`, `models`, `profiles`, and
optional `usage`. Model keys are exact physical `provider/id` names; each value
sets an explicit `family`, `data` (`any` or `public-only`), and optional model
`capabilities`. A profile names its rotation `pool`, may set
`independentReview`, and supplies one or more category routes. Each route has a
nonnegative integer `minQuality` and nonempty `candidates` with exact model,
requested `thinking`, nonnegative integer `quality`, and optional nonnegative
integer `priority`:

```json
{
  "version": 1,
  "models": {
    "provider/model-a": { "family": "lineage-a", "data": "any" },
    "provider/model-b": { "family": "lineage-b", "data": "public-only", "capabilities": ["vision"] }
  },
  "profiles": {
    "worker": {
      "pool": "general",
      "routes": {
        "standard": {
          "minQuality": 2,
          "candidates": [
            { "model": "provider/model-a", "thinking": "high", "quality": 3 },
            { "model": "provider/model-b", "thinking": "medium", "quality": 2, "priority": 1 }
          ]
        }
      }
    }
  }
}
```

This is an illustrative policy only; use physical models and lineage names
appropriate to your installation. Quality numbers are policy inputs, not
runtime benchmarks. A profile may omit categories it does not support;
requesting one without a route fails. Invalid versions, unknown fields,
missing model metadata and malformed candidates fail closed. Virtual/opaque
models are not route candidates. The legacy agent `fallback` list does not
widen a routed profile.

### Request metadata and selection

`delegate`, `delegation_resume` and `delegation_fork` accept an optional
`routing` object while the current roster contains an opted-in role. A legacy-only
roster keeps the compact legacy tool schema; startup and each run refresh the
routing schema from the roster. Command users pass the same object as
`--routing "<JSON>"`. When the interactive form selects a bound role and leaves
the model to the policy, it asks for this JSON. A model the user names in
`/delegate` (`--model`) or the form, with no `--routing`, launches the bound role
outside its routing profile, like a legacy agent with an explicit model: no
route, candidate check, data or review constraint, or fallbacks, and a notice
says so. Adding `--routing` keeps the model a policy candidate. The `delegate`
tool always routes a bound role, because there a model, not the user, chooses.
Resume and fork of such a delegation still need routing metadata. A bound call must provide `category` (`narrow`, `bounded`,
`standard` or `deep`) and `data` (`private`, `public` or `unknown`). For
example, these are illustrative request objects:

```json
{ "category": "standard", "data": "private" }
```

```json
{ "category": "bounded", "data": "public", "safePublicContext": true }
```

```json
{ "category": "standard", "data": "private", "review": { "authors": ["self"] } }
```

`safePublicContext: true` is an explicit attestation that the task,
instructions, inherited context, workspace and allowed tool reads are all
public-safe. It is not proof, sanitization or isolation. A `public-only` model
is eligible only with `data: "public"` and that attestation.

Optional `requirements` can state `contextTokens`, required `input` types
(`text`/`image`), literal required `tools`, and required model `capabilities`.
A required tool must exist as a known, non-hidden tool in the parent's catalogue
and be selected for the role; child-only discovery does not satisfy a declared
requirement. Normal child tool discovery still works for tools not declared as
requirements.

A profile requiring independent review, or a request with `review`, needs
`review.authors`: every source must be `self` (the parent's active branch) or a
known delegation id. Family names are not source references. Squire reads each
source's complete active-branch served-model history and excludes every mapped
author family before initial selection and each runtime substitution. Unknown sources or lineage fail
closed; if no qualified independent candidate remains, routing refuses rather
than lowering the bar.

Candidate constraints are applied before ranking: public-data eligibility,
quality floor, physical model availability and declared context/input/tool/
capability needs, plus any review-family exclusions. Lower numeric `priority`
comes first, then higher `quality`, then advisory quota pressure; an applicable
fresh exhausted quota excludes a candidate, while an unknown quota observation establishes neither exhaustion nor
headroom and is ignored. Genuine ties across distinct families rotate durably
and concurrently per root, pool and tied-family set. Multiple endpoints
in one family do not earn extra turns, and a launch with one qualified family
does not consume another family's tie turn.

`model` and `thinking` overrides remain available unless the agent locks the
field. An explicit model reduces the route to that single policy candidate; it
must still satisfy every hard constraint. A blank model/thinking choice for a
bound role uses the route policy rather than the parent model or effort. Pi may
clamp requested thinking to a model's supported level. Per-candidate requested
settings and initial effective levels are frozen; each substitution reapplies its
candidate's request and records the host's effective level. An availability switch
can move a routed run only to another still-eligible frozen candidate. Policy,
safety and refusal failures do not trigger that switch; this route fallback is
not a repair or escalation policy, and it never falls through to an
unrestricted legacy fallback or parent model.

Resume and fork require fresh routing metadata for a bound role, in the same
shape as `delegate`'s; their tool schemas declare only `category` and `data`
and point at `delegate`'s for the other fields. A previous
public-context attestation is never prefilled. They inspect the actual source
session file, even when an older delegation id names a session that was later
resumed. Any persisted routed history keeps the role's profile binding; removing
or changing it refuses rather than inheriting an older attempt's runtime state.
Unbound sessions with no routed history keep their legacy resume/fork behavior.

A public resume/fork requires every attempt on the source's active ancestry to
be public and attested. Messages, compactions or other context before its first
routing marker are unknown; branch summaries also require public-attested source
ancestry. Private or unknown inherited context cannot become public through a
new attestation. After launch preparation, a routed fork captures and validates
an owner-only source snapshot and passes that path to Pi's `--fork`. Later
changes to the original session cannot enter that copy, even when task mail
precedes the child's asynchronous file read. Squire rechecks the checked source
before task mail/open. Like prompt files, snapshots remain in the OS temporary
directory until cleanup and can contain sensitive context.

Pi forks copy the whole session file, including abandoned branches; only the
active context and referenced summaries are checked for public inheritance, not
arbitrary future reads of that file. This is not filesystem or process isolation.
The fresh route resolves the effective model/thinking choice under the same
hard constraints. Launch notices name the model actually admitted after tie
rotation and distinguish routed exclusions from legacy availability fallback.

### Launch hooks, evidence and limits

A routed launch freezes its candidate set, per-model effort, data and family
constraints, request, policy version/digest and usage applicability. Routed
`session:launch` mutations are validated before task mail is sent, including
when a host would otherwise open the window before delivery. A listener may add
unrelated flags and environment keys or narrow tools. It may not change model,
thinking, session identity/storage or consent/trust arguments, rewrite the
frozen routing environment or add an unrestricted fallback, broaden the
selected tool set, or remove a routing-required tool. A violation refuses the
launch before mail or window side effects.

Squire records physical assistant `provider/id` and effective thinking for each
attempt, with explicit attempt boundaries. `delegation_status` and message details record routing policy/reason, actual
served models/efforts, and independent family history. The model-facing result
prints `Served:` only when an attempt served a different or multiple models,
and prints `Independent review:` only when a review was requested (`verified`
or `unverified`, with its caller caveat) or when `not-required` provenance had
warnings. Review evidence covers exactly the
attempt after its marker, so an intermediate out-of-route model substitution
makes that attempt unverified; an unknown or incomplete history is also
unverified. Author exclusions are conservative across each source's full active
branch, not just the edits to the current artifact. Keep the candidate stable
while it is reviewed and identify every author source.

`family` is operator-supplied physical model lineage, not an endpoint-provider
inference or cryptographic/backend attestation. An active branch is not an
artifact-ownership ledger: this evidence cannot prove that the supplied author
list is exhaustive, that every earlier edit remains in the candidate, review
quality, or independent error modes. Manual/user/extension model changes are
not blocked by notification hooks; served history can expose an out-of-route
model, but this is not an OS sandbox or public-input isolation boundary. Evidence
covers persisted assistant messages, not arbitrary extensions' hidden or nested
model calls.

### Routed quota observations

The optional `usage` object has positive-millisecond `maxAgeMs` and an
explicit `applicableProviders` list of Pi provider names. The snapshot adapter
consumes cached `usage-status:snapshot` v1 data through the matching
`usage-status:request` event; that adapter does not poll, import provider code,
read credentials or make quota requests. Routed dispatch reuses existing
applicable proactive machinery for initial checks without a usable snapshot and
for limit-mark rechecks: direct-key Go requests and explicitly attested Claude
CLI checks/refreshes. Snapshots older than `maxAgeMs`,
missing, unavailable or inapplicable observations are unknown. Duration windows and safely scoped model
labels are matched to the routed provider/model. The provider list is frozen in
the routing record for runtime substitutions. Reactive usage-limit marks always
constrain routed candidates; direct-key Go proactive checks remain applicable,
while other CLI-derived proactive checks/marks require the provider to be
listed.
Set applicability only when that CLI account's observations describe the Pi
account too: Claude Code and Codex CLI caches can refer to different logins.
Without `usage.applicableProviders`, other providers' CLI observations are
inapplicable and ignored.

Legacy agents retain the existing proactive and fallback behavior described
under [Usage limits](results-and-recovery.md#usage-limits).
