let kernel;
let initializing = false;
let bodyCount = 0;
let checkpoint = 0;

self.onmessage = async ({ data }) => {
  try {
    let fault;
    let masses;
    if (!kernel) {
      if (initializing || data?.type !== 'init' || !Array.isArray(data.bodies)) {
        throw Error('需要一组完整的场景初值。');
      }
      initializing = true;
      const response = await fetch(new URL('orbit_lab_m3.wasm', self.location.href));
      if (!response.ok) throw Error(`读取物理模块失败（HTTP ${response.status}）。`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      const candidate = instance.exports;
      candidate.scene_clear_draft();
      for (const body of data.bodies) {
        if (candidate.scene_add_body(body.radius, body.density, ...body.position, ...body.velocity) !== 0) {
          throw Error(`「${body.name}」的初值无效。`);
        }
      }
      const status = candidate.scene_start(data.dt, data.end ?? 0);
      if (status === 2) throw Error('两个天体的初始位置重合，请调整坐标。');
      if (status !== 0) throw Error('场景或推进设置无效。');
      kernel = candidate;
      bodyCount = data.bodies.length;
      masses = Array.from({ length: bodyCount }, (_, index) => kernel.scene_mass(index));
    } else {
      if ((data?.type !== 'advance' && data?.type !== 'continue') ||
          !Number.isInteger(data.count) || data.count < 1 || data.count > 64) {
        throw Error('无效的推进请求。');
      }
      if (data.type === 'continue' && kernel.scene_continue() !== 0) {
        throw Error('当前场景无法从终点继续。');
      }
      const status = kernel.scene_advance(data.count);
      if (status === 2) fault = '物理步计算失败，已停在最后成功的状态。';
      else if (status !== 0) throw Error('无法推进到请求的步数。');
      checkpoint++;
    }
    self.postMessage({
      step: checkpoint,
      steps: kernel.scene_steps(),
      values: Array.from({ length: 1 + 6 * bodyCount }, (_, index) => kernel.scene_value(index)),
      masses,
      fault,
    });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
