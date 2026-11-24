// Capture the actual file prepared by the page without writing to Chrome's Downloads folder.
export function captureDownload(button) {
  let blob;
  const create = URL.createObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  try {
    URL.createObjectURL = value => {
      blob = value;
      return create.call(URL, value);
    };
    HTMLAnchorElement.prototype.click = () => {};
    button.click();
  } finally {
    URL.createObjectURL = create;
    HTMLAnchorElement.prototype.click = click;
  }
  if (!(blob instanceof Blob)) throw Error('Expected an experiment file download');
  return blob;
}

export function importFile(input, blob) {
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'experiment.json', { type: 'application/json' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));
}
