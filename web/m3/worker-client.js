// A run owns one worker and waits for each snapshot before advancing again.
export function openWorker(url, valueCount, prepareFrame) {
  const worker = new Worker(url);
  let pending;

  function reject(error) {
    pending?.reject(error);
    pending = null;
  }

  worker.onerror = event => reject(Error(event.message || 'Worker failed'));
  worker.onmessageerror = () => reject(Error('Cannot decode worker message'));
  worker.onmessage = ({ data }) => {
    if (!pending) return;
    if (data?.error) return reject(Error(data.error));
    if (data?.step !== pending.step) return reject(Error(`Expected step ${pending.step}, got ${data?.step}`));
    if (!Array.isArray(data.values) || data.values.length !== valueCount || !data.values.every(Number.isFinite)) {
      return reject(Error(`Invalid snapshot at step ${data.step}`));
    }
    try {
      prepareFrame?.(data);
      pending.resolve(data);
      pending = null;
    } catch (error) {
      reject(error);
    }
  };

  return {
    request(message, step) {
      return new Promise((resolve, fail) => {
        if (pending) throw Error('Worker request already pending');
        pending = { step, resolve, reject: fail };
        try {
          worker.postMessage(message);
        } catch (error) {
          reject(error);
        }
      });
    },
    close() {
      worker.terminate();
      reject(Error('Worker closed'));
    },
  };
}
