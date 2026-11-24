//! Fixed and adaptive step experiments against an independent REBOUND IAS15 trajectory.

use orbit_lab::{flyby::{encounter_step, Flyby, Mode, ADAPTIVE_FRACTION, FIXED_STEP, PRESETS}, Body, Simulation};
use std::time::{Duration, Instant};

type Vec3 = [f64; 3];

const MAX_POSITION_ERROR: f64 = 2e-3;
const MAX_DIRECTION_ERROR: f64 = 1e-3;
const BASELINE_REFERENCE: &str = include_str!("fixtures/flyby-ias15.csv");
const FLYBY_CASES: [(&str, &str); 4] = [
    ("baseline", BASELINE_REFERENCE),
    ("closer", include_str!("fixtures/flyby-ias15-closer.csv")),
    ("faster", include_str!("fixtures/flyby-ias15-faster.csv")),
    ("closer-faster", include_str!("fixtures/flyby-ias15-closer-faster.csv")),
];
const CASE_RESULTS_HEADER: &str = concat!(
    "case,fixed_dt,fixed_steps,adaptive_steps,",
    "fixed_position_error,adaptive_position_error,fixed_direction_error,adaptive_direction_error"
);

struct Sample {
    time: f64,
    bodies: [Body; 3],
}

fn reference(csv: &str) -> Vec<Sample> {
    let mut lines = csv.lines();
    assert_eq!(
        lines.next(),
        Some("time,m1,x1,y1,z1,vx1,vy1,vz1,m2,x2,y2,z2,vx2,vy2,vz2,m3,x3,y3,z3,vx3,vy3,vz3")
    );
    let samples: Vec<_> = lines
        .enumerate()
        .map(|(i, line)| {
            let values: Vec<f64> = line.split(',').map(|field| field.parse().unwrap()).collect();
            assert_eq!(values.len(), 22);
            assert!(values.iter().all(|value| value.is_finite()));
            assert_eq!(values[0], i as f64 / 8.0);
            let bodies = std::array::from_fn(|body| {
                let offset = 1 + body * 7;
                Body {
                    mass: values[offset],
                    pos: values[offset + 1..offset + 4].try_into().unwrap(),
                    vel: values[offset + 4..offset + 7].try_into().unwrap(),
                }
            });
            Sample {
                time: values[0],
                bodies,
            }
        })
        .collect();
    assert_eq!(samples.len(), 33);
    samples
}

