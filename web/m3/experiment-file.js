const VERSION = 1;

export function downloadExperiment(kind, settings, filename) {
  const contents = JSON.stringify({ version: VERSION, kind, settings }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readExperiment(file, kind) {
  let experiment;
  try {
    experiment = JSON.parse(await file.text());
  } catch {
    throw Error('无法读取实验文件，请选择导出的 JSON 文件。');
  }
  if (experiment?.version !== VERSION || experiment.kind !== kind ||
      !experiment.settings || typeof experiment.settings !== 'object' || Array.isArray(experiment.settings)) {
    throw Error('实验文件的类型或版本不匹配。');
  }
  return experiment.settings;
}
