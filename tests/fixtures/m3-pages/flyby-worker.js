// Only WASM selects timesteps. The page requests the next common sample.
let kernel;
let initializing = false;

self.onmessage = async ({ data }) => {
  try {
    if (!kernel) {
      if (initializing || data?.type !== 'init') throw Error('Expected one flyby init request');
      if (data.mode !== 'fixed' && data.mode !== 'adaptive') throw Error('Invalid flyby mode');
      initializing = true;
      const response = await fetch(new URL('orbit_lab_m3.wasm', self.location.href));
      if (!response.ok) throw Error(`WASM: HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      const mode = data.mode === 'adaptive' ? 1 : 0;
      if (data.preset !== undefined && (!Number.isInteger(data.preset) || data.preset < 0 || data.preset > 0xffffffff)) {
        throw Error('Invalid flyby preset');
      }
      const status = data.preset === undefined
        ? instance.exports.flyby_reset_custom(mode, data.y, data.vx)
        : instance.exports.flyby_reset_preset(mode, data.preset);
      if (status !== 0) {
        throw Error('WASM rejected the flyby initial conditions');
      }
      kernel = instance.exports;
    } else {
      if (data?.type !== 'next') throw Error('Expected a flyby checkpoint request');
      const status = kernel.flyby_next();
      if (status !== 0) throw Error(`Flyby checkpoint failed: status ${status}`);
    }

    self.postMessage({
      values: Array.from({ length: 19 }, (_, index) => kernel.flyby_value(index)),
      steps: kernel.flyby_value(19),
      step: kernel.flyby_value(20),
      end: kernel.flyby_value(21),
    });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
