use crate::{gravity::acceleration, integrator::advance, Body};

/// A fixed-size world. Only a complete kick–drift–kick advances its clock.
pub struct Simulation {
    current: Vec<Body>,
    spare: Vec<Body>,
    acceleration: Vec<[f64; 3]>,
    // When true the buffer belongs to current, never to a rejected candidate.
    acceleration_valid: bool,
    time: f64,
}

impl Simulation {
    pub fn new(initial: &[Body]) -> Self {
        Self {
            current: initial.to_vec(),
            spare: initial.to_vec(),
            acceleration: vec![[0.; 3]; initial.len()],
            acceleration_valid: false,
            time: 0.,
        }
    }

    /// Starts an independent world at this committed state, with a cold force cache.
    pub fn fork(&self) -> Self {
        Self { time: self.time, ..Self::new(&self.current) }
    }

    pub fn bodies(&self) -> &[Body] {
        &self.current
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    /// Changes only the committed mass, without advancing time or rebuilding an orbit.
    pub fn set_mass(&mut self, index: usize, mass: f64) -> Result<(), &'static str> {
        if !mass.is_finite() || mass <= 0. {
            return Err("invalid mass");
        }
        let body = self.current.get_mut(index).ok_or("invalid body index")?;
        body.mass = mass;
        self.acceleration_valid = false;
        Ok(())
    }

    pub fn step(&mut self, dt: f64) -> Result<(), &'static str> {
        let time = self.time + dt;
        // A positive dt can still round away at a large simulation time.
        if !time.is_finite() || time <= self.time {
            return Err("invalid timestep");
        }
        if self.current.iter().any(|b| !b.mass.is_finite() || b.mass <= 0.) {
            return Err("invalid mass");
        }
        if !self.acceleration_valid {
            acceleration(&self.current, &mut self.acceleration)?;
        }
        // Reuse one buffer. If advance fails after overwriting it, the next
        // attempt recomputes from current; success alone publishes the endpoint.
        self.acceleration_valid = false;
        advance(&self.current, &mut self.spare, &mut self.acceleration, dt)?;
        std::mem::swap(&mut self.current, &mut self.spare);
        self.time = time;
        self.acceleration_valid = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(sim: &Simulation) -> Vec<(f64, [f64; 3], [f64; 3])> {
        sim.bodies().iter().map(|b| (b.mass, b.pos, b.vel)).collect()
    }

    #[test]
    fn edited_warm_branch_matches_cold_reference_without_changing_a() {
        let mut a = Simulation::new(&crate::circular_binary(0.25));
        a.step(0.01).unwrap();
        let (a_time, a_state) = (a.time(), state(&a));
        let mut b = a.fork();
        b.step(0.01).unwrap(); // warm B's endpoint cache before the edit
        let mut edited = b.bodies().to_vec();
        edited[1].mass = 2.;
        let mut cold = Simulation { time: b.time(), ..Simulation::new(&edited) };
        b.set_mass(1, 2.).unwrap();
        assert_eq!(b.time(), cold.time());
        assert_eq!(state(&b), state(&cold));
        b.step(0.01).unwrap();
        cold.step(0.01).unwrap();
        assert_eq!(b.time(), cold.time());
        assert_eq!(state(&b), state(&cold));
        assert_eq!(a.time(), a_time);
        assert_eq!(state(&a), a_state);
    }

    #[test]
    fn rejected_edits_leave_committed_state_and_cache_unchanged() {
        let mut sim = Simulation::new(&crate::circular_binary(1.));
        sim.step(0.01).unwrap();
        let (time, before, acceleration) = (sim.time(), state(&sim), sim.acceleration.clone());
        for (index, mass) in [(2, 1.), (1, 0.), (0, -1.), (1, f64::NAN), (0, f64::INFINITY)] {
            assert!(sim.set_mass(index, mass).is_err());
            assert_eq!(sim.time(), time);
            assert_eq!(state(&sim), before);
            assert!(sim.acceleration_valid);
            assert_eq!(sim.acceleration, acceleration);
        }
    }

    #[test]
    fn warm_world_forks_only_committed_state() {
        let mut a = Simulation::new(&crate::circular_binary(0.25));
        a.step(0.01).unwrap();
        let (time, bodies) = (a.time(), state(&a));
        let mut b = a.fork();
        assert!(a.acceleration_valid);
        assert!(!b.acceleration_valid);
        assert_eq!(b.time(), time);
        assert_eq!(state(&b), bodies);

        b.step(0.01).unwrap();
        assert_eq!(a.time(), time);
        assert_eq!(state(&a), bodies);
        a.step(0.01).unwrap();
        assert_eq!(b.time(), a.time());
        assert_eq!(state(&b), state(&a));
    }
}
