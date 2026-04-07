let firestoreUnavailableUntil = 0;

function isQuotaError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('quota') ||
    msg.includes('resource exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('deadline exceeded')
  );
}

export function isFirestoreTemporarilyUnavailable(): boolean {
  return Date.now() < firestoreUnavailableUntil;
}

export function markFirestoreUnavailable(ms = 60_000): void {
  firestoreUnavailableUntil = Date.now() + ms;
}

export async function withFirestoreFailSoft<T>(
  task: () => Promise<T>,
  fallback: T,
  onError?: (err: any) => void
): Promise<T> {
  if (isFirestoreTemporarilyUnavailable()) {
    return fallback;
  }

  try {
    return await task();
  } catch (err: any) {
    if (isQuotaError(err)) {
      markFirestoreUnavailable(60_000);
    }
    if (onError) onError(err);
    return fallback;
  }
}

export function jsonDegraded<T>(code: string, message: string, data: T) {
  return {
    ok: false,
    degraded: true,
    code,
    message,
    data,
  };
}
