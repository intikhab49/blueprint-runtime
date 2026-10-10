# HTTP fixture: offline, and fail-closed

Scenario `corpus/blueprints/E-json.import.json`: webhook → HTTP "Make a request" (POST JSON, parse response) → webhook response.
Case `E-json-01` is a real Make run; its HTTP call is replaced by `corpus/reference/E-json-01/fixtures.json` (the request the module built and the response it got).

```
bpr test examples/http-fixture/cases/1-matches          # exit 0: the request matches, the response replays, the run equals Make's
bpr test examples/http-fixture/cases/2-wrong-request    # exit 5: the fixture expects another body; it is not consumed
bpr test examples/http-fixture/cases/3-unused-fixture   # exit 5: a fixture for a second call that never happens
bpr test examples/http-fixture/cases/4-no-fixture       # exit 5: no fixture, and no network fallback
```
