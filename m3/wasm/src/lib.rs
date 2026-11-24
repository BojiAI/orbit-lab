//! Scalar ABI for the worker-owned binary and flyby experiments.
use orbit_lab::{circular_binary, conserved_quantities, Simulation};
use std::{cell::RefCell, f64::consts::TAU};

mod flyby;
mod scene;

fn initial(q: f64) -> Simulation {
    Simulation::new(&circular_binary(q))
}

thread_local! {
    static SIM: RefCell<Simulation> = RefCell::new(initial(1.0));
    static BRANCH: RefCell<Option<Simulation>> = RefCell::new(None);
}

/// Rebuilds the circular orbit; nonzero means q was rejected without changing the world.
#[no_mangle]
pub extern "C" fn reset(q: f64) -> i32 {
    if !(0.01..=100.0).contains(&q) {
        return 1;
    }
    SIM.with(|sim| *sim.borrow_mut() = initial(q));
    BRANCH.with(|branch| *branch.borrow_mut() = None);
    0
}

/// Replace B with an independent fork of A's last committed state.
#[no_mangle]
pub extern "C" fn fork_b() {
    let fork = SIM.with(|sim| sim.borrow().fork());
    BRANCH.with(|branch| *branch.borrow_mut() = Some(fork));
}

/// Set an absolute mass in branch B, without rebuilding or advancing either world.
#[no_mangle]
pub extern "C" fn set_mass_b(index: u32, mass: f64) -> i32 {
    if !(0.01..=100.0).contains(&mass) {
        return 1;
    }
    BRANCH.with(|branch| branch.borrow_mut().as_mut().map_or(1, |sim| {
        i32::from(sim.set_mass(index as usize, mass).is_err())
    }))
}

#[no_mangle]
pub extern "C" fn mass_b(index: u32) -> f64 {
    BRANCH.with(|branch| branch.borrow().as_ref()
        .and_then(|sim| sim.bodies().get(index as usize))
        .map_or(f64::NAN, |body| body.mass))
}

fn advance(sim: &mut Simulation) -> i32 {
    i32::from(sim.step(TAU / 1024.0).is_err())
}

#[no_mangle]
pub extern "C" fn step_b() -> i32 {
    BRANCH.with(|branch| branch.borrow_mut().as_mut().map_or(1, advance))
}

/// Advances exactly one fixed step; nonzero means the step was rejected.
#[no_mangle]
pub extern "C" fn step() -> i32 {
    SIM.with(|sim| advance(&mut sim.borrow_mut()))
}

/// Time, (x, y, z, vx, vy, vz) for each body, energy, then (Lx, Ly, Lz).
/// NaN for an unknown index or unavailable diagnostic.
#[no_mangle]
pub extern "C" fn value(index: u32) -> f64 {
    SIM.with(|sim| component(&sim.borrow(), index))
}

#[no_mangle]
pub extern "C" fn value_b(index: u32) -> f64 {
    BRANCH.with(|branch| branch.borrow().as_ref().map_or(f64::NAN, |sim| component(sim, index)))
}

fn component(sim: &Simulation, index: u32) -> f64 {
    match index {
        0..=12 => phase_space_component(sim, index),
        13..=16 => conserved_quantities(sim.bodies()).map_or(f64::NAN, |diagnostics| {
            if index == 13 {
                diagnostics.energy
            } else {
                diagnostics.angular_momentum[(index - 14) as usize]
            }
        }),
        _ => f64::NAN,
    }
}

fn phase_space_component(sim: &Simulation, index: u32) -> f64 {
    if index == 0 {
        return sim.time();
    }
    let slot = (index - 1) as usize;
    let body = match sim.bodies().get(slot / 6) {
        Some(body) => body,
        None => return f64::NAN,
    };
    match slot % 6 {
        axis @ 0..=2 => body.pos[axis],
        component => body.vel[component - 3],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> [f64; 13] {
        std::array::from_fn(|i| value(i as u32))
    }

    #[test]
    fn branch_advances_independently_until_reset() {
        let branch = || std::array::from_fn(|i| value_b(i as u32));
        assert_eq!(reset(0.25), 0);
        assert_eq!(step(), 0);
        let split = snapshot();
        fork_b();
        assert_eq!(branch(), split);
        assert_eq!(step(), 0);
        assert_eq!(branch(), split);
        assert_eq!(step_b(), 0);
        assert_eq!(branch(), snapshot());
        assert_eq!(reset(1.0), 0);
        assert_ne!(step_b(), 0);
        assert!(value_b(0).is_nan());
    }

    #[test]
    fn mass_edit_targets_existing_branch_and_preserves_snapshot() {
        assert_eq!(reset(1.), 0);
        assert_ne!(set_mass_b(1, 2.), 0);
        fork_b();
        assert_eq!(step_b(), 0);
        let before: [f64; 13] = std::array::from_fn(|i| value_b(i as u32));
        let original_a = snapshot();
        for mass in [0.01, 100.] {
            assert_eq!(set_mass_b(1, mass), 0);
            assert_eq!(mass_b(1), mass);
        }
        for (index, mass) in [(2, 1.), (1, 0.009), (1, 100.01), (1, f64::NAN)] {
            assert_ne!(set_mass_b(index, mass), 0);
        }
        assert_eq!(mass_b(0), 0.5);
        assert_eq!(mass_b(1), 100.);
        assert_eq!(before, std::array::from_fn(|i| value_b(i as u32)));
        assert_eq!(original_a, snapshot());
        fork_b();
        assert_eq!(mass_b(1), 0.5); // A's mass was never edited
    }

    #[test]
    fn invalid_reset_preserves_world() {
        assert_eq!(reset(0.25), 0);
        assert_eq!(step(), 0);
        let advanced = snapshot();
        for q in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY, 0.009, 100.01] {
            assert_ne!(reset(q), 0);
            assert_eq!(snapshot(), advanced);
        }
    }
}
