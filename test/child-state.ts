// Read-only payload projection for behavioural assertions across wire generations.
// Dedicated migration tests inspect raw wrappers and released-reader rejection.
export function childState<T>(value: T): T {
	const wire = value as T & { version?: number; state: T };
	return wire.version === 2 ? wire.state : value;
}
