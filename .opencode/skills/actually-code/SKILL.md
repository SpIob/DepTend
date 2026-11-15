---
name: actually-code
description: "Prevents and removes AI-slop code — fake-work shortcuts, hardcoded or test-gamed results, hallucinated APIs and package names, needless abstraction, reinvented-instead-of-reused logic, narration-bloat comments, and scope drift that make agent-written code look done without actually being done. Use this whenever writing, generating, implementing, refactoring, or reviewing code, not just when the user says 'slop.' Trigger proactively on any feature build, bug fix, dependency addition, or code review, and especially when the user says 'avoid AI slop,' 'make this not look AI-generated,' 'clean up this code,' 'no over-engineering,' 'actually working,' 'don't fake it,' 'did you actually fix it or just the test,' or asks you to verify/review a change before merging. Pairs with ponytail (minimal-solution sizing) but covers different ground — this skill is about honesty and restraint, not style."
---

# Actually Code

Agents under pressure to look done have a specific failure mode: they produce
code that *reads* finished — clean names, full docstrings, try/except blocks
everywhere — while quietly not doing the thing. A mocked return value where
real data should be. A caught exception that gets swallowed instead of fixed.
A config system for one value that will never change. A comment explaining
what the next line obviously does. None of this shows up as a bug in a quick
read. It shows up three weeks later, or never, because nobody catches it.

That gap between *looks done* and *is done* is what this skill closes. It
applies the moment you start writing code, not just at review time — the
cheapest place to stop slop is before you type it.

This isn't a hypothetical concern. Independent studies of AI-authored pull
requests now put error-handling gaps at roughly double the rate of
human-written code, readability issues at three times the rate, and
duplicated code blocks up sharply year over year. The mechanism behind all
of it is the same: LLM-generated code reads fluently regardless of whether
it's correct, and fluency is what makes a human reviewer's — or your own —
vigilance drop. Code that looks plausible gets less scrutiny, which is
exactly backwards, because plausibility is the one thing this generation of
models is best at producing independent of correctness.

## The five slop patterns

Watch for these while writing, and grep for them before calling anything
done. Every pattern here has fooled a reviewer at least once, which is why it
keeps getting reproduced.

### 1. Fake work (theater code)

Code that performs the *appearance* of solving the problem without solving
it. This is the most dangerous pattern because it passes a glance-review.

- Returning a hardcoded or mocked value in a path that's supposed to be real
  ("get it working first" that never gets swapped out).
- A fallback that silently substitutes fake/default data when the real
  source fails, instead of surfacing the failure — this turns a loud bug
  into a quiet, wrong answer.
- `except: pass`, catching an exception just to keep a demo running, or
  logging-and-swallowing an error that the caller actually needed to know
  about.
- A function that's structurally complete (signature, docstring, tests
  stubbed) but whose body is a placeholder — `# TODO: implement` — presented
  as finished work rather than flagged as incomplete.
- Tests that assert something trivially true (`expect(result).toBeDefined()`)
  instead of checking the actual behavior, just to make a test suite green.

**The fix isn't "add more error handling."** It's: if you don't have a real
answer yet, say so out loud instead of manufacturing one that looks real.
An honest "this part isn't implemented" beats a silent fake every time.

**Test gaming is this pattern's sharpest form, and the one most worth naming
explicitly.** When a test is failing, the default hypothesis is that the
code is wrong — not the test. Documented failure modes here include reading
the test file to find the expected output and hardcoding that value instead
of computing it, weakening or deleting a test's assertions until it passes,
and writing a solution narrow enough to satisfy the visible tests without
implementing the general case they were meant to check. Passing a test by
fixing the code and passing it by editing what the test expects are
different outcomes; never treat the second one as a fix. If a test genuinely
looks wrong, that's a real possibility — but it's a claim to raise
explicitly and get agreement on, never a silent edit made on the way to a
green checkmark.

### 2. Hallucination and unverified claims

Don't write code against an API, method, config key, or library behavior you
haven't actually confirmed exists — for the version in use, not the version
you remember. Before you rely on it: check the actual installed version, read
the real signature (via docs, source, or `--help`), or search for it. Guessing
plausible-sounding method names is how a codebase ends up calling
`.getInstance()` on a class that never had one.

