# TypR Target — Suggested Improvements

## For Codex / Future Work

### 1. Raw-R blocks could be reduced
The current TypR target wraps most logic in `@{ ... }@` raw-R escape blocks.
This defeats the purpose of TypR's type system since the raw R code isn't
type-checked. As TypR matures (especially variadic function support and
environment/hash types), these blocks should be progressively replaced with
native TypR constructs.

**Example:** `parent_graph <- @{ new.env(hash = TRUE, parent = emptyenv()) }@;`
could become native when TypR supports environment types.

### 2. CLI entry point generation
The R target generates a CLI section (`if (!interactive()) { ... }`) but the
TypR target doesn't. Add an optional `cli(true)` flag that generates the
stdin-reading entry point in TypR syntax.

### 3. Test coverage
Add regression tests for:
- `compile_recursive(ancestor/2, [target(typr)], Code)` — transitive closure
- `compile_recursive(factorial/2, [target(typr), memo(false)], Code)` — linear recursion
- Compare TypR output vs R output for semantic equivalence

### 4. TypR upstream status
- **Variadic functions**: Supported in the fork, including heterogeneous named arguments and forwarding; retain the SciREPL regression coverage.
- **Braceless function bodies**: `function(x) x * x` drops the body, must use braces
- **`io.ty` not loadable**: New .ty files aren't picked up by the std generator parser
- **`default.ty` skipped**: Contains syntax the parser rejects (`{}` record types, `let` definitions mixed with `@` declarations)

### 5. Workbook generation
The "Prolog generates TypR" workbook pattern works well for demos:
1. Prolog cell: define predicates + assert facts
2. Prolog cell: `compile_recursive(pred/N, [target(typr)], Code), nb_write(...)`
3. TypR cell: execute the generated code

Consider auto-generating this workbook pattern as a SciREPL package.

### 6. Multi-cell source composition
TypR cells intentionally execute as self-contained compilation units in isolated
R environments. Variables defined in one TypR cell are not available in another.

For compiler and code-generation workflows:

1. Give the reusable source cell a stable name.
2. Put `#!source` on its first line.
3. Read its `.code` through the Notebook VFS.
4. Combine it with generated definitions and write the complete program to an executable TypR cell.

A source-only cell keeps syntax highlighting, does not execute its contents, and
intentionally produces no `Out [n]`.
