"""Build the neuron position asset used to draw the brain inside the fly.

Every FlyWire neuron has at least one annotated point in FAFB space
(data/coordinates.csv.gz, in nanometres). The garden draws each simulated
neuron at that point, inside the fly's head, and lights it when it fires.
Positions are display-only: nothing in the simulation reads them.

Outputs:
  data/neuron_positions.bin.gz   quantized per-neuron position
  data/neuron_positions.json     manifest: version, counts, bounds, axes, hashes

Binary layout (little-endian, gzip-compressed):
  magic  b"FBNP"
  uint32 format version (1)
  uint32 neuron_count
  6 x float32  bounds in nm: x_min, y_min, z_min, x_max, y_max, z_max
  neuron_count x 3 x uint16  position, each axis scaled from [min, max] to [0, 65535]

Index order: original binary order (neurons.csv.gz row order, as used by
build_connectome.py). The browser maps it through the worker's
sortedToOriginal, exactly as it does the sidecar. Never reorder here.

When a neuron has several points, the first one listed is used, so the output
is deterministic.

Usage: python3 scripts/build_neuron_positions.py [--data-dir data]
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

FORMAT_VERSION = 1
QMAX = 65535


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    d = Path(ap.parse_args().data_dir)

    order = []
    with gzip.open(d / "neurons.csv.gz", "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            order.append(row["root_id"])
    wanted = set(order)

    first = {}
    with gzip.open(d / "coordinates.csv.gz", "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = row["root_id"]
            if rid in wanted and rid not in first:
                first[rid] = [int(v) for v in row["position"].strip("[]").split()]

    missing = [rid for rid in order if rid not in first]
    if missing:
        sys.exit(f"{len(missing)} neurons have no coordinates (first: {missing[0]}); refusing to guess")

    n = len(order)
    pts = [first[rid] for rid in order]
    lo = [min(p[a] for p in pts) for a in range(3)]
    hi = [max(p[a] for p in pts) for a in range(3)]
    span = [max(1, hi[a] - lo[a]) for a in range(3)]

    q = bytearray(n * 6)
    for i, p in enumerate(pts):
        struct.pack_into("<HHH", q, i * 6, *(round((p[a] - lo[a]) / span[a] * QMAX) for a in range(3)))

    out_bin = d / "neuron_positions.bin.gz"
    with gzip.GzipFile(filename=str(out_bin), mode="wb", compresslevel=9, mtime=0) as f:
        f.write(b"FBNP")
        f.write(struct.pack("<II", FORMAT_VERSION, n))
        f.write(struct.pack("<6f", *lo, *hi))
        f.write(bytes(q))

    manifest = {
        "format": "flybrain-neuron-positions",
        "version": FORMAT_VERSION,
        "neuron_count": n,
        "index_order": "original connectome.bin order (neurons.csv.gz row order); the worker's stable "
                       "group sort is applied at load via sortedToOriginal",
        "units": "nm",
        "source": "FlyWire Codex coordinates.csv (FAFB v783), first listed point per root_id",
        "bounds_nm": {"min": lo, "max": hi},
        "axes": {
            "x": "medio-lateral; neurons annotated side=left have smaller x (FAFB image space is mirrored)",
            "y": "dorso-ventral; increases ventrally",
            "z": "antero-posterior; increases posteriorly",
        },
        "quantization": "uint16 per axis over bounds_nm",
        "display_only": True,
        "hashes": {
            "connectome.bin.gz": sha256_file(d / "connectome.bin.gz"),
            "neuron_positions.bin.gz": sha256_file(out_bin),
        },
    }
    with open(d / "neuron_positions.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    size_um = [round(s / 1000) for s in span]
    print(f"Wrote {out_bin} ({out_bin.stat().st_size:,} bytes) and {d / 'neuron_positions.json'}", file=sys.stderr)
    print(f"  {n:,} neurons, bounds {size_um[0]} x {size_um[1]} x {size_um[2]} um", file=sys.stderr)


if __name__ == "__main__":
    main()
