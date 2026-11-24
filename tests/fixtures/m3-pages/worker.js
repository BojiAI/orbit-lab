// The page requests observation intervals, not timesteps. Only WASM advances time.
let kernel;
let stepNumber = 0;
let branchStep = null;

function postFrame(step, readValue, readMass) {
  const values = Array.from({ length: 13 }, (_, i) => readValue(i));
  if (!values.every(Number.isFinite)) throw Error(`Non-finite snapshot at ${step}`);
  const energy = readValue(13);
  const angularMomentum = [14, 15, 16].map(index => readValue(index));
  const diagnostics = Number.isFinite(energy) && angularMomentum.every(Number.isFinite)
    ? { energy, angularMomentum } : null;
  const frame = { step, values, diagnostics };
  if (readMass) {
    frame.masses = [readMass(0), readMass(1)];
    if (!frame.masses.every(Number.isFinite)) throw Error(`Non-finite mass at ${step}`);
  }
  self.postMessage(frame);
}
let initializing = false;
self.onmessage = async ({ data }) => {
  try {
    let count = data;
    if (!kernel) {
      if (initializing || data?.type !== 'init') throw Error('Expected one init request before stepping');
      const { q } = data;
      if (!Number.isFinite(q) || q < 0.01 || q > 100) throw Error('Mass ratio q must be in [0.01, 100]');
      initializing = true;
      const url = new URL('orbit_lab_m3.wasm', self.location.href);
      const response = await fetch(url);
      if (!response.ok) throw Error(`WASM: HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      const status = instance.exports.reset(q);
      if (status !== 0) throw Error(`WASM reset: status ${status}`);
      kernel = instance.exports;
      count = 0;
    }
    if (data?.type === 'fork') {
      kernel.fork_b();
      branchStep = stepNumber;
      return postFrame(branchStep, kernel.value_b, kernel.mass_b);
    }
    if (data?.type === 'setMassB') {
      if (branchStep === null) throw Error('Fork before editing B');
      if (data.index !== 1 || !Number.isFinite(data.mass)) throw Error('Expected a finite companion mass');
      const status = kernel.set_mass_b(data.index, data.mass);
      if (status !== 0) throw Error(`WASM rejected companion mass (expected [0.01, 100])`);
      return postFrame(branchStep, kernel.value_b, kernel.mass_b);
    }
    if (data?.type === 'stepB') {
      if (branchStep === null) throw Error('Fork before stepping B');
      if (!Number.isSafeInteger(data.count) || data.count < 1 || data.count > 64 || data.count > 1024 - branchStep) {
        throw Error('Invalid B step request');
      }
      for (let i = 0; i < data.count; i++) {
        const status = kernel.step_b();
        if (status !== 0) throw Error(`WASM step B ${branchStep + 1}: status ${status}`);
        branchStep++;
      }
      return postFrame(branchStep, kernel.value_b, kernel.mass_b);
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 1024 - stepNumber) {
      throw Error(`Invalid step count: ${count}`);
    }
    for (let i = 0; i < count; i++) {
      const status = kernel.step();
      if (status !== 0) throw Error(`WASM step ${stepNumber + 1}: status ${status}`);
      stepNumber++;
    }
    postFrame(stepNumber, kernel.value);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
