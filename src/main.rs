use orbit_lab::{circular_binary, Simulation};

fn main() {
    let mut sim = Simulation::new(&circular_binary(1.0));
    let dt = std::f64::consts::TAU / 1024.;
    println!("time,x1,y1,x2,y2");
    for i in 0..=1024 {
        if i % 16 == 0 {
            let bodies = sim.bodies();
            println!("{},{},{},{},{}", i as f64 * dt, bodies[0].pos[0], bodies[0].pos[1], bodies[1].pos[0], bodies[1].pos[1]);
        }
        if i < 1024 { sim.step(dt).expect("binary integration failed"); }
    }
}
