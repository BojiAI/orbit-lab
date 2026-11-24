use orbit_lab::{circular_binary, step, Body, Simulation};

fn same(actual: &[Body], expected: &[Body]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!((a.mass, a.pos, a.vel), (b.mass, b.pos, b.vel));
    }
}

#[test]
fn warm_endpoint_collision_can_retry_with_another_dt() {
    let initial = [-0.5, 0.5].map(|x| Body {
        mass: 1., pos: [x, 0., 0.], vel: [1.5 * x, 0., 0.],
    });
    let mut sim = Simulation::new(&initial);
    sim.step(1.5).unwrap(); // half kick stops both; final kick points inward
    let before = sim.bodies().to_vec();
    // Now the cache is warm. Half kick at dt=0.5 gives speeds ±1;
    // drift moves both to the origin, so endpoint force overwrites then fails.
    assert_eq!(sim.step(0.5), Err("coincident point masses"));
    same(sim.bodies(), &before);
    assert_eq!(sim.time(), 1.5);
    let mut reference = before;
    for dt in [0.125, 0.0625, 0.03125] {
        step(&mut reference, dt).unwrap(); // cold evaluation at each start
        sim.step(dt).unwrap();
        same(sim.bodies(), &reference);
    }
    assert_eq!(sim.time(), 1.71875);
}

#[test]
fn edited_snapshot_starts_cold_for_mass_position_and_membership() {
    // The public world view is immutable. Editing means changing a snapshot
    // and constructing a new world, not sharing its source world's cache.
    let mut source = Simulation::new(&circular_binary(1.));
    source.step(0.125).unwrap();
    for edit in 0..3 {
        let mut snapshot = source.bodies().to_vec();
        match edit {
            0 => snapshot[1].mass *= 2.,
            1 => snapshot[1].pos[2] = 0.5,
            _ => snapshot.truncate(1),
        }
        // Check the first drift directly against acceleration at the edited positions.
        let old = &snapshot[0];
        let mut a = [0.; 3];
        if let Some(other) = snapshot.get(1) {
            let d: [f64; 3] = std::array::from_fn(|k| other.pos[k] - old.pos[k]);
            let r2: f64 = d.iter().map(|v| v * v).sum();
            a = d.map(|v| other.mass * v * (1. / (r2 * r2.sqrt())));
        }
        let dt = 0.125;
        let expected: [f64; 3] = std::array::from_fn(|k| old.pos[k] + dt * (old.vel[k] + 0.5 * dt * a[k]));
        let mut edited = Simulation::new(&snapshot);
        edited.step(dt).unwrap();
        assert_eq!(edited.bodies()[0].pos, expected);
    }
}
