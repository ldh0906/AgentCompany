# Contributing

- `npm test` must pass on Windows and Linux. Add a test for every bug you fix (see `test/e2e` for fake-agent scenarios).
- The ticket state machine (`src/core/ticket-machine.ts`) is the product's core invariant. Changes there need matching tests in `test/core`, including the randomized property test.
- Keep runtime dependencies at zero. The dashboard is built at release time.
- Adapters must be based on **measured** CLI behavior. Put the CLI version and what you measured in the adapter header comment, and mark unmeasured behavior as such.
- Never spawn with `shell: true`. Never read credential files.
