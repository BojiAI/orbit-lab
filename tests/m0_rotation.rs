//! M0 三维旋转协变性；显示指标：cargo test --test m0_rotation -- --nocapture
//! 单位：G=1，质量、长度、时间均取模拟单位，速度单位为长度/时间。
//! 参照解是对原系统每一步的离散状态施加同一个刚体旋转，不是精确物理解。
//! 在精确算术中，中心力和 KDK 的每个子步都与旋转可交换，因此两条轨迹
//! 的共同时间离散误差不计入容差；此实验不检验绝对轨道精度。

use orbit_lab::{Body, Simulation};

// 由单位四元数 (w,x,y,z)=(1,2,3,4)/sqrt(30) 得到的正旋转。
// 每个输出分量都依赖三个输入分量，不是换轴或符号翻转。
fn rotate([x, y, z]: [f64; 3]) -> [f64; 3] {
    [
        (-20.0 * x + 4.0 * y + 22.0 * z) / 30.0,
        (20.0 * x - 10.0 * y + 20.0 * z) / 30.0,
        (10.0 * x + 28.0 * y + 4.0 * z) / 30.0,
    ]
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1]).hypot(a[2] - b[2])
}

#[derive(Debug, Default)]
struct Peak {
    error: f64,
    step: usize,
    body: usize,
}

impl Peak {
    fn observe(&mut self, error: f64, step: usize, body: usize) {
        assert!(error.is_finite(), "nonfinite error at step {step}, body {body}");
        if error > self.error {
            *self = Self { error, step, body };
        }
    }
}

#[test]
fn noncoplanar_trajectory_commutes_with_rotation() {
    // 四点组成四面体（三条边的混合积为 8）；各质量不同，速度不对称。
    let original = [
        Body { mass: 0.4, pos: [-1.0, -0.5, -0.5], vel: [0.1, -0.2, 0.3] },
        Body { mass: 0.3, pos: [1.0, -0.5, -0.5], vel: [-0.2, 0.1, 0.1] },
        Body { mass: 0.2, pos: [-1.0, 1.5, -0.5], vel: [0.3, 0.2, -0.1] },
        Body { mass: 0.1, pos: [-1.0, -0.5, 1.5], vel: [-0.1, -0.3, 0.2] },
    ];
    let rotated = original.clone().map(|b| Body {
        pos: rotate(b.pos), vel: rotate(b.vel), mass: b.mass,
    });

    let mut original = Simulation::new(&original);
    let mut rotated = Simulation::new(&rotated);

    // 最小初始间距 2，总质量 1，动力学时间尺度约 sqrt(2^3/1)。
    // 只推进 0.5，针对光滑短弧而非近遇；二进制精确步长避免时刻歧义。
    const DT: f64 = 1.0 / 512.0;
    const STEPS: usize = 256;
    // 先验回归预算：按步数线性累积舍入量，给两套求力、积分和旋转
    // 留 32 倍运算余量。位置/速度分别取 2 长度单位和 1 速度单位为
    // 此短弧的特征尺度。是工程容差，不是严格前向误差界或实测拟合值。
    let budget = 32.0 * STEPS as f64 * f64::EPSILON;
    let (pos_tol, vel_tol) = (2.0 * budget, budget);
    let (mut pos, mut vel) = (Peak::default(), Peak::default());
    for n in 0..=STEPS {
        if n != 0 {
            original.step(DT).unwrap_or_else(|e| panic!("original step {n}: {e}"));
            rotated.step(DT).unwrap_or_else(|e| panic!("rotated step {n}: {e}"));
        }
        for (i, (a, b)) in original.bodies().iter().zip(rotated.bodies()).enumerate() {
            pos.observe(distance(rotate(a.pos), b.pos), n, i);
            vel.observe(distance(rotate(a.vel), b.vel), n, i);
        }
    }
    println!("M0 rotation dt={DT} steps={STEPS}: max_position={:.12e} (step {}, body {}), tol={pos_tol:e}; max_velocity={:.12e} (step {}, body {}), tol={vel_tol:e}",
             pos.error, pos.step, pos.body, vel.error, vel.step, vel.body);
    assert!(pos.error <= pos_tol, "position {pos:?} exceeds {pos_tol:e}");
    assert!(vel.error <= vel_tol, "velocity {vel:?} exceeds {vel_tol:e}");
}
