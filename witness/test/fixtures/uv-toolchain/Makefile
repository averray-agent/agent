gate:
	@uv --version
	@python3 --version
	@python3 -c 'from pathlib import Path; assert len(list(Path("/opt/witness-wheels").glob("uv_build-0.9.27-*.whl"))) == 1; print("uv-build 0.9.27 pinned wheel")'
	@uv run --no-project --offline python3 check.py
