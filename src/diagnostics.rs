use crate::Body;

#[derive(Clone, Copy, Debug)]
pub struct ConservedQuantities {
    pub energy: f64,
    pub angular_momentum: [f64; 3],
}

/// Total Newtonian energy (G = 1) and angular momentum about the input frame's origin.
/// Returns an error if the diagnostic is undefined or its calculation overflows.
pub fn conserved_quantities(bodies: &[Body]) -> Result<ConservedQuantities, &'static str> {
    let mut energy = 0.0;
    let mut angular_momentum = [0.0; 3];
    for body in bodies {
        if !body.mass.is_finite() || body.mass <= 0.0 {
            return Err("invalid mass");
        }
        if !body.pos.iter().chain(&body.vel).all(|v| v.is_finite()) {
            return Err("nonfinite state");
        }

        let [x, y, z] = body.pos;
        let [px, py, pz] = body.vel.map(|v| body.mass * v);
        let [vx, vy, vz] = body.vel;
        energy += 0.5 * vx * px + 0.5 * vy * py + 0.5 * vz * pz;
        angular_momentum[0] += y * pz - z * py;
        angular_momentum[1] += z * px - x * pz;
        angular_momentum[2] += x * py - y * px;
    }

    for (i, body) in bodies.iter().enumerate() {
        for other in &bodies[i + 1..] {
            let [dx, dy, dz] = std::array::from_fn(|k| other.pos[k] - body.pos[k]);
            let distance = dx.hypot(dy).hypot(dz);
            if distance == 0.0 {
                return Err("coincident point masses");
            }
            if !distance.is_finite() {
                return Err("nonfinite separation");
            }
            energy -= body.mass * other.mass / distance;
        }
    }

    if !energy.is_finite() || !angular_momentum.iter().all(|v| v.is_finite()) {
        return Err("nonfinite diagnostics");
    }
    Ok(ConservedQuantities {
        energy,
        angular_momentum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_diagnostics_return_errors() {
        let mut bodies = crate::circular_binary(1.0);
        bodies[1].pos = bodies[0].pos;
        assert_eq!(conserved_quantities(&bodies).unwrap_err(), "coincident point masses");

        let mut bodies = crate::circular_binary(1.0);
        bodies[1].vel[1] = f64::MAX;
        assert_eq!(conserved_quantities(&bodies).unwrap_err(), "nonfinite diagnostics");
        bodies[1].vel[1] = f64::NAN;
        assert_eq!(conserved_quantities(&bodies).unwrap_err(), "nonfinite state");
    }
}
