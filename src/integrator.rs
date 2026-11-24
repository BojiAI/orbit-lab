use crate::{gravity::acceleration, Body};

pub(crate) fn advance(bodies: &[Body], next: &mut [Body], acc: &mut [[f64; 3]], dt: f64) -> Result<(), &'static str> {
    // On entry acc belongs to bodies. The endpoint evaluation overwrites it;
    // on error its contents must not be used for another initial kick.
    next.clone_from_slice(bodies);
    for (b, a) in next.iter_mut().zip(acc.iter()) {
        for k in 0..3 {
            b.vel[k] += 0.5 * dt * a[k];
            b.pos[k] += dt * b.vel[k];
        }
    }
    acceleration(next, acc)?;
    for (b, a) in next.iter_mut().zip(acc.iter()) {
        for k in 0..3 { b.vel[k] += 0.5 * dt * a[k]; }
        if !b.pos.iter().chain(&b.vel).all(|x| x.is_finite()) { return Err("nonfinite state"); }
    }
    Ok(())
}
