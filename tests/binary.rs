use orbit_lab::{circular_binary, Simulation};

fn closure_error(n: usize) -> f64 {
    let mut sim = Simulation::new(&circular_binary(0.25));
    let start = sim.bodies()[1].pos;
    for _ in 0..n { sim.step(std::f64::consts::TAU / n as f64).unwrap(); }
    let b = sim.bodies();
    for k in 0..3 {
        assert!((b[0].mass*b[0].pos[k] + b[1].mass*b[1].pos[k]).abs() < 1e-12);
    }
    (b[1].pos[0]-start[0]).hypot(b[1].pos[1]-start[1])
}

#[test]
fn binary_converges_at_second_order() {
    let coarse = closure_error(256);
    let fine = closure_error(512);
    assert!(fine < 1e-3 && (3.8..4.2).contains(&(coarse/fine)));
}

#[test]
fn singularity_does_not_advance_state() {
    let mut b = circular_binary(1.);
    b[1].pos = b[0].pos;
    let mut sim = Simulation::new(&b);
    assert!(sim.step(0.1).is_err());
    assert_eq!(sim.time(), 0.);
    for (x,y) in sim.bodies().iter().zip(&b) { assert_eq!(x.pos,y.pos); assert_eq!(x.vel,y.vel); }
}
