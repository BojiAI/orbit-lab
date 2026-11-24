//! Opt-in, serial release measurement. Keep scenario, accuracy gates and batch
//! sizes fixed across implementations; record CPU/OS/rustc/RUSTFLAGS alongside stdout.
//! Run: `cargo +1.85.1 test --locked --release --features m2-bench --lib m2_baseline::measure -- --exact --ignored --nocapture --test-threads=1`

use crate::{circular_binary, gravity::acceleration, Body, Simulation};
use std::f64::consts::{PI, TAU};
use std::hint::black_box;
use std::time::{Duration, Instant};

const SAMPLES: usize = 7;

struct Orbit {
    name: &'static str,
    initial: Vec<Body>,
    omega: f64,
    dt: f64,
    steps: usize,
    runs: usize, // independent trajectories per timed batch
    phase_limit: f64,
    pos_limit: f64,
}

fn binary() -> Orbit {
    let dt = TAU / 1024.;
    Orbit {
        name: "equal-binary", initial: circular_binary(1.).to_vec(), omega: 1.,
        dt, steps: 1024, runs: 128,
        // Same dimensionless one-period O(dt²) budgets as M0.
        phase_limit: 4. * dt * dt, pos_limit: 4. * dt * dt,
    }
}

fn polygon() -> Orbit {
    // Unit radius, unit total mass, G=1. Each other vertex contributes
    // m/(4 sin(pi*k/n)) inward acceleration; tangential components cancel.
    // Hence omega² = inward acceleration / radius, independent of the kernel.
    let n = 64;
    let mass = 1. / n as f64;
    let omega = ((1..n).map(|k| mass / (4. * (PI * k as f64 / n as f64).sin()))
        .sum::<f64>()).sqrt();
    let initial = (0..n).map(|k| {
        let (s, c) = (TAU * k as f64 / n as f64).sin_cos();
        Body { mass, pos: [c, s, 0.], vel: [-omega * s, omega * c, 0.] }
    }).collect();
    let dt = 1. / 1024.;
    let steps = 128;
    // Short arc: the exact polygon rotates rigidly, but a long trajectory
    // amplifies symmetry-breaking roundoff. KDK local error scales as h³
    // in angular units h=omega*dt. Budget 4*steps*h³ over this fixed arc,
    // both in radians and in arc length (unit radius); not a rigorous bound.
    let budget = 4. * steps as f64 * (omega * dt).powi(3);
    Orbit { name: "regular-polygon", initial, omega, dt, steps, runs: 8,
        phase_limit: budget, pos_limit: budget }
}

// Untimed gate: every completed step, every body, not just endpoint agreement.
fn verify(o: &Orbit) -> (f64, f64) {
    let mut sim = Simulation::new(&o.initial);
    let (mut phase, mut pos) = (0_f64, 0_f64);
    for k in 1..=o.steps {
        sim.step(o.dt).unwrap();
        let t = k as f64 * o.dt;
        assert!((sim.time() - t).abs() <= 2. * k as f64 * f64::EPSILON * t);
        let (s, c) = (o.omega * t).sin_cos();
        for (start, body) in o.initial.iter().zip(sim.bodies()) {
            let [x, y, _] = start.pos;
            let (ex, ey) = (c * x - s * y, s * x + c * y);
            let [x, y, z] = body.pos;
            let dp = (ex * y - ey * x).atan2(ex * x + ey * y).abs();
            let dr = ((x - ex).powi(2) + (y - ey).powi(2) + z * z).sqrt();
            assert!(dp.is_finite() && dr.is_finite());
            phase = phase.max(dp);
            pos = pos.max(dr);
        }
    }
    assert!(phase <= o.phase_limit && pos <= o.pos_limit,
        "{} not eligible: phase {phase:e} vs {:e}, pos {pos:e} vs {:e}",
        o.name, o.phase_limit, o.pos_limit);
    (phase, pos)
}

fn force_batch(o: &Orbit) -> Duration {
    let mut a = vec![[0.; 3]; o.initial.len()];
    let start = Instant::now();
    for _ in 0..o.steps * o.runs {
        acceleration(black_box(&o.initial[..]), &mut a).unwrap();
        black_box(&a[..]);
    }
    start.elapsed()
}

fn step_batch(o: &Orbit) -> Duration {
    let mut elapsed = Duration::ZERO;
    for _ in 0..o.runs {
        let mut sim = Simulation::new(&o.initial);
        let dt = black_box(o.dt);
        let start = Instant::now();
        for _ in 0..o.steps {
            sim.step(dt).unwrap();
        }
        // Observe final state, not per-step diagnostics; setup/drop excluded.
        black_box((sim.bodies(), sim.time()));
        elapsed += start.elapsed();
    }
    elapsed
}

#[test]
#[ignore = "opt-in release CPU timing; run alone"]
fn measure() {
    assert!(!cfg!(debug_assertions), "use cargo test --release");
    for o in [binary(), polygon()] {
        let (phase, pos) = verify(&o);
        force_batch(&o);
        step_batch(&o);
        let mut forces = [Duration::ZERO; SAMPLES];
        let mut steps = forces;
        for i in 0..SAMPLES {
            // Alternate order so one path does not always follow the other.
            if i % 2 == 0 {
                forces[i] = force_batch(&o);
                steps[i] = step_batch(&o);
            } else {
                steps[i] = step_batch(&o);
                forces[i] = force_batch(&o);
            }
        }
        forces.sort_unstable();
        steps.sort_unstable();
        let f = forces[SAMPLES / 2].as_secs_f64();
        let w = steps[SAMPLES / 2].as_secs_f64();
        let count = (o.steps * o.runs) as f64;
        println!("{} n={} omega={:.12e} dt={:.12e} steps/run={} duration/run={:.12e} runs/batch={} samples={} warmup_batches/path=1", o.name, o.initial.len(), o.omega, o.dt, o.steps, o.dt * o.steps as f64, o.runs, SAMPLES);
        println!("max_phase_rad={phase:.8e} limit={:.8e} max_pos={pos:.8e} limit={:.8e}", o.phase_limit, o.pos_limit);
        println!("force_batch_median_s={f:.9} ns/force={:.3} step_batch_median_s={w:.9} ns/step={:.3} sim_time/wall_s={:.6}", 1e9 * f / count, 1e9 * w / count, count * o.dt / w);
    }
}
