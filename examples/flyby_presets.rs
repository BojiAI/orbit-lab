//! The browser reads the same preset metadata used to initialize Rust runs.

use orbit_lab::flyby::{ADAPTIVE_FRACTION, CUSTOM_FIXED_DENOMINATOR, END_TIME, PRESETS};

fn main() {
    println!("export const CUSTOM_FIXED_DENOMINATOR = {CUSTOM_FIXED_DENOMINATOR};");
    println!("export const ADAPTIVE_FRACTION = {ADAPTIVE_FRACTION};");
    println!("export const END_TIME = {END_TIME};");
    println!("export const PRESETS = [");
    for (index, preset) in PRESETS.iter().enumerate() {
        println!(
            "  {{ id: {:?}, index: {}, y: {}, vx: {}, fixedDenominator: {} }},",
            preset.id, index, preset.visitor_y, preset.visitor_vx, preset.fixed_denominator,
        );
    }
    println!("];");
}
