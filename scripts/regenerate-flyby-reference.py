"""Generate or check a three-body flyby fixture with REBOUND IAS15."""

import argparse
import csv
import math
import sys
from pathlib import Path

import rebound


VERSION = "5.2.2"
FIELDS = ("m", "x", "y", "z", "vx", "vy", "vz")
BINARY = (
    (0.9, -0.1, 0.0, 0.0, 0.0, -0.1, 0.0),
    (0.1, 0.9, 0.0, 0.0, 0.0, 0.9, 0.0),
)
# Initial visitor y and vx. The other Cartesian components are shared.
CASES = {
    "baseline": (0.23, 1.45),
    "closer": (0.12, 1.45),
    "faster": (0.23, 2.0),
    "closer-faster": (0.12, 2.0),
}
HEADER = ["time"] + [f"{field}{i}" for i in range(1, 4) for field in FIELDS]
END = 4
FINE_EPSILON = 1e-14
REFERENCE_TOLERANCE = 1e-10


def simulation(epsilon, case):
    sim = rebound.Simulation()
    sim.G = 1.0
    sim.gravity = "basic"
    sim.softening = 0.0
    sim.collision = "none"
    sim.integrator = "ias15"
    sim.integrator.epsilon = epsilon
    sim.integrator.adaptive_mode = "PRS23"
    sim.integrator.min_dt = 0.0
    sim.dt = 1 / 128
    y, vx = CASES[case]
    initial = (*BINARY, (0.02, -3.0, y, 0.20, vx, 0.02, -0.04))
    for body in initial:
        sim.add(**dict(zip(FIELDS, body)))
    sim.N_active = len(initial)
    return sim


def track(epsilon, case):
    sim = simulation(epsilon, case)
    rows = []
    for i in range(8 * END + 1):
        time = i / 8
        if i:
            sim.integrate(time, exact_finish_time=1)
        if sim.t != time:
            raise ValueError(f"Expected time {time}, got {sim.t}")
        values = [getattr(body, field) for body in sim.particles for field in FIELDS]
        rows.append([time, *values])
    return rows


def check_agreement(reference, other, label):
    if len(reference) != len(other):
        raise ValueError(f"{label}: different snapshot counts")
    error = 0.0
    for a, b in zip(reference, other):
        if len(b) != len(HEADER) or a[0] != b[0]:
            raise ValueError(f"{label}: invalid snapshot at {a[0]}")
        for value, expected in zip(b, a):
            if not (math.isfinite(value) and math.isfinite(expected)):
                raise ValueError(f"{label}: nonfinite value at {a[0]}")
            error = max(error, abs(value - expected))
    if error > REFERENCE_TOLERANCE:
        raise ValueError(f"{label}: max component difference {error:.3e} exceeds {REFERENCE_TOLERANCE:g}")
    print(f"{label}: max component difference {error:.3e}", file=sys.stderr)


def report_encounter(case):
    sim = simulation(FINE_EPSILON, case)
    closest = math.inf
    for i in range(1024 * END + 1):
        time = i / 1024
        if i:
            sim.integrate(time, exact_finish_time=1)
        primary, _, visitor = sim.particles
        separation = math.dist(primary.xyz, visitor.xyz)
        if separation < closest:
            closest = separation
            closest_time = time
            speed = math.dist((primary.vx, primary.vy, primary.vz), (visitor.vx, visitor.vy, visitor.vz))
    print(f"{case} sampled closest approach: t={closest_time:.9f}, r={closest:.9f}, r/speed={closest / speed:.9f}",
          file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=CASES, default="baseline")
    parser.add_argument("--check", type=Path, help="compare with an existing CSV instead of writing one")
    args = parser.parse_args()
    if rebound.__version__ != VERSION:
        parser.error(f"expected rebound=={VERSION}, got {rebound.__version__}")

    fine = track(FINE_EPSILON, args.case)
    check_agreement(fine, track(1e-12, args.case), "IAS15 epsilon 1e-14 vs 1e-12")
    report_encounter(args.case)
    if args.check:
        with args.check.open(newline="", encoding="utf-8") as file:
            rows = csv.reader(file)
            if next(rows, None) != HEADER:
                raise ValueError(f"Unexpected CSV header in {args.check}")
            check_agreement(fine, [list(map(float, row)) for row in rows], str(args.check))
    else:
        writer = csv.writer(sys.stdout, lineterminator="\n")
        writer.writerow(HEADER)
        writer.writerows(fine)


if __name__ == "__main__":
    main()
