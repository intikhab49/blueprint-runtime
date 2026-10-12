# Demo: a filter cutoff that moved

`scenario.blueprint.json` is scenario B with one edit: the route filter `amount > 100` became `amount >= 100` (operator `number:greater` to `number:greaterorequal`).

Each case replays a payload that went through the **real, unedited** scenario in Make, and compares the local run with what Make recorded:

```
$ bpr test examples/filter-cutoff
PASS  B-02-amount-gt-only
PASS  B-04-neither-fallback
FAIL  B-06-amount-exactly-100    step 3, filter before module 4: Make stopped the bundle [[false]], the local run passed it [[true]]
PASS  B-12-amount-decimal-100.5

4 cases: 3 matched Make, 1 differ, 0 not supported yet, 0 invalid
```

Exit code 1. Only the case sitting exactly on the cutoff catches the edit. The usual sample (150), a value well below (50) and one just above (100.5) all route the same way under both operators, so a test suite made of "normal" inputs would pass.

For every numeric filter, keep three cases: just below the cutoff, exactly at it, and just above it. An off-by-one edit (`>` to `>=`, `<` to `<=`) changes the result of the middle one.

Suggested on Reddit by a reader of the launch post.