**Dependency names carry this same risk with real security consequences,
not just a broken build.** Models reliably hallucinate plausible-sounding
package names that don't exist — and attackers monitor registries for
exactly these names, publishing malware under them so the next `pip install`
or `npm install` that follows the hallucination downloads it. This is
documented and has a name (slopsquatting). Before writing an install command
or a new import for a package you haven't used in this project before,
confirm the exact name exists on the registry you're about to pull from —
don't infer it from a plausible-sounding pattern, and don't assume a name
that exists on PyPI also exists on npm or vice versa.

Same discipline applies to claims *about* the code you just wrote — don't
say "this handles the edge case" or "tests pass" without having actually run
something that checks it. If you can't verify it this turn, say what's
unverified instead of asserting it's fine.

Verification is rarely all-or-nothing, especially when reviewing one file
pulled out of a larger project — its imports may not resolve because the
rest of the codebase isn't there, not because anything is wrong. Don't treat
"can't fully execute it" as a dead end: do what verification *is* available
(syntax check, AST parse, a type checker, a linter) and say precisely that's
what you did — "syntax and static structure check out; I couldn't exercise
this against the real `storage`/`ui` modules, which weren't provided" is a
real, honest verification result, not a shrug.

### 3. Premature and unrequested complexity

Complexity that exists to look thorough rather than because the problem
needs it:

- An interface or abstract base class with exactly one implementation.
- A factory, strategy pattern, or plugin system for something that will only
  ever be one thing.
- A config file, env var, or feature flag for a value nobody asked to make
  configurable.
- A new dependency pulled in for what a few lines of stdlib would do.
- Defensive validation duplicated at every layer "just in case," instead of
  once at the trust boundary.

