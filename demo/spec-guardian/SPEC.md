# Greeting contract

`formatGreeting(name)` returns a stable user-facing greeting.

## Requirements

1. Trim leading and trailing whitespace from `name`.
2. Return `Hello, stranger!` when the trimmed name is empty.
3. Return `Hello, <name>!` for every non-empty name.
4. Keep the exclamation mark in both forms.
5. Tests must cover a normal name, surrounding whitespace, and an empty name.
