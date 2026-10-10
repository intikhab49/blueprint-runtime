# Demo: catching a broken mapping

`scenario.blueprint.json` is scenario A with one edit: the Set variable module's mapping changed from `{{upper(1.name)}}` to `{{capitalize(1.name)}}`.

Each case replays a payload that went through the **real, unedited** scenario in Make, and compares the local run with what Make recorded:

```
$ node src/cli.ts test examples/broken-mapping
FAIL  A-001             module 2 input bundle 1 at /value: Make had "TEST", the local run "Test"
FAIL  A-002-plain       module 2 input bundle 1 at /value: Make had "ADA LOVELACE", the local run "Ada Lovelace"
FAIL  A-003-unicode     module 2 input bundle 1 at /value: Make had "STRASSE CAFÉ 日本 😀", the local run "Straße café 日本 😀"
PASS  A-004-empty-name

4 cases: 1 matched Make, 3 differ, 0 not supported yet, 0 invalid
```

Exit code 1. The empty-name case still passes because the edit makes no difference there, which is why several recorded cases are better than one.
