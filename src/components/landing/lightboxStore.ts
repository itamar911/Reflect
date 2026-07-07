type Listener = () => void;

interface LightboxSnapshot {
  src: string | null;
  label: string;
}

let snapshot: LightboxSnapshot = { src: null, label: '' };
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function openLightbox(src: string, label: string) {
  snapshot = { src, label };
  emit();
}

export function closeLightbox() {
  snapshot = { src: null, label: '' };
  emit();
}

export function subscribeLightbox(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLightboxSnapshot() {
  return snapshot;
}
