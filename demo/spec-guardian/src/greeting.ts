export function formatGreeting(name: string): string {
	const normalized = name.trim();
	return normalized ? `Hello, ${normalized}!` : "Hello, stranger!";
}
