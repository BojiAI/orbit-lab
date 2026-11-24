use orbit_lab::flyby::{Flyby, Mode, CHECKPOINT_COUNT};
use std::cell::RefCell;

thread_local! {
    static FLYBY: RefCell<Option<Flyby>> = RefCell::new(None);
}

/// Start from the flyby baseline. Mode 0 is fixed; mode 1 is adaptive.
#[no_mangle]
pub extern "C" fn flyby_reset(mode: u32) -> i32 {
    flyby_reset_preset(mode, 0)
}

#[no_mangle]
pub extern "C" fn flyby_reset_preset(mode: u32, preset: u32) -> i32 {
    reset(mode, |mode| Flyby::from_preset(mode, preset as usize))
}

#[no_mangle]
pub extern "C" fn flyby_reset_custom(mode: u32, visitor_y: f64, visitor_vx: f64) -> i32 {
    reset(mode, |mode| Flyby::from_custom(mode, visitor_y, visitor_vx))
}

fn reset(mode: u32, create: impl FnOnce(Mode) -> Result<Flyby, &'static str>) -> i32 {
    let mode = match mode {
        0 => Mode::Fixed,
        1 => Mode::Adaptive,
        _ => return 1,
    };
    let run = match create(mode) {
        Ok(run) => run,
        Err(_) => return 1,
    };
    FLYBY.with(|flyby| *flyby.borrow_mut() = Some(run));
    0
}

/// Advance to the next sample. Status 2 means the run is complete.
#[no_mangle]
pub extern "C" fn flyby_next() -> i32 {
    FLYBY.with(|flyby| {
        flyby.borrow_mut().as_mut().map_or(1, |run| match run.advance_checkpoint() {
            Ok(true) => 0,
            Ok(false) => 2,
            Err(_) => 1,
        })
    })
}

/// Time and six state values per body, then steps, checkpoint and final checkpoint.
#[no_mangle]
pub extern "C" fn flyby_value(index: u32) -> f64 {
    FLYBY.with(|flyby| {
        flyby.borrow().as_ref().map_or(f64::NAN, |run| match index {
            0..=18 => super::phase_space_component(run.simulation(), index),
            19 => f64::from(run.steps()),
            20 => f64::from(run.checkpoint()),
            21 => f64::from(CHECKPOINT_COUNT),
            _ => f64::NAN,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_start_preserves_the_current_run() {
        assert_eq!(flyby_next(), 1);
        assert!(flyby_value(0).is_nan());
        assert_eq!(flyby_reset(0), 0);
        assert_eq!(flyby_next(), 0);
        let advanced: [f64; 22] = std::array::from_fn(|index| flyby_value(index as u32));
        assert_eq!(flyby_reset(2), 1);
        assert_eq!(flyby_reset_preset(0, 4), 1);
        assert_eq!(flyby_reset_custom(1, f64::NAN, 1.45), 1);
        assert_eq!(flyby_reset_custom(1, 0.23, 0.0), 1);
        assert_eq!(advanced, std::array::from_fn(|index| flyby_value(index as u32)));
        assert_eq!(flyby_reset_preset(1, 1), 0);
        assert_eq!(flyby_value(14), 0.12);
        assert_eq!(flyby_value(16), 1.45);
        assert_eq!(flyby_reset_custom(0, 0.18, 1.72), 0);
        assert_eq!(flyby_value(14), 0.18);
        assert_eq!(flyby_value(16), 1.72);
        assert_eq!(flyby_value(0), 0.0);
        assert_eq!(flyby_value(19), 0.0);
        assert_eq!(flyby_next(), 0);
        assert_eq!(flyby_value(0), 0.125);
        assert_eq!(flyby_value(19), 128.0);
    }
}
