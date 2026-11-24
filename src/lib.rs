//! Dimensionless Newtonian point masses, G = 1. No collision model.
mod diagnostics;
pub mod flyby;
mod gravity;
mod integrator;
#[cfg(all(test, feature = "m2-bench"))]
mod m2_baseline;
mod scenarios;
mod simulation;
mod state;

pub use diagnostics::{conserved_quantities, ConservedQuantities};
pub use scenarios::{circular_binary, spherical_body};
pub use simulation::Simulation;
pub use state::Body;

/// One-off compatibility entry point. Reuse a `Simulation` for continuous stepping.
pub fn step(bodies: &mut [Body], dt: f64) -> Result<(), &'static str> {
    let mut sim = Simulation::new(bodies);
    sim.step(dt)?;
    bodies.clone_from_slice(sim.bodies());
    Ok(())
}