fn difference(a: Vec3, b: Vec3) -> Vec3 {
    std::array::from_fn(|k| a[k] - b[k])
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn norm(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}

fn angle(a: Vec3, b: Vec3) -> f64 {
    let cross = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    norm(cross).atan2(dot(a, b))
}

fn relative_to_binary(bodies: &[Body], select: impl Fn(&Body) -> Vec3) -> Vec3 {
    let (primary, companion, visitor) = (&bodies[0], &bodies[1], &bodies[2]);
    let (a, b, c) = (select(primary), select(companion), select(visitor));
    std::array::from_fn(|k| {
        let center = (primary.mass * a[k] + companion.mass * b[k]) / (primary.mass + companion.mass);
        c[k] - center
    })
}

#[derive(Debug)]
struct Measurement {
    max_position: f64,
    outgoing_direction: f64,
    steps: usize,
    largest_step: f64,
    closest_distance: f64,
    step_at_closest: f64,
}

impl Measurement {
    fn meets_budget(&self) -> bool {
        self.max_position < MAX_POSITION_ERROR && self.outgoing_direction < MAX_DIRECTION_ERROR
    }
}

fn advance_to(
    sim: &mut Simulation,
    time: f64,
    choose_step: &impl Fn(&Simulation, f64) -> f64,
    mut observe_step: impl FnMut(&Simulation, f64),
) {
    while sim.time() < time {
        let remaining = time - sim.time();
        let dt = choose_step(sim, remaining);
        assert!(dt <= remaining, "step would skip a reference checkpoint");
        sim.step(dt).expect("regular flyby step");
        observe_step(sim, dt);
    }
    assert_eq!(sim.time(), time);
}

fn position_error(actual: &[Body], expected: &[Body]) -> f64 {
    let mut max_error: f64 = 0.0;
    for (body, reference) in actual.iter().zip(expected) {
        assert_eq!(body.mass, reference.mass);
        let error = norm(difference(body.pos, reference.pos));
        assert!(error.is_finite());
        max_error = max_error.max(error);
    }
    max_error
}

fn direction_error(actual: &[Body], expected: &[Body]) -> f64 {
    angle(
        relative_to_binary(actual, |body| body.vel),
        relative_to_binary(expected, |body| body.vel),
    )
}

fn measure(samples: &[Sample], choose_step: impl Fn(&Simulation, f64) -> f64) -> Measurement {
    let mut sim = Simulation::new(&samples[0].bodies);
    let mut closest = (f64::INFINITY, 0.0);
    let mut max_position: f64 = 0.0;
    let mut largest_step: f64 = 0.0;
    let mut steps = 0;
    for sample in samples {
        advance_to(&mut sim, sample.time, &choose_step, |sim, dt| {
            steps += 1;
            largest_step = largest_step.max(dt);
            let distance = norm(difference(sim.bodies()[0].pos, sim.bodies()[2].pos));
            if distance < closest.0 {
                closest = (distance, dt);
            }
        });
        max_position = max_position.max(position_error(sim.bodies(), &sample.bodies));
    }
    Measurement {
        max_position,
        outgoing_direction: direction_error(sim.bodies(), &samples.last().unwrap().bodies),
        steps,
        largest_step,
        closest_distance: closest.0,
        step_at_closest: closest.1,
    }
}

#[test]
fn fixed_step_flyby_converges_against_ias15() {
    let samples = reference(BASELINE_REFERENCE);
    let initial = &samples[0].bodies;
    let final_bodies = &samples.last().unwrap().bodies;
    let incoming = relative_to_binary(initial, |body| body.vel);
    let outgoing = relative_to_binary(final_bodies, |body| body.vel);
    assert!(dot(relative_to_binary(initial, |body| body.pos), incoming) < 0.0);
    assert!(dot(relative_to_binary(final_bodies, |body| body.pos), outgoing) > 0.0);
    println!("IAS15 finite-time turn: {:.6} deg", angle(incoming, outgoing).to_degrees());
    println!("dt,sampled_closest_primary_visitor,max_position_error,outgoing_direction_error_rad");

    let errors = [1.0 / 32.0, 1.0 / 64.0, 1.0 / 128.0, 1.0 / 256.0, FIXED_STEP]
        .map(|dt| {
            let run = measure(&samples, |_, _| dt);
            println!(
                "{dt:.10},{:.9},{:.8e},{:.8e}",
                run.closest_distance, run.max_position, run.outgoing_direction
            );
            run
        });
    let finest = errors.last().unwrap();
    assert!(finest.meets_budget(), "{finest:?}");
    // Compare the resolved steps. Halving dt should reduce both errors about fourfold.
    for pair in errors[2..].windows(2) {
        let position_ratio = pair[0].max_position / pair[1].max_position;
        let direction_ratio = pair[0].outgoing_direction / pair[1].outgoing_direction;
        assert!(
            (3.5..=4.5).contains(&position_ratio) && (3.5..=4.5).contains(&direction_ratio),
            "step-halving ratios: positions={position_ratio}, outgoing direction={direction_ratio}"
        );
    }
}

#[test]
fn adaptive_flyby_meets_the_fixed_step_budget_with_fewer_steps() {
    let samples = reference(BASELINE_REFERENCE);
    let fixed = measure(&samples, |_, _| FIXED_STEP);
    assert!(fixed.meets_budget(), "{fixed:?}");

    println!("scheme,steps,largest_step,step_at_closest,max_position_error,outgoing_direction_error_rad,passes");
    println!(
        "fixed 1/512,{},{:.10},{:.10},{:.8e},{:.8e},{}",
        fixed.steps, fixed.largest_step, fixed.step_at_closest, fixed.max_position,
        fixed.outgoing_direction, fixed.meets_budget()
    );
    let runs = [8, 16, 32, 64].map(|denominator| {
        let fraction = 1.0 / denominator as f64;
        let run = measure(&samples, |sim, remaining| {
            encounter_step(sim, remaining, fraction).expect("adaptive flyby step")
        });
        println!(
            "eta 1/{denominator},{},{:.10},{:.10},{:.8e},{:.8e},{}",
            run.steps, run.largest_step, run.step_at_closest, run.max_position,
            run.outgoing_direction, run.meets_budget()
        );
        run
    });
    let best = runs.iter()
        .filter(|run| run.meets_budget())
        .min_by_key(|run| run.steps)
        .expect("an adaptive run must meet both flyby budgets");
    assert!(best.steps < fixed.steps, "{best:?}");
    assert!(best.step_at_closest < best.largest_step, "{best:?}");
}

fn adaptive_step(sim: &Simulation, remaining: f64) -> f64 {
    encounter_step(sim, remaining, ADAPTIVE_FRACTION).expect("adaptive flyby step")
}

fn compare_case(name: &str, samples: &[Sample]) -> (f64, Measurement, Measurement) {
    let final_bodies = &samples.last().unwrap().bodies;
    let departure = dot(
        relative_to_binary(final_bodies, |body| body.pos),
        relative_to_binary(final_bodies, |body| body.vel),
    );
    assert!(departure > 0.0, "{name} must be outbound at t=4");
    let adaptive = measure(samples, adaptive_step);
    assert!(adaptive.meets_budget(), "{name}: adaptive {adaptive:?}");

    for power in 5..=12 {
        let dt = 1.0 / (1u32 << power) as f64;
        let fixed = measure(samples, |_, _| dt);
        if fixed.meets_budget() {
            println!(
                "{name},{dt:.10},{},{},{:.8e},{:.8e},{:.8e},{:.8e}",
                fixed.steps, adaptive.steps, fixed.max_position, adaptive.max_position,
                fixed.outgoing_direction, adaptive.outgoing_direction
            );
            return (dt, fixed, adaptive);
        }
    }
    panic!("{name}: no fixed step on the tested grid meets both budgets");
}

#[test]
fn adaptive_flyby_meets_budget_across_initial_conditions() {
    println!("{CASE_RESULTS_HEADER}");
    for (name, csv) in FLYBY_CASES {
        let (_, fixed, adaptive) = compare_case(name, &reference(csv));
        assert!(adaptive.steps < fixed.steps, "{name}: {adaptive:?} vs {fixed:?}");
    }
}

#[test]
fn experiment_driver_matches_the_flyby_reference_in_both_modes() {
    let expected_counts = [(2048, 240), (4096, 267), (1024, 214), (2048, 243)];
    for (index, ((name, csv), (fixed_steps, adaptive_steps))) in
        FLYBY_CASES.into_iter().zip(expected_counts).enumerate()
    {
        assert_eq!(PRESETS[index].id, name);
        let samples = reference(csv);
        for (mode, expected_steps) in [(Mode::Fixed, fixed_steps), (Mode::Adaptive, adaptive_steps)] {
            let mut flyby = Flyby::from_preset(mode, index).unwrap();
            for (body, initial) in flyby.simulation().bodies().iter().zip(&samples[0].bodies) {
                assert_eq!((body.mass, body.pos, body.vel), (initial.mass, initial.pos, initial.vel));
            }
            assert_eq!(flyby.checkpoint(), 0);
            assert_eq!(flyby.steps(), 0);
            for (checkpoint, sample) in samples.iter().enumerate().skip(1) {
                let previous_steps = flyby.steps();
                assert!(flyby.advance_checkpoint().unwrap());
                assert_eq!(flyby.checkpoint() as usize, checkpoint);
                assert_eq!(flyby.simulation().time(), sample.time);
                assert!(flyby.steps() > previous_steps);
                assert!(position_error(flyby.simulation().bodies(), &sample.bodies) < MAX_POSITION_ERROR,
                    "{name} {mode:?} checkpoint {checkpoint}");
            }
            let final_bodies = &samples.last().unwrap().bodies;
            assert!(direction_error(flyby.simulation().bodies(), final_bodies) < MAX_DIRECTION_ERROR,
                "{name} {mode:?} outgoing direction");
            assert_eq!(flyby.steps(), expected_steps, "{name} {mode:?}");
            assert!(!flyby.advance_checkpoint().unwrap());
            assert_eq!(flyby.simulation().time(), 4.0);
            assert_eq!(flyby.steps(), expected_steps);
        }
    }
}

const TIMING_RUNS: usize = 512;
const TIMING_BATCHES: usize = 9;

fn time_batch(samples: &[Sample], choose_step: impl Fn(&Simulation, f64) -> f64) -> Duration {
    let mut trajectories: Vec<_> = (0..TIMING_RUNS)
        .map(|_| Simulation::new(&samples[0].bodies))
        .collect();
    let start = Instant::now();
    for sim in &mut trajectories {
        for sample in &samples[1..] {
            advance_to(sim, sample.time, &choose_step, |_, _| {});
        }
    }
    let elapsed = start.elapsed();

    // Observe the timed trajectories after the clock stops.
    let final_sample = samples.last().unwrap();
    for sim in &trajectories {
        assert_eq!(sim.time(), final_sample.time);
        assert!(position_error(sim.bodies(), &final_sample.bodies) < MAX_POSITION_ERROR);
        assert!(direction_error(sim.bodies(), &final_sample.bodies) < MAX_DIRECTION_ERROR);
    }
    elapsed
}

#[test]
#[ignore = "opt-in release timing; run alone"]
fn time_flyby_steps() {
    assert!(!cfg!(debug_assertions), "use cargo test --release");
    println!("{TIMING_RUNS} trajectories per batch, {TIMING_BATCHES} timed batches per scheme");
    println!("{CASE_RESULTS_HEADER}");
    for (name, csv) in FLYBY_CASES {
        let samples = reference(csv);
        let (dt, _, _) = compare_case(name, &samples);
        time_batch(&samples, |_, _| dt);
        time_batch(&samples, adaptive_step);

        let mut fixed = [Duration::ZERO; TIMING_BATCHES];
        let mut adaptive = [Duration::ZERO; TIMING_BATCHES];
        for i in 0..TIMING_BATCHES {
            if i % 2 == 0 {
                fixed[i] = time_batch(&samples, |_, _| dt);
                adaptive[i] = time_batch(&samples, adaptive_step);
            } else {
                adaptive[i] = time_batch(&samples, adaptive_step);
                fixed[i] = time_batch(&samples, |_, _| dt);
            }
        }
        fixed.sort_unstable();
        adaptive.sort_unstable();
        let micros = |batch: Duration| batch.as_secs_f64() * 1e6 / TIMING_RUNS as f64;
        let middle = TIMING_BATCHES / 2;
        let last = TIMING_BATCHES - 1;
        let fixed_us = micros(fixed[middle]);
        let adaptive_us = micros(adaptive[middle]);
        println!(
            "{name}: fixed {fixed_us:.3} µs ({:.3}–{:.3}), adaptive {adaptive_us:.3} µs ({:.3}–{:.3}), {:.2}×",
            micros(fixed[0]), micros(fixed[last]), micros(adaptive[0]), micros(adaptive[last]),
            fixed_us / adaptive_us
        );
    }
}

#[test]
fn adaptive_step_respects_crossing_time_checkpoint_and_grid() {
    let mut bodies = orbit_lab::circular_binary(1.0);
    bodies[0].vel[1] = -16.0;
    bodies[1].vel[1] = 16.0;
    let mut sim = Simulation::new(&bodies);
    let fraction = 1.0 / 8.0;

    // At unit separation and relative speed 32, the crossing time sets the limit.
    assert_eq!(encounter_step(&sim, 1.0 / 8.0, fraction), Ok(1.0 / 256.0));
    assert_eq!(encounter_step(&sim, 1.0 / 1024.0, fraction), Ok(1.0 / 1024.0));

    // A coarser step would start off its own grid after this advance.
    sim.step(1.0 / 512.0).unwrap();
    assert_eq!(encounter_step(&sim, 1.0 / 8.0 - sim.time(), fraction), Ok(1.0 / 512.0));
}

#[test]
fn adaptive_step_rejects_an_encounter_below_its_resolution() {
    // The pair is at rest, so the gravitational timescale sets the step limit.
    let bodies = [
        Body {
            mass: 0.5,
            pos: [0.0; 3],
            vel: [0.0; 3],
        },
        Body {
            mass: 0.5,
            pos: [1e-4, 0.0, 0.0],
            vel: [0.0; 3],
        },
    ];
    let sim = Simulation::new(&bodies);
    assert_eq!(
        encounter_step(&sim, 0.125, 1.0 / 8.0),
        Err("encounter requires a smaller timestep")
    );
    assert_eq!(sim.time(), 0.0);
    assert_eq!(sim.bodies()[1].pos, bodies[1].pos);
}
