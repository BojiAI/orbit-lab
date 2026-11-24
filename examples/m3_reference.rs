//! Native trajectory reference in the M3 worker's snapshot order.
use orbit_lab::{circular_binary, Simulation};
use std::f64::consts::TAU;

fn main() -> Result<(), &'static str> {
    const STEPS: usize = 1024;
    let mut args = std::env::args().skip(1);
    let q: f64 = match args.next() {
        Some(arg) => arg.parse().map_err(|_| "expected a numeric mass ratio q")?,
        None => 1.0,
    };
    if args.next().is_some() {
        return Err("usage: m3_reference [q]");
    }
    if !(0.01..=100.0).contains(&q) {
        return Err("mass ratio q must be finite and in [0.01, 100]");
    }
    let mut sim = Simulation::new(&circular_binary(q));
    println!("[");
    for step in 0..=STEPS {
        if step > 0 {
            sim.step(TAU / STEPS as f64)?;
        }
        if step % 16 == 0 {
            print!("[{}", sim.time());
            for body in sim.bodies() {
                for value in body.pos.iter().chain(&body.vel) {
                    print!(",{}", value);
                }
            }
            println!("]{}", if step == STEPS { "" } else { "," });
        }
    }
    println!("]");
    Ok(())
}
