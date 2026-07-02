// Compile-time exhaustiveness guard: a new union variant makes the call site
// fail to typecheck instead of silently falling into the last branch. The
// throw only fires if the type system was bypassed at runtime.
export const assertNever = (value: never): never => {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`);
};
