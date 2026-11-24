use crate::Body;

pub(crate) fn acceleration(bodies: &[Body], a: &mut [[f64; 3]]) -> Result<(), &'static str> {
    assert_eq!(a.len(), bodies.len());
    a.fill([0.; 3]);
    for i in 0..bodies.len() {
        for j in i + 1..bodies.len() {
            let d: [f64; 3] = std::array::from_fn(|k| bodies[j].pos[k] - bodies[i].pos[k]);
            let r2: f64 = d.iter().map(|x| x * x).sum();
            if r2 == 0.0 { return Err("coincident point masses"); }
            let inv = 1.0 / (r2 * r2.sqrt());
            for k in 0..3 {
                a[i][k] += bodies[j].mass * d[k] * inv;
                a[j][k] -= bodies[i].mass * d[k] * inv;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overwrites_reused_output() {
        let mut bodies = crate::circular_binary(1.);
        let mut a = [[7.; 3]; 2];
        acceleration(&bodies, &mut a).unwrap();
        assert_eq!(a, [[0.5, 0., 0.], [-0.5, 0., 0.]]);
        bodies[1].pos = [-0.5, 0., 2.];
        acceleration(&bodies, &mut a).unwrap();
        assert_eq!(a, [[0., 0., 0.125], [0., 0., -0.125]]);
    }
}
