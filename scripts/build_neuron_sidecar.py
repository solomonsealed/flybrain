"""Build the versioned neuron metadata sidecar used by the garden simulation.

The connectome binary (data/connectome.bin.gz) stores only region and group ids
per neuron. Directional sensing and readout need hemisphere and stable neuron
identity, plus a few populations that are more specific than the broad groups.
This script derives them from the same FlyWire CSVs, in the binary's original
index order (neurons.csv.gz row order, as used by build_connectome.py), and
records hashes so the browser can confirm the pair was built together.

Outputs:
  data/neuron_sidecar.bin.gz   per-neuron root_id, side, population bitmask
  data/neuron_sidecar.json     manifest: version, counts, hashes, population
                               definitions with provenance, and a group audit

Binary layout (little-endian, gzip-compressed):
  magic  b"FBSC"
  uint32 format version (1)
  uint32 neuron_count
  neuron_count x uint64  root_id
  neuron_count x uint8   side (0 unknown, 1 left, 2 right, 3 center)
  neuron_count x uint32  population bitmask (bit = populations[i].bit)

Index order: original binary order. The worker reorders neurons with a stable
counting sort on group_id and reports sortedToOriginal; the browser maps
sidecar indices through it. Never reorder here.

Requires numpy (connectivity scores are computed from connectome.bin.gz so they
match the simulated weights exactly).

Usage: python3 scripts/build_neuron_sidecar.py [--data-dir data]
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

import numpy as np

sys.dont_write_bytecode = True  # importing build_connectome must not leave .pyc files
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_connectome import GROUPS, GROUP_NAME_TO_ID, determine_group  # noqa: E402

FORMAT_VERSION = 1
SIDE_CODES = {"": 0, "left": 1, "right": 2, "center": 3}

# Visual projection neurons whose FlyWire neuropil group runs from lobula or
# lobula plate to PVLP/PLP (the optic-glomerulus targets of LC/LPLC types).
LOOM_PROXY_GROUPS = {"LO.PVLP", "LO.PLP", "LOP.PVLP", "LOP.PLP"}

# How many connectivity-ranked DNs to select per readout population.
DN_TOP_FRACTION = 0.10
FLOW_HOPS = 3


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_rows(data_dir: Path):
    neurons = []
    with gzip.open(data_dir / "neurons.csv.gz", "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            neurons.append(row)
    cls = {}
    with gzip.open(data_dir / "classification.csv.gz", "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cls[row["root_id"]] = row
    return neurons, cls


def load_binary(path: Path):
    raw = gzip.open(path, "rb").read()
    n, e = struct.unpack_from("<II", raw, 0)
    expected = 8 + e * 12 + n * 3
    if len(raw) != expected:
        raise SystemExit(f"connectome.bin size mismatch: expected {expected}, got {len(raw)}")
    edges = np.frombuffer(raw, dtype=np.dtype([("pre", "<u4"), ("post", "<u4"), ("w", "<f4")]), count=e, offset=8)
    meta = np.frombuffer(raw, dtype=np.dtype([("region", "u1"), ("group", "<u2")]), count=n, offset=8 + e * 12)
    return n, e, edges, meta


def flow_scores(n: int, edges, source_mask: np.ndarray, hops: int) -> np.ndarray:
    """Input-normalized excitatory information flow from a source population.

    r_0 = indicator(source); r_k[post] = sum_pre r_{k-1}[pre] * w+(pre,post) / sum_in w+(post).
    Returns sum_{k=1..hops} r_k: roughly the fraction of a neuron's excitatory
    input that originates, within `hops` synapses, from the source population.
    """
    pre = edges["pre"].astype(np.int64)
    post = edges["post"].astype(np.int64)
    w = np.where(edges["w"] > 0, edges["w"], 0).astype(np.float64)
    total_in = np.bincount(post, weights=w, minlength=n)
    norm = np.divide(w, total_in[post], out=np.zeros_like(w), where=total_in[post] > 0)
    r = source_mask.astype(np.float64)
    acc = np.zeros(n)
    for _ in range(hops):
        r = np.bincount(post, weights=norm * r[pre], minlength=n)
        r[source_mask] = 0.0  # count only flow leaving the source
        acc += r
    return acc


def main() -> None:
    parser = argparse.ArgumentParser(description="Build FlyBrain neuron sidecar")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    args = parser.parse_args()
    d = args.data_dir

    neurons, cls = load_rows(d)
    n, e, edges, meta = load_binary(d / "connectome.bin.gz")
    if n != len(neurons):
        raise SystemExit(f"neurons.csv has {len(neurons)} rows but binary has {n} neurons")

    with open(d / "neuron_meta.json", encoding="utf-8") as f:
        neuron_meta = json.load(f)
    if neuron_meta["neuron_count"] != n or neuron_meta["edge_count"] != e:
        raise SystemExit("neuron_meta.json counts disagree with connectome.bin.gz header")

    root_ids = np.zeros(n, dtype="<u8")
    side = np.zeros(n, dtype="u1")
    super_class = []
    cls_col = []
    sub_class = []
    nparts = []
    mismatched_groups = 0
    for i, row in enumerate(neurons):
        rid = row["root_id"]
        root_ids[i] = int(rid)
        c = cls.get(rid, {})
        side[i] = SIDE_CODES.get(c.get("side", "").strip().lower(), 0)
        sc = c.get("super_class", "").strip().lower()
        cl = c.get("class", "").strip().lower()
        sb = c.get("sub_class", "").strip().lower()
        super_class.append(sc)
        cls_col.append(cl)
        sub_class.append(sb)
        nparts.append(row.get("group", ""))
        # Confirm the binary's group column matches the classification rules,
        # i.e. this sidecar is aligned with the binary index order.
        g = GROUP_NAME_TO_ID[determine_group(c.get("flow", "").strip().lower(), sc, cl, sb, "central")] if c else GROUP_NAME_TO_ID["GENERIC_CENTRAL"]
        if g != int(meta["group"][i]):
            mismatched_groups += 1
    if mismatched_groups:
        raise SystemExit(f"{mismatched_groups} neurons have a binary group_id that the current "
                         "classification rules do not reproduce; rebuild connectome.bin.gz first")

    sc_arr = np.array(super_class)
    cl_arr = np.array(cls_col)
    sb_arr = np.array(sub_class)
    np_arr = np.array(nparts)
    group_arr = meta["group"].astype(np.int64)

    def in_group(name):
        return group_arr == GROUP_NAME_TO_ID[name]

    populations = []

    def add(name, mask, description, provenance):
        bit = len(populations)
        if bit >= 32:
            raise SystemExit("too many populations for a uint32 bitmask")
        populations.append({
            "name": name, "bit": bit, "mask": mask,
            "description": description, "provenance": provenance,
        })

    olf = np.char.find(cl_arr, "olfact") >= 0
    gus = np.char.find(cl_arr, "gustat") >= 0
    mech = np.char.find(cl_arr, "mechano") >= 0
    add("ORN_FOOD", olf & (np.char.find(sb_arr, "pheromone") < 0),
        "Olfactory receptor neurons, non-pheromone",
        "classification class=olfactory, sub_class != pheromone (same rule as OLF_ORN_FOOD)")
    add("ORN_PHEROMONE", olf & (np.char.find(sb_arr, "pheromone") >= 0),
        "Pheromone-sensing olfactory receptor neurons",
        "classification class=olfactory, sub_class=pheromone")
    add("GRN_SUGAR", gus & (sb_arr == "sugar/water"),
        "Sugar/water gustatory receptor neurons",
        "classification class=gustatory, sub_class=sugar/water (these are in binary group GUS_GRN_WATER; see audit)")
    add("GRN_BITTER", gus & (sb_arr == "bitter"),
        "Bitter gustatory receptor neurons",
        "classification class=gustatory, sub_class=bitter")
    add("MECH_TOUCH", mech & np.isin(sb_arr, ["eye_bristle", "head_bristle", "grooming", ""]),
        "Bristle mechanosensory neurons",
        "classification class=mechanosensory, sub_class in eye_bristle/head_bristle/grooming/unlabelled")
    add("JO_WIND", mech & (sb_arr == "wind_gravity"),
        "Johnston's organ wind/gravity neurons",
        "classification class=mechanosensory, sub_class=wind_gravity (subset of MECH_JO)")
    add("PHOTORECEPTOR", in_group("VIS_R1R6"),
        "Photoreceptors (retina and ocelli)",
        "binary group VIS_R1R6; side = eye")
    loom_proxy = (sc_arr == "visual_projection") & np.isin(np_arr, list(LOOM_PROXY_GROUPS))
    add("VPN_LOOM_PROXY", loom_proxy,
        "Lobula/lobula-plate to PVLP/PLP visual projection neurons (LC/LPLC-like proxy)",
        "classification super_class=visual_projection and neurons.csv group in "
        + ",".join(sorted(LOOM_PROXY_GROUPS))
        + ". Cell types are not annotated locally, so this is a connectivity-level proxy for "
        "looming-sensitive LC/LPLC populations, not a verified cell-type set. VIS_LC stays empty.")
    add("ALPN", cl_arr == "alpn",
        "Antennal lobe projection neurons",
        "classification class=ALPN (same rule as OLF_PN)")
    add("LH_NEURON", np.isin(cl_arr, ["lhln", "lhcent"]),
        "Lateral horn local and centrifugal neurons",
        "classification class in LHLN/LHCENT (same rule as LH_APP; valence not annotated)")
    dn = sc_arr == "descending"
    add("DN", dn, "All descending neurons", "classification super_class=descending")

    # Connectivity-ranked descending-neuron readouts.
    dn_idx = np.nonzero(dn)[0]
    k = max(1, int(round(len(dn_idx) * DN_TOP_FRACTION)))

    def top_dns(source_name, label, desc):
        src = populations[[p["name"] for p in populations].index(source_name)]["mask"]
        score = flow_scores(n, edges, src, FLOW_HOPS)
        ranked = dn_idx[np.argsort(-score[dn_idx], kind="stable")]
        chosen = ranked[:k]
        mask = np.zeros(n, dtype=bool)
        mask[chosen] = True
        add(label, mask, desc,
            f"top {DN_TOP_FRACTION:.0%} of descending neurons ({k}) ranked by {FLOW_HOPS}-hop "
            f"input-normalized excitatory flow from {source_name} (computed on connectome.bin.gz weights)")
        return score, chosen

    olf_score, _ = top_dns("ORN_FOOD", "DN_ODOR_RANKED",
                           "Descending neurons most strongly downstream of food ORNs")
    vis_score, _ = top_dns("VPN_LOOM_PROXY", "DN_LOOM_RANKED",
                           "Descending neurons most strongly downstream of the LC/LPLC-like proxy")
    touch_score, _ = top_dns("MECH_TOUCH", "DN_TOUCH_RANKED",
                             "Descending neurons most strongly downstream of bristle neurons")
    sugar_score = flow_scores(n, edges, populations[2]["mask"], FLOW_HOPS)
    mn_prob = in_group("MN_PROBOSCIS")
    add("MN_PROBOSCIS", mn_prob, "Proboscis motor neurons", "binary group MN_PROBOSCIS")

    bitmask = np.zeros(n, dtype="<u4")
    for p in populations:
        bitmask[p["mask"]] |= np.uint32(1 << p["bit"])

    out_bin = d / "neuron_sidecar.bin.gz"
    with gzip.GzipFile(filename=str(out_bin), mode="wb", compresslevel=9, mtime=0) as f:
        f.write(b"FBSC")
        f.write(struct.pack("<II", FORMAT_VERSION, n))
        f.write(root_ids.tobytes())
        f.write(side.tobytes())
        f.write(bitmask.tobytes())

    group_sizes = np.bincount(group_arr, minlength=len(GROUPS))
    audit = {
        "empty_groups": [GROUPS[g][0] for g in range(len(GROUPS)) if group_sizes[g] == 0],
        "notes": [
            "MB_MBON_APP holds every MBON (class=MBON); valence is not annotated locally, so it is not "
            "used as an approach readout.",
            "LH_APP holds all LHLN/LHCENT neurons regardless of valence; LH_AV is empty.",
            "GNG_DESC mixes ascending (AN) and descending neurons; the DN population above separates them.",
            "VIS_ME absorbs visual projection neurons with empty sub_class; VPN_LOOM_PROXY is carved out "
            "of it by neuropil group, not by cell type.",
            "No VNC motor neurons exist in FAFB (brain only); leg/wing output is a modeled VNC adapter.",
            "GUS_GRN_SWEET does not contain the sugar receptors: the build rule checks 'water' before "
            "defaulting to sweet, so sub_class 'sugar/water' GRNs land in GUS_GRN_WATER. GRN_SUGAR above "
            "is the sugar population used for taste.",
        ],
        "mean_flow_to_mn_proboscis": {
            "from_GRN_SUGAR": float(sugar_score[mn_prob].mean()) if mn_prob.any() else 0.0,
            "from_ORN_FOOD": float(olf_score[mn_prob].mean()) if mn_prob.any() else 0.0,
        },
        "mean_flow_to_dn": {
            "from_ORN_FOOD": float(olf_score[dn].mean()),
            "from_VPN_LOOM_PROXY": float(vis_score[dn].mean()),
            "from_MECH_TOUCH": float(touch_score[dn].mean()),
        },
    }

    manifest = {
        "format": "flybrain-neuron-sidecar",
        "version": FORMAT_VERSION,
        "neuron_count": int(n),
        "edge_count": int(e),
        "index_order": "original connectome.bin order (neurons.csv.gz row order); the worker's stable "
                       "group sort is applied at load via sortedToOriginal",
        "side_codes": {"unknown": 0, "left": 1, "right": 2, "center": 3},
        "side_counts": {k if k else "unknown": int((side == v).sum()) for k, v in SIDE_CODES.items()},
        "group_sizes": [int(x) for x in group_sizes],
        "hashes": {
            "connectome.bin.gz": sha256_file(d / "connectome.bin.gz"),
            "neuron_meta.json": sha256_file(d / "neuron_meta.json"),
            "neuron_sidecar.bin.gz": sha256_file(out_bin),
        },
        "populations": [
            {
                "name": p["name"], "bit": p["bit"], "description": p["description"],
                "provenance": p["provenance"], "count": int(p["mask"].sum()),
                "count_left": int((p["mask"] & (side == 1)).sum()),
                "count_right": int((p["mask"] & (side == 2)).sum()),
            }
            for p in populations
        ],
        "audit": audit,
    }
    with open(d / "neuron_sidecar.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Wrote {out_bin} and {d / 'neuron_sidecar.json'}", file=sys.stderr)
    for p in manifest["populations"]:
        print(f"  {p['name']:16s} {p['count']:6d}  L={p['count_left']:5d} R={p['count_right']:5d}", file=sys.stderr)


if __name__ == "__main__":
    main()
