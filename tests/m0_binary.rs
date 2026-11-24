//! M0: G = total mass = separation = 1, so angular speed = 1 and period = 2π.
//! Run `cargo test --test m0_binary -- --nocapture` to print the measured rows.

use orbit_lab::{circular_binary, conserved_quantities, Simulation};
use std::f64::consts::TAU;

type Vec3 = [f64; 3];
// Orthonormal basis: rotate the original plane, preserving lengths and angles.
const TILTED: (Vec3, Vec3) = ([0.6, 0.8, 0.], [-0.48, 0.36, 0.8]);

fn dot(a: Vec3, b: Vec3) -> f64 {
    (0..3).map(|k| a[k] * b[k]).sum()
}

fn norm(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}

fn in_plane(x: f64, y: f64, u: Vec3, v: Vec3) -> Vec3 {
    std::array::from_fn(|k| x * u[k] + y * v[k])
}

#[derive(Default)]
struct Metrics {
    end_phase: f64, // signed angle: numerical relative position minus exact
    max_pos: f64,   // both bodies, all sample times, Euclidean distance
    max_com: f64,   // distance from the analytic (stationary) origin
}

fn measure(q: f64, u: Vec3, v: Vec3, n: usize) -> Metrics {
    let h = TAU / n as f64;
    let mut bodies = circular_binary(q);
    for b in &mut bodies {
        b.pos = in_plane(b.pos[0], b.pos[1], u, v);
        b.vel = in_plane(b.vel[0], b.vel[1], u, v);
    }
    let mut sim = Simulation::new(&bodies);
    let radii = [-q / (1.0 + q), 1.0 / (1.0 + q)];
    let mut m = Metrics::default();
    for i in 0..=n {
        let bodies = sim.bodies();
        let (s, c) = (i as f64 * h).sin_cos();
        let direction = in_plane(c, s, u, v);
        for (b, radius) in bodies.iter().zip(radii) {
            let error = norm(std::array::from_fn(|k| b.pos[k] - radius * direction[k]));
            assert!(error.is_finite());
            m.max_pos = m.max_pos.max(error);
        }
        let com = norm(std::array::from_fn(|k| {
            bodies[0].mass * bodies[0].pos[k] + bodies[1].mass * bodies[1].pos[k]
        })); // total mass = 1
        assert!(com.is_finite());
        m.max_com = m.max_com.max(com);
        if i == n {
            let r = std::array::from_fn(|k| bodies[1].pos[k] - bodies[0].pos[k]);
            let (x, y) = (dot(r, u), dot(r, v));
            m.end_phase = (c * y - s * x).atan2(c * x + s * y);
        } else {
            sim.step(h).expect("regular circular binary step");
        }
    }
    m
}

#[test]
fn analytic_binary_orbits() {
    let xy = ([1., 0., 0.], [0., 1., 0.]);
    println!("case,q,steps,dt,end_phase_rad,max_pos_3d,max_com_3d,phase_ratio,pos_ratio");
    for (name, q, (u, v)) in [("equal", 1.0, xy), ("unequal", 0.25, xy), ("tilted", 0.25, TILTED)] {
        let mut previous: Option<Metrics> = None;
        for n in [256, 512, 1024] {
            let h = TAU / n as f64;
            let m = measure(q, u, v, n);
            let ratios = previous.as_ref().map(|p| {
                ((p.end_phase / m.end_phase).abs(), p.max_pos / m.max_pos)
            });
            let ratio_cols = ratios.map_or_else(|| ",".into(), |(a,b)| format!("{a:.8},{b:.8}"));
            println!("{name},{q},{n},{h:.12e},{:.12e},{:.12e},{:.12e},{ratio_cols}",
                     m.end_phase, m.max_pos, m.max_com);

            // One orbit, unit scales: leapfrog's global truncation error is O(h²).
            // 4 h² is an accuracy budget (~2.4e-3 at n=256), not a fitted result.
            // Enforce the scaling separately so the absolute budget alone cannot pass.
            assert!(m.end_phase.abs() < 4.0 * h * h && m.max_pos < 4.0 * h * h,
                    "{name}, n={n}: analytic orbit outside O(h²) budget");
            // Internal kicks cancel in the mass-weighted sum: no truncation drift
            // is expected in COM. Use the existing binary test's unit-scale 1e-12.
            assert!(m.max_com < 1e-12, "{name}, n={n}: centroid drift");
            if let Some((phase, pos)) = ratios {
                // Halving h predicts 2²=4; existing regression allows ±5% for
                // higher-order terms. The sampled trajectory maximum can shift too.
                assert!((3.8..=4.2).contains(&phase) && (3.8..=4.2).contains(&pos),
                        "{name}, n={n}: phase ratio={phase}, position ratio={pos}");
            }
            previous = Some(m);
        }
    }
}

#[test]
fn tilted_binary_conserved_quantities_match_analytic_values() {
    let mut bodies = circular_binary(0.25);
    let (u, v) = TILTED;
    // cos(phase) = 0.6, sin(phase) = 0.8 so both r and v have a z component.
    for body in &mut bodies {
        let radius = body.pos[0];
        body.pos = in_plane(0.6 * radius, 0.8 * radius, u, v);
        body.vel = in_plane(-0.8 * radius, 0.6 * radius, u, v);
    }
    let sim = Simulation::new(&bodies);
    let quantities = conserved_quantities(sim.bodies()).unwrap();

    // With G = M = a = 1, E = -m1*m2/2 and L = m1*m2 times the orbit normal.
    let expected_energy = -0.08;
    let expected_angular_momentum = [0.64, -0.48, 0.6].map(|axis| 0.16 * axis);
    let energy_error = (quantities.energy - expected_energy).abs();
    let angular_error = norm(std::array::from_fn(|k| {
        quantities.angular_momentum[k] - expected_angular_momentum[k]
    }));
    println!("Tilted q=0.25: |energy error|={energy_error:e}, |angular momentum error|={angular_error:e}");
    // Unit-scale roundoff for a static analytic state, with no integration error.
    let tolerance = 32.0 * f64::EPSILON;
    assert!(energy_error < tolerance, "total energy: {quantities:?}");
    assert!(angular_error < tolerance, "angular momentum: {quantities:?}");
}
