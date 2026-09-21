// Files selected on the home screen are handed to the target tool through
// this tiny registry (keeps the screens decoupled from the router).
let pending: File[] | null = null;

export function setPendingFiles(files: File[] | null): void {
  pending = files && files.length ? files : null;
}

export function takePendingFiles(): File[] | null {
  const files = pending;
  pending = null;
  return files;
}
