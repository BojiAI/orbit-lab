use orbit_lab::{Body, Simulation};

const DE440: &str = include_str!("fixtures/solar-system-de440.csv");
const AU_KM: f64 = 149_597_870.7;
const EARTH: usize = 3;
const MOON: usize = 9;

struct Sample {
    jd: f64,
    bodies: Vec<Body>,
}

fn samples() -> Vec<Sample> {
    let mut samples: Vec<Sample> = Vec::new();
    for row in DE440.lines().skip(1) {
        let columns: Vec<&str> = row.split(',').collect();
        let number = |column: usize| columns[column].parse::<f64>().unwrap();
        let jd = number(0);
        if samples.last().map(|sample| sample.jd) != Some(jd) {
            samples.push(Sample {
                jd,
                bodies: Vec::new(),
            });
        }
        // Positions are in AU, velocities in AU/day, and the stored mass field is GM in km³/s².
        samples.last_mut().unwrap().bodies.push(Body {
            mass: number(2),
            pos: std::array::from_fn(|axis| number(3 + axis)),
            vel: std::array::from_fn(|axis| number(6 + axis)),
        });
    }
    assert!(samples.iter().all(|sample| sample.bodies.len() == 10));
    samples
}

fn initial_bodies(first: &Sample) -> (Vec<Body>, f64) {
    let solar_gm = first.bodies[0].mass;
    let days_per_unit = (AU_KM.powi(3) / solar_gm).sqrt() / 86_400.0;
    let total_gm: f64 = first.bodies.iter().map(|body| body.mass).sum();
    let center = |axis: usize, component: fn(&Body) -> [f64; 3]| {
        first
            .bodies
            .iter()
            .map(|body| body.mass * component(body)[axis])
            .sum::<f64>()
            / total_gm
    };
    let origin: [f64; 3] = std::array::from_fn(|axis| center(axis, |b| b.pos));
    let motion: [f64; 3] = std::array::from_fn(|axis| center(axis, |b| b.vel));
    let bodies = first
        .bodies
        .iter()
        .map(|body| Body {
            mass: body.mass / solar_gm,
            pos: std::array::from_fn(|axis| body.pos[axis] - origin[axis]),
            vel: std::array::from_fn(|axis| (body.vel[axis] - motion[axis]) * days_per_unit),
        })
        .collect();
    (bodies, days_per_unit)
}

fn offset_error(actual: &[Body], reference: &[Body], body: usize, center: usize) -> f64 {
    let error_squared: f64 = (0..3)
        .map(|axis| {
            let computed = actual[body].pos[axis] - actual[center].pos[axis];
            let expected = reference[body].pos[axis] - reference[center].pos[axis];
            (computed - expected).powi(2)
        })
        .sum();
    error_squared.sqrt() * AU_KM
}

#[derive(Debug)]
struct ErrorAtDate {
    day: f64,
    planet_km: f64,
    moon_km: f64,
}

fn orbit_errors(samples: &[Sample], step_days: f64) -> Vec<ErrorAtDate> {
    let (bodies, days_per_unit) = initial_bodies(&samples[0]);
    let dt = step_days / days_per_unit;
    let mut world = Simulation::new(&bodies);
    let mut completed = 0;
    samples
        .iter()
        .skip(1)
        .map(|sample| {
            let day = sample.jd - samples[0].jd;
            let checkpoint = (day / step_days).round() as usize;
            assert_eq!(checkpoint as f64 * step_days, day);
            for _ in completed..checkpoint {
                world.step(dt).unwrap();
            }
            completed = checkpoint;
            assert!((world.time() * days_per_unit - day).abs() < 1e-8);
            let actual = world.bodies();
            let planet_km = (1..MOON)
                .map(|planet| offset_error(actual, &sample.bodies, planet, 0))
                .fold(0.0, f64::max);
            let moon_km = offset_error(actual, &sample.bodies, MOON, EARTH);
            ErrorAtDate {
                day,
                planet_km,
                moon_km,
            }
        })
        .collect()
}

#[test]
fn solar_system_tracks_de440_over_one_year() {
    let reference = samples();
    let normal = orbit_errors(&reference, 1.0 / 64.0);
    let refined = orbit_errors(&reference, 1.0 / 128.0);
    for (standard, fine) in normal.iter().zip(&refined) {
        eprintln!(
            "Day {:>3}: planets {:.1}/{:.1} km, Moon {:.1}/{:.1} km (22.5/11.25 min)",
            standard.day, standard.planet_km, fine.planet_km, standard.moon_km, fine.moon_km
        );
        assert!(standard.planet_km < 1_000.0, "{standard:?}");
        assert!(standard.moon_km < 300.0, "{standard:?}");
    }
    let standard = normal.last().unwrap();
    let fine = refined.last().unwrap();
    assert_eq!(standard.day, 365.0);
    assert!(fine.planet_km < standard.planet_km && fine.moon_km < standard.moon_km);
}
