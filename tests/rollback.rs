use orbit_lab::{Simulation, Body};

fn assert_bodies(actual: &[Body], expected: &[Body]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!(a.mass, b.mass);
        assert_eq!(a.pos, b.pos);
        assert_eq!(a.vel, b.vel);
    }
}

#[test]
fn timestep_below_clock_resolution_does_not_commit() {
    let t = (1_u64 << 53) as f64;
    let initial = [Body { mass: 1., pos: [-t, 0., 0.], vel: [1., 0., 0.] }];
    let mut sim = Simulation::new(&initial);
    sim.step(t).unwrap();
    let before = sim.bodies().to_vec();
    assert!(sim.step(1.).is_err());
    assert_eq!(sim.time(), t);
    assert_bodies(sim.bodies(), &before);
    sim.step(2.).unwrap();
    assert_eq!(sim.time(), t + 2.);
    assert_eq!(sim.bodies()[0].pos[0], 2.);
}

#[test]
fn collision_after_drift_can_retry() {
    let initial = [-0.5, 0.5].map(|x| Body { mass: 1., pos: [x, 0., 0.], vel: [0.; 3] });
    let mut actual = Simulation::new(&initial);
    let mut clean = Simulation::new(&initial);
    assert_eq!(actual.step(1.), Err("coincident point masses"));
    assert_eq!(actual.time(), 0.);
    assert_bodies(actual.bodies(), &initial);
    actual.step(0.25).unwrap();
    clean.step(0.25).unwrap();
    assert_eq!(actual.time(), 0.25);
    assert_eq!(actual.time(), clean.time());
    assert_bodies(actual.bodies(), clean.bodies());
}
