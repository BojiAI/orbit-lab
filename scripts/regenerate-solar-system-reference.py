"""Sample JPL DE440s at fixed TDB dates using jplephem."""

import argparse
import csv
import math
from pathlib import Path

from jplephem.spk import SPK


AU_KM = 149_597_870.7
EPOCH_JD_TDB = 2_461_041.5  # 2026-01-01 00:00 TDB
SAMPLE_DAYS = (0, 7, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 365)
OBLIQUITY = math.radians(84_381.448 / 3600)
# Segment chains from the solar-system barycenter and GM from JPL DE440 Table 2.
BODIES = (
    ("sun", ((0, 10),), 132_712_440_041.279419),
    ("mercury", ((0, 1),), 22_031.868551),
    ("venus", ((0, 2),), 324_858.592),
    ("earth", ((0, 3), (3, 399)), 398_600.435507),
    ("mars", ((0, 4),), 42_828.375816),
    ("jupiter", ((0, 5),), 126_712_764.1),
    ("saturn", ((0, 6),), 37_940_584.8418),
    ("uranus", ((0, 7),), 5_794_556.4),
    ("neptune", ((0, 8),), 6_836_527.10058),
    ("moon", ((0, 3), (3, 301)), 4_902.800118),
)
HEADER = ("jd_tdb", "body", "gm_km3_s2", "x_au", "y_au", "z_au", "vx_au_day", "vy_au_day", "vz_au_day")
FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "solar-system-de440.csv"


def to_ecliptic_au(vector):
    x, y, z = vector
    c = math.cos(OBLIQUITY)
    s = math.sin(OBLIQUITY)
    return (x / AU_KM, (c * y + s * z) / AU_KM, (c * z - s * y) / AU_KM)


def rows(kernel):
    for days in SAMPLE_DAYS:
        jd = EPOCH_JD_TDB + days
        for name, segments, gm in BODIES:
            states = [kernel[pair].compute_and_differentiate(jd) for pair in segments]
            position, velocity = (
                to_ecliptic_au([sum(axis) for axis in zip(*vectors)])
                for vectors in zip(*states)
            )
            yield (jd, name, gm, *position, *velocity)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kernel", type=Path, help="Path to the official de440s.bsp kernel")
    args = parser.parse_args()
    kernel = SPK.open(str(args.kernel))
    try:
        samples = list(rows(kernel))
    finally:
        kernel.close()
    with FIXTURE.open("w", newline="") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(HEADER)
        writer.writerows(samples)


if __name__ == "__main__":
    main()
