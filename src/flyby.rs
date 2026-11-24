//! Step selection and sampling for the three-body flyby experiment.

use crate::{scenarios::flyby_initial, Simulation};

pub const FIXED_STEP: f64 = 1.0 / BASELINE_FIXED_DENOMINATOR as f64;
pub const ADAPTIVE_FRACTION: f64 = 1.0 / 16.0;
pub const CHECKPOINT_COUNT: u32 = 32;
pub const END_TIME: f64 = CHECKPOINT_COUNT as f64 * CHECKPOINT_INTERVAL;
pub const CUSTOM_FIXED_DENOMINATOR: u32 = 1024;
const BASELINE_FIXED_DENOMINATOR: u32 = 512;
const CHECKPOINT_INTERVAL: f64 = 1.0 / 8.0;
const MAX_ADAPTIVE_STEP: f64 = 1.0 / 32.0;
const MIN_ADAPTIVE_STEP: f64 = 1.0 / 65_536.0;

#[derive(Clone, Copy, Debug)]
pub enum Mode {
    Fixed,
    Adaptive,
}

pub struct Preset {
    pub id: &'static str,
    pub visitor_y: f64,
    pub visitor_vx: f64,
    pub fixed_denominator: u32,
}

/// IAS15 comparison cases from FLYBY_BASELINE.md. Index 0 is the original run.
pub const PRESETS: [Preset; 4] = [
    Preset {
        id: "baseline",
        visitor_y: 0.23,
        visitor_vx: 1.45,
        fixed_denominator: BASELINE_FIXED_DENOMINATOR,
    },
    Preset {
        id: "closer",
        visitor_y: 0.12,
        visitor_vx: 1.45,
        fixed_denominator: 1024,
    },
    Preset {
        id: "faster",
        visitor_y: 0.23,
        visitor_vx: 2.00,
        fixed_denominator: 256,
    },
    Preset {
        id: "closer-faster",
        visitor_y: 0.12,
        visitor_vx: 2.00,
        fixed_denominator: 512,
    },
];

pub struct Flyby {
    simulation: Simulation,
    mode: Mode,
    fixed_step: f64,
    checkpoint: u32,
    steps: u32,
}

impl Flyby {
    pub fn new(mode: Mode) -> Self {
        Self::from_settings(mode, &PRESETS[0])
    }

    pub fn from_preset(mode: Mode, index: usize) -> Result<Self, &'static str> {
        PRESETS.get(index)
            .map(|preset| Self::from_settings(mode, preset))
            .ok_or("unknown flyby preset")
    }

    pub fn from_custom(mode: Mode, visitor_y: f64, visitor_vx: f64) -> Result<Self, &'static str> {
        if !visitor_y.is_finite() || !visitor_vx.is_finite() || visitor_vx <= 0.0 {
            return Err("flyby requires a finite y and a finite positive vx");
        }
        Ok(Self::start(mode, visitor_y, visitor_vx, CUSTOM_FIXED_DENOMINATOR))
    }

    fn from_settings(mode: Mode, preset: &Preset) -> Self {
        Self::start(mode, preset.visitor_y, preset.visitor_vx, preset.fixed_denominator)
    }

    fn start(mode: Mode, visitor_y: f64, visitor_vx: f64, fixed_denominator: u32) -> Self {
        Self {
            simulation: Simulation::new(&flyby_initial(visitor_y, visitor_vx)),
            mode,
            fixed_step: 1.0 / f64::from(fixed_denominator),
            checkpoint: 0,
            steps: 0,
        }
    }

    pub fn simulation(&self) -> &Simulation {
        &self.simulation
    }

    pub fn checkpoint(&self) -> u32 {
        self.checkpoint
    }

    pub fn steps(&self) -> u32 {
        self.steps
    }

    /// Advance to the next sampling time. Returns `false` at the final sample.
    /// On error, each successful physical step remains committed. The checkpoint
    /// advances only once the sampling time has been reached.
    pub fn advance_checkpoint(&mut self) -> Result<bool, &'static str> {
        if self.checkpoint == CHECKPOINT_COUNT {
            return Ok(false);
        }
        // Fixed and adaptive steps both align exactly with this dyadic grid.
        let time = f64::from(self.checkpoint + 1) * CHECKPOINT_INTERVAL;
        while self.simulation.time() < time {
            let remaining = time - self.simulation.time();
            let dt = match self.mode {
                Mode::Fixed => self.fixed_step,
                Mode::Adaptive => encounter_step(&self.simulation, remaining, ADAPTIVE_FRACTION)?,
            };
            self.simulation.step(dt)?;
            self.steps += 1;
        }
        self.checkpoint += 1;
        Ok(true)
    }
}

/// Select the largest aligned dyadic step within the remaining time and pair timescales.
pub fn encounter_step(sim: &Simulation, remaining: f64, fraction: f64) -> Result<f64, &'static str> {
    if !remaining.is_finite() || remaining <= 0.0 || !fraction.is_finite() || fraction <= 0.0 {
        return Err("invalid encounter step parameters");
    }
    let bodies = sim.bodies();
    let mut limit = remaining.min(MAX_ADAPTIVE_STEP);
    for (i, body) in bodies.iter().enumerate() {
        for other in &bodies[i + 1..] {
            let distance = separation(body.pos, other.pos);
            let speed = separation(body.vel, other.vel);
            let mass = body.mass + other.mass;
            if distance <= 0.0 || !distance.is_finite() || !speed.is_finite()
                || mass <= 0.0 || !mass.is_finite()
            {
                return Err("invalid encounter scale");
            }
            let crossing_time = distance / speed;
            // G = 1. This scale remains finite for a pair at rest.
            let dynamical_time = distance * (distance / mass).sqrt();
            limit = limit.min(fraction * crossing_time.min(dynamical_time));
        }
    }

    let mut step = MAX_ADAPTIVE_STEP;
    while step >= MIN_ADAPTIVE_STEP {
        if step <= limit && sim.time() % step == 0.0 {
            return Ok(step);
        }
        step *= 0.5;
    }
    Err("encounter requires a smaller timestep")
}

fn separation(a: [f64; 3], b: [f64; 3]) -> f64 {
    let delta: [f64; 3] = std::array::from_fn(|k| a[k] - b[k]);
    delta.iter().map(|d| d * d).sum::<f64>().sqrt()
}
