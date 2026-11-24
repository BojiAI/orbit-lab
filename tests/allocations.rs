//! Keep this integration-test executable single-test: its allocator is process-wide.
use orbit_lab::{circular_binary, Simulation};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

struct CountingAllocator;
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static ALLOC: AtomicUsize = AtomicUsize::new(0);
static ZEROED: AtomicUsize = AtomicUsize::new(0);
static REALLOC: AtomicUsize = AtomicUsize::new(0);

fn count(counter: &AtomicUsize) {
    if ACTIVE.load(Relaxed) {
        counter.fetch_add(1, Relaxed);
    }
}

// Forward the original pointer/layout unchanged; counting itself never allocates.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(&ALLOC);
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(&ZEROED);
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(&REALLOC);
        System.realloc(ptr, layout, size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
}

#[test]
fn continuous_binary_steps_do_not_allocate() {
    const DT: f64 = 1. / 1024.;
    let mut sim = Simulation::new(&circular_binary(1.));
    sim.step(DT).unwrap();
    let start = sim.bodies()[0].pos;

    ACTIVE.store(true, Relaxed);
    let result = (0..1024).try_for_each(|_| sim.step(DT));
    ACTIVE.store(false, Relaxed);

    result.unwrap();
    assert_eq!(sim.time(), 1025. * DT);
    assert_ne!(sim.bodies()[0].pos, start);
    let counts = [ALLOC.load(Relaxed), ZEROED.load(Relaxed), REALLOC.load(Relaxed)];
    println!("1024 steps: [alloc, alloc_zeroed, realloc] = {counts:?}");
    assert_eq!(counts, [0; 3]);
}
