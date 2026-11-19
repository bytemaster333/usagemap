# SPDX-License-Identifier: Apache-2.0
"""Write collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel-py.metrics.json: one OTLP/HTTP JSON
export request exactly as this package + the OpenTelemetry Python SDK produce it (tests/scenario.py). The Collector's
golden test sanitises it (go test -run TestStellarPyFixtureGolden -update).

Run from the package directory: python scripts/collector_fixture.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "src"), str(HERE.parent / "tests")]

from scenario import run_scenario  # noqa: E402

out = HERE.parents[2] / "collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel-py.metrics.json"
out.write_text(run_scenario())
print("wrote", out)
