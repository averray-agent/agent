"""20 sequential fresh-connection requests per listing path, without payment.

Usage: python3 scripts/ops/measure-verify-listing-external.py --revision DEPLOYED_SHA --output report.json
"""
import argparse
import datetime
import json
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--revision", required=True, help="Deployed revision, not the local branch")
parser.add_argument("--output", required=True)
args = parser.parse_args()
origin = "https://api.averray.com"
rows = []
with tempfile.TemporaryDirectory(prefix="listing-external-") as directory:
    body_path = Path(directory) / "body.json"
    for path, method in [("/", "GET"), ("/verify/runs", "POST"), ("/openapi.json", "GET"), ("/llms.txt", "GET")]:
        samples = []
        for _ in range(20):
            command = ["curl", "-sS", "--max-time", "30", "-o", str(body_path),
                       "-w", "%{http_code} %{time_starttransfer} %{time_total}", origin + path]
            if method == "POST":
                command += ["-H", "Content-Type: application/json", "--data", "{}"]
            status, ttfb, total = subprocess.check_output(command, text=True).split()
            assert int(status) == (402 if method == "POST" else 200), (path, status)
            if method == "POST":
                accepts = json.loads(body_path.read_text())["accepts"]
                assert len(accepts) == 3 and all(entry["amount"].isdigit() for entry in accepts)
            samples.append({"status": int(status), "ttfb_ms": round(float(ttfb) * 1000, 3),
                            "total_ms": round(float(total) * 1000, 3)})
        values = sorted(sample["total_ms"] for sample in samples)
        row = {"path": path, "method": method, "n": 20, "p50_ms": values[9], "p95_ms": values[18], "samples": samples}
        rows.append(row)
        print(json.dumps({key: value for key, value in row.items() if key != "samples"}), flush=True)
Path(args.output).write_text(json.dumps({
    "measured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "revision": args.revision,
    "method": "20 sequential curl processes per path; fresh connections; total latency; nearest-rank percentiles; no warmup",
    "origin": origin, "rows": rows}, indent=2) + "\n")
