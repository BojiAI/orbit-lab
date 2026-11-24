use orbit_lab::{spherical_body, Body, Simulation};
use std::cell::RefCell;

const MAX_EXACT_STEPS: u64 = (1 << 53) - 1; // Exact integer range of a JavaScript Number.

struct Run {
    simulation: Simulation,
    dt: f64,
    steps: u64,
    end: Option<u64>,
}

thread_local! {
    static DRAFT: RefCell<Vec<Body>> = RefCell::new(Vec::new());
    static RUN: RefCell<Option<Run>> = RefCell::new(None);
}

#[no_mangle]
pub extern "C" fn scene_clear_draft() {
    DRAFT.with(|draft| draft.borrow_mut().clear());
}

#[no_mangle]
pub extern "C" fn scene_add_body(
    radius: f64,
    density: f64,
    x: f64,
    y: f64,
    z: f64,
    vx: f64,
    vy: f64,
    vz: f64,
) -> i32 {
    match spherical_body(radius, density, [x, y, z], [vx, vy, vz]) {
        Ok(body) => {
            DRAFT.with(|draft| draft.borrow_mut().push(body));
            0
        }
        Err(_) => 1,
    }
}

/// An end of zero indicates a run with no configured step limit.
#[no_mangle]
pub extern "C" fn scene_start(dt: f64, end: u32) -> i32 {
    if !dt.is_finite() || dt <= 0.0 || !(dt * f64::from(end)).is_finite() {
        return 1;
    }
    let end = (end != 0).then_some(u64::from(end));
    DRAFT.with(|draft| {
        let mut bodies = draft.borrow_mut();
        if bodies.is_empty() {
            return 1;
        }
        for (index, body) in bodies.iter().enumerate() {
            if bodies[..index].iter().any(|other| other.pos == body.pos) {
                return 2;
            }
        }
        let simulation = Simulation::new(&bodies);
        RUN.with(|run| *run.borrow_mut() = Some(Run { simulation, dt, steps: 0, end }));
        bodies.clear();
        0
    })
}

/// Lift the step limit at the current endpoint without rebuilding the simulation.
#[no_mangle]
pub extern "C" fn scene_continue() -> i32 {
    RUN.with(|run| match run.borrow_mut().as_mut() {
        Some(run) if run.end == Some(run.steps) => {
            run.end = None;
            0
        }
        _ => 1,
    })
}

/// Return 2 if advancing fails. The last successful step remains readable.
#[no_mangle]
pub extern "C" fn scene_advance(count: u32) -> i32 {
    RUN.with(|run| {
        run.borrow_mut().as_mut().map_or(1, |run| {
            if count == 0 || run.end.map_or(false, |end| run.steps + u64::from(count) > end) {
                return 1;
            }
            for _ in 0..count {
                if run.steps == MAX_EXACT_STEPS || run.simulation.step(run.dt).is_err() {
                    return 2;
                }
                run.steps += 1;
            }
            0
        })
    })
}

#[no_mangle]
pub extern "C" fn scene_value(index: u32) -> f64 {
    RUN.with(|run| run.borrow().as_ref().map_or(f64::NAN, |run| {
        super::phase_space_component(&run.simulation, index)
    }))
}

#[no_mangle]
pub extern "C" fn scene_mass(index: u32) -> f64 {
    RUN.with(|run| run.borrow().as_ref()
        .and_then(|run| run.simulation.bodies().get(index as usize))
        .map_or(f64::NAN, |body| body.mass))
}

#[no_mangle]
pub extern "C" fn scene_steps() -> f64 {
    RUN.with(|run| run.borrow().as_ref().map_or(0.0, |run| run.steps as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_matches_native_bodies_and_preserves_the_run_when_start_is_rejected() {
        let initial = [
            spherical_body(0.15, 8.0, [-1.0, 0.0, 0.5], [0.0, -0.2, 0.0]).unwrap(),
            spherical_body(0.2, 12.0, [0.75, 0.3, -0.2], [0.0, 0.3, 0.0]).unwrap(),
            spherical_body(0.075, 6.0, [0.3, -1.0, 0.4], [0.4, 0.1, -0.1]).unwrap(),
        ];
        scene_clear_draft();
        assert_eq!(scene_add_body(0.15, 8.0, -1.0, 0.0, 0.5, 0.0, -0.2, 0.0), 0);
        assert_eq!(scene_add_body(0.2, 12.0, 0.75, 0.3, -0.2, 0.0, 0.3, 0.0), 0);
        assert_eq!(scene_add_body(0.075, 6.0, 0.3, -1.0, 0.4, 0.4, 0.1, -0.1), 0);
        let dt = 1.0 / 256.0;
        assert_eq!(scene_start(dt, 8), 0);
        assert_eq!(scene_mass(1), initial[1].mass);
        let mut native = Simulation::new(&initial);
        for _ in 0..5 {
            assert_eq!(scene_advance(1), 0);
            native.step(dt).unwrap();
            for index in 0..19 {
                assert_eq!(scene_value(index), super::super::phase_space_component(&native, index));
            }
        }
        assert_eq!(scene_steps(), 5.0);
        assert!(scene_value(19).is_nan());
        assert_eq!(scene_add_body(0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0), 1);
        assert_eq!(scene_start(dt, 4), 1);
        assert_eq!(scene_advance(4), 1);
        assert_eq!(scene_steps(), 5.0);
        assert_eq!(scene_value(0), native.time());

        assert_eq!(scene_continue(), 1);
        assert_eq!(scene_advance(3), 0);
        for _ in 0..3 {
            native.step(dt).unwrap();
        }
        assert_eq!(scene_advance(1), 1);
        assert_eq!(scene_continue(), 0);
        assert_eq!(scene_steps(), 8.0);
        for index in 0..19 {
            assert_eq!(scene_value(index), super::super::phase_space_component(&native, index));
        }
        assert_eq!(scene_advance(1), 0);
        native.step(dt).unwrap();
        assert_eq!(scene_steps(), 9.0);
        for index in 0..19 {
            assert_eq!(scene_value(index), super::super::phase_space_component(&native, index));
        }
    }

    #[test]
    fn scene_without_a_step_limit_advances_past_the_previous_default() {
        scene_clear_draft();
        assert_eq!(scene_add_body(1.0, 1.0, -2.0, 0.0, 0.0, 1.0, 0.0, 0.0), 0);
        assert_eq!(scene_start(1.0 / 128.0, 0), 0);
        assert_eq!(scene_advance(1024), 0);
        assert_eq!(scene_steps(), 1024.0);
        assert_eq!(scene_value(0), 8.0);
        assert_eq!(scene_value(1), 6.0);
    }

    #[test]
    fn failed_scene_step_exposes_the_last_committed_snapshot() {
        scene_clear_draft();
        assert_eq!(scene_add_body(1.0, 1e-30, -4.0, 0.0, 0.0, 4.0, 0.0, 0.0), 0);
        assert_eq!(scene_add_body(1.0, 1e-30, 4.0, 0.0, 0.0, -4.0, 0.0, 0.0), 0);
        assert_eq!(scene_start(1.0, 2), 0);
        let before: [f64; 13] = std::array::from_fn(|index| scene_value(index as u32));
        assert_eq!(scene_advance(1), 2);
        assert_eq!(scene_steps(), 0.0);
        assert_eq!(before, std::array::from_fn(|index| scene_value(index as u32)));
    }
}
