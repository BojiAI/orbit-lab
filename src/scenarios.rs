use crate::Body;
use std::f64::consts::PI;

/// Convert a uniform sphere into the point mass used by the engine.
pub fn spherical_body(
    radius: f64,
    density: f64,
    pos: [f64; 3],
    vel: [f64; 3],
) -> Result<Body, &'static str> {
    if !radius.is_finite() || radius <= 0.0 || !density.is_finite() || density <= 0.0 {
        return Err("radius and density must be finite and positive");
    }
    if !pos.iter().chain(&vel).all(|value| value.is_finite()) {
        return Err("position and velocity must be finite");
    }
    let mass = (density * radius * radius * radius) * (4.0 * PI / 3.0);
    if !mass.is_finite() || mass <= 0.0 {
        return Err("derived mass must be finite and positive");
    }
    Ok(Body { mass, pos, vel })
}

/// Unit separation and total mass; period = 2π. q = secondary / primary.
pub fn circular_binary(q: f64) -> [Body; 2] {
    assert!(q.is_finite() && q > 0.0);
    let m = 1.0 / (1.0 + q);
    let n = q / (1.0 + q);
    [Body { mass: m, pos: [-n, 0., 0.], vel: [0., -n, 0.] },
     Body { mass: n, pos: [m, 0., 0.], vel: [0., m, 0.] }]
}

/// The reference binary and incoming visitor, with two adjustable components.
pub(crate) fn flyby_initial(visitor_y: f64, visitor_vx: f64) -> [Body; 3] {
    [
        Body { mass: 0.9, pos: [-0.1, 0.0, 0.0], vel: [0.0, -0.1, 0.0] },
        Body { mass: 0.1, pos: [0.9, 0.0, 0.0], vel: [0.0, 0.9, 0.0] },
        Body { mass: 0.02, pos: [-3.0, visitor_y, 0.20], vel: [visitor_vx, 0.02, -0.04] },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sphere_mass_scales_with_density_and_volume() {
        let pos = [1.0, -0.5, 2.0];
        let vel = [-0.25, 0.75, 0.5];
        let base = spherical_body(1.0, 1.0, pos, vel).unwrap();
        let larger = spherical_body(2.0, 3.0, pos, vel).unwrap();
        assert_eq!(larger.mass, 24.0 * base.mass);
        assert_eq!((larger.pos, larger.vel), (pos, vel));
        assert!(spherical_body(0.0, 1.0, pos, vel).is_err());
        assert!(spherical_body(1.0, f64::INFINITY, pos, vel).is_err());
        assert!(spherical_body(f64::MAX, 1.0, pos, vel).is_err());
    }
}