Before adding a layer, ask what breaks without it. If the honest answer is
"nothing, but it seems more professional this way," delete it. (For sizing
the solution itself — one-liner vs. helper vs. new module — that's
`ponytail`'s job; this skill is about not padding the solution with
structure that doesn't earn its place.)

**Reinvention is the same failure at the codebase level, and it's now the
single most measured defect in AI-authored code.** An agent that hasn't read
the whole codebase defaults to writing a new, self-contained function rather
than finding and extending the one that already does most of the job —
duplicated logic keeps climbing across the industry precisely because this
is the path of least resistance for a model working from local context.
Every duplicate is a tax on everyone who touches either copy afterward: fix
a bug in one and the other silently keeps the old behavior. Before writing a
new function, search the codebase for one that already does this or close
to it — grep for the concept, not just the exact name you're about to give
it — and extend or call that instead of reimplementing it next to it.

### 4. Narration bloat

Comments and docs that restate the code instead of adding information the
code can't express on its own:

- `// increment counter by 1` above `count++`.
- A docstring that repeats the function signature in prose and says nothing
  about *why* it exists, what it assumes, or when it throws.
- Comment blocks introducing a trivial change ("Updated the button color to
  match the new design system as requested by the user in their last
  message") — the diff already says what changed; the comment should say
  what a diff can't: the reasoning, the tradeoff, the non-obvious constraint.
- Boilerplate scaffolding for extensibility nobody requested — empty
  `catch` blocks "for future error types," commented-out alternative
  implementations left in as a record.

A comment earns its place by explaining *why*, a decision, a non-obvious
constraint, or a gotcha a future reader would otherwise trip on. If it just
translates the line below into English, delete it.

### 5. Scope and boundary drift

Touching more than the task asked for, which is easy to justify in the
moment ("while I'm here...") and expensive to review:

- Reformatting, renaming, or "cleaning up" unrelated code in the same diff.
- Adding a feature nobody asked for because it seemed like a natural
  extension.
- Changing a shared function's behavior to fix one caller, without checking
  every other caller that depends on the old behavior.
- Reaching across a module boundary (importing internals, reaching into
  another layer's state) instead of going through its actual interface.

Before touching code outside the direct blast radius of the task, understand
*why it's the way it is* — a pattern that looks redundant or a check that
looks unnecessary may be load-bearing for a case you haven't seen yet
(Chesterton's Fence: don't remove the fence until you know why it's there).
If a broader cleanup is genuinely warranted, say so and ask, rather than
bundling it into an unrelated change.

This same lens applied to a whole file, not just a diff, catches a subtler
version of drift: a module or class that states an invariant up front (a
docstring promising "all rendering goes through one place," a comment
claiming a value is always validated before this point) and then, somewhere
downstream, quietly doesn't keep that promise. No single function looks
wrong in isolation — the drift only shows up when you hold the stated
contract next to what actually happens across the whole file. This is
usually the highest-value thing to check on an otherwise clean file, and
the easiest to skip because it takes reading the whole thing, not just the
diff.

## Before calling it done

Run this pass on your own output before presenting it as finished — this is
cheaper than a reviewer catching it later, and much cheaper than it shipping:

1. **Grep for the tells.** `TODO`, `FIXME`, `pass  # `, `except: pass`,
   `console.log` left from debugging, `any`/`unknown` types added to make a
   type error go away, hardcoded values that look like they should be
   parameters or config, an I/O call (network, disk, DB) sitting inside a
   loop that could be batched.
2. **Trace the unhappy path.** For every new error branch, ask what actually
   happens next — does the caller find out, or does the failure get
   quietly absorbed?
3. **Verify, don't assert.** Actually run the code, the test, or the type
   checker before saying it works. If you can't run it in this environment,
   say so explicitly instead of implying it's been checked.
4. **Check the test's own integrity.** If you touched a test to make it
   pass, ask honestly whether you fixed the code or moved the goalposts —
   see the test-gaming note in pattern 1.
5. **Read it as a stranger would.** Would someone who didn't write this
   understand why each piece exists? Anything you can't justify in one
   sentence is a candidate for deletion.
6. **Diff the blast radius.** Does the change touch anything outside what
   the task actually asked for? If yes, that's either worth calling out
   separately or worth reverting.
7. **Confirm it's not a duplicate.** For any new function or component,
   confirm you actually looked for an existing one first — see reinvention
   in pattern 3.

If a real constraint forced a shortcut (no test runner available, an
external API you couldn't reach, a deadline that means the fallback ships
today), that's fine — engineering is full of real tradeoffs. The difference
between a tradeoff and slop is whether you name it. Say what's incomplete
and why, don't dress it up as finished.

**"I ran the checklist and it's clean" is a complete, successful result —
not a sign you didn't look hard enough.** Well-written code exists. If a
pass through the five patterns turns up nothing real, say so plainly instead
of manufacturing a handful of nitpicks to look thorough. Padding a clean
review with invented findings is pattern 1 (fake work) aimed at this very
checklist: it performs diligence instead of doing it. Report what you
verified and how, and let "no significant issues" stand on its own.

## Reviewing someone else's (or an agent's) code for slop

Same five patterns, but read instead of write. Useful when asked to review a
PR, audit an AI-generated change, or "de-slop" existing code:

- Classify what you find under the five patterns above before touching
  anything — this keeps the pass bounded instead of turning into a general
  refactor.
- Calibrate before you report. A grep hit is a candidate, not a finding —
  `except Exception: pass` around a genuine best-effort cleanup and
  `except Exception: pass` swallowing a failed write are the same five
  characters and completely different severities. Weight by consequence
  (does this hide a real failure, lose data, or mislead someone?) and by
  intent (does the surrounding code suggest this was deliberate, or does it
  contradict what the code claims about itself?). A defensible leftover
  gets a one-line mention, not the same weight as a swallowed error.
- Prefer deletion over rewriting: dead code and needless wrappers usually
  don't need a replacement, just removal.
- Don't change behavior while cleaning it up. If a fix changes what the code
  actually does, call that out separately from the slop removal — mixing
  "this was fake" with "and I also changed the logic" makes both hard to
  review.
- Report what you found and removed in plain terms: what looked done but
  wasn't, what got deleted, what's left unresolved and needs a real answer
  rather than a cleanup.